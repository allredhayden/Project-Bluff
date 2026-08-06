import json

import pytest

from fixture_definitions import DEFAULT_FADE_PARAMETERS, FIXTURE_DEFINITIONS, PARAMETER_KEYS
from lighting_config import (
    OSC_TRIGGER_KEYS,
    TRIGGER_KEYS,
    LightingConfigStore,
    LightingConfigValidationError,
    default_config,
    default_fixture_cue_state,
    normalize_config,
)


def config_with_fixture(*, fixture_id="light-1", fixture_type="shehds-par-7x18-rgbwauv-10ch", address=1):
    config = default_config()
    config["fixtures"].append({
        "id": fixture_id,
        "name": "Town Square Left",
        "type": fixture_type,
        "universe": 1,
        "address": address,
    })
    for cue in config["cues"].values():
        cue["fixtures"][fixture_id] = default_fixture_cue_state()
    return config


def test_default_is_safe_and_contains_no_fixtures():
    config = default_config()
    assert config["version"] == 5
    assert config["outputMode"] == "artnet"
    assert config["fixtures"] == []
    assert config["artnet"] == {
        "targetHost": "255.255.255.255",
        "interfaceAddress": "",
        "portAddressBase": 0,
        "refreshHz": 30.0,
    }
    assert config["osc"] == {
        "targetHost": "127.0.0.1",
        "targetPort": 53000,
        "messages": {trigger: "" for trigger in OSC_TRIGGER_KEYS},
    }
    assert tuple(config["cues"]) == TRIGGER_KEYS
    assert all(cue["fixtures"] == {} for cue in config["cues"].values())
    assert all(
        tuple(cue["profiles"]) == tuple(FIXTURE_DEFINITIONS)
        and all(state == {"values": {}, "fade": []} for state in cue["profiles"].values())
        for cue in config["cues"].values()
    )


def test_fixture_profiles_preserve_different_physical_channel_orders():
    seven_parameters = FIXTURE_DEFINITIONS["shehds-par-7x18-rgbwauv-10ch"]["parameters"]
    eighteen_parameters = FIXTURE_DEFINITIONS["shehds-par-18x18-rgbwauv-10ch"]["parameters"]
    seven = {parameter["key"]: parameter["channel"] for parameter in seven_parameters}
    eighteen = {parameter["key"]: parameter["channel"] for parameter in eighteen_parameters}
    assert [parameter["key"] for parameter in seven_parameters] == [
        "dimmer", "red", "green", "blue", "white", "amber", "uv",
        "strobe", "autoProgram", "autoSpeed",
    ]
    assert seven == {
        "dimmer": 1, "red": 2, "green": 3, "blue": 4, "white": 5,
        "amber": 6, "uv": 7, "strobe": 8, "autoProgram": 9, "autoSpeed": 10,
    }
    assert eighteen == {
        "dimmer": 1, "red": 2, "green": 3, "blue": 4, "white": 5,
        "amber": 6, "uv": 7, "strobe": 8, "autoProgram": 9, "autoSpeed": 10,
    }


def test_complete_fixture_config_round_trips_atomically(tmp_path):
    store = LightingConfigStore(tmp_path / "lighting.json")
    config = config_with_fixture()
    config["cues"]["night"]["fadeMs"] = 4500
    config["cues"]["night"]["fixtures"]["light-1"]["values"].update(
        dimmer=180,
        blue=255,
        uv=90,
    )
    saved = store.save(config)
    assert saved == normalize_config(config)
    assert store.load() == saved
    assert (tmp_path / "lighting.json").stat().st_mode & 0o777 == 0o600


def test_every_cue_requires_every_fixture_but_allows_sparse_values():
    config = config_with_fixture()
    del config["cues"]["day"]["fixtures"]["light-1"]
    with pytest.raises(LightingConfigValidationError) as captured:
        normalize_config(config)
    assert "cues.day.fixtures" in captured.value.field_errors

    config = config_with_fixture()
    state = config["cues"]["day"]["fixtures"]["light-1"]
    state["values"]["red"] = 84
    state["fade"] = ["red"]
    normalized = normalize_config(config)
    assert normalized["cues"]["day"]["fixtures"]["light-1"] == {
        "values": {"red": 84},
        "fade": ["red"],
    }


