"""Small Art-Net output and single-look fade runtime for Project Bluff."""

from __future__ import annotations

import copy
import socket
import struct
import threading
from datetime import datetime, timezone
from time import monotonic
from typing import Any, Callable

from fixture_definitions import DEFAULT_FADE_PARAMETERS, FIXTURE_DEFINITIONS, PARAMETER_KEYS


ARTNET_PORT = 6454
ARTNET_OPCODE_DMX = 0x5000
ARTNET_PROTOCOL_VERSION = 14
DMX_SLOT_COUNT = 512


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def build_artnet_packet(port_address: int, slots: list[int] | tuple[int, ...], *, sequence: int = 1) -> bytes:
    """Build one complete ArtDMX packet containing exactly 512 slots."""

    if not 0 <= int(port_address) <= 0x7FFF:
        raise ValueError("Art-Net port address must be from 0 through 32767.")
    if len(slots) != DMX_SLOT_COUNT:
        raise ValueError("ArtDMX output requires exactly 512 DMX slots.")
    slot_bytes = bytes(max(0, min(255, int(value))) for value in slots)
    normalized_sequence = int(sequence) % 256
    if normalized_sequence == 0:
        normalized_sequence = 1
    return b"".join([
        b"Art-Net\x00",
        struct.pack("<H", ARTNET_OPCODE_DMX),
        struct.pack(">H", ARTNET_PROTOCOL_VERSION),
        bytes((normalized_sequence, 0)),
        struct.pack("<H", int(port_address)),
        struct.pack(">H", DMX_SLOT_COUNT),
        slot_bytes,
    ])


def zero_fixture_state(config: dict[str, Any]) -> dict[str, dict[str, float]]:
    return {
        fixture["id"]: {parameter: 0.0 for parameter in PARAMETER_KEYS}
        for fixture in config["fixtures"]
    }


