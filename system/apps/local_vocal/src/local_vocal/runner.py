"""Local-Vocal: a client-side-only demo of on-device voice IN and voice OUT.

This Flask app is a THIN static server. It has no transcription, no storage, no
LLM, and no keys: the entire voice pipeline runs in the browser. It only:

- serves the demo page (``assets/app.html``) with the two JS modules inlined, and
- answers ``GET /health``.

The two modules are kept as separate, unit-tested files on disk and stitched into
the page at serve time (rather than referenced with a second ``<script src>``).
Inlining sidesteps any proxy / service-worker fetch quirk for sibling module
requests -- the page carries everything it needs in one document, exactly the
approach the interview bot uses. The modules are also served standalone (for
direct use and quick inspection).

Conventions (the app runs from the repo root, ``/home/user/workspace``):

- Static assets shipped alongside this file use ``Path(__file__).parent / "assets/..."``.
- ``PORT`` defaults to this app's assigned port but honors ``LOCAL_VOCAL_PORT`` so
  an editing agent can boot a throwaway instance on a spare port (see update-app).

This app stores nothing, so it defines no ``DATA_DIR``.
"""

import os
from pathlib import Path

from flask import Flask, Response
from werkzeug.serving import run_simple

# Listen port. Defaults to this app's assigned port but is overridable via the
# LOCAL_VOCAL_PORT env var so an editing agent can boot a throwaway instance on a
# spare port next to the live one (see the update-app skill).
PORT = int(os.environ.get("LOCAL_VOCAL_PORT", "8084"))

app = Flask("local_vocal", static_folder=None)

_ASSETS = Path(__file__).parent / "assets"

# The page references each module with a plain <script src>; at serve time we
# replace those tags with the module's source inlined in a <script> block.
_MODULE_TAGS = {
    '<script src="voice_session.js"></script>': "voice_session.js",
    '<script src="voice_capture.js"></script>': "voice_capture.js",
}


def _render_page() -> str:
    html = (_ASSETS / "app.html").read_text()
    for tag, filename in _MODULE_TAGS.items():
        module = (_ASSETS / filename).read_text()
        html = html.replace(tag, f"<script>\n{module}\n</script>")
    return html


@app.route("/")
def index() -> Response:
    return Response(_render_page(), mimetype="text/html")


@app.route("/voice_session.js")
def voice_session_js() -> Response:
    """The DOM-free voice model, served standalone (the page inlines it)."""
    return Response((_ASSETS / "voice_session.js").read_text(), mimetype="text/javascript")


@app.route("/voice_capture.js")
def voice_capture_js() -> Response:
    """The reusable voice driver, served standalone (the page inlines it)."""
    return Response((_ASSETS / "voice_capture.js").read_text(), mimetype="text/javascript")


@app.route("/health")
def health() -> Response:
    return Response('{"status": "ok"}', mimetype="application/json")


def main() -> None:
    run_simple(
        "127.0.0.1", PORT, app, threaded=True, use_reloader=False, use_debugger=False
    )


if __name__ == "__main__":
    main()
