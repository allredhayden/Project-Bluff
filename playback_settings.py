"""Validated, persistent settings shared by Bluff's browser controllers."""

from __future__ import annotations

import copy
import json
import math
import os
import tempfile
from pathlib import Path
from typing import Any


TRACK_VOLUMES = {
    "bells": 1.0,
    "gong": 1.0,
    "setupLoop": 0.67,
    "day": 0.5,
    "maleScream": 0.33,
    "femaleScream": 0.33,
    "nightIntro": 1.0,
    "nightLoop": 1.0,
    "nominations": 1.0,
    "nominationVoting": 1.0,
}


def default_playback_settings() -> dict[str, Any]:
    return {
        "master": 0.8,
        "tracks": dict(TRACK_VOLUMES),
        "showLoopProgress": False,
        "daySounds": {"bells": True, "maleScream": False, "femaleScream": False},
    }


class PlaybackSettingsError(ValueError):
    """A settings patch contains an unknown field or invalid value."""


def patch_playback_settings(settings: dict[str, Any], changes: Any) -> dict[str, Any]:
    if not isinstance(changes, dict) or not changes:
        raise PlaybackSettingsError("changes must be a nonempty settings object.")
    if changes.keys() - settings.keys():
        raise PlaybackSettingsError("changes contains an unsupported setting.")
    result = copy.deepcopy(settings)
    for key, value in changes.items():
        if key in {"tracks", "daySounds"}:
            if not isinstance(value, dict) or not value or value.keys() - settings[key].keys():
                raise PlaybackSettingsError(f"{key} must contain supported setting IDs.")
            for item, setting in value.items():
                _validate_value(setting, f"{key}.{item}", boolean=key == "daySounds")
            result[key].update(value)
        else:
            _validate_value(value, key, boolean=key == "showLoopProgress")
            result[key] = value
    return result


def _validate_value(value: Any, field: str, *, boolean: bool) -> None:
    if boolean:
        if not isinstance(value, bool):
            raise PlaybackSettingsError(f"{field} must be true or false.")
    elif (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or not 0 <= value <= 1
    ):
        raise PlaybackSettingsError(f"{field} must be a finite number from 0 through 1.")


class PlaybackSettingsStore:
    def __init__(self, path: str | os.PathLike[str]):
        self.path = Path(path)

    def load(self) -> tuple[dict[str, Any], bool]:
        if not self.path.exists():
            return default_playback_settings(), False
        with self.path.open(encoding="utf-8") as settings_file:
            payload = json.load(settings_file)
        if not isinstance(payload, dict) or payload.get("version") != 1:
            raise PlaybackSettingsError("Unsupported saved playback settings version.")
        return patch_playback_settings(default_playback_settings(), payload.get("settings")), True

    def save(self, settings: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, name = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=self.path.parent)
        temporary_path = Path(name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as settings_file:
                json.dump({"version": 1, "settings": settings}, settings_file, indent=2)
                settings_file.write("\n")
                settings_file.flush()
                os.fsync(settings_file.fileno())
            os.replace(temporary_path, self.path)
        finally:
            temporary_path.unlink(missing_ok=True)
