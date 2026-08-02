"""Validated, atomic persistence for Project Bluff lighting configuration."""

from __future__ import annotations

import copy
import ipaddress
import json
import os
import re
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fixture_definitions import (
    DEFAULT_FADE_PARAMETERS,
    FIXTURE_DEFINITIONS,
    PARAMETER_KEYS,
)


CONFIG_VERSION = 2
TRIGGER_KEYS = ("setup", "day", "nominations", "night", "stopAll")
TRIGGER_LABELS = {
    "setup": "SETUP",
    "day": "DAY",
    "nominations": "NOMINATIONS",
    "night": "NIGHT",
    "stopAll": "STOP ALL",
}
MAX_FIXTURES = 64
MAX_FIXTURE_NAME_LENGTH = 64
MAX_FIXTURE_ID_LENGTH = 64
MAX_FADE_MS = 600_000
MAX_ARTNET_PORT_ADDRESS = 0x7FFF
DEFAULT_FADE_MS = 3_000

_FIXTURE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_HOST_LABEL = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")


class LightingConfigValidationError(ValueError):
    """Raised when a complete lighting configuration transaction is invalid."""

    def __init__(self, field_errors: dict[str, str]):
        super().__init__("Lighting configuration is invalid.")
        self.field_errors = field_errors


def default_parameter_values() -> dict[str, int]:
    return {parameter: 0 for parameter in PARAMETER_KEYS}


def default_fixture_cue_state() -> dict[str, Any]:
    return {
        "values": {},
        "fade": [],
    }


def _upgrade_legacy_config(payload: dict[str, Any]) -> dict[str, Any]:
    """Upgrade the complete-fixture version 1 cue model to sparse overrides."""

    if payload.get("version") != 1 or isinstance(payload.get("version"), bool):
        return payload
    upgraded = copy.deepcopy(payload)
    upgraded["version"] = CONFIG_VERSION
    cues = upgraded.get("cues")
    if isinstance(cues, dict):
        for cue in cues.values():
            if isinstance(cue, dict) and "profiles" not in cue:
                cue["profiles"] = {
                    profile_type: default_fixture_cue_state()
                    for profile_type in FIXTURE_DEFINITIONS
                }
    return upgraded


def default_config() -> dict[str, Any]:
    return {
        "version": CONFIG_VERSION,
        "artnet": {
            "targetHost": "255.255.255.255",
            "interfaceAddress": "",
            "portAddressBase": 0,
            "refreshHz": 30.0,
        },
        "fixtures": [],
        "cues": {
            trigger: {
                "fadeMs": DEFAULT_FADE_MS,
                "profiles": {
                    profile_type: default_fixture_cue_state()
                    for profile_type in FIXTURE_DEFINITIONS
                },
                "fixtures": {},
            }
            for trigger in TRIGGER_KEYS
        },
    }


def _validate_host(value: Any, *, optional: bool = False) -> str:
    if not isinstance(value, str):
        raise ValueError("Enter an IPv4 address or host name.")
    host = value.strip()
    if optional and not host:
        return ""
    if not host or host != value or len(host) > 253:
        raise ValueError("Enter an IPv4 address or host name.")
    if any(character.isspace() for character in host):
        raise ValueError("Host cannot contain whitespace.")
    if "://" in host or any(character in host for character in "/?#@"):
        raise ValueError("Enter only an address or host name, without a scheme or path.")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        hostname = host[:-1] if host.endswith(".") else host
        if not hostname or any(not _HOST_LABEL.fullmatch(label) for label in hostname.split(".")):
            raise ValueError("Enter a valid IPv4 address or host name.") from None
        return host
    if address.version != 4:
        raise ValueError("Art-Net output requires an IPv4 address.")
    return str(address)


