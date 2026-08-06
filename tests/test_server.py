import copy
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from artnet_output import LightingRuntime
from lighting_config import (
    LightingConfigStore,
    default_config,
    default_fixture_cue_state,
)
from server import ControlState, create_app


def state_without_elapsed(state):
    return {key: value for key, value in state.items() if key != "elapsedMs"}


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


class FakeOscSender:
    def __init__(self):
        self.calls = []

    def send(self, host, port, message):
        self.calls.append((host, port, message))
        return {
            "status": "sent",
            "attemptedAt": "2026-08-06T00:00:00Z",
            "address": message.split()[0],
            "argumentCount": len(message.split()) - 1,
            "message": "Datagram sent; receiver execution is not acknowledged.",
        }

    def status(self):
        last = None
        if self.calls:
            last = {
                "status": "sent",
                "attemptedAt": "2026-08-06T00:00:00Z",
                "message": "Datagram sent; receiver execution is not acknowledged.",
            }
        return {"lastAttempt": last, "packetsSent": len(self.calls), "delivery": "not acknowledged"}


class ErrorOscSender(FakeOscSender):
    def send(self, host, port, message):
        self.calls.append((host, port, message))
        return {
            "status": "error",
            "attemptedAt": "2026-08-06T00:00:00Z",
            "message": "Local OSC send failed: test failure",
        }


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
        "lightingModes": ["artnet", "osc"],
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
    assert [trigger["label"] for trigger in payload["triggers"]] == [
        "SETUP", "DAY", "GROUP DISCUSSION", "NIGHT", "STOP ALL",
    ]
    assert [trigger["id"] for trigger in payload["oscTriggers"]] == [
        "setup", "day", "nominations", "nomination", "beginVoting",
        "night", "stopAll", "bells", "maleScream", "femaleScream",
    ]
    seven, eighteen = payload["fixtures"]
    seven_channels = {parameter["key"]: parameter["channel"] for parameter in seven["parameters"]}
    eighteen_channels = {parameter["key"]: parameter["channel"] for parameter in eighteen["parameters"]}
    assert seven_channels["red"] == 2
    assert seven_channels["strobe"] == 8
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
    assert client.post("/api/lighting/arm", json={"armed": True}).status_code == 200
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
    assert client.post("/api/lighting/arm", json={"armed": True}).status_code == 200
    changed_fixture = copy.deepcopy(config)
    changed_fixture["fixtures"][0]["address"] = 21
    fixture_response = client.put("/api/lighting/config", json=changed_fixture)
    assert fixture_response.status_code == 409
    assert "cue values, timing, and OSC messages" in fixture_response.get_json()["error"]
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
    assert payload["state"]["nominationPhase"] is None
    assert payload["state"]["cueRevision"] == 1
    assert payload["state"]["audioEvents"] == []
    assert payload["state"]["loopOffset"] == 0.0
    assert runtime.calls == []
    with app.test_client() as second_client:
        remote_state = second_client.get("/api/control/state").get_json()
        assert state_without_elapsed(remote_state) == state_without_elapsed(payload["state"])
        assert remote_state["elapsedMs"] >= payload["state"]["elapsedMs"]
        stopped = second_client.post("/api/control/trigger", json={"trigger": "stopAll"}).get_json()
    assert stopped["state"]["currentStage"] is None
    assert stopped["state"]["nominationPhase"] is None
    assert runtime.calls == []


def test_shared_audio_metadata_tracks_exact_day_events_loop_offset_and_server_elapsed(app_bundle):
    _, client, _ = app_bundle
    day = client.post("/api/control/trigger", json={
        "trigger": "day",
        "auxiliaryTriggers": ["bells", "femaleScream"],
        "loopOffset": 91.25,
    }).get_json()["state"]
    assert day["cueRevision"] == 1
    assert day["audioEvents"] == ["bells", "femaleScream"]
    assert day["loopOffset"] == 91.25
    assert day["elapsedMs"] >= 0

    time.sleep(0.012)
    later = client.get("/api/control/state").get_json()
    assert later["cueRevision"] == day["cueRevision"]
    assert later["elapsedMs"] >= day["elapsedMs"] + 5

    group = client.post("/api/control/trigger", json={"trigger": "nominations"}).get_json()["state"]
    assert group["cueRevision"] == 2
    assert group["audioEvents"] == []
    assert group["loopOffset"] is None
    nomination = client.post("/api/control/trigger", json={"trigger": "nomination"}).get_json()["state"]
    assert nomination["cueRevision"] == group["cueRevision"]
    assert nomination["startedAt"] == group["startedAt"]
    assert nomination["audioEvents"] == []

    stopped = client.post("/api/control/trigger", json={"trigger": "stopAll"}).get_json()["state"]
    assert stopped["cueRevision"] == 3
    assert stopped["currentStage"] is None
    assert stopped["audioEvents"] == []
    assert stopped["loopOffset"] is None


