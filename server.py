from __future__ import annotations

import base64
import hashlib
import json
import os
import socket
import struct
import threading
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

ROOT = Path(__file__).resolve().parent
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
STATE_LOCK = threading.RLock()
CLIENTS: dict[str, "AppHandler"] = {}
CLIENT_META: dict[str, dict[str, Any]] = {}
ROOMS: dict[str, dict[str, Any]] = {}


def sanitize_room(raw_room: str | None) -> str:
    cleaned = (raw_room or "").upper()
    cleaned = "".join(char if char.isalnum() or char == "-" else "-" for char in cleaned)
    cleaned = "-".join(part for part in cleaned.split("-") if part)
    return (cleaned or "ROOM")[:24]


def sanitize_name(raw_name: str | None) -> str:
    cleaned = (raw_name or "Guest").strip()
    return cleaned[:32] or "Guest"


def build_ice_servers() -> list[dict[str, Any]]:
    ice_servers: list[dict[str, Any]] = [
        {"urls": "stun:stun.l.google.com:19302"},
        {"urls": "stun:stun1.l.google.com:19302"},
    ]

    turn_url = os.environ.get("TURN_URL", "").strip()
    if turn_url:
        turn_server: dict[str, Any] = {"urls": turn_url}
        username = os.environ.get("TURN_USERNAME", "").strip()
        credential = os.environ.get("TURN_CREDENTIAL", "").strip()
        if username:
            turn_server["username"] = username
        if credential:
            turn_server["credential"] = credential
        ice_servers.append(turn_server)

    return ice_servers


def client_meta(client_id: str) -> dict[str, Any]:
    with STATE_LOCK:
        return CLIENT_META.setdefault(
            client_id,
            {
                "room": None,
                "name": "Guest",
                "micEnabled": False,
                "screenSharing": False,
            },
        )


def participant_summary_locked(client_id: str) -> dict[str, Any]:
    meta = CLIENT_META.get(client_id, {})
    room = meta.get("room")
    room_state = ROOMS.get(room) if room else None
    return {
        "id": client_id,
        "name": meta.get("name", "Guest"),
        "micEnabled": bool(meta.get("micEnabled", False)),
        "screenSharing": bool(meta.get("screenSharing", False)),
        "isHost": bool(room_state and room_state.get("hostId") == client_id),
    }


def room_snapshot(room: str) -> dict[str, Any]:
    with STATE_LOCK:
        state = ROOMS.get(room) or {"participants": set(), "joinOrder": [], "hostId": None}
        participants = [participant_summary_locked(client_id) for client_id in state["participants"]]
        participants.sort(key=lambda participant: participant["name"].lower())
        return {
            "room": room,
            "hostId": state.get("hostId"),
            "participantCount": len(participants),
            "participants": participants,
        }


def room_participants(room: str, exclude: str | None = None) -> list[str]:
    with STATE_LOCK:
        state = ROOMS.get(room)
        if not state:
            return []
        return [client_id for client_id in state["participants"] if client_id != exclude]


def send_to(client_id: str, payload: dict[str, Any]) -> None:
    with STATE_LOCK:
        client = CLIENTS.get(client_id)

    if not client:
        return

    try:
        client.send_json(payload)
    except (BrokenPipeError, ConnectionResetError, OSError):
        unregister_client(client_id)


def broadcast_room_state(room: str) -> None:
    payload = {"type": "room_state", **room_snapshot(room)}
    for participant_id in room_participants(room):
        send_to(participant_id, payload)


def broadcast_to_room(room: str, payload: dict[str, Any], exclude: str | None = None) -> None:
    for participant_id in room_participants(room, exclude=exclude):
        send_to(participant_id, payload)


def broadcast_chat(room: str, sender_id: str, author: str, text: str) -> None:
    payload = {
        "type": "chat_message",
        "senderId": sender_id,
        "author": author,
        "text": text,
    }
    for participant_id in room_participants(room):
        send_to(participant_id, payload)


def remove_empty_room(room: str) -> None:
    with STATE_LOCK:
        state = ROOMS.get(room)
        if not state:
            return
        if state["participants"]:
            return
        ROOMS.pop(room, None)


