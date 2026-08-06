"""Local Project Bluff server with mutually exclusive Art-Net or OSC output."""

from __future__ import annotations

import json
import math
import os
import socket
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context
from werkzeug.exceptions import BadRequest

from artnet_output import LightingRuntime, LightingRuntimeError
from fixture_definitions import public_fixture_definitions
from lighting_config import (
    OSC_AUXILIARY_TRIGGER_KEYS,
    OSC_PHASE_TRIGGER_KEYS,
    OSC_TRIGGER_KEYS,
    TRIGGER_KEYS,
    TRIGGER_LABELS,
    LightingConfigStore,
    LightingConfigValidationError,
    normalize_config,
)
from lighting_output import LightingOutputController
from osc_sender import OscSender


PROJECT_ROOT = Path(__file__).resolve().parent
SOUNDS_ROOT = PROJECT_ROOT / "sounds"
STAGE_TRIGGERS = {"setup", "day", "nominations", "night"}
CONTROL_TRIGGER_KEYS = (*TRIGGER_KEYS, *OSC_PHASE_TRIGGER_KEYS)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class ControlState:
    """Process-local shared stage state for simultaneous phone and desktop clients."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._condition = threading.Condition(self._lock)
        self._session_id = uuid.uuid4().hex
        self._revision = 0
        self._current_stage: str | None = None
        self._nomination_phase: str | None = None
        self._started_at: str | None = None
        self._started_monotonic: float | None = None
        self._audio_events: tuple[str, ...] = ()
        self._loop_offset: float | None = None
        self._cue_revision = 0
        self._updated_at = _utc_now()

    def apply(
        self,
        trigger: str,
        auxiliary_triggers: tuple[str, ...] = (),
        loop_offset: float | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            if trigger in OSC_PHASE_TRIGGER_KEYS:
                self._apply_nomination_event_locked(trigger)
            elif trigger in STAGE_TRIGGERS or trigger == "stopAll":
                self._current_stage = trigger if trigger in STAGE_TRIGGERS else None
                self._nomination_phase = "ready" if trigger == "nominations" else None
                self._started_at = _utc_now() if self._current_stage else None
                self._started_monotonic = time.monotonic()
                self._audio_events = auxiliary_triggers if trigger == "day" else ()
                self._loop_offset = (
                    loop_offset if loop_offset is not None else 0.0
                ) if trigger == "day" else None
                self._cue_revision += 1
            else:
                raise ValueError("Unknown control trigger.")
            self._revision += 1
            self._updated_at = _utc_now()
            self._condition.notify_all()
            return self._snapshot_locked()

    def _apply_nomination_event_locked(self, trigger: str) -> None:
        if self._current_stage != "nominations":
            raise ControlTransitionError(
                "Nomination controls are available only during Group Discussion."
            )
        if trigger == "nomination":
            if self._nomination_phase != "ready":
                raise ControlTransitionError("A nomination is already active.")
            self._nomination_phase = "nomination"
            return
        if self._nomination_phase != "nomination":
            raise ControlTransitionError("Begin Voting requires an active nomination.")
        self._nomination_phase = "ready"

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return self._snapshot_locked()

    def wait_for_revision(self, after_revision: int, timeout: float = 20.0) -> dict[str, Any]:
        with self._condition:
            if self._revision <= after_revision:
                self._condition.wait_for(
                    lambda: self._revision > after_revision,
                    timeout=timeout,
                )
            return self._snapshot_locked()

    def _snapshot_locked(self) -> dict[str, Any]:
        elapsed_ms = 0
        if self._started_monotonic is not None:
            elapsed_ms = max(0, round((time.monotonic() - self._started_monotonic) * 1000))
        return {
            "sessionId": self._session_id,
            "revision": self._revision,
            "cueRevision": self._cue_revision,
            "currentStage": self._current_stage,
            "nominationPhase": self._nomination_phase,
            "startedAt": self._started_at,
            "elapsedMs": elapsed_ms,
            "audioEvents": list(self._audio_events),
            "loopOffset": self._loop_offset,
            "updatedAt": self._updated_at,
        }


class ControlTransitionError(ValueError):
    """Raised when a synchronized phase action is not valid in the current state."""


def _json_body() -> dict[str, Any]:
    if not request.is_json:
        raise BadRequest("Request body must use application/json.")
    payload = request.get_json(silent=False)
    if not isinstance(payload, dict):
        raise BadRequest("Request JSON must be an object.")
    return payload


def _error_response(message: str, status: int, field_errors: dict[str, str] | None = None):
    payload: dict[str, Any] = {"error": message}
    if field_errors:
        payload["fieldErrors"] = field_errors
    return jsonify(payload), status


def _read_control_payload() -> tuple[str, tuple[str, ...], float | None]:
    payload = _json_body()
    supported_shapes = (
        {"trigger"},
        {"trigger", "auxiliaryTriggers"},
        {"trigger", "loopOffset"},
        {"trigger", "auxiliaryTriggers", "loopOffset"},
    )
    if set(payload) not in supported_shapes:
        raise BadRequest(
            "Provide one supported trigger with optional auxiliaryTriggers and DAY loopOffset."
        )
    trigger = payload.get("trigger")
    if trigger not in CONTROL_TRIGGER_KEYS:
        raise BadRequest("Provide one supported control trigger.")
    if trigger in OSC_PHASE_TRIGGER_KEYS:
        if set(payload) != {"trigger"}:
            raise BadRequest("Nomination events accept only one trigger.")
        return trigger, (), None
    auxiliaries = payload.get("auxiliaryTriggers", [])
    if not isinstance(auxiliaries, list) or any(not isinstance(item, str) for item in auxiliaries):
        raise BadRequest("auxiliaryTriggers must be an array of supported event IDs.")
    if len(auxiliaries) != len(set(auxiliaries)):
        raise BadRequest("auxiliaryTriggers cannot contain duplicates.")
    if any(item not in OSC_AUXILIARY_TRIGGER_KEYS for item in auxiliaries):
        raise BadRequest("auxiliaryTriggers contains an unsupported event ID.")
    if auxiliaries and trigger != "day":
        raise BadRequest("Auxiliary sound events are supported only with DAY.")
    expected_order = [item for item in OSC_AUXILIARY_TRIGGER_KEYS if item in auxiliaries]
    if auxiliaries != expected_order:
        raise BadRequest("Auxiliary sound events must use Bells, Male Scream, Female Scream order.")
    loop_offset = payload.get("loopOffset")
    if loop_offset is not None:
        if (
            isinstance(loop_offset, bool)
            or not isinstance(loop_offset, (int, float))
            or not math.isfinite(loop_offset)
            or loop_offset < 0
            or loop_offset > 86400
        ):
            raise BadRequest("loopOffset must be a finite number from 0 through 86400 seconds.")
        if trigger != "day":
            raise BadRequest("loopOffset is supported only with DAY.")
        loop_offset = float(loop_offset)
    return trigger, tuple(auxiliaries), loop_offset


def _read_preview_payload() -> str:
    payload = _json_body()
    if set(payload) != {"trigger"} or payload.get("trigger") not in OSC_TRIGGER_KEYS:
        raise BadRequest("Provide one supported lighting event and no additional fields.")
    return payload["trigger"]


def _output_patch(config: dict[str, Any]) -> dict[str, Any]:
    return {
        "outputMode": config["outputMode"],
        "artnet": config["artnet"],
        "oscDestination": {
            "targetHost": config["osc"]["targetHost"],
            "targetPort": config["osc"]["targetPort"],
        },
        "fixtures": config["fixtures"],
    }


def create_app(
    config_path: str | os.PathLike[str] | None = None,
    lighting_runtime: LightingRuntime | None = None,
    control_state: ControlState | None = None,
    osc_sender: OscSender | None = None,
) -> Flask:
    app = Flask(__name__, static_folder=None, instance_relative_config=True)
    app.config.update(JSON_SORT_KEYS=False)

    resolved_config_path = Path(
        config_path
        or os.environ.get("BLUFF_LIGHTING_CONFIG_PATH")
        or (Path(app.instance_path) / "lighting-config.json")
    )
    store = LightingConfigStore(resolved_config_path)
    artnet_runtime = lighting_runtime or LightingRuntime(store.load)
    runtime = LightingOutputController(
        store.load,
        artnet_runtime=artnet_runtime,
        osc_sender=osc_sender,
    )
    shared_state = control_state or ControlState()
    app.extensions["project_bluff_control_state"] = shared_state
    control_dispatch_lock = threading.RLock()
    app.extensions["bluff_lighting_store"] = store
    app.extensions["bluff_lighting_runtime"] = runtime
    app.extensions["bluff_control_state"] = shared_state

    @app.after_request
    def apply_response_headers(response: Response) -> Response:
        response.headers["X-Content-Type-Options"] = "nosniff"
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store, max-age=0"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response

    @app.errorhandler(BadRequest)
    def handle_bad_request(error: BadRequest):
        return _error_response(error.description or "Invalid request.", 400)

    @app.get("/")
    def index():
        return send_from_directory(PROJECT_ROOT, "index.html", conditional=True)

    @app.get("/app.js")
    def app_javascript():
        return send_from_directory(PROJECT_ROOT, "app.js", conditional=True)

    @app.get("/lighting-control.js")
    def lighting_javascript():
        return send_from_directory(PROJECT_ROOT, "lighting-control.js", conditional=True)

    @app.get("/styles.css")
    def styles():
        return send_from_directory(PROJECT_ROOT, "styles.css", conditional=True)

    @app.get("/service-worker.js")
    def service_worker():
        response = send_from_directory(PROJECT_ROOT, "service-worker.js", conditional=True)
        response.headers["Service-Worker-Allowed"] = "/"
        return response

    @app.get("/sounds/<path:filename>")
    def sounds(filename: str):
        return send_from_directory(SOUNDS_ROOT, filename, conditional=True)

    @app.get("/api/health")
    def health():
        return jsonify({
            "status": "ok",
            "service": "project-bluff",
            "lightingAvailable": True,
            "lightingModes": ["artnet", "osc"],
        })

    @app.get("/api/lighting/definitions")
    def get_lighting_definitions():
        return jsonify({
            "fixtures": public_fixture_definitions(),
            "triggers": [
                {"id": trigger, "label": TRIGGER_LABELS[trigger]}
                for trigger in TRIGGER_KEYS
            ],
            "oscTriggers": [
                {"id": trigger, "label": TRIGGER_LABELS[trigger]}
                for trigger in OSC_TRIGGER_KEYS
            ],
        })

    @app.get("/api/lighting/config")
    def get_lighting_config():
        return jsonify(store.load())

    @app.put("/api/lighting/config")
    def put_lighting_config():
        try:
            normalized = normalize_config(_json_body())
            if runtime.is_armed() and _output_patch(normalized) != _output_patch(store.load()):
                return _error_response(
                    "While armed, only cue values, timing, and OSC messages can change. "
                    "Disarm lighting before changing the engine, patch, or output destination.",
                    409,
                )
            saved = store.save(normalized)
            if runtime.is_armed():
                runtime.update_config(saved)
        except LightingConfigValidationError as error:
            return _error_response("Lighting configuration is invalid.", 400, error.field_errors)
        except LightingRuntimeError as error:
            return _error_response(str(error), 409)
        except OSError:
            return _error_response("Lighting configuration could not be saved.", 500)
        return jsonify({"config": saved, "status": "saved"})

    @app.get("/api/lighting/status")
    def get_lighting_status():
        return jsonify(runtime.status())

    @app.post("/api/lighting/arm")
    def set_lighting_armed():
        payload = _json_body()
        if set(payload) != {"armed"} or not isinstance(payload.get("armed"), bool):
            return _error_response("Provide armed as true or false and no additional fields.", 400)
        try:
            status = runtime.arm() if payload["armed"] else runtime.disarm(blackout=True)
        except LightingRuntimeError as error:
            return _error_response(str(error), 400)
        except OSError as error:
            return _error_response(f"Lighting output could not start: {error}", 502)
        return jsonify({"status": status})

    @app.get("/api/control/state")
    def get_control_state():
        return jsonify(shared_state.snapshot())

    @app.get("/api/control/events")
    def stream_control_events():
        last_event_id = request.headers.get("Last-Event-ID")
        current_session_id = shared_state.snapshot()["sessionId"]
        raw_revision = request.args.get("afterRevision", "-1")
        if last_event_id is not None:
            event_session_id, separator, event_revision = last_event_id.rpartition(":")
            if separator and event_session_id != current_session_id:
                raw_revision = "-1"
            else:
                raw_revision = event_revision if separator else last_event_id
        try:
            after_revision = int(raw_revision)
        except (TypeError, ValueError):
            return _error_response("afterRevision must be an integer.", 400)
        if after_revision < -1:
            return _error_response("afterRevision must be -1 or greater.", 400)

        @stream_with_context
        def event_stream():
            revision = after_revision
            while True:
                state = shared_state.wait_for_revision(revision)
                if state["revision"] <= revision:
                    yield ": keepalive\n\n"
                    continue
                revision = state["revision"]
                payload = json.dumps(state, separators=(",", ":"))
                event_id = f"{state['sessionId']}:{revision}"
                yield f"id: {event_id}\nevent: control\ndata: {payload}\n\n"

        return Response(
            event_stream(),
            mimetype="text/event-stream",
            headers={"X-Accel-Buffering": "no"},
        )

    @app.post("/api/control/trigger")
    def trigger_control():
        trigger, auxiliary_triggers, loop_offset = _read_control_payload()
        with control_dispatch_lock:
            try:
                shared_state.apply(trigger, auxiliary_triggers, loop_offset)
            except ControlTransitionError as error:
                return _error_response(str(error), 409)
            try:
                lighting = runtime.trigger(trigger, auxiliary_triggers)
            except LightingRuntimeError as error:
                lighting = {"status": "error", "message": str(error), "runtime": runtime.status()}
            state = shared_state.snapshot()
        return jsonify({"trigger": trigger, "state": state, "lighting": lighting})

    @app.post("/api/lighting/preview")
    def preview_lighting():
        trigger = _read_preview_payload()
        try:
            lighting = runtime.preview(trigger)
        except LightingRuntimeError as error:
            return _error_response(str(error), 400)
        return jsonify({"trigger": trigger, "lighting": lighting})

    return app


def _display_urls(host: str, port: int) -> list[str]:
    urls = [f"http://127.0.0.1:{port}"]
    if host not in {"0.0.0.0", "::"}:
        return [f"http://{host}:{port}"]
    addresses: set[str] = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            address = info[4][0]
            if not address.startswith("127."):
                addresses.add(address)
    except OSError:
        pass
    urls.extend(f"http://{address}:{port}" for address in sorted(addresses))
    return urls


def main() -> None:
    from waitress import serve

    host = os.environ.get("BLUFF_HOST", "0.0.0.0")
    try:
        port = int(os.environ.get("BLUFF_PORT", "5050"))
    except ValueError as error:
        raise SystemExit("BLUFF_PORT must be an integer from 1 through 65535.") from error
    if not 1 <= port <= 65535:
        raise SystemExit("BLUFF_PORT must be an integer from 1 through 65535.")

    app = create_app()
    print("Project Bluff is ready:", flush=True)
    for url in _display_urls(host, port):
        print(f"  {url}", flush=True)
    print("Lighting starts disarmed. Press Control-C to stop Project Bluff.", flush=True)
    try:
        serve(app, host=host, port=port, threads=8)
    finally:
        app.extensions["bluff_lighting_runtime"].close()


if __name__ == "__main__":
    main()