def test_control_state_wait_and_event_stream_push_revisions(app_bundle):
    app, client, _ = app_bundle
    state = app.extensions["project_bluff_control_state"]

    with ThreadPoolExecutor(max_workers=1) as executor:
        waiting = executor.submit(state.wait_for_revision, 0, 1.0)
        time.sleep(0.01)
        client.post("/api/control/trigger", json={"trigger": "night"})
        pushed = waiting.result(timeout=1.0)
    assert pushed["revision"] == 1
    assert pushed["currentStage"] == "night"

    stream = client.get("/api/control/events?afterRevision=-1", buffered=False)
    first_event = next(stream.response).decode("utf-8")
    stream.close()
    assert stream.mimetype == "text/event-stream"
    assert "event: control" in first_event
    assert f"id: {pushed['sessionId']}:1" in first_event
    assert '"currentStage":"night"' in first_event
    assert "no-store" in stream.headers["Cache-Control"]

    restarted_stream = client.get(
        "/api/control/events",
        headers={"Last-Event-ID": "previous-server:999"},
        buffered=False,
    )
    restarted_event = next(restarted_stream.response).decode("utf-8")
    restarted_stream.close()
    assert f"id: {pushed['sessionId']}:1" in restarted_event
    assert client.get("/api/control/events?afterRevision=bad").status_code == 400


def test_preview_fires_only_lighting_and_does_not_change_shared_stage(app_bundle):
    _, client, runtime = app_bundle
    config = config_with_fixture()
    assert client.put("/api/lighting/config", json=config).status_code == 200
    assert client.post("/api/lighting/arm", json={"armed": True}).status_code == 200
    before = client.get("/api/control/state").get_json()
    response = client.post("/api/lighting/preview", json={"trigger": "night"})
    assert response.status_code == 200
    assert runtime.calls == ["night"]
    assert client.get("/api/control/state").get_json() == before


def test_trigger_and_preview_reject_unknown_or_extra_fields(app_bundle):
    _, client, runtime = app_bundle
    assert client.post("/api/control/trigger", json={"trigger": "bells"}).status_code == 400
    assert client.post("/api/control/trigger", json={"trigger": "day", "host": "bad"}).status_code == 400
    assert client.post("/api/control/trigger", json={
        "trigger": "nomination", "auxiliaryTriggers": [],
    }).status_code == 400
    assert client.post("/api/control/trigger", json={
        "trigger": "day", "loopOffset": -0.1,
    }).status_code == 400
    assert client.post("/api/control/trigger", json={
        "trigger": "day", "loopOffset": True,
    }).status_code == 400
    assert client.post("/api/control/trigger", json={
        "trigger": "night", "loopOffset": 4,
    }).status_code == 400
    assert client.post("/api/lighting/preview", data={"trigger": "day"}).status_code == 400
    assert runtime.calls == []


def test_nomination_phase_sequence_is_shared_and_resets_with_the_stage(app_bundle):
    app, client, runtime = app_bundle
    initial = client.get("/api/control/state").get_json()
    assert initial["currentStage"] is None
    assert initial["nominationPhase"] is None

    assert client.post("/api/control/trigger", json={"trigger": "nomination"}).status_code == 409
    group = client.post("/api/control/trigger", json={"trigger": "nominations"}).get_json()
    assert group["state"]["currentStage"] == "nominations"
    assert group["state"]["nominationPhase"] == "ready"

    nomination = client.post("/api/control/trigger", json={"trigger": "nomination"})
    assert nomination.status_code == 200
    assert nomination.get_json()["state"]["nominationPhase"] == "nomination"
    revision = nomination.get_json()["state"]["revision"]
    repeated = client.post("/api/control/trigger", json={"trigger": "nomination"})
    assert repeated.status_code == 409
    assert client.get("/api/control/state").get_json()["revision"] == revision

    with app.test_client() as second_client:
        assert second_client.get("/api/control/state").get_json()["nominationPhase"] == "nomination"
        voting = second_client.post("/api/control/trigger", json={"trigger": "beginVoting"})
    assert voting.status_code == 200
    assert voting.get_json()["state"]["nominationPhase"] == "ready"
    assert client.post("/api/control/trigger", json={"trigger": "beginVoting"}).status_code == 409

    night = client.post("/api/control/trigger", json={"trigger": "night"}).get_json()
    assert night["state"]["nominationPhase"] is None
    assert client.post("/api/control/trigger", json={"trigger": "nomination"}).status_code == 409
    assert runtime.calls == []


