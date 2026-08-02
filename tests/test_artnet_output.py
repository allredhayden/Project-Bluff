import copy
import socket
import struct

import pytest

from artnet_output import (
    ARTNET_OPCODE_DMX,
    ArtNetSender,
    LightingRuntime,
    LightingRuntimeError,
    build_artnet_packet,
    build_dmx_frames,
    resolve_cue_fixture_states,
    zero_fixture_state,
)
from lighting_config import default_config, default_fixture_cue_state


def configured_fixture(*, fixture_type="shehds-par-18x18-rgbwauv-10ch"):
    config = default_config()
    config["fixtures"] = [{
        "id": "key-light",
        "name": "Key Light",
        "type": fixture_type,
        "universe": 1,
        "address": 1,
    }]
    for cue in config["cues"].values():
        cue["fixtures"]["key-light"] = default_fixture_cue_state()
    return config


class FakeClock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


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


def test_artdmx_packet_shape_and_header_fields():
    packet = build_artnet_packet(17, list(range(256)) * 2, sequence=9)
    assert len(packet) == 530
    assert packet[:8] == b"Art-Net\x00"
    assert struct.unpack("<H", packet[8:10])[0] == ARTNET_OPCODE_DMX
    assert struct.unpack(">H", packet[10:12])[0] == 14
    assert packet[12] == 9
    assert struct.unpack("<H", packet[14:16])[0] == 17
    assert struct.unpack(">H", packet[16:18])[0] == 512
    assert list(packet[18:23]) == [0, 1, 2, 3, 4]


def test_18x18_profile_places_colors_before_special_channels():
    config = configured_fixture()
    values = zero_fixture_state(config)
    values["key-light"].update(
        dimmer=200,
        red=101,
        green=102,
        blue=103,
        white=104,
        amber=105,
        uv=106,
        strobe=22,
        autoProgram=33,
        autoSpeed=44,
    )
    slots = build_dmx_frames(config, values)[1]
    assert slots[:10] == [200, 101, 102, 103, 104, 105, 106, 22, 33, 44]


def test_7x18_profile_places_colors_before_special_channels():
    config = configured_fixture(fixture_type="shehds-par-7x18-rgbwauv-10ch")
    values = zero_fixture_state(config)
    values["key-light"].update(
        dimmer=200,
        red=101,
        green=102,
        blue=103,
        white=104,
        amber=105,
        uv=106,
        strobe=22,
        autoProgram=33,
        autoSpeed=44,
    )
    assert build_dmx_frames(config, values)[1][:10] == [200, 101, 102, 103, 104, 105, 106, 22, 33, 44]


def test_cue_resolution_uses_profile_then_sparse_fixture_override_then_home():
    config = configured_fixture()
    config["fixtures"].append({
        "id": "fill-light",
        "name": "Fill Light",
        "type": "shehds-par-18x18-rgbwauv-10ch",
        "universe": 1,
        "address": 11,
    })
    for cue in config["cues"].values():
        cue["fixtures"]["fill-light"] = default_fixture_cue_state()
    cue = config["cues"]["day"]
    profile = cue["profiles"]["shehds-par-18x18-rgbwauv-10ch"]
    profile["values"].update(dimmer=200, red=80)
    profile["fade"] = ["dimmer", "red"]
    cue["fixtures"]["key-light"]["values"]["red"] = 0

    resolved = resolve_cue_fixture_states(config, cue)

    assert resolved["key-light"]["values"]["dimmer"] == 200
    assert "dimmer" in resolved["key-light"]["fade"]
    assert resolved["key-light"]["values"]["red"] == 0
    assert "red" not in resolved["key-light"]["fade"]
    assert resolved["fill-light"]["values"]["red"] == 80
    assert "red" in resolved["fill-light"]["fade"]
    assert resolved["key-light"]["values"]["green"] == 0
    assert "green" in resolved["key-light"]["fade"]
    assert resolved["key-light"]["values"]["strobe"] == 0
    assert "strobe" not in resolved["key-light"]["fade"]


def test_runtime_starts_home_fades_selected_values_and_snaps_others():
    config = configured_fixture()
    day = config["cues"]["day"]
    day["fadeMs"] = 3000
    day_state = day["fixtures"]["key-light"]
    day_state["values"].update(dimmer=240, red=80, autoProgram=51)
    day_state["fade"] = ["dimmer"]
    clock = FakeClock()
    senders = []

    def sender_factory(artnet):
        sender = RecordingSender(artnet)
        senders.append(sender)
        return sender

    runtime = LightingRuntime(lambda: config, sender_factory=sender_factory, clock=clock, start_thread=False)
    assert runtime.arm()["armed"] is True
    assert senders[0].frames[-1][1][:10] == [0] * 10
    assert runtime.trigger("day")["status"] == "started"
    assert runtime.current_values()["key-light"]["dimmer"] == 0
    assert runtime.current_values()["key-light"]["red"] == 80
    assert runtime.current_values()["key-light"]["autoProgram"] == 51
    clock.advance(1.5)
    runtime.tick()
    assert runtime.current_values()["key-light"]["dimmer"] == pytest.approx(120)
    assert senders[0].frames[-1][1][0] == 120


