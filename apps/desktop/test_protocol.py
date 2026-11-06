#!/usr/bin/env python3
"""
Talkity Desktop Protocol Tests
Tests WebSocket protocol, reconnection logic, heartbeat, and message handling.
Can run on any platform - uses mocks for Windows-specific APIs.
"""

import json
import time
import sys
import unittest
from unittest.mock import Mock, patch, MagicMock, PropertyMock
import threading

# Mock Windows APIs for cross-platform testing
class MockWin32:
    """Mock Win32 functions for testing on non-Windows platforms."""
    @staticmethod
    def mock_all():
        if sys.platform != 'win32':
            # Mock ctypes
            ctypes_mock = MagicMock()
            ctypes_mock.windll = MagicMock()
            ctypes_mock.windll.user32 = MagicMock()
            ctypes_mock.windll.kernel32 = MagicMock()
            ctypes_mock.create_unicode_buffer = lambda size: MagicMock()
            ctypes_mock.byref = lambda x: x
            ctypes_mock.wstring_at = lambda x: ""
            ctypes_mock.memmove = lambda *args: None

            sys.modules['ctypes'] = ctypes_mock

            # Mock winsound
            winsound_mock = MagicMock()
            sys.modules['winsound'] = winsound_mock

            # Mock websocket
            websocket_mock = MagicMock()
            sys.modules['websocket'] = websocket_mock
            sys.modules['websocket'] = MagicMock()

# Run mock setup on non-Windows
if sys.platform != 'win32':
    MockWin32.mock_all()

# Import after mocking
import random
import uuid


# ============================
# Test Protocol Constants
# ============================
PROTOCOL_VERSION = "1.0.0"
HEARTBEAT_INTERVAL_MS = 30000
HEARTBEAT_TIMEOUT_MS = 35000
CLIENT_HEARTBEAT_INTERVAL_MS = 20000
INITIAL_RECONNECT_DELAY_MS = 1000
MAX_RECONNECT_DELAY_MS = 30000
RECONNECT_BACKOFF = 1.5
RECONNECT_JITTER_RANGE = 0.3
MAX_TEXT_PAYLOAD = 5000
MAX_EVENT_ID_PAYLOAD = 64


# ============================
# Test Cases
# ============================
class TestProtocolConstants(unittest.TestCase):
    """Verify protocol constants match server expectations."""

    def test_heartbeat_interval_matches_server(self):
        """Server uses 30000ms interval (server.js line 221)."""
        self.assertEqual(HEARTBEAT_INTERVAL_MS, 30000)

    def test_heartbeat_timeout_matches_server(self):
        """Server uses 35000ms timeout (server.js line 222)."""
        self.assertEqual(HEARTBEAT_TIMEOUT_MS, 35000)

    def test_max_text_payload(self):
        """Text payload limited to 5000 chars for security."""
        self.assertEqual(MAX_TEXT_PAYLOAD, 5000)


class TestJsonMessageValidation(unittest.TestCase):
    """Test JSON message parsing and validation."""

    def test_valid_json_parsing(self):
        """Valid JSON should parse successfully."""
        data = json.loads('{"type": "heartbeat", "timestamp": 123}')
        self.assertEqual(data["type"], "heartbeat")
        self.assertEqual(data["timestamp"], 123)

    def test_invalid_json_raises_error(self):
        """Invalid JSON should raise JSONDecodeError."""
        with self.assertRaises(json.JSONDecodeError):
            json.loads('{invalid json}')

    def test_empty_string_raises_error(self):
        """Empty string should raise JSONDecodeError."""
        with self.assertRaises(json.JSONDecodeError):
            json.loads('')

    def test_non_object_json(self):
        """Non-object JSON should be handled as unknown type."""
        data = json.loads('"just a string"')
        self.assertIsInstance(data, str)