def test_osc_mode_routes_primary_and_actual_day_auxiliaries_in_order(tmp_path):
    runtime = FakeRuntime()
    osc_sender = FakeOscSender()
    app = create_app(tmp_path / "lighting.json", runtime, ControlState(), osc_sender)
    app.config.update(TESTING=True)
    client = app.test_client()
    config = default_config()
    config["outputMode"] = "osc"
    config["osc"]["messages"].update(
        day="/cue/DAY/start",
        bells="/cue/BELLS/start",
        femaleScream="/cue/FEMALE/start",
    )
    assert client.put("/api/lighting/config", json=config).status_code == 200
    armed = client.post("/api/lighting/arm", json={"armed": True}).get_json()["status"]
    assert armed["armed"] is True
    assert armed["outputMode"] == "osc"

    response = client.post("/api/control/trigger", json={
        "trigger": "day",
        "auxiliaryTriggers": ["bells", "femaleScream"],
    })
    payload = response.get_json()
    assert response.status_code == 200
    assert payload["state"]["currentStage"] == "day"
    assert [result["trigger"] for result in payload["lighting"]["events"]] == [
        "day", "bells", "femaleScream",
    ]
    assert [call[2] for call in osc_sender.calls] == [
        "/cue/DAY/start", "/cue/BELLS/start", "/cue/FEMALE/start",
    ]
    assert runtime.calls == []

    before = client.get("/api/control/state").get_json()
    preview = client.post("/api/lighting/preview", json={"trigger": "femaleScream"})
    assert preview.status_code == 200
    assert osc_sender.calls[-1][2] == "/cue/FEMALE/start"
    after = client.get("/api/control/state").get_json()
    assert state_without_elapsed(after) == state_without_elapsed(before)
    assert after["elapsedMs"] >= before["elapsedMs"]


def test_osc_mode_routes_group_nomination_and_voting_as_independent_events(tmp_path):
    runtime = FakeRuntime()
    osc_sender = FakeOscSender()
    app = create_app(tmp_path / "lighting.json", runtime, ControlState(), osc_sender)
    app.config.update(TESTING=True)
    client = app.test_client()
    config = default_config()
    config["outputMode"] = "osc"
    config["osc"]["messages"].update(
        nominations="/cue/GROUP/start",
        nomination='/cue/NOMINATION/start "phase one"',
        beginVoting="/cue/VOTING/start",
    )
    assert client.put("/api/lighting/config", json=config).status_code == 200
    assert client.post("/api/lighting/arm", json={"armed": True}).status_code == 200

    group = client.post("/api/control/trigger", json={"trigger": "nominations"})
    nomination = client.post("/api/control/trigger", json={"trigger": "nomination"})
    voting = client.post("/api/control/trigger", json={"trigger": "beginVoting"})

    assert [response.status_code for response in (group, nomination, voting)] == [200, 200, 200]
    assert nomination.get_json()["state"]["nominationPhase"] == "nomination"
    assert voting.get_json()["state"]["nominationPhase"] == "ready"
    assert [call[2] for call in osc_sender.calls] == [
        "/cue/GROUP/start",
        '/cue/NOMINATION/start "phase one"',
        "/cue/VOTING/start",
    ]
    assert runtime.calls == []


def test_artnet_nomination_phase_does_not_disturb_the_group_discussion_look(tmp_path):
    runtime = FakeRuntime()
    app = create_app(tmp_path / "lighting.json", runtime, ControlState())
    app.config.update(TESTING=True)
    client = app.test_client()
    config = config_with_fixture()
    assert client.put("/api/lighting/config", json=config).status_code == 200
    assert client.post("/api/lighting/arm", json={"armed": True}).status_code == 200

    assert client.post("/api/control/trigger", json={"trigger": "nominations"}).status_code == 200
    assert client.post("/api/control/trigger", json={"trigger": "nomination"}).status_code == 200
    assert client.post("/api/control/trigger", json={"trigger": "beginVoting"}).status_code == 200

    assert runtime.calls == ["nominations"]
    assert client.get("/api/lighting/status").get_json()["activeTrigger"] == "nominations"


