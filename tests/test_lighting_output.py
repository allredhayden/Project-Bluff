import copy

from lighting_config import default_config, default_fixture_cue_state
from lighting_output import LightingOutputController


def configured_artnet():
    config = default_config()
    config["fixtures"] = [{
        "id": "light-1",
        "name": "Light 1",
        "type": "shehds-par-18x18-rgbwauv-10ch",
        "universe": 1,
        "address": 1,
    }]
    for cue in config["cues"].values():
        cue["fixtures"]["light-1"] = default_fixture_cue_state()
    return config


class FakeArtNetRuntime:
    def __init__(self):
        self.armed = False
        self.calls = []
        self.updated = []
        self.disarms = []

    def arm(self):
        self.armed = True
        return self.status()

    def disarm(self, *, blackout=True):
        self.disarms.append(blackout)
        self.armed = False
        return self.status()

    def trigger(self, trigger):
        self.calls.append(trigger)
        return {"status": "started", "message": "started", "runtime": self.status()}

    def update_config(self, config):
        self.updated.append(copy.deepcopy(config))
        return self.status()

    def status(self):
        return {
            "armed": self.armed,
            "senderState": "sending" if self.armed else "disarmed",
            "activeTrigger": self.calls[-1] if self.calls else None,
            "transitioning": False,
            "transitionProgress": None,
            "revision": len(self.calls),
            "lastSentAt": None,
            "packetsSent": len(self.calls),
            "lastError": "",
        }

    def close(self):
        self.armed = False


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


def test_selected_engine_is_exclusive_and_both_modes_start_disarmed():
    config = configured_artnet()
    artnet = FakeArtNetRuntime()
    osc = FakeOscSender()
    controller = LightingOutputController(lambda: config, artnet_runtime=artnet, osc_sender=osc)

    assert controller.status()["armed"] is False
    assert controller.trigger("day", ["bells"])["status"] == "skipped"
    controller.arm()
    controller.trigger("day", ["bells"])
    assert artnet.calls == ["day"]
    assert osc.calls == []
    controller.disarm()
    assert artnet.disarms == [True]

    config["outputMode"] = "osc"
    config["osc"]["messages"].update(
        day="/cue/DAY/start",
        bells="/cue/BELLS/start",
        femaleScream="/cue/FEMALE/start",
    )
    controller.arm()
    assert osc.calls == []
    result = controller.trigger("day", ["bells", "maleScream", "femaleScream"])
    assert result["status"] == "sent"
    assert [call[2] for call in osc.calls] == [
        "/cue/DAY/start", "/cue/BELLS/start", "/cue/FEMALE/start",
    ]
    assert [event["status"] for event in result["events"]] == [
        "sent", "sent", "skipped", "sent",
    ]
    assert artnet.calls == ["day"]
    controller.disarm()
    assert [call[2] for call in osc.calls] == [
        "/cue/DAY/start", "/cue/BELLS/start", "/cue/FEMALE/start",
    ]


def test_osc_preview_sends_one_auxiliary_without_changing_artnet():
    config = configured_artnet()
    config["outputMode"] = "osc"
    config["osc"]["messages"]["maleScream"] = "/cue/MALE/start"
    artnet = FakeArtNetRuntime()
    osc = FakeOscSender()
    controller = LightingOutputController(lambda: config, artnet_runtime=artnet, osc_sender=osc)
    controller.arm()
    result = controller.preview("maleScream")
    assert result["status"] == "sent"
    assert osc.calls == [("127.0.0.1", 53000, "/cue/MALE/start")]
    assert artnet.calls == []