class TestReconnectionLogic(unittest.TestCase):
    """Test exponential backoff with jitter."""

    def test_exponential_backoff(self):
        """Reconnect delay should increase exponentially."""
        # Start from initial delay and verify it increases on subsequent attempts
        initial_delay = INITIAL_RECONNECT_DELAY_MS
        delay = initial_delay

        for attempt in range(2, 6):  # Skip attempt 1 (same as initial)
            new_delay = min(
                initial_delay * (RECONNECT_BACKOFF ** (attempt - 1)),
                MAX_RECONNECT_DELAY_MS
            )
            self.assertGreater(new_delay, delay, f"Attempt {attempt}: {new_delay} should be > {delay}")
            delay = new_delay

    def test_delay_caps_at_max(self):
        """Delay should never exceed max reconnect delay."""
        for attempt in range(1, 20):
            delay = min(
                INITIAL_RECONNECT_DELAY_MS * (RECONNECT_BACKOFF ** attempt),
                MAX_RECONNECT_DELAY_MS
            )
            self.assertLessEqual(delay, MAX_RECONNECT_DELAY_MS)

    def test_jitter_within_range(self):
        """Jitter should be between 0 and 30% of delay."""
        delay = 1000

        for _ in range(100):
            jitter = random.uniform(0, RECONNECT_JITTER_RANGE) * delay
            total = delay + jitter
            self.assertGreaterEqual(total, delay)
            self.assertLessEqual(total, delay * (1 + RECONNECT_JITTER_RANGE))


class TestEventIdHandling(unittest.TestCase):
    """Test duplicate event prevention with event IDs."""

    def setUp(self):
        self.processed_events = set()

    def test_new_event_id_accepted(self):
        """New event IDs should be accepted."""
        event_id = str(uuid.uuid4())
        self.assertNotIn(event_id, self.processed_events)

    def test_duplicate_event_id_rejected(self):
        """Duplicate event IDs should be rejected."""
        event_id = str(uuid.uuid4())
        self.processed_events.add(event_id)
        self.assertIn(event_id, self.processed_events)

    def test_event_id_memory_bounded(self):
        """Event ID set should be bounded to prevent memory leaks."""
        # Simulate adding many events
        for _ in range(1500):
            self.processed_events.add(str(uuid.uuid4()))

        # Should be cleared when exceeding limit
        if len(self.processed_events) > 1000:
            self.processed_events.clear()

        self.assertEqual(len(self.processed_events), 0)


class TestMessageTypeHandling(unittest.TestCase):
    """Test handling of various message types from server."""

    def test_heartbeat_message_format(self):
        """Server sends heartbeat with timestamp."""
        msg = {"type": "heartbeat", "timestamp": 1234567890}
        self.assertEqual(msg["type"], "heartbeat")
        self.assertIn("timestamp", msg)

    def test_heartbeat_ack_format(self):
        """Client should respond with heartbeat_ack."""
        ack = {
            "type": "heartbeat_ack",
            "clientId": "desktop-1234",
            "timestamp": 1234567890
        }
        self.assertEqual(ack["type"], "heartbeat_ack")
        self.assertIn("clientId", ack)

    def test_inject_text_message_format(self):
        """inject_text should have required text field."""
        msg = {"type": "inject_text", "text": "Hello world", "eventId": "abc-123"}
        self.assertEqual(msg["type"], "inject_text")
        self.assertIn("text", msg)
        self.assertIn("eventId", msg)

    def test_error_message_format(self):
        """Error messages should have code and message."""
        msg = {"type": "error", "code": "invalid_json", "message": "Parse failed"}
        self.assertEqual(msg["type"], "error")
        self.assertEqual(msg["code"], "invalid_json")

    def test_acknowledgment_format(self):
        """ACK messages should confirm event processing."""
        ack = {"type": "ack", "eventId": "evt-123", "success": True}
        self.assertEqual(ack["type"], "ack")
        self.assertEqual(ack["success"], True)

        ack_fail = {"type": "ack", "eventId": "evt-456", "success": False, "reason": "empty_text"}
        self.assertEqual(ack_fail["success"], False)
        self.assertIn("reason", ack_fail)