def test_nomination_phase_updates_even_when_osc_delivery_fails(tmp_path):
    runtime = FakeRuntime()
    osc_sender = ErrorOscSender()
    app = create_app(tmp_path / "lighting.json", runtime, ControlState(), osc_sender)
    app.config.update(TESTING=True)
    client = app.test_client()
    config = default_config()
    config["outputMode"] = "osc"
    config["osc"]["messages"]["nomination"] = "/cue/NOMINATION/start"
    assert client.put("/api/lighting/config", json=config).status_code == 200
    assert client.post("/api/lighting/arm", json={"armed": True}).status_code == 200
    assert client.post("/api/control/trigger", json={"trigger": "nominations"}).status_code == 200

    response = client.post("/api/control/trigger", json={"trigger": "nomination"})
    assert response.status_code == 200
    assert response.get_json()["lighting"]["status"] == "error"
    assert response.get_json()["state"]["nominationPhase"] == "nomination"


def test_simultaneous_nomination_presses_emit_exactly_once(tmp_path):
    runtime = FakeRuntime()
    osc_sender = FakeOscSender()
    app = create_app(tmp_path / "lighting.json", runtime, ControlState(), osc_sender)
    app.config.update(TESTING=True)
    client = app.test_client()
    config = default_config()
    config["outputMode"] = "osc"
    config["osc"]["messages"]["nomination"] = "/cue/NOMINATION/start"
    assert client.put("/api/lighting/config", json=config).status_code == 200
    assert client.post("/api/lighting/arm", json={"armed": True}).status_code == 200
    assert client.post("/api/control/trigger", json={"trigger": "nominations"}).status_code == 200

    def press_nomination():
        with app.test_client() as thread_client:
            response = thread_client.post("/api/control/trigger", json={"trigger": "nomination"})
            return response.status_code

    with ThreadPoolExecutor(max_workers=2) as executor:
        statuses = sorted(executor.map(lambda _: press_nomination(), range(2)))

    assert statuses == [200, 409]
    assert [call[2] for call in osc_sender.calls] == ["/cue/NOMINATION/start"]
    assert client.get("/api/control/state").get_json()["nominationPhase"] == "nomination"


def test_armed_osc_allows_message_edits_but_locks_mode_and_destination(tmp_path):
    runtime = FakeRuntime()
    osc_sender = FakeOscSender()
    app = create_app(tmp_path / "lighting.json", runtime, ControlState(), osc_sender)
    app.config.update(TESTING=True)
    client = app.test_client()
    config = default_config()
    config["outputMode"] = "osc"
    config["osc"]["messages"]["night"] = "/cue/NIGHT/start"
    assert client.put("/api/lighting/config", json=config).status_code == 200
    assert client.post("/api/lighting/arm", json={"armed": True}).status_code == 200

    message_edit = copy.deepcopy(config)
    message_edit["osc"]["messages"]["night"] = "/cue/NIGHT-NEW/start"
    assert client.put("/api/lighting/config", json=message_edit).status_code == 200

    mode_edit = copy.deepcopy(message_edit)
    mode_edit["outputMode"] = "artnet"
    assert client.put("/api/lighting/config", json=mode_edit).status_code == 409

    destination_edit = copy.deepcopy(message_edit)
    destination_edit["osc"]["targetPort"] = 53002
    assert client.put("/api/lighting/config", json=destination_edit).status_code == 409

    before_disarm = list(osc_sender.calls)
    assert client.post("/api/lighting/arm", json={"armed": False}).status_code == 200
    assert osc_sender.calls == before_disarm


def test_day_auxiliary_payload_rejects_unknown_duplicate_or_wrong_order(app_bundle):
    _, client, _ = app_bundle
    assert client.post("/api/control/trigger", json={
        "trigger": "day", "auxiliaryTriggers": ["bells", "bells"],
    }).status_code == 400
    assert client.post("/api/control/trigger", json={
        "trigger": "night", "auxiliaryTriggers": ["bells"],
    }).status_code == 400
    assert client.post("/api/control/trigger", json={
        "trigger": "day", "auxiliaryTriggers": ["femaleScream", "bells"],
    }).status_code == 400


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
