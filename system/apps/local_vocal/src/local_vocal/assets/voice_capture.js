// Local-Vocal: the reusable on-device voice driver.
//
// This is the DOM-free glue around the voice model (voice_session.js). It owns
// the microphone pipeline and the speech pipeline; the page passes callbacks and
// never touches the worker, the VAD, or the audio buffers directly.
//
//   Voice IN  (listen):
//     - Silero VAD (@ricky0123/vad-web) detects real speech segments.
//     - Moonshine ASR (@huggingface/transformers, in a Web Worker) transcribes
//       -- fast, good on short audio, no word timestamps.
//     - ONE streaming mechanism (VoiceSession.StreamingTurn) powers both the live
//       caption and each finalized turn: the turn's audio rolls through a bounded
//       ~20s window; heads are sliced off at genuine pauses, transcribed, and
//       folded into the turn's committed text. The caption is always
//       `committed + window hypothesis`; the finalized turn is just the committed
//       text once the last chunk folds in. See voice_session.js for the model.
//
//   Voice OUT (speak):
//     - Kokoro TTS (kokoro-js), on-device, WebGPU with WASM fallback, and the
//       browser's speechSynthesis as a last resort.
//
// Everything runs in the browser: no API, no key, no server round-trip. The
// models are fetched once from a CDN and cached by the browser.
//
// Public API (all on the global `LocalVocal`):
//   LocalVocal.init({ onStatus })              -> begin loading the ASR model (idempotent)
//   LocalVocal.status                          -> "idle" | "loading" | "ready" | "error"
//   LocalVocal.whenReady()                     -> Promise, resolves when the ASR model is loaded
//   LocalVocal.listen({ onCaption, onTurn, onError, onLevel, onStatus }) -> { stop() }
//   LocalVocal.speak(text)                     -> Promise, resolves when speaking finishes
//   LocalVocal.stopSpeaking()                  -> interrupt any current speech
//   LocalVocal.encodeWav(float32, sampleRate)  -> Blob (16-bit PCM WAV of the samples)
//
// Callbacks:
//   onStatus(status, detail)   loading progress: status as above, detail a string (e.g. "42%")
//   onCaption(stable, tentative)  the live caption of the active turn; stable = committed +
//                                 agreed hypothesis prefix, tentative = the rest. Both "" clears it.
//   onTurn(text, wavBlob)      a finalized turn: its committed text and the exact captured audio.
//   onLevel(level)             per-frame mic level in [0,1] for a meter, even between turns.
//   onError(error)             a recoverable pipeline error (model load, transcribe, mic).
//
// Loads as a browser global (window.LocalVocal) via a <script> tag; it reads the
// voice model from the global `VoiceSession` (load voice_session.js first).
(function (root) {
  "use strict";

  // ---- CDN libraries (same versions the model was validated against) ----
  const MODEL = "onnx-community/moonshine-base-ONNX";
  const VAD_LIB = "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/bundle.min.js";
  const VAD_ASSETS = "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/";  // silero model + worklet
  const ORT_WASM = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";       // matches vad-web@0.0.30 bundle
  const TRANSFORMERS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3";
  const KOKORO_LIB = "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm";
  const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
  const KOKORO_VOICE = "af_heart";

  const SR = 16000;         // the VAD's sample rate (and the model's)
  const STREAM_MS = 500;    // how often to refresh the live caption
  const MIN_INTERIM_S = 0.3;   // don't transcribe a window shorter than this for a caption

  function voiceSession() {
    const vs = root.VoiceSession;
    if (!vs) throw new Error("VoiceSession is not loaded (include voice_session.js before voice_capture.js)");
    return vs;
  }

  // ---- WAV encode (the exact captured utterance, for playback / download) ----
  function encodeWav(float32, sampleRate) {
    const len = float32.length, buffer = new ArrayBuffer(44 + len * 2), view = new DataView(buffer);
    const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    writeStr(0, "RIFF"); view.setUint32(4, 36 + len * 2, true); writeStr(8, "WAVE");
    writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    writeStr(36, "data"); view.setUint32(40, len * 2, true);
    let o = 44; for (let i = 0; i < len; i++) { const s = Math.max(-1, Math.min(1, float32[i])); view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
    return new Blob([view], { type: "audio/wav" });
  }

  // ---- module state ----
  // status of the ASR model (the thing `listen` waits for).
  let status = "idle";               // "idle" | "loading" | "ready" | "error"
  let statusCb = null;               // onStatus(status, detail)
  let statusDetail = "";
  function setStatus(s, detail) {
    status = s; statusDetail = detail || "";
    if (statusCb) { try { statusCb(status, statusDetail); } catch (_) {} }
  }

  // The transcription worker is a persistent singleton (loaded once, shared by
  // every listen session). Its callbacks route into whichever session is active;
  // a result for a segment the active session doesn't know is ignored.
  let worker = null, modelReady = false, inFlight = false, pendingInterim = null;
  const commitQueue = [];            // FIFO of transcribe-and-commit jobs (head slices + drained chunks)
  let readyPromise = null, readyResolve = null;

  // The current listen session's callbacks (one microphone, so one at a time).
  let callbacks = { onCaption: null, onTurn: null, onError: null, onLevel: null };
  let listening = false, myvad = null;

  // Per-turn streaming state (mirrors the interview loop's bookkeeping, minus the
  // DOM): a finishing turn can still be folding its last chunks while the next
  // turn has already begun, so state is keyed by segment id.
  let inSpeech = false, segId = 0, lastStream = 0, activeTurn = null, captionSeg = null;
  const turnsBySeg = {};             // seg -> StreamingTurn, until the turn finalizes
  const pendingCommits = {};         // seg -> transcribe-and-commit jobs still outstanding
  const sealedSegs = new Set();      // segments whose speech ended, awaiting their last commit
  const audioBySeg = {};             // seg -> the full raw utterance (Float32Array), for the WAV

  let kokoro = null, ttsAudio = null;   // Kokoro model + the currently-playing utterance
  let vadLibPromise = null;

  const emitCaption = (stable, tentative) => { if (callbacks.onCaption) { try { callbacks.onCaption(stable, tentative); } catch (_) {} } };
  const emitTurn = (text, wav) => { if (callbacks.onTurn) { try { callbacks.onTurn(text, wav); } catch (_) {} } };
  const emitError = (err) => { if (callbacks.onError) { try { callbacks.onError(err); } catch (_) {} } };
  const emitLevel = (level) => { if (callbacks.onLevel) { try { callbacks.onLevel(level); } catch (_) {} } };

  // ---------- transcription worker (Moonshine) ----------
  const WORKER_SRC = `
    import { pipeline, env } from "${TRANSFORMERS}";
    env.allowLocalModels = false;
    let asr = null;
    async function load(model, device, dtype) {
      const cb = (data) => postMessage({ type: "progress", data });
      try { asr = await pipeline("automatic-speech-recognition", model, { device, dtype, progress_callback: cb }); postMessage({ type: "ready", device }); }
      catch (e) {
        postMessage({ type: "progress", data: { status: "fallback", message: String(e) } });
        asr = await pipeline("automatic-speech-recognition", model, { device: "wasm", dtype: "q8", progress_callback: cb });
        postMessage({ type: "ready", device: "wasm" });
      }
    }
    onmessage = async (e) => {
      const m = e.data;
      if (m.type === "load") { try { await load(m.model, m.device, m.dtype); } catch (err) { postMessage({ type: "error", error: String(err) }); } }
      else if (m.type === "transcribe") {
        if (!asr) { postMessage({ type: "result", text: "", kind: m.kind, seg: m.seg, epoch: m.epoch }); return; }
        try { const out = await asr(m.audio); postMessage({ type: "result", text: (out.text || "").trim(), kind: m.kind, seg: m.seg, epoch: m.epoch }); }
        catch (err) { postMessage({ type: "error", error: String(err), kind: m.kind, seg: m.seg }); }
      }
    };
  `;

  async function startWorker() {
    worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: "application/javascript" })), { type: "module" });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") {
        if (m.data && m.data.status === "progress" && m.data.total) setStatus("loading", Math.round((m.data.loaded / m.data.total) * 100) + "%");
        else if (m.data && m.data.status === "fallback") setStatus("loading", "CPU");
      } else if (m.type === "ready") {
        modelReady = true; setStatus("ready", "");
        if (readyResolve) { readyResolve(); readyResolve = null; }
      } else if (m.type === "result") { inFlight = false; applyTranscription(m); pump(); }
      else if (m.type === "error") {
        inFlight = false;
        emitError(new Error("transcription: " + m.error));
        // A failed transcribe-and-commit job loses that chunk's words, but must
        // not leave its turn waiting forever: settle the count and move on.
        if (m.kind === "commit" && m.seg !== undefined) settleCommit(m.seg);
        pump();
      }
    };
    // A worker THREAD crash (not a caught job error) fires here, never onmessage,
    // so inFlight would otherwise stay stuck true and stall transcription forever.
    // Recover by resetting and reloading the model. Queued jobs are dropped, so
    // any turn waiting on them finalizes with the text it has committed so far.
    worker.onerror = (e) => {
      emitError(new Error("transcription worker crashed; reloading: " + ((e && e.message) || e)));
      inFlight = false;
      try { worker.terminate(); } catch (_) {}
      modelReady = false; setStatus("loading", "");
      commitQueue.length = 0; pendingInterim = null;
      for (const seg in pendingCommits) pendingCommits[seg] = 0;
      for (const seg of [...sealedSegs]) maybeFinalize(seg);
      startWorker();
    };
    // Pick the device on the main thread: only use WebGPU if an adapter really exists.
    let device = "wasm", dtype = "q8";
    try { if (navigator.gpu && (await navigator.gpu.requestAdapter())) { device = "webgpu"; dtype = "fp32"; } } catch (_) {}
    worker.postMessage({ type: "load", model: MODEL, device, dtype });
  }

  // One job at a time. Commit jobs (head slices + drained chunks) drain FIFO
  // before interims, so folds land in slice order and a stale caption refresh
  // never delays the record. Audio buffers are transferred; the model already
  // handed out copies, so nothing retained is detached.
  function requestInterim(audio, seg, epoch) { pendingInterim = { audio, seg, epoch }; pump(); }
  function requestCommit(audio, seg) {
    pendingCommits[seg] = (pendingCommits[seg] || 0) + 1;
    commitQueue.push({ audio, seg });
    pump();
  }
  function pump() {
    if (inFlight || !worker) return;
    let job = null, kind = null;
    if (commitQueue.length) { job = commitQueue.shift(); kind = "commit"; }
    else if (pendingInterim) { job = pendingInterim; pendingInterim = null; kind = "interim"; }
    if (!job) return;
    inFlight = true;
    worker.postMessage({ type: "transcribe", audio: job.audio, kind, seg: job.seg, epoch: job.epoch }, [job.audio.buffer]);
  }

  function applyTranscription(m) {
    const turn = turnsBySeg[m.seg];
    if (!turn) return;   // the segment was cancelled (misfire / session stopped)
    if (m.kind === "interim") {
      turn.applyHypothesis(m.text, m.epoch);   // stale epochs are ignored inside
      renderLive(m.seg);
      return;
    }
    turn.commitText(m.text);
    renderLive(m.seg);   // the caption's committed prefix just grew
    settleCommit(m.seg);
  }

  function settleCommit(seg) {
    if (pendingCommits[seg] !== undefined) pendingCommits[seg] -= 1;
    maybeFinalize(seg);
  }

  // The live caption shows only the active turn: all committed text plus the
  // active window's hypothesis (stable prefix, then tentative). A finishing turn
  // that is no longer the caption owner does not overwrite the caption.
  function renderLive(seg) {
    if (Number(seg) !== captionSeg) return;
    const turn = turnsBySeg[seg];
    if (!turn) return;
    const parts = turn.liveParts();
    emitCaption(parts.stable, parts.tentative);
  }

  // A turn finalizes once its speech has ended AND its last chunk has folded in.
  function maybeFinalize(seg) {
    if (!sealedSegs.has(Number(seg)) || (pendingCommits[seg] || 0) > 0) return;
    sealedSegs.delete(Number(seg));
    delete pendingCommits[seg];
    const turn = turnsBySeg[seg];
    delete turnsBySeg[seg];
    // The saved turn IS the model's committed text -- the same text the live
    // caption was showing, read at the moment the turn ended.
    const text = turn ? turn.committedText : "";
    if (Number(seg) === captionSeg) { captionSeg = null; emitCaption("", ""); }
    const audio = audioBySeg[seg]; delete audioBySeg[seg];
    if (text) emitTurn(text, audio ? encodeWav(audio, SR) : null);
  }

  // Abandon all in-progress voice capture (a fresh listen): pending jobs and
  // unfinalized turns are dropped, so no late fold can write into a new session.
  function discardPendingTurns() {
    commitQueue.length = 0; pendingInterim = null;
    for (const seg in turnsBySeg) delete turnsBySeg[seg];
    for (const seg in pendingCommits) delete pendingCommits[seg];
    for (const seg in audioBySeg) delete audioBySeg[seg];
    sealedSegs.clear();
    captionSeg = null; activeTurn = null;
  }

  // ---------- Silero VAD callbacks ----------
  function onSpeechStart() {
    if (!listening) return;
    inSpeech = true; segId++; lastStream = (typeof performance !== "undefined" ? performance.now() : Date.now());
    activeTurn = new (voiceSession().StreamingTurn)();
    turnsBySeg[segId] = activeTurn;
    captionSeg = segId;
    emitCaption("", "");   // a fresh, empty caption line for the new turn
  }
  function onFrameProcessed(_probs, frame) {
    emitLevel(Math.min(1, voiceSession().frameRms(frame) * 4));
    if (!inSpeech || !activeTurn) return;
    activeTurn.addFrame(frame.slice(0));   // copy: the VAD reuses its frame buffer
    // Slide the window: once it exceeds ~20s the model slices a head off at a
    // genuine pause; transcribing-and-committing that head is what keeps both the
    // caption and the record growing at any turn length.
    for (let head; (head = activeTurn.takeHeadSlice()); ) requestCommit(head, segId);
    const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
    if (now - lastStream > STREAM_MS) {
      lastStream = now;
      const w = activeTurn.windowAudio();
      if (w.audio.length >= SR * MIN_INTERIM_S) requestInterim(w.audio, segId, w.epoch);
    }
  }
  function onSpeechEnd(audio) {
    inSpeech = false;
    audioBySeg[segId] = audio;   // the full raw utterance, kept for the WAV
    sealTurn(segId);
  }
  // End the segment's capture: drain what's left of its window into
  // transcribe-and-commit chunks and finalize once they have all folded in.
  function sealTurn(seg) {
    const turn = turnsBySeg[seg];
    if (!turn || sealedSegs.has(seg)) return;
    if (pendingInterim && pendingInterim.seg === seg) pendingInterim = null;   // stale window
    for (const chunk of turn.drainChunks()) requestCommit(chunk, seg);
    sealedSegs.add(seg);
    maybeFinalize(seg);          // nothing left to transcribe -> finalize now
  }
  function onVADMisfire() {
    inSpeech = false;
    delete turnsBySeg[segId]; delete pendingCommits[segId]; delete audioBySeg[segId];
    activeTurn = null;
    if (segId === captionSeg) { captionSeg = null; emitCaption("", ""); }
  }

  // ---------- speech (Kokoro TTS, system voice fallback) ----------
  // Load Kokoro once in the background (model is cached after the first ~86MB
  // fetch). Prefer WebGPU, fall back to WASM (still natural, just slower); only if
  // both fail do we drop to the browser's built-in voice.
  async function loadKokoro() {
    if (kokoro) return;
    let KokoroTTS;
    try {
      ({ KokoroTTS } = await import(/* @vite-ignore */ KOKORO_LIB));
    } catch (err) {
      emitError(new Error("Kokoro library failed to load; using system voice: " + err));
      return;
    }
    let useWebgpu = false;
    try { useWebgpu = "gpu" in navigator && !!(await navigator.gpu.requestAdapter()); } catch (_) {}
    for (const device of useWebgpu ? ["webgpu", "wasm"] : ["wasm"]) {
      try {
        kokoro = await KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: device === "webgpu" ? "fp32" : "q8", device });
        return;
      } catch (_) { /* try the next device */ }
    }
    emitError(new Error("Kokoro unavailable; using system voice"));
  }

  function doSpeak(text, done) {
    if (!kokoro) return systemSpeak(text, done);
    kokoro
      .generate(text, { voice: KOKORO_VOICE })
      .then((audio) => {
        stopSpeaking();
        const url = URL.createObjectURL(audio.toBlob());
        ttsAudio = new Audio(url);
        const finish = () => { URL.revokeObjectURL(url); ttsAudio = null; done(); };
        ttsAudio.onended = finish;
        ttsAudio.onerror = finish;
        ttsAudio.play().catch(finish);
      })
      .catch((err) => { emitError(new Error("Kokoro synth failed, using system voice: " + err)); systemSpeak(text, done); });
  }

  function systemSpeak(text, done) {
    if (!("speechSynthesis" in root) || !root.speechSynthesis) { setTimeout(done, 900); return; }
    root.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.98; u.pitch = 1.0; u.volume = 1.0; u.onend = done; u.onerror = done;
    root.speechSynthesis.speak(u);
  }

  function stopSpeaking() {
    if (ttsAudio) { try { ttsAudio.pause(); } catch (_) {} ttsAudio = null; }
    if (root.speechSynthesis) root.speechSynthesis.cancel();
  }

  // ---------- VAD library loading ----------
  // Prefer an already-present global (a page may include the <script> itself);
  // otherwise inject the CDN bundle once and resolve when its global appears.
  function loadVadLib() {
    if (root.vad && root.vad.MicVAD) return Promise.resolve(root.vad);
    if (vadLibPromise) return vadLibPromise;
    vadLibPromise = new Promise((resolve, reject) => {
      if (typeof document === "undefined") { reject(new Error("no document to load the VAD library")); return; }
      const script = document.createElement("script");
      script.src = VAD_LIB;
      script.onload = () => {
        if (root.vad && root.vad.MicVAD) resolve(root.vad);
        else reject(new Error("VAD library loaded but window.vad is missing"));
      };
      script.onerror = () => reject(new Error("failed to load the VAD library from " + VAD_LIB));
      document.head.appendChild(script);
    });
    return vadLibPromise;
  }

  // ---------- public API ----------
  function init(options) {
    if (options && options.onStatus) statusCb = options.onStatus;
    if (worker) return;
    setStatus("loading", "");
    readyPromise = new Promise((resolve) => { readyResolve = resolve; });
    startWorker();
    loadKokoro();
  }

  function whenReady() {
    init();
    return modelReady ? Promise.resolve() : readyPromise;
  }

  function listen(options) {
    const opts = options || {};
    if (opts.onStatus) statusCb = opts.onStatus;
    // One microphone: a new listen replaces any prior session cleanly.
    if (listening || myvad) stop();
    discardPendingTurns();
    callbacks = {
      onCaption: opts.onCaption || null,
      onTurn: opts.onTurn || null,
      onError: opts.onError || null,
      onLevel: opts.onLevel || null,
    };
    listening = true;
    init();
    (async () => {
      try {
        await whenReady();
        if (!listening) return;   // stopped while the model was still loading
        const vadLib = await loadVadLib();
        if (!listening) return;
        const instance = await vadLib.MicVAD.new({
          model: "v5",
          baseAssetPath: VAD_ASSETS,
          onnxWASMBasePath: ORT_WASM,
          positiveSpeechThreshold: 0.5,
          negativeSpeechThreshold: 0.35,
          redemptionMs: 800,        // ~0.8s silence ends an utterance
          preSpeechPadMs: 300,
          minSpeechMs: 200,
          onSpeechStart, onFrameProcessed, onSpeechEnd, onVADMisfire,
        });
        if (!listening) { try { instance.destroy(); } catch (_) {} return; }
        myvad = instance;
        await myvad.start();
      } catch (err) {
        listening = false;
        emitError(err instanceof Error ? err : new Error(String(err)));
      }
    })();
    return { stop };
  }

  function stop() {
    listening = false;
    // If the stop cut a turn off mid-speech, seal it: the words captured so far
    // drain through the normal commit path and still land as a finalized turn
    // (the worker keeps draining the queue after the mic is gone).
    if (inSpeech && activeTurn) sealTurn(segId);
    inSpeech = false; activeTurn = null;
    pendingInterim = null;
    if (myvad) { try { myvad.destroy(); } catch (_) {} myvad = null; }
    stopSpeaking();
    emitLevel(0);
  }

  function speak(text) {
    return new Promise((resolve) => {
      const t = (text || "").trim();
      if (!t) { resolve(); return; }
      doSpeak(t, resolve);
    });
  }

  const LocalVocal = {
    init,
    whenReady,
    listen,
    speak,
    stopSpeaking,
    encodeWav,
    get status() { return status; },
    get statusDetail() { return statusDetail; },
  };

  if (typeof module !== "undefined" && module.exports) module.exports = LocalVocal;
  else root.LocalVocal = LocalVocal;
})(typeof self !== "undefined" ? self : this);
