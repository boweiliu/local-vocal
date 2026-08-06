"""Run the streaming voice-model unit tests (JS) via node.

The reusable voice model lives in ``assets/voice_session.js`` -- a DOM-free
module so its commit-and-slice / authoritative-text policy can be tested off the
browser. Its invariants are expressed as ``node --test`` cases in
``assets/voice_session.test.mjs``; this wrapper runs them under pytest so the
project's suite (and CI) exercises them too, skipping cleanly where node is
unavailable.
"""

import shutil
import subprocess
from pathlib import Path

import pytest

_ASSETS = Path(__file__).parent / "assets"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available")
def test_voice_session_js_unit_tests_pass() -> None:
    result = subprocess.run(
        ["node", "--test"],
        cwd=_ASSETS,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stdout + result.stderr
