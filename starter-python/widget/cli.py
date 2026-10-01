"""The `widget` CLI — one binary, three execution modes, one command group each.

The mode is the command group, not an option: `widget blocking …`, `widget attended …`,
`widget detached …`. Every demo method exists in all three, so picking a mode is picking
a group, and reading a mode means reading exactly one file — `widget/<mode>/cli.py`, a
self-contained copy-paste unit with no dispatch layer between the command and the SDK
call it makes.

This module is the assembler and nothing else: it loads `.env` and mounts the three
groups in reading order (blocking, then attended, then detached — how you'd learn them).
"""

import typer
from dotenv import load_dotenv

from widget.attended.cli import app as attended_app
from widget.blocking.cli import app as blocking_app
from widget.detached.cli import app as detached_app

app = typer.Typer(no_args_is_help=True, help="Run the demo Pipelex methods through the Pipelex API.")

app.add_typer(blocking_app, name="blocking", help="One call, one response. Start here — but a run over ~30s is cut off on hosted.")
app.add_typer(attended_app, name="attended", help="Start a durable run and wait here for the result. No cap.")
app.add_typer(detached_app, name="detached", help="Start a durable run and exit; collect it later by run id.")


@app.callback()
def main() -> None:
    """Load .env so PIPELEX_BASE_URL / PIPELEX_API_KEY are available."""
    load_dotenv()


if __name__ == "__main__":
    app()
