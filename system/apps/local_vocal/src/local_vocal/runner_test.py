"""Route tests for the thin static server (no network, via Flask's test client)."""

import pytest

from local_vocal.runner import app


@pytest.fixture
def client():
    app.config["TESTING"] = True
    return app.test_client()


def test_health_ok(client) -> None:
    res = client.get("/health")
    assert res.status_code == 200
    assert res.get_json() == {"status": "ok"}


def test_index_inlines_both_modules(client) -> None:
    res = client.get("/")
    assert res.status_code == 200
    html = res.get_data(as_text=True)
    # The model and the driver are stitched in, not left as separate <script src>.
    assert '<script src="voice_session.js"></script>' not in html
    assert '<script src="voice_capture.js"></script>' not in html
    # A marker unique to the model source proves voice_session.js was inlined.
    assert "class StreamingTurn" in html
    # A marker unique to the driver source proves voice_capture.js was inlined.
    assert "root.LocalVocal = LocalVocal" in html
    # And the page wires the DOM to the driver.
    assert "LocalVocal.listen" in html or "LV.listen" in html


def test_modules_served_standalone(client) -> None:
    session = client.get("/voice_session.js")
    assert session.status_code == 200
    assert "javascript" in session.headers["Content-Type"]
    assert "class StreamingTurn" in session.get_data(as_text=True)

    capture = client.get("/voice_capture.js")
    assert capture.status_code == 200
    assert "javascript" in capture.headers["Content-Type"]
    assert "LocalVocal" in capture.get_data(as_text=True)
