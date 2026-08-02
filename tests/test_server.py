import copy

import pytest

from artnet_output import LightingRuntime
from lighting_config import (
    LightingConfigStore,
    default_config,
    default_fixture_cue_state,
)
from server import ControlState, create_app


def config_with_fixture():
    config = default_config()
    config["fixtures"] = [{
        "id": "light-1",
        "name": "Town Square",
        "type": "shehds-par-18x18-rgbwauv-10ch",
        "universe": 1,
        "address": 1,
    }]
    for cue in config["cues"].values():
        cue["fixtures"]["light-1"] = default_fixture_cue_state()
    return config


class FakeRuntime:
    def __init__(self):
        self.armed = False
        self.calls = []
        self.updated_configs = []
        self.revision = 0

    def is_armed(self):
        return self.armed

    def status(self):
        return {
            "armed": self.armed,
            "senderState": "sending" if self.armed else "disarmed",
            "activeTrigger": self.calls[-1] if self.calls else None,
            "transitioning": False,
            "transitionProgress": None,
            "revision": self.revision,
            "lastSentAt": None,
            "packetsSent": 0,
            "lastError": "",
        }

    def arm(self):
        self.armed = True
        self.revision += 1
        return self.status()

    def disarm(self, *, blackout=True):
        self.armed = False
        self.revision += 1
        return self.status()

    def trigger(self, trigger):
        self.calls.append(trigger)
        self.revision += 1
        return {
            "status": "started" if self.armed else "skipped",
            "message": "test",
            "runtime": self.status(),
        }

    def update_config(self, config):
        self.updated_configs.append(copy.deepcopy(config))
        self.revision += 1
        return self.status()

    def close(self):
        self.armed = False


class RecordingSender:
    def __init__(self, config):
        self.config = copy.deepcopy(config)
        self.frames = []
        self.closed = False

    def send_frames(self, frames):
        self.frames.append(copy.deepcopy(frames))
        return len(frames)

    def close(self):
        self.closed = True


@pytest.fixture
def app_bundle(tmp_path):
    runtime = FakeRuntime()
    state = ControlState()
    app = create_app(tmp_path / "lighting.json", runtime, state)
    app.config.update(TESTING=True)
    return app, app.test_client(), runtime


def test_static_server_health_range_and_route_whitelist(app_bundle):
    _, client, _ = app_bundle
    assert client.get("/").status_code == 200
    assert client.get("/app.js").mimetype == "text/javascript"
    assert client.get("/lighting-control.js").mimetype == "text/javascript"
    assert client.get("/sounds/BotC%20Gong.mp3", headers={"Range": "bytes=0-31"}).status_code == 206
    assert client.get("/server.py").status_code == 404
    assert client.get("/sounds/../server.py").status_code == 404
    assert client.get("/api/health").get_json() == {
        "lightingAvailable": True,
        "service": "project-bluff",
        "status": "ok",
    }


def test_fixture_definitions_are_fixed_to_the_two_supported_pars(app_bundle):
    _, client, _ = app_bundle
    payload = client.get("/api/lighting/definitions").get_json()
    assert [definition["shortName"] for definition in payload["fixtures"]] == ["7x18 PAR", "18x18 PAR"]
    assert [trigger["id"] for trigger in payload["triggers"]] == [
        "setup", "day", "nominations", "night", "stopAll",
    ]
    seven, eighteen = payload["fixtures"]
    seven_channels = {parameter["key"]: parameter["channel"] for parameter in seven["parameters"]}
    eighteen_channels = {parameter["key"]: parameter["channel"] for parameter in eighteen["parameters"]}
    assert seven_channels["red"] == 5
    assert seven_channels["strobe"] == 2
    assert eighteen_channels["red"] == 2
    assert eighteen_channels["strobe"] == 8


def test_every_api_response_is_never_cacheable(app_bundle):
    _, client, _ = app_bundle
    responses = [
        client.get("/api/health"),
        client.get("/api/lighting/definitions"),
        client.get("/api/lighting/config"),
        client.get("/api/lighting/status"),
        client.get("/api/control/state"),
        client.post("/api/control/trigger", json={"trigger": "day"}),
    ]
    for response in responses:
        assert "no-store" in response.headers["Cache-Control"]
        assert response.headers["Pragma"] == "no-cache"


def test_config_is_shared_and_invalid_save_is_transactional(app_bundle):
    app, first_client, _ = app_bundle
    config = config_with_fixture()
    saved = first_client.put("/api/lighting/config", json=config).get_json()["config"]
    with app.test_client() as second_client:
        assert second_client.get("/api/lighting/config").get_json() == saved
        invalid = copy.deepcopy(saved)
        invalid["fixtures"][0]["address"] = 510
        response = second_client.put("/api/lighting/config", json=invalid)
        assert response.status_code == 400
        assert "fixtures.light-1.address" in response.get_json()["fieldErrors"]
    assert first_client.get("/api/lighting/config").get_json() == saved


