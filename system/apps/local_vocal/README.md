# Local-Vocal

A minimal, **client-side-only** browser demo of on-device voice **in** and voice
**out**. Everything runs in your browser: no API, no key, no server round-trip.
The models are fetched once from a CDN and cached by the browser.

- **Voice IN** — speak, and your words appear as a live caption and as finalized
  turns, for utterances of any length. Pipeline: Silero VAD (speech detection) →
  Moonshine ASR (transformers.js, in a Web Worker) → the streaming
  "commit-and-slice" transcriber.
- **Voice OUT** — type any text and Local-Vocal speaks it with on-device Kokoro
  TTS (with the browser's `speechSynthesis` as a fallback).

The Flask server (`runner.py`) is a **thin static server only**: it serves the
page (with the JS modules inlined) and a `/health` endpoint. There is no
server-side transcription, no turn storage, and no LLM.

## Files

- `assets/voice_session.js` — **the model.** A DOM-free, dependency-free module:
  `StreamingTurn` (the commit-and-slice transcriber), `Transcript`, and the text
  helpers (`collapseRepeats`, `cleanAsrText`, `dropSeamOverlap`, `frameRms`,
  `normWord`, `normText`). Loads as `window.VoiceSession` in the browser and as a
  CommonJS module for `node --test`. This is the battle-tested core, kept
  byte-identical to the version proven out in the interview bot.
- `assets/voice_session.test.mjs` — 18 `node --test` invariants for the model.
- `assets/voice_capture.js` — **the reusable driver** (`window.LocalVocal`). It
  owns the microphone pipeline (VAD + the ASR Web Worker + `StreamingTurn`
  wiring) and the speech pipeline (Kokoro TTS). It touches no app-specific DOM;
  the page passes callbacks.
- `assets/app.html` — the demo page: a mic orb / level meter, a live caption
  (committed styled solid, tentative styled faint), a list of finalized turns
  (each with its exact captured audio), and a "type text and Speak it" control.
- `src/local_vocal/runner.py` — the thin Flask server (inlines the two modules
  into the page at serve time; serves `/health`).
- `src/local_vocal/voice_session_js_test.py` — pytest wrapper that runs the
  `node --test` invariants (skips cleanly if node is absent).
- `src/local_vocal/runner_test.py` — route tests (`/health`; the page inlines
  both modules; the modules are served standalone).

## The `LocalVocal` driver API (`voice_capture.js`)

```js
LocalVocal.init({ onStatus })          // begin loading the ASR model (idempotent)
LocalVocal.status                       // "idle" | "loading" | "ready" | "error"
LocalVocal.whenReady()                  // Promise, resolves when the ASR model is loaded
LocalVocal.listen({                     // start VAD + ASR; returns a handle { stop() }
  onCaption(stable, tentative),         //   live caption of the active turn (both "" clears it)
  onTurn(text, wavBlob),                //   a finalized turn: committed text + its exact audio
  onLevel(level),                       //   per-frame mic level in [0,1], for a meter
  onError(error),                       //   a recoverable pipeline error
  onStatus(status, detail),             //   optional model-loading progress
})
LocalVocal.speak(text)                  // Promise, resolves when speaking finishes (Kokoro → system voice)
LocalVocal.stopSpeaking()               // interrupt any current speech
LocalVocal.encodeWav(float32, sampleRate) // -> Blob (16-bit PCM WAV of the samples)
```

Load `voice_session.js` **before** `voice_capture.js` (the driver reads the model
off the `VoiceSession` global). The driver injects the VAD library from its CDN
on the first `listen()` if the page hasn't already loaded it.

## Key design decisions

**One streaming mechanism, model-as-source-of-truth.** A single `StreamingTurn`
per VAD speech segment powers *both* the live caption and the finalized turn. The
caption is always `committed words + current window hypothesis`; the saved turn is
simply `committedText` once the last chunk folds in. Nothing is ever read back
out of the DOM — display, scrolling, or errors cannot corrupt what was said.

**Silence-anchored commit-and-slice.** Moonshine is a short-audio model whose
decoder loops past ~20s, and it returns only `{text}` — **no word timestamps**.
So the turn's audio rolls through a bounded ~20s window; when the window exceeds
the cap, the model slices off a *head* of audio at a genuine pause — a contiguous
low-energy run of **≥ 200ms** (a real inter-word gap, never a stop-consonant
closure) — transcribes it, and folds the text into the committed words. Because
the cut lands in silence, **no word is split**. Slice points come from audio
*energy*, not token times, precisely because the model has no timestamps.

**LocalAgreement-2 for caption stability.** Consecutive window hypotheses are
compared; their agreed prefix is styled "stable", the rest "tentative", so the
caption doesn't flicker.

**Forced-cut backstop + word-level seam de-dup.** If no qualifying pause is found
by a ~30s hard cap, a cut is forced at the quietest frame near the cap. On such a
forced cut the ASR can hear the boundary word on both sides, so a capped
word-level seam de-dup drops a leading chunk word that repeats the committed tail.
On pause-anchored cuts the chunks share no audio, so this rarely fires.

**Client-side / on-device, no keys.** VAD, ASR, and TTS all run in the browser
via WebAssembly / WebGPU. The server never sees audio or text.

## CDN libraries (pinned)

`@ricky0123/vad-web@0.0.30`, `onnxruntime-web@1.22.0`, `@huggingface/transformers@3`,
`kokoro-js@1.2.1` — the same versions the model was validated against.

## Tests

```bash
cd system/apps/local_vocal && uv run pytest
```

Runs the ratchets, the route tests, and the 18 `node --test` model invariants
(via the pytest wrapper). The live microphone / ASR / TTS path cannot be
exercised headlessly — it needs a human with a microphone in a real browser.
