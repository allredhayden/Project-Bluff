import socket

import pytest
from pythonosc.osc_packet import OscPacket

from osc_sender import MessageValidationError, OscSender, build_osc_packet, parse_osc_message


class RecordingSocket:
    def __init__(self, *, short_write=False):
        self.short_write = short_write
        self.sent = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def sendto(self, packet, destination):
        self.sent.append((packet, destination))
        return len(packet) - 1 if self.short_write else len(packet)


def resolver(host, port, *, type):
    assert type == socket.SOCK_DGRAM
    return [(socket.AF_INET, socket.SOCK_DGRAM, 0, "", (host, port))]


def test_complete_message_builds_exact_address_and_string_arguments():
    packet, address, count = build_osc_packet('/cue/DAY/start "look one" second')
    decoded = OscPacket(packet).messages[0].message
    assert address == "/cue/DAY/start"
    assert count == 2
    assert decoded.address == "/cue/DAY/start"
    assert decoded.params == ["look one", "second"]


@pytest.mark.parametrize(
    "message",
    ["", "cue/start", "#bundle", '/cue/start "unterminated', "/cue/start\nnext"],
)
def test_invalid_message_text_is_rejected(message):
    with pytest.raises(MessageValidationError):
        parse_osc_message(message)


def test_sender_reports_udp_send_without_claiming_receiver_execution():
    recording = RecordingSocket()
    sender = OscSender(socket_factory=lambda *_args: recording, resolver=resolver)
    result = sender.send("127.0.0.1", 53000, "/cue/12/start")
    assert result["status"] == "sent"
    assert result["address"] == "/cue/12/start"
    assert result["argumentCount"] == 0
    assert "not acknowledged" in result["message"]
    assert recording.sent[0][1] == ("127.0.0.1", 53000)
    assert sender.status()["packetsSent"] == 1


def test_sender_converts_short_udp_write_to_safe_error_status():
    recording = RecordingSocket(short_write=True)
    sender = OscSender(socket_factory=lambda *_args: recording, resolver=resolver)
    result = sender.send("127.0.0.1", 53000, "/go")
    assert result["status"] == "error"
    assert "complete OSC datagram" in result["message"]
    assert sender.status()["packetsSent"] == 0


def test_real_loopback_sender_emits_one_exact_osc_datagram():
    receiver = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    receiver.bind(("127.0.0.1", 0))
    receiver.settimeout(1)
    try:
        sender = OscSender()
        result = sender.send(
            "127.0.0.1",
            receiver.getsockname()[1],
            '/cue/DAY/start "warm look"',
        )
        packet, _ = receiver.recvfrom(2048)
    finally:
        receiver.close()
    decoded = OscPacket(packet).messages[0].message
    assert result["status"] == "sent"
    assert decoded.address == "/cue/DAY/start"
    assert decoded.params == ["warm look"]