def test_interrupted_fade_begins_from_live_output_without_a_jump():
    config = configured_fixture()
    config["cues"]["day"]["fadeMs"] = 4000
    config["cues"]["day"]["fixtures"]["key-light"]["values"]["dimmer"] = 200
    config["cues"]["day"]["fixtures"]["key-light"]["fade"] = ["dimmer"]
    config["cues"]["night"]["fadeMs"] = 2000
    config["cues"]["night"]["fixtures"]["key-light"]["values"]["dimmer"] = 0
    config["cues"]["night"]["fixtures"]["key-light"]["fade"] = ["dimmer"]
    clock = FakeClock()
    runtime = LightingRuntime(lambda: config, sender_factory=RecordingSender, clock=clock, start_thread=False)
    runtime.arm()
    runtime.trigger("day")
    clock.advance(2.0)
    assert runtime.current_values()["key-light"]["dimmer"] == pytest.approx(100)
    runtime.trigger("night")
    assert runtime.current_values()["key-light"]["dimmer"] == pytest.approx(100)
    clock.advance(1.0)
    assert runtime.current_values()["key-light"]["dimmer"] == pytest.approx(50)


def test_runtime_accepts_cue_only_updates_while_armed():
    config = configured_fixture()
    runtime = LightingRuntime(lambda: config, sender_factory=RecordingSender, start_thread=False)
    runtime.arm()
    updated = copy.deepcopy(config)
    updated["cues"]["night"]["fadeMs"] = 0
    updated["cues"]["night"]["fixtures"]["key-light"]["values"]["blue"] = 207
    status = runtime.update_config(updated)
    assert status["armed"] is True
    runtime.trigger("night")
    assert runtime.current_values()["key-light"]["blue"] == 207


def test_runtime_rejects_patch_changes_while_armed():
    config = configured_fixture()
    runtime = LightingRuntime(lambda: config, sender_factory=RecordingSender, start_thread=False)
    runtime.arm()
    updated = copy.deepcopy(config)
    updated["fixtures"][0]["address"] = 21
    with pytest.raises(LightingRuntimeError, match="Disarm lighting"):
        runtime.update_config(updated)


def test_disarm_sends_blackout_and_closes_sender():
    config = configured_fixture()
    sender = RecordingSender(config["artnet"])
    runtime = LightingRuntime(lambda: config, sender_factory=lambda _config: sender, start_thread=False)
    runtime.arm()
    runtime.disarm()
    assert sender.frames[-1][1][:10] == [0] * 10
    assert sender.closed is True
    assert runtime.status()["armed"] is False


def test_repeated_arm_is_idempotent_and_keeps_the_existing_sender():
    config = configured_fixture()
    senders = []

    def sender_factory(artnet):
        sender = RecordingSender(artnet)
        senders.append(sender)
        return sender

    runtime = LightingRuntime(lambda: config, sender_factory=sender_factory, start_thread=False)
    first_status = runtime.arm()
    second_status = runtime.arm()
    assert second_status == first_status
    assert len(senders) == 1
    assert senders[0].closed is False


def test_arm_refuses_empty_patch():
    runtime = LightingRuntime(default_config, sender_factory=RecordingSender, start_thread=False)
    with pytest.raises(LightingRuntimeError, match="Add at least one fixture"):
        runtime.arm()


def test_real_loopback_sender_emits_exact_artdmx_packet():
    receiver = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    receiver.bind(("127.0.0.1", 0))
    receiver.settimeout(1)
    try:
        sender = ArtNetSender(
            {
                "targetHost": "127.0.0.1",
                "interfaceAddress": "",
                "portAddressBase": 7,
                "refreshHz": 30.0,
            },
            port=receiver.getsockname()[1],
        )
        slots = [0] * 512
        slots[0] = 201
        assert sender.send_frames({1: slots}) == 1
        packet, _ = receiver.recvfrom(1024)
    finally:
        receiver.close()
        if "sender" in locals():
            sender.close()
    assert struct.unpack("<H", packet[14:16])[0] == 7
    assert packet[18] == 201
