"""The receiver side of a caller webhook: `verify_webhook` held to the contract's known-answer vectors, vendored byte
for byte from the conformance repository in `fixtures/caller-webhooks/`, then to the shared cases of
`fixtures/webhook-events.json`, which say what each verified body reads as and which secrets are refused.
`@pipelex/sdk` runs the same two files in `tests/webhooks.test.ts`.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

import httpx
import pytest
from werkzeug.datastructures import EnvironHeaders, Headers

from pipelex_sdk.errors import RequestArgumentError, WebhookEventUnreadableError, WebhookRefusal, WebhookVerificationError
from pipelex_sdk.webhooks import RunFinishedEvent, UnknownWebhookEvent, WebhookHeaders, verify_webhook

_FIXTURES = Path(__file__).parent.parent / "fixtures"
_VECTOR_BYTES = (_FIXTURES / "caller-webhooks" / "signature-vectors.json").read_bytes()
_VECTORS: dict[str, Any] = json.loads(_VECTOR_BYTES)
_VENDORED: dict[str, Any] = json.loads((_FIXTURES / "caller-webhooks" / "vendored.json").read_text(encoding="utf-8"))
_CASES: dict[str, Any] = json.loads((_FIXTURES / "webhook-events.json").read_text(encoding="utf-8"))

_VERIFICATION: list[dict[str, Any]] = _VECTORS["verification"]
_SIGNING: list[dict[str, Any]] = _VECTORS["signing"]
_CALLS: list[dict[str, Any]] = _CASES["calls"]
_SECRETS: list[dict[str, Any]] = _CASES["secrets"]


def _clock_at(unix_seconds: int) -> datetime:
    return datetime.fromtimestamp(unix_seconds, tz=UTC)


def _signature_of(secret: str, webhook_id: str, timestamp: str, body: bytes) -> str:
    """The base64 HMAC-SHA256 a sender writes for `body` under `secret`."""
    key = base64.b64decode(secret.removeprefix("whsec_"))
    return base64.b64encode(hmac.new(key, f"{webhook_id}.{timestamp}.".encode() + body, hashlib.sha256).digest()).decode("ascii")


def _signed_call(call: dict[str, Any]) -> tuple[bytes, dict[str, str]]:
    """A shared case's call, signed under the case file's secret as its fields say."""
    body = base64.b64decode(call["body_base64"]) if "body_base64" in call else call["body"].encode("utf-8")
    timestamp: str = call.get("webhook_timestamp", _CASES["webhook_timestamp"])
    signature = _signature_of(_CASES["secret"], _CASES["webhook_id"], timestamp, body)
    header = call.get("signature_header", "{v1}").replace("{v1}", f"v1,{signature}").replace("{signature}", signature)
    return body, {"webhook-id": _CASES["webhook_id"], "webhook-timestamp": timestamp, "webhook-signature": header}


def _ids(cases: list[dict[str, Any]]) -> list[str]:
    return [case["name"] for case in cases]


def _completed_call() -> tuple[bytes, dict[str, str]]:
    """The shared case of a completed self-hosted run, signed, its headers named in lowercase."""
    return _signed_call(next(one for one in _CALLS if one["name"] == "self-hosted/completed"))


def _refusal_params(headers: object) -> dict[str, Any]:
    """The `params` of the argument refusal `verify_webhook` raises for the completed call under `headers`."""
    body, _ = _completed_call()
    with pytest.raises(RequestArgumentError) as caught:
        verify_webhook(body, cast("WebhookHeaders", headers), _CASES["secret"], now=_clock_at(_CASES["receiver_clock"]))
    assert caught.value.problem.params is not None
    return caught.value.problem.params.as_wire()


# A signature no secret of the case file makes, standing for another sender's or a stale one, padded so that a comma
# joining a repeated header follows its padding.
_OTHER_SIGNATURE = "v1,ZmFrZQ=="


class TestVerifyWebhook:
    def test_the_vendored_vectors_are_the_conformance_file_byte_for_byte(self) -> None:
        record = _VENDORED["files"]["signature-vectors.json"]
        assert _VENDORED["source"]["repository"] == "Pipelex/conformance"
        assert len(_VENDORED["source"]["commit"]) == 40
        assert record["path"] == "tests/caller_webhooks/fixtures/signature-vectors.json"
        assert hashlib.sha256(_VECTOR_BYTES).hexdigest() == record["sha256"]

    def test_the_vectors_set_the_tolerance_the_sdk_applies(self) -> None:
        assert _VECTORS["timestamp_tolerance_seconds"] == 300

    @pytest.mark.parametrize("vector", _VERIFICATION, ids=_ids(_VERIFICATION))
    def test_a_verification_vector(self, vector: dict[str, Any]) -> None:
        now = _clock_at(vector["receiver_clock"])
        if vector["verdict"] == "accepted":
            event = verify_webhook(vector["body"], vector["headers"], vector["secret"], now=now)
            assert isinstance(event, RunFinishedEvent)
            assert event.model_dump(mode="json", exclude_unset=True) == json.loads(vector["body"])
            return
        with pytest.raises(WebhookVerificationError) as caught:
            verify_webhook(vector["body"], vector["headers"], vector["secret"], now=now)
        assert caught.value.refusal == WebhookRefusal(vector["refusal"])

    @pytest.mark.parametrize("vector", _VERIFICATION, ids=_ids(_VERIFICATION))
    def test_a_verification_vector_from_the_body_bytes_and_a_list_of_secrets(self, vector: dict[str, Any]) -> None:
        now = _clock_at(vector["receiver_clock"])
        body = vector["body"].encode("utf-8")
        if vector["verdict"] == "accepted":
            event = verify_webhook(body, vector["headers"], [vector["secret"]], now=now)
            assert event.model_dump(mode="json", exclude_unset=True) == json.loads(vector["body"])
            return
        with pytest.raises(WebhookVerificationError) as caught:
            verify_webhook(body, vector["headers"], [vector["secret"]], now=now)
        assert caught.value.refusal == WebhookRefusal(vector["refusal"])

    @pytest.mark.parametrize("vector", _SIGNING, ids=_ids(_SIGNING))
    def test_a_signing_vector_verifies_under_each_secret_that_signed_it_and_under_all(self, vector: dict[str, Any]) -> None:
        headers = {
            "webhook-id": vector["webhook_id"],
            "webhook-timestamp": vector["webhook_timestamp"],
            "webhook-signature": vector["webhook_signature"],
        }
        now = _clock_at(int(vector["webhook_timestamp"]))
        secret_sets: list[list[str]] = [[secret] for secret in vector["secrets"]]
        secret_sets.append(vector["secrets"])
        for secrets in secret_sets:
            event = verify_webhook(vector["body"], headers, secrets, now=now)
            assert event.model_dump(mode="json", exclude_unset=True) == json.loads(vector["body"])

    @pytest.mark.parametrize("vector", _SIGNING, ids=_ids(_SIGNING))
    def test_the_signature_a_sender_writes_is_the_vectors(self, vector: dict[str, Any]) -> None:
        body = vector["body"].encode("utf-8")
        written = " ".join(f"v1,{_signature_of(secret, vector['webhook_id'], vector['webhook_timestamp'], body)}" for secret in vector["secrets"])
        assert written == vector["webhook_signature"]

    @pytest.mark.parametrize("call", _CALLS, ids=_ids(_CALLS))
    def test_a_shared_call(self, call: dict[str, Any]) -> None:
        body, headers = _signed_call(call)
        now = _clock_at(_CASES["receiver_clock"])
        expected: dict[str, Any] = call["expect"]
        if "event" in expected:
            wanted: dict[str, Any] = expected["event"]
            event = verify_webhook(body, headers, _CASES["secret"], now=now)
            assert event.type == wanted["type"]
            assert isinstance(event, RunFinishedEvent) is wanted["known"]
            if not isinstance(event, RunFinishedEvent):
                assert isinstance(event, UnknownWebhookEvent)
                return
            assert event.attempt == wanted["attempt"]
            assert (event.data.error.code if event.data.error is not None else None) == wanted["error_code"]
            data = event.data.model_dump(mode="json")
            for member, value in wanted.get("data", {}).items():
                assert data[member] == value
        elif "refusal" in expected:
            with pytest.raises(WebhookVerificationError) as refused:
                verify_webhook(body, headers, _CASES["secret"], now=now)
            assert refused.value.refusal == WebhookRefusal(expected["refusal"])
            assert refused.value.problem.code == _CASES["refusals"][expected["refusal"]]
        else:
            with pytest.raises(WebhookEventUnreadableError) as unreadable:
                verify_webhook(body, headers, _CASES["secret"], now=now)
            assert unreadable.value.problem.code == expected["unreadable"]["code"]
            assert unreadable.value.problem.params is not None
            assert unreadable.value.problem.params.as_wire() == expected["unreadable"]["params"]

    @pytest.mark.parametrize("refusal", list(WebhookRefusal))
    def test_each_refusal_carries_its_problem_and_is_no_request_error(self, refusal: WebhookRefusal) -> None:
        vector = next(one for one in _VERIFICATION if one.get("refusal") == refusal)

        with pytest.raises(WebhookVerificationError) as caught:
            verify_webhook(vector["body"], vector["headers"], vector["secret"], now=_clock_at(vector["receiver_clock"]))

        assert caught.value.problem.code == _CASES["refusals"][refusal]
        assert not isinstance(caught.value, RequestArgumentError)

    def test_reads_a_header_given_as_several_values_as_those_values_joined(self) -> None:
        vector = next(one for one in _SIGNING if one["name"] == "rotation")
        current, previous = vector["webhook_signature"].split(" ")
        headers: dict[str, str | list[str]] = {
            "webhook-id": vector["webhook_id"],
            "webhook-timestamp": vector["webhook_timestamp"],
            "webhook-signature": [current, previous],
        }

        event = verify_webhook(vector["body"], headers, vector["secrets"][1], now=_clock_at(int(vector["webhook_timestamp"])))

        assert event.type == "run.finished"

    def test_verifies_against_the_current_time_when_no_clock_is_given(self) -> None:
        call = next(one for one in _CALLS if one["name"] == "self-hosted/completed")
        body, headers = _signed_call({**call, "webhook_timestamp": str(int(time.time()))})

        event = verify_webhook(body, headers, _CASES["secret"])

        assert isinstance(event, RunFinishedEvent)

    @pytest.mark.parametrize("wrap", [bytearray, memoryview], ids=["bytearray", "memoryview"])
    def test_verifies_a_body_given_as_another_bytes_like(self, wrap: type[bytearray | memoryview]) -> None:
        call = next(one for one in _CALLS if one["name"] == "self-hosted/completed")
        body, headers = _signed_call(call)

        event = verify_webhook(wrap(body), headers, _CASES["secret"], now=_clock_at(_CASES["receiver_clock"]))

        assert isinstance(event, RunFinishedEvent)

    @pytest.mark.parametrize("refused", _SECRETS, ids=_ids(_SECRETS))
    def test_a_refused_secret(self, refused: dict[str, Any]) -> None:
        vector = _VERIFICATION[0]

        with pytest.raises(RequestArgumentError) as caught:
            verify_webhook(vector["body"], vector["headers"], refused["secret"], now=_clock_at(vector["receiver_clock"]))

        assert caught.value.problem.code == "client.argument_invalid"
        assert caught.value.problem.params is not None
        assert caught.value.problem.params.as_wire() == {"argument": "secret", "reason": refused["reason"]}
        # The secret is the receiver's credential, so no refusal quotes it.
        given: object = refused["secret"]
        quoted: list[object] = list(cast("list[object]", given)) if isinstance(given, list) else [given]
        for value in quoted:
            if isinstance(value, str) and len(value) > len("whsec_"):
                assert value not in str(caught.value)

    def test_refuses_a_body_that_is_neither_text_nor_bytes_before_the_call_is_looked_at(self) -> None:
        vector = _VERIFICATION[0]

        with pytest.raises(RequestArgumentError) as caught:
            verify_webhook(json.loads(vector["body"]), vector["headers"], vector["secret"])

        assert caught.value.problem.params is not None
        assert caught.value.problem.params.as_wire() == {"argument": "body", "reason": "not_text_or_bytes"}

    def test_refuses_a_clock_that_is_no_datetime(self) -> None:
        vector = _VERIFICATION[0]

        with pytest.raises(RequestArgumentError) as caught:
            verify_webhook(vector["body"], vector["headers"], vector["secret"], now=cast("datetime", vector["receiver_clock"]))

        assert caught.value.problem.params is not None
        assert caught.value.problem.params.as_wire() == {"argument": "now", "reason": "not_a_date"}

    def test_refuses_a_naive_clock(self) -> None:
        vector = _VERIFICATION[0]
        naive = _clock_at(vector["receiver_clock"]).replace(tzinfo=None)

        with pytest.raises(RequestArgumentError) as caught:
            verify_webhook(vector["body"], vector["headers"], vector["secret"], now=naive)

        assert caught.value.problem.params is not None
        assert caught.value.problem.params.as_wire() == {"argument": "now", "reason": "not_timezone_aware"}

    def test_reads_flasks_request_headers_which_iterate_as_pairs(self) -> None:
        body, headers = _completed_call()
        # Flask's `request.headers`: Werkzeug's view of the WSGI environ, which iterates as (name, value) pairs.
        environ = {f"HTTP_{name.upper().replace('-', '_')}": value for name, value in headers.items()}

        event = verify_webhook(body, EnvironHeaders(environ), _CASES["secret"], now=_clock_at(_CASES["receiver_clock"]))

        assert isinstance(event, RunFinishedEvent)

    def test_reads_a_signature_header_werkzeug_lists_twice(self) -> None:
        body, headers = _completed_call()
        werkzeug_headers = Headers(
            [
                ("Webhook-Id", headers["webhook-id"]),
                ("Webhook-Timestamp", headers["webhook-timestamp"]),
                ("Webhook-Signature", _OTHER_SIGNATURE),
                ("Webhook-Signature", headers["webhook-signature"]),
            ]
        )

        event = verify_webhook(body, werkzeug_headers, _CASES["secret"], now=_clock_at(_CASES["receiver_clock"]))

        assert isinstance(event, RunFinishedEvent)

    def test_reads_a_signature_header_httpx_joins_with_a_comma(self) -> None:
        body, headers = _completed_call()
        httpx_headers = httpx.Headers(
            [
                ("webhook-id", headers["webhook-id"]),
                ("webhook-timestamp", headers["webhook-timestamp"]),
                ("webhook-signature", headers["webhook-signature"]),
                ("webhook-signature", _OTHER_SIGNATURE),
            ]
        )
        # The matching signature comes first, so the comma httpx writes after it is what the reading must drop.
        assert httpx_headers["webhook-signature"] == f"{headers['webhook-signature']}, {_OTHER_SIGNATURE}"

        event = verify_webhook(body, httpx_headers, _CASES["secret"], now=_clock_at(_CASES["receiver_clock"]))

        assert isinstance(event, RunFinishedEvent)

    def test_reads_header_values_given_as_bytes_as_latin1_text(self) -> None:
        body, headers = _completed_call()
        bytes_headers: dict[str, bytes | list[bytes]] = {
            "Webhook-Id": headers["webhook-id"].encode("latin-1"),
            "Webhook-Timestamp": headers["webhook-timestamp"].encode("latin-1"),
            "Webhook-Signature": [_OTHER_SIGNATURE.encode("latin-1"), headers["webhook-signature"].encode("latin-1")],
        }

        event = verify_webhook(body, bytes_headers, _CASES["secret"], now=_clock_at(_CASES["receiver_clock"]))

        assert isinstance(event, RunFinishedEvent)

    @pytest.mark.parametrize("value", [1793696104, ["v1,ZmFrZQ==", 5]], ids=["a-number", "a-list-holding-a-number"])
    def test_refuses_a_header_value_that_is_neither_text_nor_bytes(self, value: object) -> None:
        _, headers = _completed_call()

        params = _refusal_params({**headers, "webhook-timestamp": value})

        assert params == {"argument": "headers", "reason": "not_text_or_bytes"}

    def test_refuses_headers_that_list_no_pairs(self) -> None:
        _, headers = _completed_call()

        params = _refusal_params(list(headers))

        assert params == {"argument": "headers", "reason": "not_a_mapping"}
