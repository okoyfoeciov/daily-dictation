(() => {
  "use strict";

  // Daily Dictation — dictation sessions from PBS NewsHour (audio-only, 1-2
  // sentences per session, looped), with a WER-based checker. See
  // backend/dictation.js for the session partition algorithm and the grading
  // contract. Drives the <audio> element and bottom player bar owned by
  // app-player.js, and asks it for word/phrase explanations via
  // window.__dictationExplain.

  // DOM — created in app.html
  const dictView = document.getElementById("dictation-view");
  const dictStatsEl = document.getElementById("dictation-stats");
  const dictRateWrap = document.getElementById("dictation-rate-wrap");
  const dictRateEl = document.getElementById("dictation-rate");
  const dictRateVal = document.getElementById("dictation-rate-val");
  const dictMetaEl = document.getElementById("dictation-session-meta");
  const dictTitleEl = document.getElementById("dictation-title");
  const dictLoopHint = document.getElementById("dictation-loop-hint");
  const dictLoopRange = document.getElementById("dictation-loop-range");
  const dictWrap = document.getElementById("dictation-notepad-wrap");
  const dictInput = document.getElementById("dictation-input");
  const dictCheckBtn = document.getElementById("dictation-check");
  const dictRevealBtn = document.getElementById("dictation-reveal");
  const dictLoopBtn = document.getElementById("dictation-loop");
  const dictNextBtn = document.getElementById("dictation-next");
  const dictScoreEl = document.getElementById("dictation-score");
  const dictPctEl = document.getElementById("dictation-pct");
  const dictDetailEl = document.getElementById("dictation-detail");
  const dictResultEl = document.getElementById("dictation-result");
  const dictRefEl = document.getElementById("dictation-ref");
  const dictRefPanel = document.getElementById("dictation-ref-panel");
  const dictRefScroll = document.getElementById("dictation-ref-scroll");
  const dictEmptyEl = document.getElementById("dictation-empty");
  const dictEmptyMsg = document.getElementById("dictation-empty-msg");
  const dictRetryBtn = document.getElementById("dictation-retry");
  const dictSyncEl = document.getElementById("dictation-sync");

  // The <audio> element (owned by app-player.js) — dictation loops a small
  // window inside it.
  const audioEl = document.getElementById("ln-audio");
  const playerEl = document.getElementById("ln-player");
  const playBtn = document.getElementById("ln-play");

  let currentSession = null; // {sessionId, entryId, entryTitle, start, end, duration, wordCount, reference, words, contextBefore, contextAfter}

  // Monotonic stamp for the in-flight ensureDictationAudio load. A pending
  // 'loadedmetadata' seek is only valid for the load that armed it; pressing
  // Next twice on the same entry takes the sameEntry branch (no reload, no new
  // src), so a URL stamp alone cannot tell the two apart.
  let dictLoadSeq = 0;
  let lastGrade = null;
  let hasCheckedThisSession = false;

  // Dedicated dictation loop — independent from the A-B word loop's
  // loopStart/loopEnd so clicks that clear that loop never clear this one.
  let dLoopStart = null, dLoopEnd = null;
  let dLoopRAF = null;
  const D_LOOP_LEAD_IN = 0.03;
  const D_LOOP_TAIL = 0.15;

  // An A-B LOOP over a phrase INSIDE the segment — right-click a reference word to
  // loop that word, right-press-and-drag across words to loop the phrase. It is
  // deliberately a SECOND loop, distinct from the segment window above: the
  // segment plays once and stops where this one repeats until cleared. Both
  // null = no A-B loop, and the segment behaves exactly as before.
  let abStart = null, abEnd = null;
  const AB_LEAD_IN = 0.03;   // start this far before the first word, so its onset isn't clipped
  const AB_TAIL = 0.12;      // …and this far past the last, so its final syllable finishes
  const AB_MIN = 0.35;       // floor length when the ASR reports end == start (degenerate)
  const AB_MIN_AUDIBLE = 0.12; // below this a loop window is inaudible, so treat it as degenerate

  // Playback rate for the segment. Persisted, because a learner who needs 0.75x
  // needs it on every session, not once. The "av-" prefix is kept so existing
  // installs keep their saved rate.
  const LS_DICT_RATE = "av-dictation-rate";
  const DICT_RATE_MIN = 0.6, DICT_RATE_MAX = 1.0;
  let dictRate = 1.0;

  // Continuous loop over the segment, off by default. The segment otherwise
  // plays once and stops (6da3781); this makes repeating it a toggle rather
  // than a click per repetition. Per session, NOT persisted: looping is what
  // you switch on at the end of a session, to drill the sentence you have just
  // checked — a new session always starts with it off, so a saved value would
  // only ever be overwritten the moment the first session loads.
  let dictLoopEnabled = false;

  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  const DICT_WORD_RE = /[\p{L}\p{N}](?:[\p{L}\p{N}'’\-]*[\p{L}\p{N}])?/gu;

  // Strip leading/trailing punctuation, so a span reading "problem." still asks
  // the explanation panel about "problem" (what the old regex renderer captured).
  const DICT_WORD_TRIM_RE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

  // Reference paragraph, rendered FROM the session's ASR word array so every span
  // carries its own data-start/data-end — that is what makes a right-click or
  // right-drag loopable. The session's reference text is precisely these words
  // joined by single spaces (backend/dictation.js partitionTranscript), so this
  // reproduces it verbatim.
  function renderDictationReferenceFromWords(words) {
    let html = "";
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const shown = String(w.text || "");
      const bare = shown.replace(DICT_WORD_TRIM_RE, "");
      html += (i ? " " : "") +
        `<span class="word dictation-ref-word" data-i="${i}" data-start="${w.start}" data-end="${w.end}"` +
        ` data-word="${escapeHtml(bare)}">${escapeHtml(shown)}</span>`;
    }
    return `<p>${html}</p>`;
  }

  // Fallback for a session the backend sent no timings for (unreadable transcript,
  // or an older backend): the words are still clickable for an explanation, they
  // just can't be looped — a right-click says so rather than dying silently.
  function renderDictationReference(reference, words) {
    if (Array.isArray(words) && words.length) return renderDictationReferenceFromWords(words);
    const text = String(reference || "");
    const re = new RegExp(DICT_WORD_RE.source, DICT_WORD_RE.flags);
    let html = '';
    let last = 0, m, i = 0;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) html += escapeHtml(text.slice(last, m.index));
      const w = m[0];
      // data-i even here, where there are no timings to loop: the explanation
      // gesture indexes by it, and without it left-click/drag would silently do
      // nothing on any session whose transcript could not be read.
      html += `<span class="word dictation-ref-word" data-i="${i++}" data-word="${escapeHtml(w)}">${escapeHtml(w)}</span>`;
      last = re.lastIndex;
    }
    if (last < text.length) html += escapeHtml(text.slice(last));
    return `<p>${html}</p>`;
  }

  // ---------------------------------------------------------------------------
  // View init — dictation is the only feature, so there is no feature switch:
  // the notepad is always shown and the player bar always visible.
  // ---------------------------------------------------------------------------

  function initDictationView() {
    if (dictView) dictView.hidden = false;
    if (playerEl) playerEl.hidden = false;
    // Resize observer in app-player.js measures player height for --player-h.
    requestAnimationFrame(() => {
      try { window.dispatchEvent(new Event("resize")); } catch {}
    });
  }

  // ---------------------------------------------------------------------------
  // Dictation — stats + session loading
  // ---------------------------------------------------------------------------

  // Progress, as reported by the scheduler. The backend has always computed
  // total / due / retired and sent them on every request; nothing rendered them,
  // so a drill built on daily repetition showed the learner no count, no trend,
  // and no sign when the pool ran dry.
  function renderDictStats(p) {
    if (!dictStatsEl) return;
    if (!p || !p.total) { dictStatsEl.hidden = true; dictStatsEl.textContent = ""; return; }

    const done = Math.max(0, (p.total || 0) - (p.unseen != null ? p.unseen : p.remaining || 0));
    const bits = [`${done} / ${p.total} seen`];
    if (p.due) bits.push(`<span class="due">${p.due} due</span>`);
    if (p.retired) bits.push(`${p.retired} mastered`);

    let html = bits.join('<span class="sep">·</span>');

    // Recent scores oldest→newest, so the bars read left to right like a trend.
    const recent = Array.isArray(p.recentScores) ? p.recentScores.slice().reverse() : [];
    if (recent.length) {
      const bars = recent.map((s) => {
        const h = Math.max(3, Math.round((s / 100) * 14));
        const cls = s >= 85 ? "good" : s < 60 ? "bad" : "";
        return `<i class="${cls}" style="height:${h}px" title="${s}%"></i>`;
      }).join("");
      html += `<span class="sep">·</span><span class="recent">${bars}</span>`;
    }

    dictStatsEl.innerHTML = html;
    dictStatsEl.hidden = false;
  }

  async function fetchDictStats() {
    try {
      const r = await fetch(apiBase() + "/api/dictation/stats");
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  async function refreshDictationView() {
    const p = await fetchDictStats();
    if (p) renderDictStats(p);
  }

  // ---------------------------------------------------------------------------
  // Catch-up sync status
  //
  // The backend checks for new PBS segments on launch and every few hours (see
  // backend/pbs-sync.js), filling in anything missing and repairing broken
  // transcripts. This shows what it is doing, and hides when there is nothing
  // to report.
  // ---------------------------------------------------------------------------
  let lastSyncState = null;

  function renderSyncStatus(st) {
    if (!dictSyncEl) return;
    const s = st || {};
    let text = "";
    if (s.state === "checking") {
      text = "Checking for new episodes…";
    } else if (s.state === "importing" || s.state === "repairing") {
      const verb = s.state === "repairing" ? "Repairing" : "Importing";
      text = s.total ? `${verb} ${s.current}/${s.total}…` : `${verb}…`;
    } else if (s.state === "done") {
      const bits = [];
      if (s.imported) bits.push(`Added ${s.imported} new episode${s.imported === 1 ? "" : "s"}`);
      if (s.repaired) bits.push(`repaired ${s.repaired}`);
      // Keep the result on screen for a beat after the run finishes.
      if (bits.length && Date.now() - (s.at || 0) < 12000) text = bits.join(" · ");
      // A source whose feed could not be read stays on screen until a run reads
      // it, so a dead feed is not hidden behind the other source's good run.
      if (s.feedFailures) {
        const n = s.feedFailures;
        text = (text ? text + " · " : "") + `${n} source${n === 1 ? "" : "s"} unreachable — will retry`;
      }
    } else if (s.state === "error") {
      text = "New-episode check failed — will retry";
    }
    dictSyncEl.textContent = text;
    dictSyncEl.hidden = !text;
  }

  async function pollSyncStatus() {
    try {
      const r = await fetch(apiBase() + "/api/sync/status");
      if (!r.ok) return;
      const st = await r.json();
      const becameDone = lastSyncState !== "done" && st.state === "done";
      lastSyncState = st.state;
      renderSyncStatus(st);
      // New transcripts mean new sessions — refresh the stats the moment a
      // run that imported or repaired something finishes.
      if (becameDone && (st.imported || st.repaired)) refreshDictationView();
    } catch { /* backend briefly unavailable; the next poll retries */ }
  }

  // ---------------------------------------------------------------------------
  // Playback rate
  //
  // preservesPitch keeps a slowed clip intelligible rather than turning it into
  // a drawl; without it, slowing speech is close to useless for decoding.
  // ---------------------------------------------------------------------------

  function applyDictRate() {
    if (!audioEl) return;
    try {
      audioEl.preservesPitch = true;
      audioEl.mozPreservesPitch = true;
      audioEl.webkitPreservesPitch = true;
    } catch {}
    try { audioEl.playbackRate = dictRate; } catch {}
  }

  function setDictRate(rate, { persist = true } = {}) {
    dictRate = Math.min(DICT_RATE_MAX, Math.max(DICT_RATE_MIN, Number(rate) || 1));
    if (dictRateEl) dictRateEl.value = String(Math.round(dictRate * 100));
    // Strip a trailing zero ("0.60" -> "0.6") but never the one in "1.0", which
    // the old expression ate and rendered as "1.×" — the default label every
    // learner who has not touched the slider sees.
    if (dictRateVal) {
      dictRateVal.textContent =
        (dictRate === 1 ? "1.0" : dictRate.toFixed(2).replace(/0$/, "")) + "×";
    }
    if (persist) { try { localStorage.setItem(LS_DICT_RATE, String(dictRate)); } catch {} }
    applyDictRate();
  }

  function setDictLoop(on) {
    dictLoopEnabled = !!on;
    if (dictLoopBtn) {
      dictLoopBtn.classList.toggle("active", dictLoopEnabled);
      dictLoopBtn.setAttribute("aria-pressed", dictLoopEnabled ? "true" : "false");
      const label = dictLoopEnabled
        ? "Looping this segment — click to play it once instead"
        : "Loop this segment continuously";
      dictLoopBtn.title = label;
      // The button is a bare icon in the player bar; without this the only name
      // it has is the tooltip, which assistive tech does not read.
      dictLoopBtn.setAttribute("aria-label", label);
    }
    // Turning it on mid-segment should start looping now, not after the next
    // manual play; the tick only runs while a loop is armed.
    if (dictLoopEnabled && !audioEl.paused) startDictLoop();
  }

  (function initDictLoop() {
    setDictLoop(false);
    if (dictLoopBtn) dictLoopBtn.addEventListener("click", () => setDictLoop(!dictLoopEnabled));
  })();

  (function initDictRate() {
    let saved = 1.0;
    try { saved = Number(localStorage.getItem(LS_DICT_RATE)) || 1.0; } catch {}
    setDictRate(saved, { persist: false });
    if (dictRateEl) {
      dictRateEl.addEventListener("input", () => setDictRate(Number(dictRateEl.value) / 100));
    }
  })();

  function showDictEmpty(msg) {
    dictEmptyMsg.textContent = msg || "No dictation sessions available.";
    dictEmptyEl.hidden = false;
    dictWrap.hidden = true;
    // Loop lives in the player bar now, which stays up with no session loaded —
    // the notepad wrap used to hide it for free. There is nothing to loop here.
    if (dictLoopBtn) dictLoopBtn.disabled = true;
    dictMetaEl.hidden = true;
    dictLoopHint.hidden = true;
    if (dictRateWrap) dictRateWrap.hidden = true;
  }

  function showDictReady() {
    dictEmptyEl.hidden = true;
    dictWrap.hidden = false;
    dictMetaEl.hidden = false;
    if (dictLoopBtn) dictLoopBtn.disabled = false;
  }

  function hideDictRef() {
    clearAbLoop();   // the looped words are gone, so the loop goes with them
    if (dictRefEl) { dictRefEl.hidden = true; dictRefEl.innerHTML = ""; }
    if (dictRefPanel) dictRefPanel.hidden = true;
    if (dictRefScroll) dictRefScroll.scrollTop = 0;
  }
  function showDictRef() {
    if (dictRefEl) dictRefEl.hidden = false;
    if (dictRefPanel) dictRefPanel.hidden = false;
    // The reference lives inside .player, in the slot above the controls. On
    // the narrow layout (app.html's max-width:760px rules) the player boots
    // collapsed (body.player-collapsed, display:none) and only the floating
    // show-player button re-opens it — so a Reveal there would show nothing at
    // all. Open the player the way that button does: its click runs
    // app-player.js's closure-private setPlayerCollapsed(false), which also
    // re-measures --player-h. On desktop the class is inert and the player is
    // never display:none, so this branch is never taken there.
    if (playerEl && document.body.classList.contains("player-collapsed") &&
        getComputedStyle(playerEl).display === "none") {
      const fab = document.getElementById("ln-fab");
      if (fab) fab.click();
    }
    // Scroll the panel's content to top and bring panel into view
    if (dictRefPanel) dictRefPanel.scrollIntoView({ block: "nearest" });
    if (dictRefScroll) dictRefScroll.scrollTop = 0;
  }

  // autoplay defaults to FALSE: arriving at a new session should not start audio
  // on its own. The learner decides when to listen — pressing Next while reading
  // the previous answer used to blast the next clip immediately. Callers that
  // genuinely want playback pass autoplay: true.
  async function loadNextSession({ autoplay = false } = {}) {
    dictCheckBtn.disabled = true;
    dictNextBtn.disabled = true;
    dictResultEl.hidden = true;
    dictResultEl.innerHTML = "";
    hideDictRef();
    dictScoreEl.hidden = true;
    closeExplanations();
    lastGrade = null;
    hasCheckedThisSession = false;
    dictInput.value = "";
    dictRevealBtn.hidden = true;
    // A new session starts with Loop off: the toggle belongs to the session it
    // was switched on in (drilling the sentence just checked) and is never
    // carried into the next one. Next already flips it at click time
    // (completeAndNext); this covers Retry and the first load as well.
    setDictLoop(false);

    try {
      const r = await fetch(apiBase() + "/api/dictation/session");
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const data = await r.json();

      // Everything mastered. Show the totals rather than the blank "no sessions"
      // screen, which is what an unreachable backend looks like.
      if (!data.sessionId) {
        currentSession = null;
        showDictEmpty("All sessions mastered — nothing due right now.");
        if (data.stats) renderDictStats(data.stats);
        dictNextBtn.disabled = false;
        return;
      }

      currentSession = {
        sessionId: data.sessionId,
        entryId: data.entryId,
        entryTitle: data.entryTitle,
        start: Number(data.start) || 0,
        end: Number(data.end) || 0,
        duration: Number(data.duration) || 0,
        wordCount: Number(data.wordCount) || 0,
        reference: String(data.reference || ""),
        // Neighboring sessions' texts (same entry) for the explanation lookup:
        // a one-sentence session alone often cannot fix a word's sense.
        contextBefore: String(data.contextBefore || ""),
        contextAfter: String(data.contextAfter || ""),
        wpm: Number(data.wpm) || 0,
        exhausted: !!data.exhausted,
        // Per-word ASR timings for this segment — the raw material for the A-B
        // loop below. [] from a backend that couldn't read the transcript.
        words: Array.isArray(data.words) ? data.words.map((w) => ({
          text: String(w.text || ""),
          start: Number(w.start) || 0,
          end: Number(w.end) || Number(w.start) || 0,
        })) : [],
      };
      // Update header
      dictTitleEl.textContent = currentSession.entryTitle || currentSession.entryId;
      dictTitleEl.title = currentSession.entryTitle || "";
      dictLoopRange.textContent = `${fmt(currentSession.start)} – ${fmt(currentSession.end)}  ·  ${currentSession.wordCount} words`;
      dictLoopHint.hidden = false;
      showDictReady();
      dictCheckBtn.disabled = false;
      dictNextBtn.disabled = false;
      if (dictRateWrap) dictRateWrap.hidden = false;
      await ensureDictationAudio({ autoplay });
      // Nothing is due and nothing is new — the learner is studying ahead of
      // schedule. Say so, instead of silently re-serving finished material the
      // way the old recycle branch did.
      if (data.exhausted) {
        flashLoopHint("All caught up — reviewing ahead of schedule");
      }
      refreshDictationView();
    } catch (e) {
      console.error("dictation next failed", e);
      showDictEmpty(e && e.message ? String(e.message) : "Could not load a session.");
      if (dictStatsEl) { dictStatsEl.textContent = ""; dictStatsEl.hidden = true; }
      dictNextBtn.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Dictation — audio (loop whole file, play window [dLoopStart, dLoopEnd))
  // ---------------------------------------------------------------------------

  function stopDictLoop() {
    dLoopStart = null; dLoopEnd = null;
    if (dLoopRAF != null) { cancelAnimationFrame(dLoopRAF); dLoopRAF = null; }
  }

  function startDictLoop() {
    if (dLoopRAF == null) dLoopRAF = requestAnimationFrame(dictLoopTick);
  }

  function dictLoopTick() {
    dLoopRAF = null;
    if (!audioEl.src || audioEl.paused || audioEl.error) return;
    // An A-B loop takes precedence over the segment window, and REPEATS where the
    // segment deliberately plays once and stops (the pause branch below).
    if (abStart != null && abEnd != null) {
      if ((audioEl.currentTime || 0) >= abEnd) {
        try { audioEl.currentTime = Math.max(0, abStart - AB_LEAD_IN); } catch {}
      }
      dLoopRAF = requestAnimationFrame(dictLoopTick);
      return;
    }
    if (dLoopStart == null || dLoopEnd == null) return;
    const pos = audioEl.currentTime || 0;
    if (pos >= dLoopEnd - 0.02) {
      // With Loop on, rewind and keep playing. With it off, play once then pause
      // and reset to the start for the next manual play — leaving the playhead
      // at dLoopEnd instead would re-trigger this branch on the next Play click
      // and look like the button had switched itself off.
      if (dictLoopEnabled) {
        try { audioEl.currentTime = Math.max(0, dLoopStart - D_LOOP_LEAD_IN); } catch {}
        dLoopRAF = requestAnimationFrame(dictLoopTick);
        return;
      }
      try { audioEl.pause(); } catch {}
      try { audioEl.currentTime = Math.max(0, dLoopStart - D_LOOP_LEAD_IN); } catch {}
      return;
    }
    dLoopRAF = requestAnimationFrame(dictLoopTick);
  }

  // ---------------------------------------------------------------------------
  // A-B loop over a phrase inside the segment (right-click / right-drag)
  // ---------------------------------------------------------------------------

  // Momentary message in the header's loop-range slot, restored after a beat.
  let loopHintTimer = null;
  function flashLoopHint(msg) {
    if (!dictLoopRange) return;
    dictLoopRange.textContent = msg;
    if (loopHintTimer) clearTimeout(loopHintTimer);
    loopHintTimer = setTimeout(() => {
      loopHintTimer = null;
      if (!currentSession) return;
      dictLoopRange.textContent =
        `${fmt(currentSession.start)} \u2013 ${fmt(currentSession.end)}  \u00b7  ${currentSession.wordCount} words`;
    }, 1800);
  }

  // Mark every reference word inside [abStart, abEnd) with .looping. Matched by
  // start time rather than index, so it survives a re-render of the paragraph.
  function applyAbLoopMark() {
    if (!dictRefEl) return;
    for (const sp of dictRefEl.querySelectorAll(".dictation-ref-word")) {
      const s = parseFloat(sp.dataset.start);
      sp.classList.toggle("looping",
        abStart != null && !isNaN(s) && s >= abStart - 0.001 && s < abEnd - 0.001);
    }
  }

  // Always repaints, even when nothing was looping — it doubles as the way a
  // drag PREVIEW is wiped when the gesture ends without setting a loop.
  function clearAbLoop() {
    abStart = null; abEnd = null;
    applyAbLoopMark();
  }

  // Loop reference words [i0..i1] (one word when i0 === i1): jump to the phrase and
  // play it at once, so the loop is audible without touching the transport.
  function setAbLoopFromWords(i0, i1) {
    const words = (currentSession && currentSession.words) || [];
    const a = Math.min(i0, i1), b = Math.max(i0, i1);
    let s = Infinity, e = -Infinity;
    for (let k = a; k <= b; k++) {
      const w = words[k];
      if (!w || !isFinite(w.start)) continue;
      if (w.start < s) s = w.start;
      const we = (isFinite(w.end) && w.end > w.start) ? w.end : w.start;
      if (we > e) e = we;
    }
    if (!isFinite(s) || !isFinite(e)) { flashLoopHint("No word timings to loop"); return false; }
    // The floor has to be a real audible length, not a test for exactly-zero.
    // The transcriber squashes overlapping words to exactly 0.050 s, which is
    // not < 0.05, so a tighter test never fired and left a window too short to
    // hear.
    if (e - s < AB_MIN_AUDIBLE) e = s + AB_MIN;
    e += AB_TAIL;
    // …but never reach into the next word — unless honouring that would leave
    // nothing to play. In a collapsed-timestamp run every word shares one start,
    // so this clamp used to drive e back to s, and dictLoopTick then reseeked on
    // every animation frame with no audio ever advancing.
    const next = words[b + 1];
    if (next && isFinite(next.start) && next.start - s > AB_MIN_AUDIBLE) {
      e = Math.min(e, next.start);
    }
    if (e - s < AB_MIN_AUDIBLE) e = s + AB_MIN;          // last resort: always playable
    abStart = s; abEnd = e;
    applyAbLoopMark();
    try { audioEl.currentTime = Math.max(0, abStart - AB_LEAD_IN); } catch {}
    if (audioEl.paused) { const p = audioEl.play(); if (p && p.catch) p.catch(() => {}); }
    startDictLoop();
    return true;
  }

  async function ensureDictationAudio({ autoplay = true } = {}) {
    if (!currentSession) return;
    const src = apiBase() + "/api/library/" + encodeURIComponent(currentSession.entryId) + "/stream";
    const dStart = currentSession.start;
    const dEnd = currentSession.end;

    // If the <audio> already points at this entry, just move the loop window
    // and seek (don't reload the stream — that would re-buffer).
    const currentSrc = audioEl.getAttribute("src") || audioEl.src || "";
    const sameEntry = currentSrc.includes("/api/library/" + encodeURIComponent(currentSession.entryId) + "/");

    dLoopStart = dStart;
    dLoopEnd = dEnd + D_LOOP_TAIL; // let final syllable finish

    // Invalidate any seek still pending from an earlier call — including one on
    // this same entry, which the sameEntry branch below would otherwise leave
    // armed to drag the playhead back to the PREVIOUS segment's offset.
    const myLoad = ++dictLoadSeq;
    applyDictRate();

    if (sameEntry && audioEl.src) {
      try { audioEl.currentTime = Math.max(0, dStart - D_LOOP_LEAD_IN); } catch {}
      startDictLoop();
      if (autoplay) {
        if (audioEl.paused) {
          const p = audioEl.play();
          if (p && p.catch) p.catch(() => {});
        }
      } else {
        try { audioEl.pause(); } catch {}
      }
      return;
    }

    // New entry: point the <audio> at it — dictation loops a small window
    // inside the segment's file.
    audioEl.src = src;
    try { audioEl.load(); } catch {}
    // Wait for metadata to know duration before seeking
    const seekToLoop = () => {
      audioEl.removeEventListener("loadedmetadata", seekToLoop);
      // Stale-listener hazard: a pending seek is only valid for the load that
      // armed it — a newer session must not inherit this one's offset.
      if (myLoad !== dictLoadSeq) return;                 // a newer session superseded this one
      if (audioEl.getAttribute("src") !== src) return;
      try { audioEl.currentTime = Math.max(0, dStart - D_LOOP_LEAD_IN); } catch {}
      applyDictRate();   // a new src resets playbackRate to 1
      startDictLoop();
      if (autoplay) {
        const p = audioEl.play();
        if (p && p.catch) p.catch(() => {});
      }
    };
    if (audioEl.readyState >= 1) seekToLoop();
    else audioEl.addEventListener("loadedmetadata", seekToLoop);

    // Ensure player bar is enabled
    if (playBtn) playBtn.disabled = false;
    const backBtn = document.getElementById("ln-back");
    const fwdBtn = document.getElementById("ln-fwd");
    if (backBtn) backBtn.disabled = false;
    if (fwdBtn) fwdBtn.disabled = false;
    if (playerEl) playerEl.hidden = false;
  }

  // Dictation segment monitor — play once then pause at segment end
  // (auto-loop disabled). Keep monitoring on play/seeked so we stop
  // precisely at dLoopEnd; do NOT restart on 'ended'.
  if (audioEl) {
    audioEl.addEventListener("play", () => {
      if (dLoopStart != null || abStart != null) startDictLoop();
    });
    audioEl.addEventListener("ended", () => {
      // An A-B loop whose end sits at the very end of the file reaches 'ended'
      // before the watcher catches it — send it round again rather than stopping.
      if (abStart != null) {
        try { audioEl.currentTime = Math.max(0, abStart - AB_LEAD_IN); } catch {}
        const p = audioEl.play(); if (p && p.catch) p.catch(() => {});
        startDictLoop();
        return;
      }
      if (dLoopStart == null) return;
      stopDictLoop();
    });
    audioEl.addEventListener("seeked", () => {
      if (dLoopStart == null && abStart == null) return;
      if (!audioEl.paused) startDictLoop();
    });
  }

  // ---------------------------------------------------------------------------
  // Checker
  // ---------------------------------------------------------------------------

  function renderGrade(result) {
    const { score, wer, n, S, D, I, C, ops, reference } = result;
    lastGrade = result;
    hasCheckedThisSession = true;

    // Score badge
    dictPctEl.textContent = `${score}%`;
    dictPctEl.className = "pct " + (score >= 85 ? "good" : score >= 60 ? "mid" : "bad");
    const detail = `${C}/${n} correct · ${S} sub · ${D} del · ${I} ins · WER ${(wer * 100).toFixed(1)}%`;
    dictDetailEl.textContent = detail;
    dictScoreEl.hidden = false;

    // Alignment as a flowing paragraph of spans.
    // ops is in order; for dictation we render reference-side view:
    //  C = green, S = red striked + show hyp, D = amber dashed (missing), I = italic insertion.
    let html = "";
    for (const op of ops) {
      if (op.op === "C") {
        html += `<span class="word correct" title="Correct">${escapeHtml(op.ref)}</span> `;
      } else if (op.op === "S") {
        html += `<span class="word sub" title="Should be “${escapeHtml(op.ref)}”, you wrote “${escapeHtml(op.hyp)}”">${escapeHtml(op.hyp)}</span> `;
      } else if (op.op === "D") {
        html += `<span class="word missing" title="Missing: “${escapeHtml(op.ref)}”">${escapeHtml(op.ref)}</span> `;
      } else if (op.op === "I") {
        html += `<span class="word ins" title="Extra word">${escapeHtml(op.hyp)}</span> `;
      }
    }
    dictResultEl.innerHTML = html.trim() || `<span style="color:var(--text-dim)">No words to compare.</span>`;
    dictResultEl.hidden = false;

    // Reference paragraph — hidden until Reveal, words are clickable
    // to trigger the explanation panel (via window.__dictationExplain)
    dictRefEl.innerHTML = renderDictationReference(reference, currentSession && currentSession.words);
    // Re-checking rebuilds these spans, which drops .looping from a loop that is
    // still running — leaving the audio repeating a word with nothing on screen
    // saying which. applyAbLoopMark matches on data-start, not index, precisely
    // so it survives a re-render (see its comment).
    applyAbLoopMark();
    dictRevealBtn.hidden = false;
    // Auto-scroll the result into view
    dictResultEl.scrollIntoView({ block: "nearest" });
  }

  function showRef() {
    showDictRef();
  }

  // Moving to the next session invalidates the old session's explanation —
  // close the explanation panel (aborts any in-flight stream).
  function closeExplanations() {
    if (typeof window.__dictationCloseExplanations === "function") {
      try { window.__dictationCloseExplanations(); } catch {}
    }
  }

  async function checkCurrent() {
    if (!currentSession) return;
    const hypothesis = dictInput.value || "";
    if (!hypothesis.trim()) {
      dictInput.focus();
      // Brief hint via the score slot
      dictPctEl.textContent = "—";
      dictPctEl.className = "pct bad";
      dictDetailEl.textContent = "Type something first";
      dictScoreEl.hidden = false;
      return;
    }
    dictCheckBtn.disabled = true;
    dictCheckBtn.textContent = "Checking…";
    try {
      const r = await fetch(apiBase() + "/api/dictation/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: currentSession.sessionId, hypothesis }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      renderGrade(data);
    } catch (e) {
      console.error("check failed", e);
      dictResultEl.hidden = false;
      dictResultEl.textContent = "Check failed: " + String(e.message || e);
    } finally {
      dictCheckBtn.disabled = false;
      dictCheckBtn.textContent = "Check";
    }
  }

  // Called from the microphone transcript card (mic.js): replace the notepad's
  // answer with the dictated text and grade it. Returns false when there is no
  // session to check against, so the card keeps the transcript instead of
  // closing on a no-op.
  function insertAndCheck(text) {
    const t = String(text || "").trim();
    if (!currentSession || !t) return false;
    dictInput.value = t;
    dictInput.focus();
    checkCurrent();
    return true;
  }

  async function completeAndNext() {
    // Clear grading numbers instantly on Next — don't wait for /complete or
    // /session round-trips (previous behavior kept 85% / WER visible until
    // loadNextSession's fetch completed). Capture score before clearing.
    // Disable FIRST: the attempt POST below is awaited, and until loadNextSession
    // runs the button is live with currentSession still pointing at the session
    // just submitted. A second click in that window posts a phantom skipped
    // attempt for it, and the log is append-only by design, so the junk row is
    // permanent and depresses the item's novelty score for good.
    if (dictNextBtn.disabled) return;
    dictNextBtn.disabled = true;

    const scoreToSave = lastGrade && typeof lastGrade.score === "number" ? lastGrade.score : null;
    // Captured here because the reset below runs before the attempt is posted.
    const checkedThisSession = hasCheckedThisSession;
    dictScoreEl.hidden = true;
    dictPctEl.textContent = "—";
    dictPctEl.className = "pct";
    dictDetailEl.textContent = "";
    dictResultEl.hidden = true;
    dictResultEl.innerHTML = "";
    hideDictRef();
    dictRevealBtn.hidden = true;
    // Old session's explanation is stale the moment Next is pressed — close it
    // now, not after the /complete round trip below (same as the grading clear
    // and loop-off above). loadNextSession closes again for the Retry path.
    closeExplanations();
    lastGrade = null;
    hasCheckedThisSession = false;
    // Loop off at click time, not after the /complete round trip below: the
    // segment must not keep repeating under an already-pressed Next.
    setDictLoop(false);

    // Record the attempt. A session the learner never checked is reported as
    // SKIPPED, not as a completion: the backend logs it and leaves the item
    // schedulable. Marking on Next regardless — what this used to do — meant
    // pressing Next twice while deciding what to study destroyed two items from
    // a finite pool, indistinguishably from two genuine failures.
    if (currentSession) {
      const skipped = !checkedThisSession;
      try {
        const r = await fetch(apiBase() + "/api/dictation/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: currentSession.sessionId,
            score: skipped ? null : scoreToSave,
            skipped,
          }),
        });
        if (r.ok) {
          const j = await r.json().catch(() => null);
          if (j && j.progress) renderDictStats(j.progress);
        }
      } catch (e) {
        console.warn("attempt record failed", e);
      }
    }
    await loadNextSession();
    dictInput.focus();
  }

  if (dictCheckBtn) dictCheckBtn.addEventListener("click", checkCurrent);
  if (dictRevealBtn) dictRevealBtn.addEventListener("click", showRef);
  if (dictNextBtn) dictNextBtn.addEventListener("click", completeAndNext);
  // Wrapped, not passed directly: as a listener it would receive the click Event
  // as its options object and read autoplay off it.
  if (dictRetryBtn) dictRetryBtn.addEventListener("click", () => loadNextSession());

  // Explanation lookup on the Reference line: left-CLICK a word, or left-DRAG
  // across several to ask about the whole phrase. Driven off
  // mousedown → mousemove → mouseup like the right-button loop below,
  // rather than a click listener, so a drag and a click are distinguishable and
  // the drag can paint a live preview.
  //
  // The LLM gets more than the current 1-2 sentences: one neighboring session
  // per side (same entry, served as contextBefore/contextAfter), because a
  // short session alone often cannot fix a word's sense. The current session —
  // where the click came from — is wrapped in >>> <<< so a word appearing both
  // inside and outside it still resolves to the inside occurrence. With no
  // neighbors the context is just the session itself (previous behaviour).
  function buildExplainContext() {
    const focus = String((currentSession && currentSession.reference) || "").trim();
    const before = String((currentSession && currentSession.contextBefore) || "").trim();
    const after = String((currentSession && currentSession.contextAfter) || "").trim();
    if (!before && !after) return focus;
    const lines = [
      "Explain the chosen word(s) as used inside the >>> <<< marks. " +
      "The lines outside the marks are neighboring sentences from the same episode, " +
      "included only to fix the sense — when the same word appears inside and " +
      "outside the marks, the inside occurrence is the one to explain.",
      "",
    ];
    if (before) lines.push(before);
    lines.push(`>>> ${focus} <<<`);
    if (after) lines.push(after);
    return lines.join("\n");
  }

  function explainFromRange(a, b) {
    if (!dictRefEl) return;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const parts = [];
    for (const sp of dictRefEl.querySelectorAll(".dictation-ref-word")) {
      const i = Number(sp.dataset.i);
      if (isNaN(i) || i < lo || i > hi) continue;
      const bare = sp.dataset.word || sp.textContent || "";
      if (bare.trim()) parts.push(bare.trim());
    }
    const phrase = parts.join(" ");
    if (!phrase) return;
    const context = buildExplainContext() || phrase;
    if (window.__dictationExplain) window.__dictationExplain(phrase, context);
  }

  function paintMarkRange(a, b) {
    if (!dictRefEl) return;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    for (const sp of dictRefEl.querySelectorAll(".dictation-ref-word")) {
      const i = Number(sp.dataset.i);
      sp.classList.toggle("marked", !isNaN(i) && i >= lo && i <= hi);
    }
  }

  function clearMarkRange() {
    if (!dictRefEl) return;
    for (const sp of dictRefEl.querySelectorAll(".dictation-ref-word")) sp.classList.remove("marked");
  }

  // Right-click a Reference word to loop it, right-press-and-drag across words to
  // loop the phrase. The right button doesn't drag-select natively (it fires
  // 'contextmenu', suppressed just below), so the whole gesture is driven off
  // mousedown → mousemove → mouseup ourselves.
  //
  // The two gestures keep SEPARATE state. Sharing one slot discriminated by a
  // button field meant a right press mid-left-drag overwrote it, stranding the
  // .marked paint with no path left to clear it, and an undiscriminated window
  // mouseup let the release of either button finish whichever gesture happened
  // to be stored.
  let abDrag = null;     // right button — A-B loop
  let markDrag = null;   // left button — explanation lookup

  // Live preview while dragging: paint the range as it WOULD loop, without
  // committing it. Wiped by applyAbLoopMark() when the gesture ends.
  function paintAbDragRange() {
    if (!abDrag || abDrag.startIdx == null || !dictRefEl) return;
    const a = Math.min(abDrag.startIdx, abDrag.currentIdx);
    const b = Math.max(abDrag.startIdx, abDrag.currentIdx);
    for (const sp of dictRefEl.querySelectorAll(".dictation-ref-word")) {
      const i = Number(sp.dataset.i);
      sp.classList.toggle("looping", !isNaN(i) && i >= a && i <= b);
    }
  }

  if (dictRefEl) {
    // The panel owns the right button, so the native menu never pops mid-gesture.
    dictRefEl.addEventListener("contextmenu", (e) => { e.preventDefault(); });

    dictRefEl.addEventListener("mousedown", (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      const span = e.target.closest && e.target.closest(".dictation-ref-word");

      // LEFT press → mark a word/phrase for an explanation lookup. Must start on a
      // word, and needs no word timings — an explanation is about the text.
      if (e.button === 0) {
        if (!span || span.dataset.i === undefined) return;
        e.preventDefault();
        const i = Number(span.dataset.i);
        markDrag = { startIdx: i, currentIdx: i, moved: false };
        paintMarkRange(i, i);
        return;
      }

      e.preventDefault();
      // A right press abandons any left drag in progress — the learner has
      // changed their mind about what this gesture is. Drop its paint here, or
      // nothing downstream ever will.
      if (markDrag) { markDrag = null; clearMarkRange(); }
      if (!currentSession || !(currentSession.words || []).length) {
        flashLoopHint("No word timings to loop");
        return;
      }
      // Right-pressing OFF a word leaves startIdx null; mousemove can still anchor
      // the drag on the first word it crosses, and a release that never did clears.
      const i = span && span.dataset.i !== undefined ? Number(span.dataset.i) : null;
      abDrag = { startIdx: i, currentIdx: i, moved: false };
      if (i != null) paintAbDragRange();
    });

    dictRefEl.addEventListener("mousemove", (e) => {
      const ds = markDrag || abDrag;
      if (!ds) return;
      if (e.buttons === 0) {   // a release we never saw — recover, don't keep a stale preview
        markDrag = null; abDrag = null;
        clearMarkRange();
        applyAbLoopMark();
        return;
      }
      const span = e.target.closest && e.target.closest(".dictation-ref-word");
      if (!span || span.dataset.i === undefined) return;
      const i = Number(span.dataset.i);
      const repaint = ds === markDrag
        ? () => paintMarkRange(ds.startIdx, ds.currentIdx)
        : paintAbDragRange;
      if (ds.startIdx == null) { ds.startIdx = ds.currentIdx = i; repaint(); return; }
      if (i === ds.currentIdx) return;
      ds.currentIdx = i;
      if (i !== ds.startIdx) ds.moved = true;
      repaint();
    });
  }

  // Released anywhere, so a drag that slips off the panel still commits.
  // Released anywhere, so a drag that slips off the panel still commits — but
  // only the button that STARTED a gesture may finish it. Without that check the
  // release of a right button pressed mid-left-drag was read as the end of the
  // left gesture and fired a half-finished explanation.
  window.addEventListener("mouseup", (e) => {
    // LEFT release → fire the explanation for the marked word or phrase. Clearing
    // the marks first, then repainting the loop, keeps a live A-B loop visible
    // underneath a selection that has just been consumed.
    if (e.button === 0 && markDrag) {
      const ds = markDrag; markDrag = null;
      clearMarkRange();
      applyAbLoopMark();
      if (ds.startIdx != null) explainFromRange(ds.startIdx, ds.currentIdx);
      return;
    }
    if (e.button !== 2 || !abDrag) return;
    const ds = abDrag; abDrag = null;

    if (ds.startIdx == null) { clearAbLoop(); return; }   // right-clicked empty space → stop
    // A single right-click on the word already looping toggles the loop OFF.
    const w0 = ((currentSession && currentSession.words) || [])[ds.startIdx];
    if (!ds.moved && w0 && abStart != null && Math.abs((Number(w0.start) || 0) - abStart) < 0.001) {
      clearAbLoop();
      return;
    }
    setAbLoopFromWords(ds.startIdx, ds.currentIdx);
  });

  // ANY press other than the right button (which sets or extends the loop)
  // stops it — click anywhere to stop looping.
  // Dictation's main surface is a textarea the learner must click to do the very
  // exercise the loop exists for, so the unmodified reflex reads as "start typing
  // to stop looping". Exempt only the surfaces where a press IS the exercise:
  // the textarea, the graded word-diff, and the Reference panel (a left-click
  // there asks for an explanation of the very word you're looping). Deliberately
  // NOT the whole notepad wrap — that contains Check/Reveal, and a press on one of
  // those means the learner is done listening to the looped word. Every button, and
  // the player bar, keeps the "a press means move on" reading.
  const LOOP_KEEP_SEL = "#dictation-input, #dictation-result, #dictation-ref-panel";
  document.addEventListener("mousedown", (e) => {
    if (e.button === 2) return;
    if (abStart == null) return;
    if (e.target && e.target.closest && e.target.closest(LOOP_KEEP_SEL)) return;
    clearAbLoop();
  });

  // Esc stops the loop. Allowed while the notepad has focus —
  // Escape types nothing, and a learner mid-sentence is exactly who wants it.
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key !== "Escape" || abStart == null) return;
    e.preventDefault();
    clearAbLoop();
  });

  // Keyboard: Ctrl/Cmd+Enter to check, Enter on next when focused, and
  // plain Enter in the textarea should NOT submit (learner needs newlines).
  if (dictInput) {
    dictInput.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        checkCurrent();
      }
    });
  }

  // Allow the player bar's global Space handler to control the <audio>
  // even in dictation — no need to suppress. But when the textarea is focused
  // Space must type, so that global handler already bails when document.activeElement
  // is a text field (see app-player.js isEditableTarget) — no action needed.

  // ---------------------------------------------------------------------------
  // Reference panel — touch-scroll quarantine (mirrors keepScrollInside)
  // ---------------------------------------------------------------------------
  (function wireDictRefScroll() {
    if (dictRefScroll) {
      let lastY = 0;
      dictRefScroll.addEventListener("touchstart", (e) => {
        if (e.touches.length === 1) lastY = e.touches[0].clientY;
      }, { passive: true });
      dictRefScroll.addEventListener("touchmove", (e) => {
        if (e.touches.length !== 1) return;
        const y = e.touches[0].clientY;
        const dy = y - lastY;
        lastY = y;
        if (dy === 0) return;
        const canScroll = dictRefScroll.scrollHeight - dictRefScroll.clientHeight > 0;
        const atTop = dictRefScroll.scrollTop <= 0;
        const atBottom = dictRefScroll.scrollTop + dictRefScroll.clientHeight >= dictRefScroll.scrollHeight - 1;
        if ((!canScroll || (atTop && dy > 0) || (atBottom && dy < 0)) && e.cancelable) e.preventDefault();
      }, { passive: false });
    }
  })();

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  initDictationView();
  refreshDictationView();
  loadNextSession({ autoplay: false });
  pollSyncStatus();
  setInterval(pollSyncStatus, 10000);

  // The mic transcript card's "Insert and check" entry point (see mic.js).
  window.__dictationInsertAndCheck = insertAndCheck;

  // Expose for console debugging
  window.__dictation = {
    get session() { return currentSession; },
    get abLoop() { return abStart == null ? null : { start: abStart, end: abEnd }; },
    loadNextSession,
    checkCurrent,
    insertAndCheck,
    completeAndNext,
  };
})();