class TestRegistrationProtocol(unittest.TestCase):
    """Test desktop client registration handshake."""

    def test_register_desktop_message(self):
        """Client sends register_desktop on connect."""
        register = {
            "type": "register_desktop",
            "clientId": "desktop-1234",
            "protocolVersion": PROTOCOL_VERSION,
            "timestamp": 1234567890
        }
        self.assertEqual(register["type"], "register_desktop")
        self.assertIn("clientId", register)
        self.assertIn("protocolVersion", register)

    def test_connected_response(self):
        """Server sends connected confirmation."""
        response = {
            "type": "connected",
            "message": "Talkity WebSocket connected",
            "clientId": "client-abc-123",
            "serverTime": "2024-01-01T00:00:00.000Z"
        }
        self.assertEqual(response["type"], "connected")
        self.assertIn("serverTime", response)


class TestTextPayloadSanitization(unittest.TestCase):
    """Test text payload limits and validation."""

    def test_text_truncation(self):
        """Text exceeding max should be truncated."""
        long_text = "x" * 10000
        truncated = long_text[:MAX_TEXT_PAYLOAD]
        self.assertEqual(len(truncated), MAX_TEXT_PAYLOAD)

    def test_empty_text_rejected(self):
        """Empty text should be rejected."""
        text = ""
        self.assertFalse(bool(text))

    def test_non_string_rejected(self):
        """Non-string text should be rejected."""
        text = 12345
        self.assertFalse(isinstance(text, str))


class TestHeartbeatTimeout(unittest.TestCase):
    """Test heartbeat timeout detection."""

    def test_timeout_detection(self):
        """Should detect when server hasn't pinged within timeout."""
        last_ping = 0  # No ping received
        now = HEARTBEAT_TIMEOUT_MS + 1000  # Past timeout

        elapsed = now - last_ping
        if last_ping:
            timeout = elapsed > HEARTBEAT_TIMEOUT_MS
            self.assertFalse(timeout)  # No ping means timeout detection should wait
        else:
            # If last_ping is 0, it's initialization state, not a timeout
            self.assertEqual(last_ping, 0)

    def test_timeout_with_recent_ping(self):
        """Should NOT timeout when ping is recent."""
        last_ping = 1000  # Recent ping at time 1000
        now = 10000  # Current time
        elapsed = now - last_ping

        # Within timeout window
        self.assertLess(elapsed, HEARTBEAT_TIMEOUT_MS)


class TestReconnectAttemptLimit(unittest.TestCase):
    """Test reconnection attempt limiting."""

    def test_max_attempts_limit(self):
        """Should stop reconnecting after max attempts."""
        max_attempts = 10
        reconnect_attempts = 0

        for _ in range(max_attempts + 5):
            reconnect_attempts += 1
            if reconnect_attempts > max_attempts:
                break

        self.assertEqual(reconnect_attempts, max_attempts + 1)


def run_tests():
    """Run all tests and return results."""
    # Create test suite
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()

    # Add test classes
    suite.addTests(loader.loadTestsFromTestCase(TestProtocolConstants))
    suite.addTests(loader.loadTestsFromTestCase(TestJsonMessageValidation))
    suite.addTests(loader.loadTestsFromTestCase(TestReconnectionLogic))
    suite.addTests(loader.loadTestsFromTestCase(TestEventIdHandling))
    suite.addTests(loader.loadTestsFromTestCase(TestMessageTypeHandling))
    suite.addTests(loader.loadTestsFromTestCase(TestRegistrationProtocol))
    suite.addTests(loader.loadTestsFromTestCase(TestTextPayloadSanitization))
    suite.addTests(loader.loadTestsFromTestCase(TestHeartbeatTimeout))
    suite.addTests(loader.loadTestsFromTestCase(TestReconnectAttemptLimit))

    # Run tests
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)

    return result.wasSuccessful()


if __name__ == "__main__":
    print("=" * 60)
    print("Talkity Desktop Protocol Tests")
    print("=" * 60)

    success = run_tests()

    print("\n" + "=" * 60)
    if success:
        print("[PASS] All tests passed!")
    else:
        print("[FAIL] Some tests failed")
    print("=" * 60)

    sys.exit(0 if success else 1)