def test_armed_config_save_allows_cue_changes_and_updates_runtime(app_bundle):
    _, client, runtime = app_bundle
    config = config_with_fixture()
    assert client.put("/api/lighting/config", json=config).status_code == 200
    runtime.armed = True
    config["cues"]["night"]["fixtures"]["light-1"]["values"]["blue"] = 211
    response = client.put("/api/lighting/config", json=config)
    assert response.status_code == 200
    saved = response.get_json()["config"]
    assert saved["cues"]["night"]["fixtures"]["light-1"]["values"]["blue"] == 211
    assert runtime.updated_configs == [saved]


def test_armed_config_save_rejects_fixture_or_artnet_changes(app_bundle):
    _, client, runtime = app_bundle
    config = config_with_fixture()
    assert client.put("/api/lighting/config", json=config).status_code == 200
    runtime.armed = True
    changed_fixture = copy.deepcopy(config)
    changed_fixture["fixtures"][0]["address"] = 21
    fixture_response = client.put("/api/lighting/config", json=changed_fixture)
    assert fixture_response.status_code == 409
    assert "only cue values and timing" in fixture_response.get_json()["error"]
    changed_network = copy.deepcopy(config)
    changed_network["artnet"]["targetHost"] = "192.168.1.255"
    network_response = client.put("/api/lighting/config", json=changed_network)
    assert network_response.status_code == 409
    assert runtime.updated_configs == []


def test_arm_and_disarm_require_exact_boolean_payload(app_bundle):
    _, client, runtime = app_bundle
    assert client.post("/api/lighting/arm", json={"armed": "yes"}).status_code == 400
    armed = client.post("/api/lighting/arm", json={"armed": True}).get_json()["status"]
    assert armed["armed"] is True
    assert runtime.armed is True
    disarmed = client.post("/api/lighting/arm", json={"armed": False}).get_json()["status"]
    assert disarmed["armed"] is False
    assert runtime.armed is False


def test_trigger_updates_shared_stage_even_when_lighting_is_disarmed(app_bundle):
    app, client, runtime = app_bundle
    response = client.post("/api/control/trigger", json={"trigger": "day"})
    payload = response.get_json()
    assert payload["lighting"]["status"] == "skipped"
    assert payload["state"]["currentStage"] == "day"
    assert runtime.calls == ["day"]
    with app.test_client() as second_client:
        assert second_client.get("/api/control/state").get_json() == payload["state"]
        stopped = second_client.post("/api/control/trigger", json={"trigger": "stopAll"}).get_json()
    assert stopped["state"]["currentStage"] is None
    assert runtime.calls == ["day", "stopAll"]


def test_preview_fires_only_lighting_and_does_not_change_shared_stage(app_bundle):
    _, client, runtime = app_bundle
    before = client.get("/api/control/state").get_json()
    response = client.post("/api/lighting/preview", json={"trigger": "night"})
    assert response.status_code == 200
    assert runtime.calls == ["night"]
    assert client.get("/api/control/state").get_json() == before


def test_trigger_and_preview_reject_unknown_or_extra_fields(app_bundle):
    _, client, runtime = app_bundle
    assert client.post("/api/control/trigger", json={"trigger": "bells"}).status_code == 400
    assert client.post("/api/control/trigger", json={"trigger": "day", "host": "bad"}).status_code == 400
    assert client.post("/api/lighting/preview", data={"trigger": "day"}).status_code == 400
    assert runtime.calls == []


def test_legacy_osc_routes_and_assets_are_gone(app_bundle):
    _, client, _ = app_bundle
    assert client.get("/osc-control.js").status_code == 404
    assert client.get("/api/osc/config").status_code == 404
    assert client.post("/api/osc/dispatch", json={"triggers": ["day"]}).status_code == 404


def test_real_runtime_flow_compiles_18x18_colors_before_specials(tmp_path):
    path = tmp_path / "lighting.json"
    store = LightingConfigStore(path)
    senders = []

    def sender_factory(artnet):
        sender = RecordingSender(artnet)
        senders.append(sender)
        return sender

    runtime = LightingRuntime(store.load, sender_factory=sender_factory, start_thread=False)
    app = create_app(path, runtime, ControlState())
    app.config.update(TESTING=True)
    client = app.test_client()
    config = config_with_fixture()
    day = config["cues"]["day"]
    day["fadeMs"] = 0
    day["fixtures"]["light-1"]["values"].update(
        dimmer=255,
        red=111,
        strobe=22,
        autoProgram=33,
        autoSpeed=44,
    )
    assert client.put("/api/lighting/config", json=config).status_code == 200
    assert client.post("/api/lighting/arm", json={"armed": True}).status_code == 200
    response = client.post("/api/control/trigger", json={"trigger": "day"})
    assert response.status_code == 200
    assert senders[0].frames[-1][1][:10] == [255, 111, 0, 0, 0, 0, 0, 22, 33, 44]
    runtime.close()