def _validate_artnet(payload: Any, errors: dict[str, str]) -> dict[str, Any]:
    payload = payload if isinstance(payload, dict) else {}
    expected = {"targetHost", "interfaceAddress", "portAddressBase", "refreshHz"}
    if not isinstance(payload, dict) or set(payload) != expected:
        errors["artnet"] = "Art-Net settings must contain only the supported fields."

    try:
        target_host = _validate_host(payload.get("targetHost"))
    except ValueError as error:
        target_host = "255.255.255.255"
        errors["artnet.targetHost"] = str(error)

    try:
        interface_address = _validate_host(payload.get("interfaceAddress"), optional=True)
        if interface_address and not ipaddress.ip_address(interface_address).is_private:
            raise ValueError("Choose a private-network IPv4 interface address.")
    except ValueError as error:
        interface_address = ""
        errors["artnet.interfaceAddress"] = str(error)

    port_address_base = payload.get("portAddressBase")
    if (
        isinstance(port_address_base, bool)
        or not isinstance(port_address_base, int)
        or not 0 <= port_address_base <= MAX_ARTNET_PORT_ADDRESS
    ):
        errors["artnet.portAddressBase"] = "Port-address base must be an integer from 0 through 32767."
        port_address_base = 0

    refresh_hz = payload.get("refreshHz")
    if (
        isinstance(refresh_hz, bool)
        or not isinstance(refresh_hz, (int, float))
        or not 1 <= float(refresh_hz) <= 60
    ):
        errors["artnet.refreshHz"] = "Refresh rate must be from 1 through 60 Hz."
        refresh_hz = 30.0

    return {
        "targetHost": target_host,
        "interfaceAddress": interface_address,
        "portAddressBase": port_address_base,
        "refreshHz": float(refresh_hz),
    }


def _validate_fixtures(
    payload: Any,
    artnet: dict[str, Any],
    errors: dict[str, str],
) -> list[dict[str, Any]]:
    if not isinstance(payload, list):
        errors["fixtures"] = "Fixtures must be a list."
        return []
    if len(payload) > MAX_FIXTURES:
        errors["fixtures"] = f"Project Bluff supports at most {MAX_FIXTURES} fixtures."

    fixtures = []
    seen_ids: set[str] = set()
    seen_names: set[str] = set()
    patch_slots: dict[int, dict[int, str]] = {}
    for index, raw_fixture in enumerate(payload[:MAX_FIXTURES]):
        field = f"fixtures.{index}"
        if not isinstance(raw_fixture, dict):
            errors[field] = "Fixture must be an object."
            continue
        expected = {"id", "name", "type", "universe", "address"}
        if set(raw_fixture) != expected:
            errors[field] = "Fixture contains unsupported or missing fields."

        fixture_id = raw_fixture.get("id")
        if not isinstance(fixture_id, str) or not _FIXTURE_ID.fullmatch(fixture_id):
            errors[f"{field}.id"] = "Fixture ID must use letters, numbers, _ or - and be at most 64 characters."
            continue
        if fixture_id in seen_ids:
            errors[f"{field}.id"] = "Fixture IDs must be unique."
            continue
        seen_ids.add(fixture_id)

        name = raw_fixture.get("name")
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > MAX_FIXTURE_NAME_LENGTH:
            errors[f"fixtures.{fixture_id}.name"] = "Enter a fixture name from 1 through 64 characters."
            name = f"Light {index + 1}"
        else:
            name = name.strip()
            name_key = name.casefold()
            if name_key in seen_names:
                errors[f"fixtures.{fixture_id}.name"] = "Fixture names must be unique."
            seen_names.add(name_key)

        fixture_type = raw_fixture.get("type")
        definition = FIXTURE_DEFINITIONS.get(fixture_type)
        if definition is None:
            errors[f"fixtures.{fixture_id}.type"] = "Choose one of the two supported PAR types."
            fixture_type = next(iter(FIXTURE_DEFINITIONS))
            definition = FIXTURE_DEFINITIONS[fixture_type]

        universe = raw_fixture.get("universe")
        maximum_universe = MAX_ARTNET_PORT_ADDRESS - artnet["portAddressBase"] + 1
        if (
            isinstance(universe, bool)
            or not isinstance(universe, int)
            or not 1 <= universe <= maximum_universe
        ):
            errors[f"fixtures.{fixture_id}.universe"] = (
                f"Universe must be an integer from 1 through {maximum_universe}."
            )
            universe = 1

        address = raw_fixture.get("address")
        last_valid_address = 513 - definition["footprint"]
        if (
            isinstance(address, bool)
            or not isinstance(address, int)
            or not 1 <= address <= last_valid_address
        ):
            errors[f"fixtures.{fixture_id}.address"] = (
                f"A {definition['footprint']}-channel fixture must start from address 1 through {last_valid_address}."
            )
            address = 1

        universe_slots = patch_slots.setdefault(universe, {})
        conflicts = {
            universe_slots[slot]
            for slot in range(address, address + definition["footprint"])
            if slot in universe_slots
        }
        if conflicts:
            errors[f"fixtures.{fixture_id}.address"] = (
                f"DMX patch overlaps fixture {sorted(conflicts)[0]}."
            )
        else:
            for slot in range(address, address + definition["footprint"]):
                universe_slots[slot] = fixture_id

        fixtures.append({
            "id": fixture_id,
            "name": name,
            "type": fixture_type,
            "universe": universe,
            "address": address,
        })
    return fixtures


