"""`script`'s write of its file, with an interrupt landing at each point Python can raise one once the file exists.

Python raises `KeyboardInterrupt` from a signal handler only where its interpreter checks for pending work: at
the end of each call and at each backward jump. The test watches each instruction `_write_script` runs and
raises one at each such point it passes once its file exists on disk, one point per run, until a run finishes
before reaching its point. Wherever the interrupt lands, the file the call created is whole and the interrupt's
message says it was written, or the file is gone and the message says nothing was, and no descriptor is left
open.
"""

from __future__ import annotations

import dis
import itertools
import os
import sys
from contextlib import contextmanager
from typing import TYPE_CHECKING, Any

import pytest

from pipelex_sdk.command.io import Progress
from pipelex_sdk.command.script import _write_script

if TYPE_CHECKING:
    from collections.abc import Callable, Generator
    from pathlib import Path
    from types import CodeType, FrameType

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
    """Raise `KeyboardInterrupt` at the `point`-th place, counted from 0, where a signal handler could raise one
    in `_write_script` once `path` exists, `observe` being told of each instruction about to run.
    """

    def __init__(self, path: Path, point: int) -> None:
        self._path = path
        self._point = point
        self._passed = 0
        self._last: int | None = None
        self.landed = False

    def observe(self, offset: int) -> None:
        last, self._last = self._last, offset
        if not self.landed and last in _CHECKED and self._path.exists():
            if self._passed == self._point:
                self.landed = True
                raise KeyboardInterrupt
            self._passed += 1


@contextmanager
def _instructions_observed(code: CodeType, observe: Callable[[int], None]) -> Generator[None]:
    """Call `observe` with the offset of each instruction of `code` about to run, an exception it raises being
    raised by that instruction.

    From Python 3.12, through `sys.monitoring`'s `INSTRUCTION` event, set on `code` alone: on 3.12 a trace
    function's opcode events never come, since setting `f_trace_opcodes` from the trace function has no effect
    there (they come again from 3.13), and `sys.monitoring` is the instruction-level hook `sys.settrace` itself is
    built on from 3.12. On 3.11, which has no `sys.monitoring`, through the opcode events of `sys.settrace`.
    """
    if sys.version_info >= (3, 12):
        monitoring = sys.monitoring
        tool = next(candidate for candidate in range(6) if monitoring.get_tool(candidate) is None)
        monitoring.use_tool_id(tool, "pipelex-sdk script write test")

        def on_instruction(instruction_code: CodeType, offset: int) -> None:
            del instruction_code
            observe(offset)

        monitoring.register_callback(tool, monitoring.events.INSTRUCTION, on_instruction)
        monitoring.set_local_events(tool, code, monitoring.events.INSTRUCTION)
        try:
            yield
        finally:
            monitoring.set_local_events(tool, code, monitoring.events.NO_EVENTS)
            monitoring.register_callback(tool, monitoring.events.INSTRUCTION, None)
            monitoring.free_tool_id(tool)
    else:

        def trace_instructions(frame: FrameType, event: str, arg: Any) -> Any:
            del arg
            frame.f_trace_opcodes = True
            if event == "opcode":
                observe(frame.f_lasti)
            return trace_instructions

        def trace_calls(frame: FrameType, event: str, arg: Any) -> Any:
            del arg
            if event == "call" and frame.f_code is code:
                frame.f_trace_opcodes = True
                return trace_instructions
            return None

        previous_trace = sys.gettrace()
        sys.settrace(trace_calls)
        try:
            yield
        finally:
            sys.settrace(previous_trace)


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
            try:
                with _instructions_observed(_write_script.__code__, interrupt.observe):
                    _write_script(str(target), _BODY, progress)
            except KeyboardInterrupt:
                assert interrupt.landed

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

        # The file exists from the open on, so at least the point right after it was tried: a version whose
        # instructions went unobserved fails here rather than passing without trying any point.
        assert points_tried > 0
