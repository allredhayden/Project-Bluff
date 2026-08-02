"""The two fixed fixture profiles supported by Project Bluff.

The parameter list is intentionally ordered for a compact semantic editor. The
explicit ``channel`` field is the physical one-based DMX offset used when
rendering Art-Net frames. Both supported 10-channel modes use the color emitters
before the special-function channels.
"""

from __future__ import annotations

from typing import Any


PARAMETER_KEYS = (
    "dimmer",
    "red",
    "green",
    "blue",
    "white",
    "amber",
    "uv",
    "strobe",
    "autoProgram",
    "autoSpeed",
)

DEFAULT_FADE_PARAMETERS = (
    "dimmer",
    "red",
    "green",
    "blue",
    "white",
    "amber",
    "uv",
)


def _parameter(
    key: str,
    label: str,
    channel: int,
    *,
    fade_allowed: bool = True,
    kind: str = "continuous",
) -> dict[str, Any]:
    return {
        "key": key,
        "label": label,
        "channel": channel,
        "homeValue": 0,
        "fadeAllowed": fade_allowed,
        "kind": kind,
    }


FIXTURE_DEFINITIONS: dict[str, dict[str, Any]] = {
    "shehds-par-7x18-rgbwauv-10ch": {
        "id": "shehds-par-7x18-rgbwauv-10ch",
        "name": "SHEHDS Mini PAR 7x18W RGBWA+UV (10CH)",
        "shortName": "7x18 PAR",
        "footprint": 10,
        "parameters": [
            _parameter("dimmer", "Dimmer", 1),
            _parameter("red", "Red", 2),
            _parameter("green", "Green", 3),
            _parameter("blue", "Blue", 4),
            _parameter("white", "White", 5),
            _parameter("amber", "Amber", 6),
            _parameter("uv", "UV", 7),
            _parameter("strobe", "Strobe", 8),
            _parameter(
                "autoProgram",
                "Auto Program",
                9,
                fade_allowed=False,
                kind="indexed",
            ),
            _parameter("autoSpeed", "Auto Speed", 10),
        ],
    },
    "shehds-par-18x18-rgbwauv-10ch": {
        "id": "shehds-par-18x18-rgbwauv-10ch",
        "name": "SHEHDS PAR 18x18W RGBWA+UV (10CH)",
        "shortName": "18x18 PAR",
        "footprint": 10,
        "parameters": [
            _parameter("dimmer", "Dimmer", 1),
            _parameter("red", "Red", 2),
            _parameter("green", "Green", 3),
            _parameter("blue", "Blue", 4),
            _parameter("white", "White", 5),
            _parameter("amber", "Amber", 6),
            _parameter("uv", "UV", 7),
            _parameter("strobe", "Strobe", 8),
            _parameter(
                "autoProgram",
                "Auto Program",
                9,
                fade_allowed=False,
                kind="indexed",
            ),
            _parameter("autoSpeed", "Auto Speed", 10),
        ],
    },
}


def public_fixture_definitions() -> list[dict[str, Any]]:
    """Return the small immutable catalog in API-friendly form."""

    return [
        {
            "id": definition["id"],
            "name": definition["name"],
            "shortName": definition["shortName"],
            "footprint": definition["footprint"],
            "parameters": [dict(parameter) for parameter in definition["parameters"]],
        }
        for definition in FIXTURE_DEFINITIONS.values()
    ]
