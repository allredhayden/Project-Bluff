"""Mutually exclusive Art-Net/OSC output routing for Project Bluff."""

from __future__ import annotations

import threading
from typing import Any, Callable

from artnet_output import LightingRuntime, LightingRuntimeError
from lighting_config import OSC_TRIGGER_KEYS, TRIGGER_KEYS
from osc_sender import OscSender


class LightingOutputController:
    """Apply one shared arm gate to the selected lighting engine."""

    def __init__(
        self,
        config_provider: Callable[[], dict[str, Any]],
        *,
        artnet_runtime: LightingRuntime | Any | None = None,
        osc_sender: OscSender | Any | None = None,
    ) -> None:
        self._config_provider = config_provider
        self._artnet_runtime = artnet_runtime or LightingRuntime(config_provider)
        self._osc_sender = osc_sender or OscSender()
        self._lock = threading.RLock()
        self._armed = False
        self._armed_mode: str | None = None
        self._active_trigger: str | None = None
        self._last_error = ""
        self._revision = 0

    def is_armed(self) -> bool:
        with self._lock:
            return self._armed

    def arm(self) -> dict[str, Any]:
        with self._lock:
            if self._armed:
                return self.status()
        config = self._config_provider()
        mode = config["outputMode"]
        if mode == "artnet":
            self._artnet_runtime.arm()
        else:
            if not any(config["osc"]["messages"].values()):
                raise LightingRuntimeError("Map at least one OSC event before arming lighting.")
        with self._lock:
            self._armed = True
            self._armed_mode = mode
            self._active_trigger = None
            self._last_error = ""
            self._revision += 1
        return self.status()

    def disarm(self, *, blackout: bool = True) -> dict[str, Any]:
        with self._lock:
            if not self._armed:
                return self.status()
            mode = self._armed_mode
        if mode == "artnet":
            self._artnet_runtime.disarm(blackout=blackout)
        with self._lock:
            self._armed = False
            self._armed_mode = None
            self._active_trigger = None
            self._last_error = ""
            self._revision += 1
        return self.status()

    def update_config(self, config: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            armed = self._armed
            mode = self._armed_mode
        if armed and mode == "artnet":
            self._artnet_runtime.update_config(config)
        with self._lock:
            self._revision += 1
        return self.status()

    def trigger(
        self,
        trigger: str,
        auxiliary_triggers: tuple[str, ...] | list[str] = (),
    ) -> dict[str, Any]:
        if trigger not in TRIGGER_KEYS:
            raise LightingRuntimeError("Unknown lighting trigger.")
        with self._lock:
            if not self._armed:
                return {
                    "status": "skipped",
                    "message": "Lighting is not armed.",
                    "events": [],
                    "runtime": self.status(),
                }
            mode = self._armed_mode
        if mode == "artnet":
            result = self._artnet_runtime.trigger(trigger)
            result["events"] = [{"trigger": trigger, "status": result["status"]}]
            result["runtime"] = self.status()
            return result
        return self._send_osc_events(trigger, auxiliary_triggers)

    def preview(self, trigger: str) -> dict[str, Any]:
        if trigger not in OSC_TRIGGER_KEYS:
            raise LightingRuntimeError("Unknown lighting trigger.")
        with self._lock:
            if not self._armed:
                return {
                    "status": "skipped",
                    "message": "Lighting is not armed.",
                    "events": [],
                    "runtime": self.status(),
                }
            mode = self._armed_mode
        if mode == "artnet":
            if trigger not in TRIGGER_KEYS:
                raise LightingRuntimeError("Art-Net has no look for that auxiliary event.")
            result = self._artnet_runtime.trigger(trigger)
            result["events"] = [{"trigger": trigger, "status": result["status"]}]
            result["runtime"] = self.status()
            return result
        return self._send_osc_events(trigger, ())

    def _send_osc_events(
        self,
        trigger: str,
        auxiliary_triggers: tuple[str, ...] | list[str],
    ) -> dict[str, Any]:
        config = self._config_provider()["osc"]
        results = []
        for event in (trigger, *auxiliary_triggers):
            message = config["messages"][event]
            if not message:
                result = {"status": "skipped", "message": "No OSC message is mapped."}
            else:
                result = self._osc_sender.send(config["targetHost"], config["targetPort"], message)
            results.append({"trigger": event, **result})
        statuses = {result["status"] for result in results}
        overall = "error" if "error" in statuses else ("sent" if "sent" in statuses else "skipped")
        errors = [result["message"] for result in results if result["status"] == "error"]
        with self._lock:
            self._active_trigger = trigger
            self._last_error = errors[-1] if errors else ""
            self._revision += 1
        return {
            "status": overall,
            "message": "OSC events processed.",
            "events": results,
            "runtime": self.status(),
        }

    def status(self) -> dict[str, Any]:
        config = self._config_provider()
        with self._lock:
            armed = self._armed
            armed_mode = self._armed_mode
            active_trigger = self._active_trigger
            controller_error = self._last_error
            revision = self._revision
        mode = armed_mode if armed_mode is not None else config["outputMode"]
        if mode == "artnet":
            artnet_status = self._artnet_runtime.status()
            return {
                **artnet_status,
                "armed": armed,
                "outputMode": "artnet",
                "revision": revision + int(artnet_status.get("revision", 0)),
            }
        osc_status = self._osc_sender.status()
        last_attempt = osc_status["lastAttempt"]
        last_error = controller_error
        return {
            "armed": armed,
            "outputMode": "osc",
            "senderState": "ready" if armed else "disarmed",
            "activeTrigger": active_trigger,
            "transitioning": False,
            "transitionProgress": None,
            "revision": revision,
            "lastSentAt": (
                last_attempt.get("attemptedAt")
                if last_attempt and last_attempt.get("status") == "sent"
                else None
            ),
            "packetsSent": osc_status["packetsSent"],
            "lastError": last_error,
            "lastAttempt": last_attempt,
            "delivery": osc_status["delivery"],
        }

    def close(self) -> None:
        self.disarm(blackout=True)
        self._artnet_runtime.close()
