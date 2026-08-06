---
title: Local-Vocal
description: On-device VAD, live streaming speech-to-text, and text-to-speech in the browser -- no API key, no server round-trip.
thumbnail: inspiration-local-vocal.svg
version: v1
format: v1
---

# Local-Vocal

This file is the manifest for the **Local-Vocal** inspiration (slug:
`local-vocal`). It is the one document a future agent reads to understand,
present, and adapt this inspiration. If you are an agent in a mind that was
created from this inspiration, this file is your script: read all of it, then
follow "How to adapt it" below.

## What it is

On-device VAD, live streaming speech-to-text, and text-to-speech in the browser -- no API key, no server round-trip.

Local-Vocal is a self-contained, client-side-only browser component (and a demo
app to show it off) for giving a mind on-device voice **in** and voice **out** --
no API key, no server round-trip, no cloud transcription. Voice in: you speak,
and your words appear as a live caption that firms up as you go and as cleanly
finalized turns, for utterances of any length. Voice out: you hand it text and it
speaks it aloud. Everything -- speech detection, transcription, and
text-to-speech -- runs inside the browser on the user's own machine via
WebAssembly/WebGPU; the models are fetched once from public CDNs and cached
locally, and the server never sees the audio or the text. When it is running, the
user opens a tab with a microphone orb and level meter, watches their speech turn
into text live, sees a list of finalized turns (each keeping its exact captured
audio), and can type text into a box and have it spoken back. The reason this
inspiration exists is the reusable logic underneath the demo: two DOM-free modules
(`voice_session.js`, the streaming transcription model, and `voice_capture.js`,
the `window.LocalVocal` driver) that an adopting mind wires into its own
voice-driven feature.

## How it works

The snapshot includes these paths (each is a repo-root-relative path copied
from the original mind onto a clean default-workspace-template base):

- `system/apps/local_vocal`

`system/apps/local_vocal` is the whole inspiration: a standalone Flask app that
is, deliberately, a **thin static server only**. Inside it:

- `src/local_vocal/runner.py` -- the Flask server. It serves one page (with the
  two JS modules inlined at serve time) and a `/health` endpoint. There is no
  server-side transcription, no turn storage, and no LLM; the server never sees
  audio or text.
- `assets/voice_session.js` -- **the model**, and the core of the inspiration. A
  DOM-free, dependency-free module holding `StreamingTurn` (the commit-and-slice
  streaming transcriber), `Transcript`, and the text helpers. It loads as
  `window.VoiceSession` in the browser and as a CommonJS module for `node --test`.
- `assets/voice_capture.js` -- **the reusable driver**, exposed as
  `window.LocalVocal`. It owns the microphone pipeline (Silero VAD -> the
  Moonshine ASR Web Worker -> `StreamingTurn`) and the speech pipeline (Kokoro
  TTS), touches no app-specific DOM, and drives everything through callbacks:
  `init` / `whenReady` / `listen({ onCaption, onTurn, onLevel, onError })` /
  `speak` / `stopSpeaking`.
- `assets/app.html` -- the demo page: a mic orb / level meter, a live caption
  (committed text solid, tentative text faint), a list of finalized turns each
  with its captured audio, and a "type text and Speak it" control. It is a
  minimal showcase, not a product UI.

At runtime the app is a single supervisord program, `[program:local-vocal]` in
`system/supervisord.conf`. That program runs `python3 system/scripts/forward_port.py
--url http://localhost:8084 --name local-vocal && uv run local-vocal`, so the app
listens on **port 8084** and registers itself under the name `local-vocal` via
`forward_port.py` (which is how it becomes an openable tab). The repo-root
`pyproject.toml` resolves the package: `local-vocal` is listed in the project
dependencies, mapped to the workspace with `local-vocal = {workspace = true}`, and
excluded from the root pytest run (it carries its own coverage config, run from
inside its own directory). At load time the browser fetches the VAD, ASR, and TTS
models from public CDNs (jsdelivr + huggingface) and caches them; from then on the
whole pipeline runs on-device.