def _validate_program_state(
    raw_state: Any,
    state_field: str,
    errors: dict[str, str],
) -> dict[str, Any]:
    if not isinstance(raw_state, dict):
        errors[state_field] = "Cue programming must be an object."
        raw_state = {}
    if set(raw_state) != {"values", "fade"}:
        errors[state_field] = "Cue programming must contain only values and fade."

    raw_values = raw_state.get("values")
    if not isinstance(raw_values, dict):
        errors[f"{state_field}.values"] = "Parameter values must be an object."
        raw_values = {}
    unsupported_values = set(raw_values) - set(PARAMETER_KEYS)
    if unsupported_values:
        errors[f"{state_field}.values"] = "Parameter values contain unsupported fields."
    values = {}
    for parameter in PARAMETER_KEYS:
        if parameter not in raw_values:
            continue
        value = raw_values[parameter]
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 255:
            errors[f"{state_field}.values.{parameter}"] = (
                "DMX value must be an integer from 0 through 255."
            )
            value = 0
        values[parameter] = value

    raw_fade = raw_state.get("fade")
    if not isinstance(raw_fade, list):
        errors[f"{state_field}.fade"] = "Fade parameters must be a list."
        raw_fade = []
    invalid_fade = [
        parameter
        for parameter in raw_fade
        if (
            parameter not in PARAMETER_KEYS
            or parameter == "autoProgram"
            or parameter not in raw_values
        )
    ]
    if invalid_fade or len(set(raw_fade)) != len(raw_fade):
        errors[f"{state_field}.fade"] = (
            "Fade parameters must be unique, explicitly programmed, and Auto Program must snap."
        )
    fade = [
        parameter
        for parameter in PARAMETER_KEYS
        if parameter in raw_fade and parameter in values and parameter != "autoProgram"
    ]
    return {"values": values, "fade": fade}