def test_raw_values_and_fade_rules_are_strict():
    config = config_with_fixture()
    state = config["cues"]["day"]["fixtures"]["light-1"]
    state["values"]["red"] = 256
    state["values"]["autoProgram"] = 5
    state["fade"].append("autoProgram")
    with pytest.raises(LightingConfigValidationError) as captured:
        normalize_config(config)
    assert "cues.day.fixtures.light-1.values.red" in captured.value.field_errors
    assert "cues.day.fixtures.light-1.fade" in captured.value.field_errors


def test_fade_requires_an_explicit_value_at_the_same_priority_layer():
    config = config_with_fixture()
    config["cues"]["day"]["profiles"]["shehds-par-7x18-rgbwauv-10ch"]["fade"] = ["red"]
    with pytest.raises(LightingConfigValidationError) as captured:
        normalize_config(config)
    assert (
        "cues.day.profiles.shehds-par-7x18-rgbwauv-10ch.fade"
        in captured.value.field_errors
    )


def test_version_one_complete_fixture_cues_upgrade_without_changing_their_look():
    legacy = config_with_fixture()
    legacy["version"] = 1
    for cue in legacy["cues"].values():
        del cue["profiles"]
        cue["fixtures"]["light-1"] = {
            "values": {parameter: 0 for parameter in PARAMETER_KEYS},
            "fade": list(DEFAULT_FADE_PARAMETERS),
        }
    legacy["cues"]["night"]["fixtures"]["light-1"]["values"]["blue"] = 211

    upgraded = normalize_config(legacy)

    assert upgraded["version"] == 5
    assert upgraded["outputMode"] == "artnet"
    assert upgraded["cues"]["night"]["fixtures"]["light-1"]["values"]["blue"] == 211
    assert all(
        state == {"values": {}, "fade": []}
        for state in upgraded["cues"]["night"]["profiles"].values()
    )


def test_version_two_artnet_config_upgrades_losslessly():
    legacy = config_with_fixture(fixture_type="shehds-par-18x18-rgbwauv-10ch", address=11)
    legacy["cues"]["day"]["fadeMs"] = 7123
    legacy["cues"]["day"]["fixtures"]["light-1"] = {
        "values": {"dimmer": 255, "red": 91, "white": 17},
        "fade": ["dimmer", "red", "white"],
    }
    legacy["artnet"]["targetHost"] = "192.168.1.255"
    legacy["version"] = 2
    legacy.pop("outputMode")
    legacy.pop("osc")
    original_artnet = json.loads(json.dumps(legacy["artnet"]))
    original_fixtures = json.loads(json.dumps(legacy["fixtures"]))
    original_cues = json.loads(json.dumps(legacy["cues"]))

    upgraded = normalize_config(legacy)

    assert upgraded["version"] == 5
    assert upgraded["outputMode"] == "artnet"
    assert upgraded["artnet"] == original_artnet
    assert upgraded["fixtures"] == original_fixtures
    assert upgraded["cues"] == original_cues


def test_version_three_dual_engine_config_upgrades_losslessly():
    legacy = config_with_fixture(fixture_type="shehds-par-18x18-rgbwauv-10ch", address=11)
    legacy["version"] = 3
    legacy["outputMode"] = "osc"
    legacy["artnet"]["targetHost"] = "192.168.1.255"
    legacy["cues"]["nominations"]["fadeMs"] = 5400
    legacy["osc"]["messages"].pop("nomination")
    legacy["osc"]["messages"].pop("nominationOff")
    legacy["osc"]["messages"].pop("beginVoting")
    legacy["osc"]["messages"].update(
        setup="/cue/SETUP/start",
        day="/cue/DAY/start",
        nominations="/cue/GROUP/start",
        night="/cue/NIGHT/start",
        stopAll="/cue/BLACKOUT/start",
    )
    original = json.loads(json.dumps(legacy))

    upgraded = normalize_config(legacy)

    assert upgraded["version"] == 5
    assert upgraded["outputMode"] == original["outputMode"]
    assert upgraded["artnet"] == original["artnet"]
    assert upgraded["fixtures"] == original["fixtures"]
    assert upgraded["cues"] == original["cues"]
    for trigger, message in original["osc"]["messages"].items():
        assert upgraded["osc"]["messages"][trigger] == message
    assert upgraded["osc"]["messages"]["nomination"] == ""
    assert upgraded["osc"]["messages"]["nominationOff"] == ""
    assert upgraded["osc"]["messages"]["beginVoting"] == ""


