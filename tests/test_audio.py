import base64
import json

from app.audio import decode_twilio_media, encode_for_twilio, build_clear_message


def test_decode_twilio_media():
    """decode_twilio_media extracts raw bytes from a Twilio media payload."""
    raw_audio = b"\x00\x01\x02\x03\xff\xfe\xfd"
    payload = {
        "event": "media",
        "media": {"payload": base64.b64encode(raw_audio).decode("ascii")},
    }
    result = decode_twilio_media(payload)
    assert result == raw_audio


def test_encode_for_twilio():
    """encode_for_twilio wraps bytes into a valid Twilio media JSON message."""
    raw_audio = b"\xaa\xbb\xcc\xdd"
    stream_sid = "MZ123abc"

    result_str = encode_for_twilio(raw_audio, stream_sid)
    result = json.loads(result_str)

    assert result["event"] == "media"
    assert result["streamSid"] == stream_sid
    decoded = base64.b64decode(result["media"]["payload"])
    assert decoded == raw_audio


def test_encode_decode_roundtrip():
    """Audio survives a full encode -> decode round-trip."""
    original = bytes(range(256))  # All possible byte values
    stream_sid = "MZroundtrip"

    encoded_str = encode_for_twilio(original, stream_sid)
    encoded_msg = json.loads(encoded_str)

    # Simulate receiving the message back
    decoded = decode_twilio_media(encoded_msg)
    assert decoded == original


def test_build_clear_message():
    """build_clear_message produces a valid Twilio clear event."""
    stream_sid = "MZclear123"
    result = json.loads(build_clear_message(stream_sid))
    assert result["event"] == "clear"
    assert result["streamSid"] == stream_sid