def _validate_cues(
    payload: Any,
    fixtures: list[dict[str, Any]],
    errors: dict[str, str],
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        errors["cues"] = "Cues must be an object."
        payload = {}
    if set(payload) != set(TRIGGER_KEYS):
        errors["cues"] = "Cues must contain exactly Setup, Day, Nominations, Night, and Stop All."

    fixture_ids = [fixture["id"] for fixture in fixtures]
    normalized_cues = {}
    for trigger in TRIGGER_KEYS:
        cue_field = f"cues.{trigger}"
        raw_cue = payload.get(trigger)
        if not isinstance(raw_cue, dict):
            errors[cue_field] = "Cue must be an object."
            raw_cue = {}
        if set(raw_cue) != {"fadeMs", "profiles", "fixtures"}:
            errors[cue_field] = "Cue must contain only fadeMs, profiles, and fixtures."

        fade_ms = raw_cue.get("fadeMs")
        if (
            isinstance(fade_ms, bool)
            or not isinstance(fade_ms, int)
            or not 0 <= fade_ms <= MAX_FADE_MS
        ):
            errors[f"{cue_field}.fadeMs"] = "Fade time must be from 0 through 600000 milliseconds."
            fade_ms = DEFAULT_FADE_MS

        raw_profiles = raw_cue.get("profiles")
        if not isinstance(raw_profiles, dict):
            errors[f"{cue_field}.profiles"] = "Cue profile values must be an object."
            raw_profiles = {}
        if set(raw_profiles) != set(FIXTURE_DEFINITIONS):
            errors[f"{cue_field}.profiles"] = (
                "Every cue must contain both supported fixture profiles exactly once."
            )
        profiles = {
            profile_type: _validate_program_state(
                raw_profiles.get(profile_type),
                f"{cue_field}.profiles.{profile_type}",
                errors,
            )
            for profile_type in FIXTURE_DEFINITIONS
        }

        raw_states = raw_cue.get("fixtures")
        if not isinstance(raw_states, dict):
            errors[f"{cue_field}.fixtures"] = "Cue fixture values must be an object."
            raw_states = {}
        if set(raw_states) != set(fixture_ids):
            errors[f"{cue_field}.fixtures"] = "Every cue must contain every configured fixture exactly once."

        states = {}
        for fixture_id in fixture_ids:
            state_field = f"{cue_field}.fixtures.{fixture_id}"
            states[fixture_id] = _validate_program_state(
                raw_states.get(fixture_id),
                state_field,
                errors,
            )

        normalized_cues[trigger] = {
            "fadeMs": fade_ms,
            "profiles": profiles,
            "fixtures": states,
        }
    return normalized_cues


def normalize_config(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise LightingConfigValidationError({"config": "Lighting configuration must be a JSON object."})

    payload = _upgrade_legacy_config(payload)
    errors: dict[str, str] = {}
    if set(payload) != {"version", "artnet", "fixtures", "cues"}:
        errors["config"] = "Configuration contains unsupported or missing fields."
    if payload.get("version") != CONFIG_VERSION or isinstance(payload.get("version"), bool):
        errors["version"] = f"Configuration version must be {CONFIG_VERSION}."

    artnet = _validate_artnet(payload.get("artnet"), errors)
    fixtures = _validate_fixtures(payload.get("fixtures"), artnet, errors)
    cues = _validate_cues(payload.get("cues"), fixtures, errors)
    if errors:
        raise LightingConfigValidationError(errors)
    return {
        "version": CONFIG_VERSION,
        "artnet": artnet,
        "fixtures": fixtures,
        "cues": cues,
    }


class LightingConfigStore:
    def __init__(self, path: str | os.PathLike[str]):
        self.path = Path(path)
        self._lock = threading.RLock()

    def load(self) -> dict[str, Any]:
        with self._lock:
            if not self.path.exists():
                return default_config()
            try:
                with self.path.open("r", encoding="utf-8") as config_file:
                    return normalize_config(json.load(config_file))
            except OSError:
                return default_config()
            except (json.JSONDecodeError, LightingConfigValidationError, UnicodeError):
                self._retain_invalid_file()
                return default_config()

    def save(self, payload: Any) -> dict[str, Any]:
        normalized = normalize_config(payload)
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary_path: Path | None = None
            try:
                descriptor, temporary_name = tempfile.mkstemp(
                    prefix=f".{self.path.name}.",
                    suffix=".tmp",
                    dir=self.path.parent,
                )
                temporary_path = Path(temporary_name)
                with os.fdopen(descriptor, "w", encoding="utf-8") as config_file:
                    json.dump(normalized, config_file, indent=2)
                    config_file.write("\n")
                    config_file.flush()
                    os.fsync(config_file.fileno())
                os.chmod(temporary_path, 0o600)
                os.replace(temporary_path, self.path)
            except Exception:
                if temporary_path is not None:
                    temporary_path.unlink(missing_ok=True)
                raise
        return copy.deepcopy(normalized)

    def _retain_invalid_file(self) -> None:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        backup = self.path.with_name(f"{self.path.name}.invalid-{timestamp}")
        try:
            os.replace(self.path, backup)
        except OSError:
            pass