def resolve_cue_fixture_states(
    config: dict[str, Any],
    cue: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    """Resolve profile baselines and fixture overrides to complete output states."""

    resolved: dict[str, dict[str, Any]] = {}
    default_fade = set(DEFAULT_FADE_PARAMETERS)
    for fixture in config["fixtures"]:
        fixture_state = cue["fixtures"][fixture["id"]]
        profile_state = cue["profiles"][fixture["type"]]
        values: dict[str, int] = {}
        fade: list[str] = []
        for parameter in PARAMETER_KEYS:
            if parameter in fixture_state["values"]:
                values[parameter] = fixture_state["values"][parameter]
                should_fade = parameter in fixture_state["fade"]
            elif parameter in profile_state["values"]:
                values[parameter] = profile_state["values"][parameter]
                should_fade = parameter in profile_state["fade"]
            else:
                values[parameter] = 0
                should_fade = parameter in default_fade
            if should_fade:
                fade.append(parameter)
        resolved[fixture["id"]] = {"values": values, "fade": fade}
    return resolved


def build_dmx_frames(
    config: dict[str, Any],
    fixture_values: dict[str, dict[str, float]],
) -> dict[int, list[int]]:
    """Compile semantic parameter values to show-universe DMX frames."""

    frames: dict[int, list[int]] = {}
    for fixture in config["fixtures"]:
        definition = FIXTURE_DEFINITIONS[fixture["type"]]
        slots = frames.setdefault(fixture["universe"], [0] * DMX_SLOT_COUNT)
        values = fixture_values.get(fixture["id"], {})
        for parameter in definition["parameters"]:
            slot_index = fixture["address"] + parameter["channel"] - 2
            slots[slot_index] = max(0, min(255, round(float(values.get(parameter["key"], 0)))))
    return frames


class ArtNetSender:
    """One UDP sender for the configured Art-Net destination."""

    def __init__(
        self,
        config: dict[str, Any],
        *,
        socket_factory: Callable[..., socket.socket] = socket.socket,
        port: int = ARTNET_PORT,
    ) -> None:
        self._config = copy.deepcopy(config)
        self._port = port
        self._sequence = 0
        self._lock = threading.Lock()
        self._socket = socket_factory(socket.AF_INET, socket.SOCK_DGRAM)
        self._socket.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        if self._config.get("interfaceAddress"):
            self._socket.bind((self._config["interfaceAddress"], 0))

    def send_frames(self, frames: dict[int, list[int]]) -> int:
        sent = 0
        with self._lock:
            self._sequence = (self._sequence + 1) % 256
            if self._sequence == 0:
                self._sequence = 1
            for show_universe in sorted(frames):
                port_address = self._config["portAddressBase"] + show_universe - 1
                packet = build_artnet_packet(port_address, frames[show_universe], sequence=self._sequence)
                transmitted = self._socket.sendto(
                    packet,
                    (self._config["targetHost"], self._port),
                )
                if transmitted != len(packet):
                    raise OSError("The complete ArtDMX packet was not sent.")
                sent += 1
        return sent

    def close(self) -> None:
        with self._lock:
            self._socket.close()


class LightingRuntimeError(RuntimeError):
    pass


class LightingRuntime:
    """Thread-safe complete-look runtime with one linear transition at a time."""

    def __init__(
        self,
        config_provider: Callable[[], dict[str, Any]],
        *,
        sender_factory: Callable[[dict[str, Any]], Any] = ArtNetSender,
        clock: Callable[[], float] = monotonic,
        start_thread: bool = True,
    ) -> None:
        self._config_provider = config_provider
        self._sender_factory = sender_factory
        self._clock = clock
        self._lock = threading.RLock()
        self._wake_event = threading.Event()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._armed = False
        self._config: dict[str, Any] | None = None
        self._sender: Any = None
        self._current_values: dict[str, dict[str, float]] = {}
        self._transition: dict[str, Any] | None = None
        self._active_trigger: str | None = None
        self._revision = 0
        self._last_sent_at: str | None = None
        self._last_error = ""
        self._packets_sent = 0
        if start_thread:
            self._thread = threading.Thread(
                target=self._run,
                name="project-bluff-artnet",
                daemon=True,
            )
            self._thread.start()

    def is_armed(self) -> bool:
        with self._lock:
            return self._armed

    def update_config(self, config: dict[str, Any]) -> dict[str, Any]:
        """Load cue-only changes without disturbing an armed Art-Net sender."""

        with self._lock:
            if not self._armed:
                return self._status_locked()
            if self._config is None:
                raise LightingRuntimeError("Lighting is armed without an active configuration.")
            if config["artnet"] != self._config["artnet"] or config["fixtures"] != self._config["fixtures"]:
                raise LightingRuntimeError(
                    "Disarm lighting before changing fixtures or Art-Net output settings."
                )
            self._config = copy.deepcopy(config)
            self._revision += 1
            return self._status_locked()

    def arm(self) -> dict[str, Any]:
        with self._lock:
            if self._armed:
                return self._status_locked()

        config = self._config_provider()
        if not config["fixtures"]:
            raise LightingRuntimeError("Add at least one fixture before arming lighting.")
        sender = self._sender_factory(config["artnet"])
        old_sender = None
        with self._lock:
            if self._armed:
                sender.close()
                return self._status_locked()
            old_sender = self._sender
            self._config = copy.deepcopy(config)
            self._sender = sender
            self._current_values = zero_fixture_state(config)
            self._transition = None
            self._active_trigger = None
            self._armed = True
            self._revision += 1
            self._last_error = ""
        if old_sender is not None:
            old_sender.close()
        self.tick()
        self._wake_event.set()
        return self.status()

    def disarm(self, *, blackout: bool = True) -> dict[str, Any]:
        with self._lock:
            if not self._armed:
                return self._status_locked()
            sender = self._sender
            config = self._config
            blackout_frames = (
                build_dmx_frames(config, zero_fixture_state(config))
                if blackout and config is not None
                else {}
            )
            self._armed = False
            self._sender = None
            self._transition = None
            self._active_trigger = None
            self._current_values = zero_fixture_state(config) if config is not None else {}
            self._revision += 1
            self._last_error = ""
        if sender is not None:
            try:
                if blackout_frames:
                    sender.send_frames(blackout_frames)
            except OSError as error:
                with self._lock:
                    self._last_error = f"Art-Net blackout failed: {error}"
            finally:
                sender.close()
        return self.status()

    def trigger(self, trigger: str) -> dict[str, Any]:
        now = self._clock()
        with self._lock:
            if not self._armed or self._config is None:
                return {
                    "status": "skipped",
                    "message": "Lighting is not armed.",
                    "runtime": self._status_locked(now),
                }
            cue = self._config["cues"].get(trigger)
            if cue is None:
                raise LightingRuntimeError("Unknown lighting trigger.")

            start_values = self._evaluate_locked(now)
            resolved_states = resolve_cue_fixture_states(self._config, cue)
            target_values = {
                fixture_id: {
                    parameter: float(value)
                    for parameter, value in state["values"].items()
                }
                for fixture_id, state in resolved_states.items()
            }
            fade_parameters = {
                fixture_id: set(state["fade"])
                for fixture_id, state in resolved_states.items()
            }
            self._transition = {
                "startedAt": now,
                "duration": cue["fadeMs"] / 1000.0,
                "start": copy.deepcopy(start_values),
                "target": target_values,
                "fade": fade_parameters,
            }
            self._active_trigger = trigger
            self._revision += 1
            self._evaluate_locked(now)
        tick_result = self.tick()
        self._wake_event.set()
        runtime_status = self.status()
        if tick_result and tick_result.get("status") == "error":
            return {**tick_result, "runtime": runtime_status}
        return {
            "status": "started",
            "message": f"{trigger} lighting cue started.",
            "runtime": runtime_status,
        }

    def current_values(self) -> dict[str, dict[str, float]]:
        with self._lock:
            return copy.deepcopy(self._evaluate_locked(self._clock()))

    def tick(self) -> dict[str, Any] | None:
        now = self._clock()
        with self._lock:
            if not self._armed or self._config is None or self._sender is None:
                return None
            values = copy.deepcopy(self._evaluate_locked(now))
            frames = build_dmx_frames(self._config, values)
            sender = self._sender
        try:
            packet_count = sender.send_frames(frames)
        except OSError as error:
            with self._lock:
                self._last_error = f"Art-Net send failed: {error}"
            return {"status": "error", "message": self._last_error}
        with self._lock:
            self._last_sent_at = _utc_now()
            self._last_error = ""
            self._packets_sent += packet_count
        return {"status": "sent", "packetCount": packet_count}

    def status(self) -> dict[str, Any]:
        with self._lock:
            return self._status_locked(self._clock())

    def close(self) -> None:
        self.disarm(blackout=True)
        self._stop_event.set()
        self._wake_event.set()
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(timeout=1.0)

    def _evaluate_locked(self, now: float) -> dict[str, dict[str, float]]:
        transition = self._transition
        if transition is None:
            return self._current_values
        duration = transition["duration"]
        progress = 1.0 if duration <= 0 else max(0.0, min(1.0, (now - transition["startedAt"]) / duration))
        next_values: dict[str, dict[str, float]] = {}
        for fixture_id, target_values in transition["target"].items():
            start_values = transition["start"][fixture_id]
            fade_parameters = transition["fade"][fixture_id]
            next_values[fixture_id] = {}
            for parameter, target in target_values.items():
                if parameter in fade_parameters:
                    start = start_values[parameter]
                    next_values[fixture_id][parameter] = start + ((target - start) * progress)
                else:
                    next_values[fixture_id][parameter] = target
        self._current_values = next_values
        if progress >= 1.0:
            self._transition = None
        return self._current_values

    def _status_locked(self, now: float | None = None) -> dict[str, Any]:
        now = self._clock() if now is None else now
        transition_progress = None
        if self._transition is not None:
            duration = self._transition["duration"]
            transition_progress = (
                1.0
                if duration <= 0
                else max(0.0, min(1.0, (now - self._transition["startedAt"]) / duration))
            )
        return {
            "armed": self._armed,
            "senderState": "error" if self._last_error else ("sending" if self._armed else "disarmed"),
            "activeTrigger": self._active_trigger,
            "transitioning": self._transition is not None,
            "transitionProgress": transition_progress,
            "revision": self._revision,
            "lastSentAt": self._last_sent_at,
            "packetsSent": self._packets_sent,
            "lastError": self._last_error,
        }

    def _run(self) -> None:
        while not self._stop_event.is_set():
            with self._lock:
                armed = self._armed
                refresh_hz = (
                    self._config["artnet"]["refreshHz"]
                    if self._config is not None
                    else 30.0
                )
            if armed:
                self.tick()
                timeout = 1.0 / refresh_hz
            else:
                timeout = 0.25
            self._wake_event.wait(timeout)
            self._wake_event.clear()
