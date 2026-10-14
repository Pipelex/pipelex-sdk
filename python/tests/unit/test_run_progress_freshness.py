"""Tests for `is_fresher_run_progress`, the rule a reader keeps the fresher of two progress snapshots by."""

from typing import Any

import pytest

from pipelex_sdk.runs import RunProgress, RunProgressStatus, is_fresher_run_progress


def _snapshot(**overrides: Any) -> RunProgress:
    """A snapshot of the whole run, still going, at version 1 unless given."""
    snapshot: dict[str, Any] = {
        "pipeline_run_id": "run-1",
        "mode": "live",
        "status": "running",
        "version": 1,
        "assembled_at": "2026-10-12T09:30:00.000Z",
        "summary": "Running review_filings",
        "invocations": [],
    }
    snapshot.update(overrides)
    return RunProgress.model_validate(snapshot)


_GOING = ["pending", "running"]
_ENDED = ["succeeded", "failed", "canceled"]


class TestRunProgressFreshness:
    def test_anything_read_is_fresher_when_nothing_is_held(self) -> None:
        assert is_fresher_run_progress(_snapshot(), None) is True

    def test_the_higher_version_is_fresher_whatever_the_times(self) -> None:
        held = _snapshot(version=5, assembled_at="2026-10-12T09:31:00.000Z")

        assert is_fresher_run_progress(_snapshot(version=6), held) is True
        assert is_fresher_run_progress(_snapshot(version=4, assembled_at="2026-10-12T10:00:00Z"), held) is False

    @pytest.mark.parametrize(
        ("assembled_at", "fresher"),
        [
            pytest.param("2026-10-12T09:31:00.001Z", True, id="a-later-assembly"),
            pytest.param("2026-10-12T09:30:59.999Z", False, id="an-earlier-assembly"),
            pytest.param("2026-10-12T09:31:00Z", False, id="the-same-instant-written-without-a-fraction"),
            pytest.param("2026-10-12T11:31:00+02:00", False, id="the-same-instant-in-another-offset"),
        ],
    )
    def test_at_the_same_version_the_later_assembly_is_fresher_and_a_tie_keeps_the_one_held(self, assembled_at: str, fresher: bool) -> None:
        held = _snapshot(version=5, assembled_at="2026-10-12T09:31:00.000Z")

        assert is_fresher_run_progress(_snapshot(version=5, assembled_at=assembled_at), held) is fresher

    def test_the_assembly_times_compare_as_instants_microseconds_and_offsets_included(self) -> None:
        # As text, `06.870Z` sorts after `06.870123Z`.
        held = _snapshot(assembled_at="2026-10-12T09:30:06.870Z")
        microseconds_later = _snapshot(assembled_at="2026-10-12T09:30:06.870123Z")

        assert is_fresher_run_progress(microseconds_later, held) is True
        assert is_fresher_run_progress(held, microseconds_later) is False
        assert is_fresher_run_progress(_snapshot(assembled_at="2026-10-12T11:30:07+02:00"), held) is True
        assert is_fresher_run_progress(_snapshot(assembled_at="2026-10-12t09:30:07z"), held) is True
        # Digits past the microsecond are dropped, so these two are the same instant.
        assert is_fresher_run_progress(_snapshot(assembled_at="2026-10-12T09:30:06.8700009Z"), held) is False

    @pytest.mark.parametrize(
        "unreadable",
        [
            pytest.param("yesterday", id="words"),
            pytest.param("2026-10-12", id="a-date-alone"),
            pytest.param("2026-10-12T09:30:07", id="no-zone"),
            pytest.param("2026-10-12T09:30:07Z\n", id="a-trailing-line-break"),
            pytest.param("2026-13-12T09:30:07Z", id="a-month-that-does-not-exist"),
            pytest.param("２０２６-10-12T09:30:07Z", id="digits-outside-ascii"),
        ],
    )
    def test_times_that_cannot_be_compared_keep_the_one_held(self, unreadable: str) -> None:
        held = _snapshot(assembled_at="2026-10-12T09:30:06.870Z")

        assert is_fresher_run_progress(_snapshot(assembled_at=unreadable), held) is False
        assert is_fresher_run_progress(held, _snapshot(assembled_at=unreadable)) is False

    @pytest.mark.parametrize("ended", _ENDED)
    @pytest.mark.parametrize("going", _GOING)
    def test_a_snapshot_of_the_ended_run_is_never_traded_for_one_still_going(self, ended: str, going: str) -> None:
        held = _snapshot(status=ended, version=20, assembled_at="2026-10-12T09:31:00Z")
        read = _snapshot(status=going, version=26, assembled_at="2026-10-12T09:32:00Z")

        assert is_fresher_run_progress(read, held) is False
        # And the other way round: the ended one wins even from a lower version and an earlier assembly.
        assert is_fresher_run_progress(held, read) is True

    def test_a_later_snapshot_of_the_ended_run_is_taken_by_version_then_by_assembly(self) -> None:
        held = _snapshot(status="failed", version=20, assembled_at="2026-10-12T09:31:00Z")

        assert is_fresher_run_progress(_snapshot(status="failed", version=21), held) is True
        assert is_fresher_run_progress(_snapshot(status="canceled", version=19), held) is False
        assert is_fresher_run_progress(_snapshot(status="failed", version=20, assembled_at="2026-10-12T09:31:01Z"), held) is True

    def test_a_status_this_sdk_does_not_know_leaves_the_versions_to_decide(self) -> None:
        held = _snapshot(status="failed", version=20)

        assert is_fresher_run_progress(_snapshot(status="paused", version=26), held) is True
        assert is_fresher_run_progress(_snapshot(status="paused", version=19), held) is False

    @pytest.mark.parametrize(
        ("status", "is_ended"),
        [
            (RunProgressStatus.PENDING, False),
            (RunProgressStatus.RUNNING, False),
            (RunProgressStatus.SUCCEEDED, True),
            (RunProgressStatus.FAILED, True),
            (RunProgressStatus.CANCELED, True),
        ],
    )
    def test_a_progress_status_says_whether_the_run_has_ended(self, status: RunProgressStatus, is_ended: bool) -> None:
        assert status.is_ended is is_ended
