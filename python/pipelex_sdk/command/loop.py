"""The command's one event loop, and how Ctrl-C stops what runs on it.

Every check that needs no request runs before the loop starts, on the main thread, where Ctrl-C
raises `KeyboardInterrupt` at once, a read that blocks (stdin, a named pipe, a stalled mount)
included. Once the loop runs, the first Ctrl-C cancels the command's task, as `asyncio.run` does, and
`KeyboardInterrupt` is raised once the task has unwound. Along the way, the command keeps these promises:

- **Nothing is sent once the interrupt has landed.** Python runs its signal handler between two
  bytecodes, so the cancellation can land while the task runs, and it is delivered at the task's
  next suspension. The command calls `before_request` right before each request it makes, so an
  interrupt that landed while an answer was being read stops the command there, before the next
  request leaves.
- **A read the command stopped waiting for does not hold the process.** `upload_file` reads a local
  file in a worker thread, and a thread blocked in a read cannot be stopped. `asyncio.run` waits for
  its default executor's threads before it returns, which would keep a command interrupted during
  such a read waiting forever, so the loop runs its threaded work on daemon threads it never waits
  for.
"""

from __future__ import annotations

import asyncio
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from typing import TYPE_CHECKING, Any, TypeVar

from typing_extensions import override

if TYPE_CHECKING:
    from collections.abc import Callable, Coroutine

_T = TypeVar("_T")


class _AbandoningExecutor(ThreadPoolExecutor):
    """Run each call on a daemon thread of its own, and never wait for one on shutdown.

    The loop's threaded work is a handful of file reads, so a thread per call costs nothing, and
    a daemon thread blocked in a read is left behind when the process ends. It derives from
    `ThreadPoolExecutor` only because a loop's default executor must be one; none of the pool's own
    threads is ever started, so the interpreter has none of them to join at exit either.
    """

    @override
    def submit(self, fn: Callable[..., _T], /, *args: Any, **kwargs: Any) -> Future[_T]:
        future: Future[_T] = Future()

        def work() -> None:
            if not future.set_running_or_notify_cancel():
                return
            try:
                result = fn(*args, **kwargs)
            except BaseException as exc:  # handed to the awaiting coroutine, which raises it
                future.set_exception(exc)
            else:
                future.set_result(result)

        threading.Thread(target=work, name="pipelex-sdk-command", daemon=True).start()
        return future

    @override
    def shutdown(self, wait: bool = True, *, cancel_futures: bool = False) -> None:
        """Return at once: a thread still running is blocked in a read the command no longer wants."""


def run_until_done(main: Coroutine[Any, Any, _T]) -> _T:
    """Run the command's asynchronous part to its end, as `asyncio.run` does, on a loop whose
    threaded work never holds the command after an interrupt.

    Raises:
        KeyboardInterrupt: Ctrl-C, once the task it cancelled has unwound.
    """
    with asyncio.Runner() as runner:
        loop = runner.get_loop()
        loop.set_default_executor(_AbandoningExecutor())
        try:
            return runner.run(main)
        except KeyboardInterrupt:
            # A Ctrl-C that lands once the task is done is raised from inside the loop, with the task's
            # own callback, the one that stops the loop, still queued. The runner's close would run it
            # while it waits for the executor's shutdown, stop there and fail. One turn of the loop
            # runs it first, so the close completes and the interrupt is what the command reports.
            loop.call_soon(loop.stop)
            loop.run_forever()
            raise


async def before_request() -> None:
    """Give an interrupt that has already landed its chance to stop the command before a request.

    Raises:
        asyncio.CancelledError: Ctrl-C landed since the task last waited.
    """
    await asyncio.sleep(0)
