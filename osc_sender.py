"""Constrained UDP OSC sender for Project Bluff."""

from __future__ import annotations

import re
import shlex
import socket
import threading
from datetime import datetime, timezone
from typing import Any, Callable

from pythonosc.osc_message_builder import OscMessageBuilder


_OSC_ADDRESS = re.compile(r"^/(?:[A-Za-z0-9_.-]+/?)+$")
_DELIVERY_WORDING = "Datagram sent; receiver execution is not acknowledged."


class MessageValidationError(ValueError):
    pass


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_osc_message(message: str) -> tuple[str, list[str]]:
    """Parse an OSC address followed by optional shell-quoted string arguments."""

    if not isinstance(message, str) or not message.strip():
        raise MessageValidationError("Enter an OSC address and optional quoted string arguments.")
    if any(character in message for character in ("\x00", "\r", "\n")):
        raise MessageValidationError("OSC messages cannot contain line breaks or NUL characters.")
    try:
        tokens = shlex.split(message, posix=True)
    except ValueError as error:
        raise MessageValidationError("OSC message contains unbalanced or invalid quotes.") from error
    if not tokens:
        raise MessageValidationError("Enter an OSC address and optional quoted string arguments.")
    address, *arguments = tokens
    if address == "#bundle" or not _OSC_ADDRESS.fullmatch(address):
        raise MessageValidationError(
            "OSC address must begin with / and use only letters, numbers, ., _, or -."
        )
    if any("\x00" in argument or "\r" in argument or "\n" in argument for argument in arguments):
        raise MessageValidationError("OSC string arguments cannot contain line breaks or NUL characters.")
    return address, arguments


def build_osc_packet(message: str) -> tuple[bytes, str, int]:
    address, arguments = parse_osc_message(message)
    builder = OscMessageBuilder(address=address)
    for argument in arguments:
        builder.add_arg(argument, arg_type="s")
    return builder.build().dgram, address, len(arguments)


class OscSender:
    """Send one complete OSC datagram per mapped Bluff event."""

    def __init__(
        self,
        *,
        socket_factory: Callable[..., socket.socket] = socket.socket,
        resolver: Callable[..., Any] = socket.getaddrinfo,
    ) -> None:
        self._socket_factory = socket_factory
        self._resolver = resolver
        self._lock = threading.RLock()
        self._last_attempt: dict[str, Any] | None = None
        self._packets_sent = 0

    def send(self, host: str, port: int, message: str) -> dict[str, Any]:
        attempted_at = _utc_now()
        try:
            packet, address, argument_count = build_osc_packet(message)
            destinations = self._resolver(host, port, type=socket.SOCK_DGRAM)
            if not destinations:
                raise OSError("Host did not resolve to a UDP destination.")
            family, socket_type, protocol, _, destination = destinations[0]
            with self._socket_factory(family, socket_type, protocol) as udp_socket:
                bytes_sent = udp_socket.sendto(packet, destination)
            if bytes_sent != len(packet):
                raise OSError("The complete OSC datagram was not sent.")
            result = {
                "status": "sent",
                "attemptedAt": attempted_at,
                "address": address,
                "argumentCount": argument_count,
                "message": _DELIVERY_WORDING,
            }
        except (OSError, MessageValidationError, ValueError) as error:
            result = {
                "status": "error",
                "attemptedAt": attempted_at,
                "message": f"Local OSC send failed: {error}",
            }
        with self._lock:
            self._last_attempt = dict(result)
            if result["status"] == "sent":
                self._packets_sent += 1
        return result

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "lastAttempt": dict(self._last_attempt) if self._last_attempt else None,
                "packetsSent": self._packets_sent,
                "delivery": _DELIVERY_WORDING,
            }