def leave_current_room(client_id: str) -> None:
    with STATE_LOCK:
        meta = CLIENT_META.get(client_id)
        if not meta:
            return

        room = meta.get("room")
        if not room:
            return

        state = ROOMS.get(room)
        if state:
            state["participants"].discard(client_id)
            state["joinOrder"] = [participant_id for participant_id in state["joinOrder"] if participant_id != client_id]
            previous_host = state.get("hostId")
            if previous_host == client_id:
                state["hostId"] = state["joinOrder"][0] if state["joinOrder"] else None
            next_host = state.get("hostId")
        else:
            previous_host = None
            next_host = None

        meta["room"] = None
        meta["micEnabled"] = False
        meta["screenSharing"] = False
        remaining = list(state["participants"]) if state else []

    for participant_id in remaining:
        send_to(participant_id, {"type": "participant_left", "participantId": client_id})

    if previous_host == client_id and next_host:
        send_to(
            next_host,
            {
                "type": "host_changed",
                "hostId": next_host,
                "hostName": client_meta(next_host).get("name", "Host"),
            },
        )
        broadcast_to_room(
            room,
            {
                "type": "host_changed",
                "hostId": next_host,
                "hostName": client_meta(next_host).get("name", "Host"),
            },
            exclude=next_host,
        )

    if remaining:
        broadcast_room_state(room)

    remove_empty_room(room)


def join_room(client_id: str, room: str, name: str) -> None:
    room = sanitize_room(room)
    name = sanitize_name(name)
    leave_current_room(client_id)

    with STATE_LOCK:
        state = ROOMS.setdefault(room, {"participants": set(), "joinOrder": [], "hostId": None})
        state["participants"].add(client_id)
        if client_id not in state["joinOrder"]:
            state["joinOrder"].append(client_id)
        if not state["hostId"]:
            state["hostId"] = client_id
        meta = client_meta(client_id)
        meta["room"] = room
        meta["name"] = name
        meta["micEnabled"] = False
        meta["screenSharing"] = False
        summary = participant_summary_locked(client_id)
        others = [participant_id for participant_id in state["participants"] if participant_id != client_id]
        host_id = state["hostId"]

    send_to(
        client_id,
        {"type": "room_joined", "room": room, "participant": summary, "hostId": host_id},
    )
    for participant_id in others:
        send_to(participant_id, {"type": "participant_joined", "participant": summary})

    broadcast_room_state(room)


def update_participant_status(client_id: str, mic_enabled: Any, screen_sharing: Any) -> None:
    with STATE_LOCK:
        meta = CLIENT_META.get(client_id)
        if not meta or not meta.get("room"):
            return

        room_state = ROOMS.get(meta["room"])
        is_host = bool(room_state and room_state.get("hostId") == client_id)
        meta["micEnabled"] = bool(mic_enabled)
        meta["screenSharing"] = bool(screen_sharing) if is_host else False
        room = meta["room"]

    broadcast_room_state(str(room))


def forward_signal(client_id: str, payload: dict[str, Any]) -> None:
    target = str(payload.get("target") or "")
    if not target:
        return

    with STATE_LOCK:
        sender_meta = CLIENT_META.get(client_id)
        target_meta = CLIENT_META.get(target)
        sender_room = sender_meta.get("room") if sender_meta else None
        target_room = target_meta.get("room") if target_meta else None
        if not sender_room or sender_room != target_room:
            return

    message = {
        "type": payload["type"],
        "senderId": client_id,
    }

    if "description" in payload:
        message["description"] = payload["description"]
    if "candidate" in payload:
        message["candidate"] = payload["candidate"]

    send_to(target, message)


def unregister_client(client_id: str) -> None:
    leave_current_room(client_id)
    with STATE_LOCK:
        CLIENTS.pop(client_id, None)
        CLIENT_META.pop(client_id, None)


class AppHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        upgrade_header = self.headers.get("Upgrade", "")

        if parsed.path == "/ws" and upgrade_header.lower() == "websocket":
            self.handle_websocket()
            return

        if parsed.path == "/config.json":
            self.send_json_response({"iceServers": build_ice_servers()})
            return

        self.path = "/index.html" if parsed.path in {"", "/"} else parsed.path
        super().do_GET()

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[http] {self.client_address[0]} - {format % args}")

    def handle_websocket(self) -> None:
        key = self.headers.get("Sec-WebSocket-Key")
        version = self.headers.get("Sec-WebSocket-Version")
        if not key or version != "13":
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid WebSocket handshake")
            return

        accept = base64.b64encode(
            hashlib.sha1(f"{key}{WS_GUID}".encode("utf-8")).digest()
        ).decode("ascii")

        self.send_response(HTTPStatus.SWITCHING_PROTOCOLS)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()

        self.close_connection = False
        self.client_id = uuid4().hex[:8]
        self.ws_lock = threading.Lock()

        with STATE_LOCK:
            CLIENTS[self.client_id] = self
            client_meta(self.client_id)

        self.send_json({"type": "connection_ready", "clientId": self.client_id})

        try:
            while True:
                opcode, payload = self.read_frame()
                if opcode is None:
                    break
                if opcode == 0x8:
                    break
                if opcode == 0x9:
                    self.send_frame(payload, opcode=0xA)
                    continue
                if opcode != 0x1:
                    continue

                message = json.loads(payload.decode("utf-8"))
                self.route_message(message)
        except (ConnectionResetError, BrokenPipeError, socket.timeout, json.JSONDecodeError):
            pass
        finally:
            unregister_client(self.client_id)

    def route_message(self, message: dict[str, Any]) -> None:
        message_type = message.get("type")

        if message_type == "join_room":
            join_room(
                self.client_id,
                str(message.get("room") or ""),
                sanitize_name(message.get("name")),
            )
            return

        if message_type == "leave_room":
            leave_current_room(self.client_id)
            return

        if message_type == "participant_status":
            update_participant_status(
                self.client_id,
                message.get("micEnabled"),
                message.get("screenSharing"),
            )
            return

        if message_type in {"signal_description", "signal_candidate"}:
            forward_signal(self.client_id, message)
            return

        if message_type == "chat_message":
            meta = client_meta(self.client_id)
            room = meta.get("room")
            text = str(message.get("text") or "").strip()[:240]
            author = sanitize_name(message.get("author") or meta.get("name"))
            if room and text:
                broadcast_chat(str(room), self.client_id, author, text)

    def read_exact(self, size: int) -> bytes:
        buffer = bytearray()
        while len(buffer) < size:
            chunk = self.connection.recv(size - len(buffer))
            if not chunk:
                raise ConnectionResetError("WebSocket client disconnected")
            buffer.extend(chunk)
        return bytes(buffer)

    def read_frame(self) -> tuple[int | None, bytes]:
        try:
            header = self.read_exact(2)
        except ConnectionResetError:
            return None, b""

        first_byte, second_byte = header
        opcode = first_byte & 0x0F
        payload_length = second_byte & 0x7F
        masked = bool(second_byte & 0x80)

        if payload_length == 126:
            payload_length = struct.unpack("!H", self.read_exact(2))[0]
        elif payload_length == 127:
            payload_length = struct.unpack("!Q", self.read_exact(8))[0]

        mask_key = self.read_exact(4) if masked else b""
        payload = self.read_exact(payload_length) if payload_length else b""

        if masked:
            payload = bytes(
                byte ^ mask_key[index % 4] for index, byte in enumerate(payload)
            )

        return opcode, payload

    def send_frame(self, payload: bytes, opcode: int = 0x1) -> None:
        frame = bytearray()
        frame.append(0x80 | opcode)
        payload_length = len(payload)

        if payload_length < 126:
            frame.append(payload_length)
        elif payload_length <= 65535:
            frame.append(126)
            frame.extend(struct.pack("!H", payload_length))
        else:
            frame.append(127)
            frame.extend(struct.pack("!Q", payload_length))

        frame.extend(payload)
        with self.ws_lock:
            self.connection.sendall(frame)

    def send_json(self, payload: dict[str, Any]) -> None:
        self.send_frame(json.dumps(payload).encode("utf-8"))

    def send_json_response(self, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True


def main() -> None:
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    server = ReusableThreadingHTTPServer((host, port), AppHandler)

    print(f"Live with frens server running on http://{host}:{port}")
    print("Create a room, invite friends, share a screen, and talk live with mic control.")
    server.serve_forever()


if __name__ == "__main__":
    main()