The reason this component is worth reusing is a handful of design decisions that
make streaming, on-device transcription actually hold together -- these are the
substance of the inspiration:

- **One streaming mechanism, model-as-source-of-truth.** A single `StreamingTurn`
  per VAD speech segment powers *both* the live caption and the finalized turn. The
  caption is always `committed words + current window hypothesis`; the saved turn
  is just `committedText` once the last chunk folds in. Nothing is ever read back
  out of the DOM, so display, scrolling, or errors cannot corrupt what was said.
  Both the on-screen display and the saved record read from that committed
  transcript model.
- **Silence-anchored commit-and-slice.** Moonshine (in transformers.js) returns
  only `{text}` -- **no word timestamps** -- and its decoder loops past ~20s. So the
  turn's audio rolls through a bounded ~20s active window; when it exceeds the cap,
  the model slices off a head of audio at a genuine pause and folds its text into
  the committed words. Slice points come from audio *energy*, not token times,
  precisely because the model has no timestamps.
- **A real pause, never mid-word.** A qualifying pause is a contiguous
  low-energy run of at least ~200ms -- long enough that a stop-consonant closure
  can't be mistaken for a word gap -- so a cut never splits a word.
- **LocalAgreement-2 for a stable caption.** Consecutive window hypotheses are
  compared; their agreed prefix is shown "stable" and the rest "tentative," so the
  live caption firms up instead of flickering.
- **Forced-cut backstop + seam de-dup.** If no qualifying pause appears by a hard
  cap, a cut is forced at the quietest nearby frame; because the ASR can then hear
  the boundary word on both sides, a word-level seam de-dup drops a leading chunk
  word that repeats the committed tail. On pause-anchored cuts the chunks share no
  audio, so this rarely fires.
- **Arbitrary-length turns, crash-resilient.** A turn of any length is transcribed
  in full (the windowing is what makes that safe), and a `worker.onerror` reload
  recovers the ASR Web Worker so a crash can't stall the pipeline.

## Recipe

This inspiration is version `v1` (front-matter `version:`).
It is not a fork of the workspace it came from -- it is DERIVED from it by the
recipe below: include these paths, leave these out, apply these
published-version rules. An update re-runs the recipe against the current
workspace and publishes the result as the next version, so anything excluded
here stays excluded even though it still exists in the source workspace. This
block is the durable home of that recipe -- a later update reads it back from
here.

```yaml
version: v1
include:
  - system/apps/local_vocal
data_include: []
exclude:
  - the interview-bot app this voice component was extracted from, and all of its wiring
  - the mind-mapper app and its wiring
  - all user data (transcripts, saved turns, captured audio, any per-user state)
  - any server-side transcription, turn storage, or LLM call -- Local-Vocal is client-only
modification_rules:
  - register the local-vocal app on the clean base's supervisord (a [program:local-vocal] block on port 8084, registered via forward_port.py) so a booted mind runs it automatically
  - register the local-vocal package in the root pyproject (add it to project dependencies, map it as a workspace source, and ignore it in the root pytest addopts since it carries its own coverage config)
```

## Prerequisites

Activation requirements: what the adopting agent must SET UP -- and must
INITIATE ITSELF during setup, before asking how to adapt -- for this
inspiration to run against the new user's own accounts/data. One line per
requirement, in this machine-readable form (greppable by `requires_`):

**No prerequisites -- runs with no external permissions or secrets.** Local-Vocal
is self-contained and keyless. There are deliberately **no** `requires_permission`
lines (it calls no latchkey-gated service), **no** `requires_secret` lines (it
needs no API key, token, or server credential), and **no** `requires_llm` line (it
never calls an LLM -- there is no server-side transcription and no model call on
the server). Everything runs on-device in the user's browser.

Its only real-world requirements are environmental, not credentials, and the
adopting agent does not "activate" them -- the browser and the user handle them:

- A modern browser with WebAssembly. WebGPU is used when available; it falls back
  to WASM (and the TTS falls back to the browser's built-in `speechSynthesis`), so
  no GPU is strictly required.
- Network access on first load so the browser can fetch the models from the public
  CDNs (jsdelivr + huggingface): `@ricky0123/vad-web`, `onnxruntime-web`,
  `@huggingface/transformers` (Moonshine ASR), and `kokoro-js` (Kokoro TTS). The
  browser caches them after the first load.
- Microphone permission, granted by the user in the browser at the OS/browser
  level for voice **in**. (Voice **out** needs no microphone.) This is a normal
  in-browser prompt, not a latchkey permission the agent initiates.

## How to adapt it

Instructions for the NEXT agent -- the one adapting this inspiration into a
new mind. This is the `use-inspiration` skill's template path; in short:

1. Read this entire file first, especially "Prerequisites" and "Holes"
   below -- Prerequisites are your SETUP agenda, Holes are your ADAPTATION
   agenda.
2. Present the inspiration to the user in plain, non-technical language: what
   it is, what it does, and what it needs from them (name the Prerequisites).
3. Ask whether they want to use the same connectors (e.g. their own Slack).
   If YES: ACTIVATE FIRST -- initiate every `requires_permission` line NOW
   via a latchkey permission request (see the `latchkey` skill; the request
   opens the approval/login flow in the minds app), wire up any
   `requires_secret` values, start the services, and get the app showing
   THE USER'S OWN DATA. Done for a data-backed app means the user can open it
   and see their own data -- NOT that a service starts or an endpoint returns
   200. Then tell them it is live and to take a look.
4. Only AFTER that (or immediately, if they chose different connectors -- the
   swap is then the first adaptation) ask: "How do you want to adapt it?"
5. Work through each hole interactively, one at a time. Translate each into
   plain language, ask for a decision only when you genuinely need one, and
   resolve the obvious ones yourself.
6. When done, append a dated entry to "Adaptation history" below (never
   rewrite earlier entries) and commit.

## Holes

Local-Vocal runs out of the box -- there are no stubbed integrations or hardcoded
accounts to rewire. The "holes" here are the adaptation agenda: the choices an
adopter makes to turn the demo into their own feature.

- **The demo page is a showcase, not a product.** `assets/app.html` exists to
  prove the pipeline works (mic orb, live caption, turn list, a Speak box). The
  real deliverable is the `LocalVocal` driver. An adopter wires the driver's
  callbacks (`onCaption`, `onTurn`, `onLevel`, `onError`, plus `speak`) into their
  own app's UI and logic, rather than shipping this page as-is.
- **Pause-detection thresholds are heuristics.** The silence-anchored commit
  points come from audio *energy*, controlled by `quietAbsoluteRms` and
  `quietPeakFraction` (options on `StreamingTurn`). The defaults are tuned for a
  typical desktop mic in a reasonably quiet room; a noisier environment or an
  unusual microphone may want them retuned. They are exposed as options precisely
  so an adopter can tune per environment.
- **English-only ASR.** Transcription uses Moonshine base, which is
  English-only. Supporting another language means swapping the ASR model (and
  verifying the commit-and-slice logic still holds for it).
- **One default TTS voice.** Voice out uses Kokoro's default `af_heart` voice.
  An adopter who wants a different voice (or a different TTS engine) changes it in
  the driver's speech pipeline.

## Publication history

This inspiration's changelog: what each published version changed. The PUBLISHER
appends one entry per version (newest last); earlier entries are never rewritten.
This is distinct from "Adaptation history" below, which is the ADOPTERS' log.

### v1 (2026-08-06) -- First release: standalone on-device VAD + live streaming transcription + TTS, as a reusable browser module (voice_session.js + voice_capture.js) and a demo app.

## Adaptation history

Each mind that adapts this inspiration appends one dated entry below. Earlier
entries are never rewritten.