def test_version_four_nomination_config_adds_nomination_off_losslessly():
    legacy = config_with_fixture(fixture_type="shehds-par-18x18-rgbwauv-10ch", address=21)
    legacy["version"] = 4
    legacy["outputMode"] = "osc"
    legacy["artnet"]["targetHost"] = "10.20.30.255"
    legacy["artnet"]["interfaceAddress"] = "10.20.30.4"
    legacy["cues"]["nominations"]["fadeMs"] = 6789
    legacy["cues"]["nominations"]["fixtures"]["light-1"] = {
        "values": {"dimmer": 231, "red": 87, "blue": 14},
        "fade": ["dimmer", "red", "blue"],
    }
    legacy["osc"]["targetHost"] = "10.20.30.8"
    legacy["osc"]["targetPort"] = 53001
    legacy["osc"]["messages"].pop("nominationOff")
    legacy["osc"]["messages"].update(
        nominations="/cue/GROUP/start",
        nomination="/cue/NOMINATION/start",
        beginVoting="/cue/VOTE/start",
    )
    original = json.loads(json.dumps(legacy))

    upgraded = normalize_config(legacy)

    assert upgraded["version"] == 5
    assert upgraded["outputMode"] == original["outputMode"]
    assert upgraded["artnet"] == original["artnet"]
    assert upgraded["fixtures"] == original["fixtures"]
    assert upgraded["cues"] == original["cues"]
    assert upgraded["osc"]["targetHost"] == original["osc"]["targetHost"]
    assert upgraded["osc"]["targetPort"] == original["osc"]["targetPort"]
    for trigger, message in original["osc"]["messages"].items():
        assert upgraded["osc"]["messages"][trigger] == message
    assert upgraded["osc"]["messages"]["nominationOff"] == "/cue/NOM-OFF/start"


def test_osc_destination_and_all_eleven_messages_are_validated():
    config = default_config()
    config["outputMode"] = "osc"
    config["osc"]["messages"]["day"] = '/cue/DAY/start "look one"'
    normalized = normalize_config(config)
    assert normalized["osc"]["messages"]["day"] == '/cue/DAY/start "look one"'

    config["osc"]["targetPort"] = True
    config["osc"]["messages"]["night"] = 'not-an-address "broken'
    with pytest.raises(LightingConfigValidationError) as captured:
        normalize_config(config)
    assert "osc.targetPort" in captured.value.field_errors
    assert "osc.messages.night" in captured.value.field_errors


def test_patch_overlap_and_footprint_bounds_are_rejected():
    config = config_with_fixture()
    config["fixtures"].append({
        "id": "light-2",
        "name": "Town Square Right",
        "type": "shehds-par-18x18-rgbwauv-10ch",
        "universe": 1,
        "address": 10,
    })
    for cue in config["cues"].values():
        cue["fixtures"]["light-2"] = default_fixture_cue_state()
    with pytest.raises(LightingConfigValidationError) as captured:
        normalize_config(config)
    assert "fixtures.light-2.address" in captured.value.field_errors

    config = config_with_fixture(address=504)
    with pytest.raises(LightingConfigValidationError) as captured:
        normalize_config(config)
    assert "fixtures.light-1.address" in captured.value.field_errors


def test_duplicate_names_and_unknown_fixture_types_are_rejected():
    config = config_with_fixture()
    config["fixtures"].append({
        "id": "light-2",
        "name": "town square left",
        "type": "unknown",
        "universe": 1,
        "address": 11,
    })
    for cue in config["cues"].values():
        cue["fixtures"]["light-2"] = default_fixture_cue_state()
    with pytest.raises(LightingConfigValidationError) as captured:
        normalize_config(config)
    assert "fixtures.light-2.name" in captured.value.field_errors
    assert "fixtures.light-2.type" in captured.value.field_errors


def test_invalid_existing_file_is_retained_and_defaults_are_loaded(tmp_path):
    path = tmp_path / "lighting.json"
    path.write_text("not-json", encoding="utf-8")
    store = LightingConfigStore(path)
    assert store.load() == default_config()
    assert not path.exists()
    backups = list(tmp_path.glob("lighting.json.invalid-*") )
    assert len(backups) == 1
    assert backups[0].read_text(encoding="utf-8") == "not-json"


def test_failed_save_does_not_replace_previous_configuration(tmp_path):
    store = LightingConfigStore(tmp_path / "lighting.json")
    original = store.save(config_with_fixture())
    invalid = json.loads(json.dumps(original))
    invalid["artnet"]["refreshHz"] = 0
    with pytest.raises(LightingConfigValidationError):
        store.save(invalid)
    assert store.load() == original
