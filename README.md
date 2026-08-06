# Local-Vocal

On-device VAD, live streaming speech-to-text, and text-to-speech in the browser -- no API key, no server round-trip.

Local-Vocal is a self-contained, client-side-only browser component for on-device
voice **in** and voice **out** -- no API key, no server round-trip, no cloud
transcription. You speak and your words appear as a live caption and as cleanly
finalized turns (for utterances of any length); you hand it text and it speaks the
text aloud. Speech detection (Silero VAD), streaming transcription (Moonshine
ASR), and text-to-speech (Kokoro) all run inside the browser via
WebAssembly/WebGPU, with the models fetched once from public CDNs and cached
locally. The reusable core is two DOM-free modules -- `voice_session.js` (the
streaming transcription model) and `voice_capture.js` (the `window.LocalVocal`
driver) -- with a small Flask app that serves a demo page to show them off.

This repository is a published **minds inspiration**: a clean, bootable
snapshot of the apps and features a mind built, ready to adapt into your own.
It is NOT the generic workspace template -- it is this specific project.

## Use it

- **Create a new mind from it:** point a new minds workspace at this repo's
  URL. On first boot the mind reads the inspiration and helps you connect your
  own accounts and adapt it.
- **Bring it into an existing mind:** run `/use-inspiration <this repo's URL>`.

## What's inside

- **Local-Vocal** -- [`inspiration-local-vocal.md`](inspiration-local-vocal.md) (published now)

Each `inspiration-<slug>.md` is the full manifest for that inspiration: what
it is, how it works, the prerequisites it needs, and how to adapt it.
