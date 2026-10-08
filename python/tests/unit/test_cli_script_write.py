"""`script`'s write of its file, with an interrupt landing at each point Python can raise one once the file exists.

Python raises `KeyboardInterrupt` from a signal handler only where its interpreter checks for pending work: at
the end of each call and at each backward jump. An opcode trace here raises one at each such point that
`_write_script` passes once its file exists on disk, one point per run, until a run finishes before reaching
its point. Wherever the interrupt lands, the file the call created is whole and the interrupt's message says it
was written, or the file is gone and the message says nothing was, and no descriptor is left open.
"""

from __future__ import annotations

import dis
import itertools
import os
import sys
from typing import TYPE_CHECKING, Any

import pytest

from pipelex_sdk.command.io import Progress
from pipelex_sdk.command.script import _write_script

if TYPE_CHECKING:
    from pathlib import Path
    from types import FrameType

_NOTHING_WRITTEN = "Interrupted. Nothing was written."
_BODY = "#!/bin/sh\n# A script, written whole or not at all.\nexec true\n"

# The instructions at whose end the interpreter checks for a pending signal, so that a `KeyboardInterrupt`
# raised by Python's handler lands right after them.
_CHECKED = {
    instruction.offset
    for instruction in dis.get_instructions(_write_script)
    if instruction.opname.startswith("CALL") or instruction.opname == "JUMP_BACKWARD"
}


class _InterruptAt:
    """An opcode trace raising `KeyboardInterrupt` at the `point`-th place, counted from 0, where a signal
    handler could raise one in `_write_script` once `path` exists.
    """

    def __init__(self, path: Path, point: int) -> None:
        self._path = path
        self._point = point
        self._passed = 0
        self._last: int | None = None
        self.landed = False

    def trace_calls(self, frame: FrameType, event: str, arg: Any) -> Any:
        del arg
        if event == "call" and frame.f_code is _write_script.__code__:
            frame.f_trace_opcodes = True
            return self.trace_instructions
        return None

    def trace_instructions(self, frame: FrameType, event: str, arg: Any) -> Any:
        del arg
        # Set again on the frame's own events: from the call event alone, Python 3.13 sends no opcode events.
        frame.f_trace_opcodes = True
        if event == "opcode":
            last, self._last = self._last, frame.f_lasti
            if not self.landed and last in _CHECKED and self._path.exists():
                if self._passed == self._point:
                    self.landed = True
                    raise KeyboardInterrupt
                self._passed += 1
        return self.trace_instructions


def _open_descriptors() -> list[str]:
    return sorted(os.listdir("/dev/fd"))


class TestScriptWrite:
    @pytest.mark.skipif(os.name != "posix", reason="the open descriptors are listed in /dev/fd")
    def test_an_interrupt_once_the_file_exists_leaves_it_whole_or_absent(self, tmp_path: Path) -> None:
        target = tmp_path / "script"
        points_tried = 0
        for point in itertools.count():
            target.unlink(missing_ok=True)
            progress = Progress()
            progress.interrupt_message = _NOTHING_WRITTEN
            interrupt = _InterruptAt(target, point)
            descriptors = _open_descriptors()
            previous_trace = sys.gettrace()
            sys.settrace(interrupt.trace_calls)
            try:
                _write_script(str(target), _BODY, progress)
            except KeyboardInterrupt:
                assert interrupt.landed
            finally:
                sys.settrace(previous_trace)

            where = f"interrupt at point {point}"
            assert _open_descriptors() == descriptors, where
            if target.exists():
                assert target.read_text() == _BODY, where
                assert progress.interrupt_message == f"Interrupted. {target} was written.", where
            else:
                assert progress.interrupt_message == _NOTHING_WRITTEN, where
            if not interrupt.landed:
                break
            points_tried += 1

        # The file exists from the open on, so at least the point right after it was tried.
        assert points_tried > 0
