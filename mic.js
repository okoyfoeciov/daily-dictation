// mic.js — the floating microphone button: press to record, press again to
// stop and transcribe. The transcript opens in a draggable card with a player
// so you can hear what you said while you read it, and the text is copied to
// your clipboard automatically. The card's "Insert and check" button hands the
// transcript to app-dictation.js, which replaces the notepad answer with it and
// runs the checker.
//
// This page IS the app's own origin, so the microphone is requested and held
// right here and the recorded clip plays from a real <audio> element.
//
// The transcription endpoint is this app's own backend, which proxies the
// WebSocket at /api/transcribe/ws straight through to ai-service while the
// recording runs — so the response shape (including a failed transcription's
// detail) is ai-service's, and failMessage() below maps it.

(() => {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const svg = (d, cls) => {
    const s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("class", cls);
    for (const spec of d) {
      const el = document.createElementNS(NS, spec.t);
      for (const [k, v] of Object.entries(spec)) if (k !== "t") el.setAttribute(k, v);
      s.appendChild(el);
    }
    return s;
  };

  const MAX_RECORD_MS = 60 * 1000;
  const MIN_RECORD_MS = 350;
  const MIN_RECORD_BYTES = 1200;

  /* ---------------------------------------------------------------- *
   * The button
   * ---------------------------------------------------------------- */

  const root = document.createElement("section");
  root.className = "mic";
  root.setAttribute("aria-label", "Voice transcription");
  root.dataset.state = "idle";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mic-btn";
  btn.setAttribute("aria-label", "Record");

  const micIco = svg([
    { t: "path", d: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" },
    { t: "path", d: "M19 10v2a7 7 0 0 1-14 0v-2" },
    { t: "path", d: "M12 19v3" },
  ], "mic-ico mic-ico-mic");
  micIco.setAttribute("fill", "none");
  micIco.setAttribute("stroke", "currentColor");
  micIco.setAttribute("stroke-width", "2");
  micIco.setAttribute("stroke-linecap", "round");
  micIco.setAttribute("stroke-linejoin", "round");

  const stopIco = svg([
    { t: "rect", x: "7", y: "7", width: "10", height: "10", rx: "2.5", fill: "currentColor" },
  ], "mic-ico mic-ico-stop");

  const label = document.createElement("span");
  label.className = "mic-label";
  label.setAttribute("aria-live", "polite");

  const spin = document.createElement("span");
  spin.className = "mic-spin";
  spin.setAttribute("aria-hidden", "true");

  btn.append(micIco, stopIco, label, spin);
  root.appendChild(btn);

  /* ---------------------------------------------------------------- *
   * The transcript card
   * ---------------------------------------------------------------- */

  const modal = document.createElement("div");
  modal.className = "mic-modal";
  modal.hidden = true;

  const backdrop = document.createElement("div");
  backdrop.className = "mic-backdrop";

  const card = document.createElement("section");
  card.className = "mic-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", "Transcript");

  const grip = document.createElement("div");
  grip.className = "mic-drag";
  grip.setAttribute("aria-hidden", "true");

  const body = document.createElement("div");
  body.className = "mic-body";
  const textEl = document.createElement("p");
  textEl.className = "mic-text";

  const player = document.createElement("div");
  player.className = "mic-player";
  const pp = document.createElement("button");
  pp.type = "button";
  pp.className = "mic-pp";
  pp.setAttribute("aria-label", "Play");
  const playIco = svg([
    { t: "path", d: "M9 7.4v9.2a1 1 0 0 0 1.53.85l7.3-4.6a1 1 0 0 0 0-1.7l-7.3-4.6A1 1 0 0 0 9 7.4z", fill: "currentColor" },
  ], "mic-ico-pp mic-ico-play");
  const pauseIco = svg([
    { t: "rect", x: "8", y: "6", width: "3.2", height: "12", rx: "1.2", fill: "currentColor" },
    { t: "rect", x: "12.8", y: "6", width: "3.2", height: "12", rx: "1.2", fill: "currentColor" },
  ], "mic-ico-pp mic-ico-pause");
  pp.append(playIco, pauseIco);
  const track = document.createElement("div");
  track.className = "mic-track";
  const fill = document.createElement("div");
  fill.className = "mic-fill";
  track.appendChild(fill);
  const time = document.createElement("span");
  time.className = "mic-time";
  time.textContent = "0:00 / 0:00";
  player.append(pp, track, time);

  const audioEl = document.createElement("audio");
  audioEl.preload = "auto";
  audioEl.hidden = true;

  const actions = document.createElement("div");
  actions.className = "mic-actions";

  const insertBtn = document.createElement("button");
  insertBtn.type = "button";
  insertBtn.className = "mic-insert";
  insertBtn.setAttribute("aria-label", "Insert and check");
  insertBtn.title = "Insert this transcript and check it";
  const insertIco = svg([
    { t: "rect", x: "8", y: "2", width: "8", height: "4", rx: "1" },
    { t: "path", d: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" },
    { t: "path", d: "m9 14 2 2 4-4" },
  ], "mic-ico-insert");
  insertIco.setAttribute("fill", "none");
  insertIco.setAttribute("stroke", "currentColor");
  insertIco.setAttribute("stroke-width", "2");
  insertIco.setAttribute("stroke-linecap", "round");
  insertIco.setAttribute("stroke-linejoin", "round");
  insertBtn.appendChild(insertIco);

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "mic-copy";
  copyBtn.setAttribute("aria-label", "Copy");
  const cpIco = svg([
    { t: "rect", x: "9", y: "9", width: "11", height: "11", rx: "2" },
    { t: "path", d: "M5 15V6a2 2 0 0 1 2-2h8" },
  ], "mic-ico-cp");
  const ckIco = svg([{ t: "path", d: "M20 6 9 17l-5-5" }], "mic-ico-ck");
  for (const s of [cpIco, ckIco]) {
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "2");
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
  }
  copyBtn.append(cpIco, ckIco);
  actions.append(insertBtn, copyBtn);
  body.append(textEl, player, audioEl, actions);
  card.append(grip, body);
  modal.append(backdrop, card);

  document.body.append(root, modal);

  /* ---------------------------------------------------------------- *
   * State
   * ---------------------------------------------------------------- */

  // idle -> arming -> recording -> transcribing -> idle. "arming" is the gap
  // while the microphone permission/device is being opened; it draws as idle
  // (only the status text differs) so the button never claims to be
  // recording before it is.
  let state = "idle";
  // A per-attempt token, not a shared boolean: a click during arming can only
  // cancel the arm attempt it belongs to. A boolean shared across attempts
  // would let a stale getUserMedia() resolution — cancelled, then re-armed
  // by a later click before it settles — sail past a since-reset flag and
  // start a second live recorder on top of the new one.
  let armToken = 0;
  let ticker = 0;
  let startedAt = 0;
  let stream = null;
  let recorder = null;
  let chunks = [];
  let recMime = "";
  let clipUrl = null;
  let clipMs = 0;

  // The streaming transcription socket, open for the whole recording.
  let streamSocket = null;
  let streamOpen = null;
  let streamPending = [];
  let streamChain = Promise.resolve();
  let streamResult = null;

  function setState(s) {
    state = s;
    root.dataset.state = s === "recording" ? "recording" : s === "transcribing" ? "transcribing" : "idle";
    btn.setAttribute("aria-label",
      s === "recording" ? "Stop recording" : s === "transcribing" ? "Transcribing" : "Record");
  }

  const fmt = (ms) => {
    const t = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
  };

  function setStatus(msg, isError) {
    label.textContent = msg;
    root.dataset.msg = "1";
    btn.classList.toggle("mic-error", !!isError);
  }
  function idleStatus() {
    label.textContent = "";
    delete root.dataset.msg;
    btn.classList.remove("mic-error");
  }
  let flashTimer = 0;
  function flash(msg, isError) {
    setStatus(msg, isError);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { if (state === "idle") idleStatus(); }, 1800);
  }

  // The cap lives in the same 200ms tick that repaints the label, since
  // there is no separate offscreen document to check it independently here.
  function startTicking(at) {
    startedAt = at || Date.now();
    clearInterval(ticker);
    const tick = () => {
      if (state !== "recording") return;
      const ms = Date.now() - startedAt;
      if (ms >= MAX_RECORD_MS) { discard("over"); return; }
      setStatus(fmt(ms), false);
    };
    tick();
    ticker = setInterval(tick, 200);
  }
  function stopTicking() { clearInterval(ticker); ticker = 0; }

  function releaseMic() {
    if (!stream) return;
    for (const t of stream.getTracks()) { try { t.stop(); } catch (_) {} }
    stream = null;
  }

  /* ---------------------------------------------------------------- *
   * Playback — a real <audio> element, played directly.
   * ---------------------------------------------------------------- */

  function playState() {
    const d = isFinite(audioEl.duration) && audioEl.duration > 0 ? audioEl.duration : clipMs / 1000;
    return { playing: !audioEl.paused && !audioEl.ended, t: Math.min(audioEl.currentTime || 0, d), dur: d };
  }

  function paint(s) {
    const dur = s && s.dur ? s.dur : 0;
    const t = s ? Math.min(s.t || 0, dur) : 0;
    fill.style.width = (dur ? (t / dur) * 100 : 0) + "%";
    time.textContent = clock(t) + " / " + clock(dur);
    player.classList.toggle("mic-playing", !!(s && s.playing));
    pp.setAttribute("aria-label", s && s.playing ? "Pause" : "Play");
  }

  const clock = (sec) => {
    const n = Math.max(0, Math.floor(sec || 0));
    return Math.floor(n / 60) + ":" + String(n % 60).padStart(2, "0");
  };

  function loadClip(blob, ms) {
    if (clipUrl) { try { URL.revokeObjectURL(clipUrl); } catch (_) {} }
    clipUrl = URL.createObjectURL(blob);
    clipMs = ms;
    audioEl.src = clipUrl;
  }

  // A new recording replaces whatever clip is currently loaded. Without this,
  // pressing the button again while the transcript card is open leaves the OLD
  // clip playing audibly for the whole new recording, only actually stopping
  // once the new one finishes and loadClip() overwrites audioEl.src out from
  // under it.
  function dropClip() {
    try { audioEl.pause(); } catch (_) {}
    if (clipUrl) { try { URL.revokeObjectURL(clipUrl); } catch (_) {} clipUrl = null; }
    audioEl.removeAttribute("src");
    try { audioEl.load(); } catch (_) {}
    clipMs = 0;
  }

  const repaint = () => paint(playState());
  audioEl.addEventListener("timeupdate", repaint);
  audioEl.addEventListener("play", repaint);
  audioEl.addEventListener("pause", repaint);
  audioEl.addEventListener("ended", repaint);
  audioEl.addEventListener("loadedmetadata", repaint);
  audioEl.addEventListener("error", () => {
    const err = audioEl.error;
    if (!audioEl.src || (err && err.code === 1)) return;
    flash("Couldn't play the recording" + (err && err.code === 4 ? " (unsupported format)" : "") + ".", true);
  });

  function showTranscript(t, dur) {
    textEl.textContent = t || "No speech detected";
    textEl.classList.toggle("mic-empty", !t);
    insertBtn.hidden = !t;
    insertBtn.disabled = false;
    copyBtn.hidden = !t;
    card.style.transform = "";
    dx = dy = 0;
    player.hidden = false;
    paint({ playing: false, t: 0, dur: dur || 0 });
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add("mic-show"));
    // Plays back the moment the transcript opens, so you hear what you said
    // while reading it.
    const p = audioEl.play();
    if (p && p.catch) p.catch(() => {});
  }

  let closeTimer = 0;
  function closeModal(release = true) {
    if (modal.hidden) return;
    modal.classList.remove("mic-show");
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      modal.hidden = true;
      if (release) dropClip();
      paint(null);
      player.hidden = false;
      textEl.textContent = "";
      textEl.classList.remove("mic-empty");
      dropSelection();
      clearTimeout(copiedTimer);
      copyBtn.classList.remove("mic-copied");
      copyBtn.setAttribute("aria-label", "Copy");
    }, 240);
  }

  /* ---------------------------------------------------------------- *
   * Recording
   * ---------------------------------------------------------------- */

  function pickMime() {
    const opts = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4",
                  "audio/ogg;codecs=opus", "audio/ogg"];
    for (const o of opts) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(o)) return o;
    }
    return "";
  }

  // One streaming socket per recording. The backend proxies it to ai-service;
  // the text "stop" frame is the finish signal.
  function startTranscriptionStream(mime) {
    streamChain = Promise.resolve();
    streamPending = [];
    let openResolve, openReject;
    streamOpen = new Promise((resolve, reject) => {
      openResolve = resolve;
      openReject = reject;
    });
    streamOpen.catch(() => {});     // handled; the stop path still sees it
    streamResult = new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      let ws;
      try {
        ws = new WebSocket(window.apiBase().replace(/^http/, "ws") +
                           "/api/transcribe/ws?type=" +
                           encodeURIComponent(mime || "audio/webm"));
      } catch (err) {
        openReject(err);
        finish({ error: err });
        return;
      }
      streamSocket = ws;
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        streamPending.forEach((b) => ws.send(b));
        streamPending = [];
        openResolve(true);
      };
      ws.onmessage = (e) => {
        let data = {};
        try { data = JSON.parse(e.data); } catch (_) { /* non-JSON error body */ }
        if (data && data.error) {
          finish({ ok: false, status: 502, data });
          return;
        }
        finish({ ok: true, status: 200, data });
      };
      ws.onerror = () => {
        const err = new Error("transcription connection failed");
        openReject(err);
        finish({ error: err });
      };
      ws.onclose = () => {
        const err = new Error("transcription connection closed");
        openReject(err);
        finish({ error: err });
      };
    });
  }

  function sendAudio(buf) {
    if (streamSocket && streamSocket.readyState === WebSocket.OPEN) {
      streamSocket.send(buf);
    } else {
      streamPending.push(buf);
    }
  }

  function abortStream() {
    streamPending = [];
    if (streamSocket) {
      try { streamSocket.close(); } catch (_) {}
      streamSocket = null;
    }
    streamChain = Promise.resolve();
    streamResult = null;
    streamOpen = null;
  }

  function startRecording() {
    dropClip();
    chunks = [];
    recMime = pickMime();
    const opts = { audioBitsPerSecond: 128000 };
    if (recMime) opts.mimeType = recMime;
    try { recorder = new MediaRecorder(stream, opts); }
    catch (_) { recorder = new MediaRecorder(stream); }
    recMime = recorder.mimeType || recMime || "audio/webm";
    recorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      chunks.push(e.data);
      const blob = e.data;
      streamChain = streamChain.then(() => blob.arrayBuffer()).then((buf) => {
        sendAudio(buf);
      }).catch((err) => {
        console.error("[mic] stream chunk failed:", err && err.message);
      });
    };
    recorder.onstop = finish;
    startTranscriptionStream(recMime);
    recorder.start(100);
    setState("recording");
    startTicking(Date.now());
  }

  // A real stop: the recording is kept and sent to be transcribed.
  function requestStop() {
    if (state !== "recording") return;
    stopTicking();
    setState("transcribing");
    label.textContent = "";
    delete root.dataset.msg;
    try { recorder.stop(); } catch (_) { finish(); }
  }

  // An abnormal end — the 60-second cap. Drop the handlers so onstop cannot
  // transcribe, let go of the mic, bin the audio: it never reaches the network.
  function discard(reason) {
    if (state !== "recording") return;
    stopTicking();
    abortStream();
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      try { recorder.stop(); } catch (_) {}
    }
    releaseMic();
    recorder = null;
    chunks = [];
    setState("idle");
    idleStatus();
    if (reason === "over") flash("Recording cancelled — over 1 minute", false);
  }

  async function finish() {
    const elapsed = Date.now() - startedAt;
    const mime = (recorder && recorder.mimeType) || recMime || "audio/webm";
    const blob = new Blob(chunks, { type: mime });
    releaseMic();
    recorder = null;
    chunks = [];

    if (elapsed < MIN_RECORD_MS || blob.size < MIN_RECORD_BYTES) {
      abortStream();
      setState("idle");
      idleStatus();
      flash("Too short — try again", false);
      return;
    }

    try {
      await Promise.all([streamChain, streamOpen]);
      if (!streamSocket || streamSocket.readyState !== WebSocket.OPEN) {
        throw new Error("transcription connection closed");
      }
      streamPending.forEach((b) => streamSocket.send(b));
      streamPending = [];
      streamSocket.send("stop");
      const res = await streamResult;
      if (!res) throw new Error("no transcription response");
      if (res.error) throw res.error;
      if (!res.ok) {
        setState("idle");
        idleStatus();
        setStatus(res.data && res.data.error
          ? "Transcription failed — " + res.data.error
          : failMessage(res.status, res.data), true);
        return;
      }
      const text = String(res.data.text || "").trim();
      loadClip(blob, elapsed);
      setState("idle");
      idleStatus();
      if (text) copy(text);
      showTranscript(text, playState().dur);
    } catch (err) {
      setState("idle");
      idleStatus();
      setStatus("Transcription failed — " + (err && err.message || "no answer"), true);
    } finally {
      if (streamSocket) {
        try { streamSocket.close(); } catch (_) {}
      }
      streamSocket = null;
      streamOpen = null;
      streamPending = [];
    }
  }

  // The backend proxies straight through to ai-service's streaming route, so
  // the response shape (Groq status included) is ai-service's.
  function failMessage(status, data) {
    const gs = data && data.groqStatus;
    let reason;
    if (gs === 429 || status === 429) reason = "rate limited (Groq 429)";
    else if (status === 401) reason = "session expired (401)";
    else if (status === 413) reason = "recording too long";
    else if (status === 422) reason = "recording too short";
    else if (gs) reason = "Groq " + gs;
    else reason = "HTTP " + status;
    if (data && data.retryAfter) reason += " · retry in " + data.retryAfter + "s";
    return "Transcription failed — " + reason;
  }

  function copy(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).catch(() => {});
    }
  }

  /* ---------------------------------------------------------------- *
   * Gestures
   * ---------------------------------------------------------------- */

  btn.addEventListener("click", async (e) => {
    if (!e.isTrusted) return;

    if (state === "idle") {
      closeModal(false);
      setState("arming");
      setStatus("Starting…", false);
      const myArm = ++armToken;
      let localStream;
      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: false,
                   noiseSuppression: false, autoGainControl: false },
        });
      } catch (err) {
        if (myArm !== armToken) return;
        setState("idle");
        idleStatus();
        const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
        setStatus(denied ? "Microphone access denied" : "Microphone unavailable", true);
        return;
      }
      if (myArm !== armToken) {
        for (const t of localStream.getTracks()) { try { t.stop(); } catch (_) {} }
        return;
      }
      stream = localStream;
      startRecording();
      return;
    }

    if (state === "arming") {
      armToken++;
      setState("idle");
      idleStatus();
      return;
    }

    if (state === "recording") {
      requestStop();
    }
    // transcribing: a request is already in flight, so the click is ignored.
  });

  insertBtn.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    const t = textEl.textContent;
    if (!t || typeof window.__dictationInsertAndCheck !== "function") return;
    // The card has no checker of its own; app-dictation.js owns the notepad and
    // grades the text. It returns false when there is no active session, in
    // which case the card stays open rather than throwing the transcript away.
    if (window.__dictationInsertAndCheck(t) === false) return;
    // The card stays clickable for the 240ms fade; without this a double-click
    // would replace the answer and start a second check.
    insertBtn.disabled = true;
    insertBtn.blur();
    closeModal();
  });

  let copiedTimer = 0;
  copyBtn.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    const done = () => {
      copyBtn.classList.add("mic-copied");
      copyBtn.setAttribute("aria-label", "Copied");
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => {
        copyBtn.classList.remove("mic-copied");
        copyBtn.setAttribute("aria-label", "Copy");
      }, 1500);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(textEl.textContent).then(done, selectText);
    else selectText();
    copyBtn.blur();
  });

  function dropSelection() {
    try {
      const sel = getSelection();
      if (!sel || !sel.rangeCount) return;
      if (card.contains(sel.getRangeAt(0).commonAncestorContainer)) sel.removeAllRanges();
    } catch (_) {}
  }

  function selectText() {
    try {
      const range = document.createRange();
      range.selectNodeContents(textEl);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}
  }

  pp.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    const playing = !audioEl.paused && !audioEl.ended;
    if (playing) {
      audioEl.pause();
    } else {
      const s = playState();
      if (audioEl.ended || (s.dur && audioEl.currentTime >= s.dur - 0.05)) audioEl.currentTime = 0;
      const p = audioEl.play();
      if (p && p.catch) p.catch(() => {});
    }
  });

  track.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    const r = track.getBoundingClientRect();
    if (!r.width) return;
    const dur = playState().dur;
    if (!dur) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    try { audioEl.currentTime = frac * dur; } catch (_) {}
  });

  backdrop.addEventListener("click", (e) => { if (e.isTrusted) closeModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.isTrusted && e.key === "Escape" && !modal.hidden) closeModal();
  });

  // Drag to move the card, clamped to an 8px margin so it cannot be lost
  // off screen.
  let dx = 0, dy = 0, baseDx = 0, baseDy = 0, sx = 0, sy = 0;
  let minX = 0, maxX = 0, minY = 0, maxY = 0, dragging = false;

  grip.addEventListener("pointerdown", (e) => {
    if (!e.isTrusted || e.button) return;
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    baseDx = dx; baseDy = dy;
    const r = card.getBoundingClientRect(), m = 8;
    const left = r.left - dx, top = r.top - dy;
    minX = m - left; maxX = window.innerWidth - r.width - m - left;
    minY = m - top;  maxY = window.innerHeight - r.height - m - top;
    if (minX > maxX) minX = maxX = 0;
    if (minY > maxY) minY = maxY = 0;
    card.classList.add("mic-dragging");
    try { grip.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  });
  grip.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const nx = baseDx + (e.clientX - sx), ny = baseDy + (e.clientY - sy);
    dx = nx < minX ? minX : nx > maxX ? maxX : nx;
    dy = ny < minY ? minY : ny > maxY ? maxY : ny;
    card.style.transform = `translate(${dx}px,${dy}px)`;
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    card.classList.remove("mic-dragging");
    try { grip.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  grip.addEventListener("pointerup", endDrag);
  grip.addEventListener("pointercancel", endDrag);
})();
