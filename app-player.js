(function () {
  "use strict";

  /* Player — dictation's audio transport + AI-explanation engine. Owned by
     Daily Dictation (app-dictation.js): it shares this file's <audio> element
     and bottom player bar (play/pause/seek/time/back-fwd/collapse/keyboard/
     ticker), and drives explanations through window.__dictationExplain
     (single panel, drill-down rounds, pronunciation badges, credits warning).
     Dictation sets the audio source itself and this file just plays it. */

  /* ---------- render helpers ---------- */

  const WORD_RE = /[\p{L}\p{N}](?:[\p{L}\p{N}'’\-]*[\p{L}\p{N}])?/gu;
  const PRON_BRACKET_RE = /\[\[PRON\b([^\]]*?)\]\]/g;
  const PRON_WORD_ATTR_RE = /\bword="([^"]*)"/;
  const PRON_POS_ATTR_RE = /\bpos="([^"]*)"/;
  // ipa="…" is the LLM's own best-effort respelling, used as the fallback badge
  // when Merriam-Webster has no pronunciation for the word (see badgeHtml).
  const PRON_IPA_ATTR_RE = /\bipa="([^"]*)"/;
  // [[SENSE p="N"]] — how likely this reading of the passage is, as a whole
  // percent. The model emits one per sense ONLY when a passage genuinely leaves
  // the sense open and the answer therefore carries more than one (the prompt's
  // Ambiguity rule); an unambiguous item gets none.
  const SENSE_BRACKET_RE = /\[\[SENSE\b([^\]]*?)\]\]/g;
  const SENSE_P_ATTR_RE = /\bp="\s*(\d{1,3})\s*%?"/;
  // Any placeholder tag, half-streamed or whole — used to hide a tag that is
  // still arriving so half of one never flashes on screen.
  const ANY_TAG_OPENERS = ["[[PRON", "[[SENSE"];

  const POS_ABBREV = {
    noun: "n.", verb: "v.", adjective: "adj.", adverb: "adv.",
    preposition: "prep.", conjunction: "conj.",
    interjection: "interj.", pronoun: "pron.",
  };

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // The POS "head": the bare part of speech with MW's "(1)" / "(2)" sense
  // suffix and any trailing words ("transitive verb") dropped — so "noun (2)"
  // and "noun" both reduce to "noun" for matching.
  function posHead(pos) {
    return String(pos || "").toLowerCase().split(/[\s(]/)[0];
  }

  function posAbbrev(pos) {
    if (!pos) return "";
    const head = posHead(pos);
    return POS_ABBREV[head] || head;
  }

  // The LLM is told to give a bare MW-style respelling, but tolerate stray
  // wrapping (\…\, /…/, [ … ]) or whitespace so a slip never shows up in a badge.
  function normIpa(s) {
    return String(s || "").trim().replace(/^[\\/\[]+|[\\/\]]+$/g, "").trim();
  }

  // Reduce a respelling to its bare letters — stress marks, syllable hyphens,
  // dots and spaces stripped — so two transcriptions of the SAME sound compare
  // equal even if one omits a stress mark. Used only to line up the LLM's own
  // ipa against Merriam-Webster's, to disambiguate same-POS homographs.
  function ipaSkeleton(s) {
    return normIpa(s).toLowerCase().replace(/[ˈˌ.\-\s]/g, "");
  }

  function badgeKey({ word, pos }) {
    return `${word.toLowerCase()}|${(pos || "").toLowerCase()}`;
  }

  function parsePronAttrs(body) {
    const w = PRON_WORD_ATTR_RE.exec(body);
    const p = PRON_POS_ATTR_RE.exec(body);
    if (!w || !p) return null;
    const i = PRON_IPA_ATTR_RE.exec(body);
    return { word: w[1], pos: p[1], ipa: i ? normIpa(i[1]) : "" };
  }

  // Odds of one reading, as the model rated it. Deliberately not a button: the
  // pronunciation badge is clickable (it plays audio), and a chip that looks
  // interactive but isn't is worse than one that plainly isn't.
  function senseOddsHtml(pct) {
    const lead = pct >= 50 ? " lead" : "";
    const title = `About ${pct} readers in 100 would read the passage this way` +
      " — the model's own estimate, not a dictionary fact";
    return `<span class="sense-odds${lead}" title="${escapeHtml(title)}" ` +
      `aria-label="${escapeHtml(title)}">${pct}%</span>`;
  }

  // Placeholders are lifted out BEFORE escaping/markdown so their attributes are
  // never mangled, then dropped back in afterwards. The sentinel is wrapped in
  // U+0001 rather than spaces: a space-delimited sentinel could not match two
  // placeholders separated by a single space (the first match ate the space the
  // second one needed), which silently printed a raw "PH1" into the answer. The
  // optional " ?" on each side keeps the old spacing — a tag between two words
  // still collapses to zero gap, and the chips carry their own margins.
  function inline(s, renderBadge) {
    const placeholders = [];
    const stash = (html) => {
      const i = placeholders.length;
      placeholders.push(html);
      return `\u0001${i}\u0001`;
    };
    s = s.replace(PRON_BRACKET_RE, (_, body) => {
      const attrs = parsePronAttrs(body);
      if (!attrs) return " ";
      return stash(renderBadge ? renderBadge(attrs) : "");
    });
    s = s.replace(SENSE_BRACKET_RE, (_, body) => {
      const m = SENSE_P_ATTR_RE.exec(body);
      if (!m) return " ";
      const pct = Number(m[1]);
      if (!(pct >= 1 && pct <= 100)) return " ";
      return stash(senseOddsHtml(pct));
    });
    s = escapeHtml(s);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/ ?\u0001(\d+)\u0001 ?/g, (_, i) => placeholders[Number(i)] || "");
    return s;
  }

  function renderMarkdownPure(src, renderBadge) {
    const blocks = src.split(/\n{2,}/).map((b) => b.replace(/\s+$/, "")).filter(Boolean);
    const out = [];
    for (const block of blocks) {
      const lines = block.split("\n");
      let bufP = [], bufQ = [];
      const flushP = () => { if (bufP.length) { out.push(`<p>${inline(bufP.join(" "), renderBadge)}</p>`); bufP = []; } };
      const flushQ = () => { if (bufQ.length) { out.push(`<blockquote>${bufQ.map((b) => inline(b, renderBadge)).join("<br>")}</blockquote>`); bufQ = []; } };
      for (const ln of lines) {
        const m = /^>\s?(.*)$/.exec(ln);
        if (m) { flushP(); bufQ.push(m[1]); }
        else { flushQ(); bufP.push(ln); }
      }
      flushP(); flushQ();
    }
    return out.join("");
  }
  function renderMarkdown(src) { return renderMarkdownPure(src, badgeHtml); }

  /* ---------- DOM ---------- */

  const bandEl = document.getElementById("ln-explain-band");

  const warnEl = document.getElementById("ln-warn");
  const playerEl = document.getElementById("ln-player");
  const bar = document.getElementById("ln-bar");
  const playBtn = document.getElementById("ln-play");
  const backBtn = document.getElementById("ln-back");   // mobile ←: jump −5s
  const fwdBtn = document.getElementById("ln-fwd");      // mobile →: jump +5s
  const collapseBtn = document.getElementById("ln-collapse"); // mobile: hide the player
  const fabEl = document.getElementById("ln-fab");            // mobile: floating "show player" button
  const trackEl = document.getElementById("ln-track");
  const fillEl = document.getElementById("ln-fill");
  const timeEl = document.getElementById("ln-time");
  const audioEl = document.getElementById("ln-audio");

  /* ---------- state ---------- */

  let ticker = null;
  // While a programmatic seek (arrow keys / track click) is in flight, Chrome
  // keeps reporting the OLD audioEl.currentTime until the seek actually lands.
  // Reading it to paint the time made the bar lag the audio when seeking
  // fast, and reading it as the base for the next ±5s jump made rapid presses
  // under-shoot. Track the intended target and treat it as the source of
  // truth until 'seeked' confirms the audio caught up. null = not seeking.
  let seekTarget = null;
  function effPos() { return seekTarget != null ? seekTarget : (audioEl.currentTime || 0); }


  // The single explanation panel for the reference line. Each new reference
  // selection refreshes it (overrides the previous one); inside it the answers
  // form a drill-down chain (one round each). Picking a word/phrase in round
  // R_k regenerates R_(k+1) and drops every round after it, so the chain only
  // ever grows from the round you pick on. Resizable (see the resize block).
  const MAX_PANELS = 1;
  const panels = [];          // sparse: panels[slot] or undefined
  let oSelectionCount = 0;    // total reference selections so far

  // pronunciation cache
  const pronCache = new Map();
  const pronInflight = new Set();
  let pickedPosByWord = new Map();
  // word (lowercase) -> the LLM's own ipa from its [[PRON … ipa="…"]], used as
  // the fallback badge when Merriam-Webster has no pronunciation for the word.
  let llmIpaByWord = new Map();

  /* ---------- word marking → instant explain ---------- */


  // ---- touch drag-select (mobile) ----
  // Desktop selects words by mouse drag. Touch has no equivalent: a finger drag
  // scrolls the page. So on touch we use press-and-hold then drag: hold a word
  // ~280ms to enter selection, then drag across words to extend, lift to fire —
  // the same gesture the user knows from native text selection. A plain TAP is
  // left untouched (it still rides the synthetic mouse click into the existing
  // handlers, so single-word lookups work exactly as before).
  //
  // Because a committed touch gesture also emits a trailing synthetic mouse
  // burst, finishing one stamps `suppressMouseUntil`; the three mousedown
  // handlers ignore mouse input until then so the selection can't double-fire.
  let suppressMouseUntil = 0;
  const mouseSuppressed = () => performance.now() < suppressMouseUntil;
  function enableTouchWordSelect(container, wordSel, begin, extend, finish) {
    let timer = null, active = false, pressed = false, sx = 0, sy = 0, span0 = null;
    const HOLD_MS = 280, MOVE_TOL = 10;
    const cancelTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const release = () => { if (active || !pressed) return; pressed = false; };
    container.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) { cancelTimer(); release(); return; }   // a second finger = pinch
      const t = e.touches[0];
      const span = e.target.closest && e.target.closest(wordSel);
      if (!span) return;
      span0 = span; sx = t.clientX; sy = t.clientY; active = false;
      cancelTimer();
      pressed = true;
      timer = setTimeout(() => {
        timer = null;
        if (begin(span0) === false) return;   // nothing to select here
        active = true;
        if (navigator.vibrate) { try { navigator.vibrate(8); } catch {} }   // subtle "armed" cue
      }, HOLD_MS);
    }, { passive: true });
    container.addEventListener("touchmove", (e) => {
      const t = e.touches[0]; if (!t) return;
      if (!active) {
        // Still waiting on the hold: any real movement means the user is
        // scrolling, so drop the timer and let the page scroll.
        if (Math.abs(t.clientX - sx) > MOVE_TOL || Math.abs(t.clientY - sy) > MOVE_TOL) { cancelTimer(); release(); }
        return;
      }
      e.preventDefault();   // selecting now → stop the page from scrolling
      const el = document.elementFromPoint(t.clientX, t.clientY);
      const span = el && el.closest && el.closest(wordSel);
      if (span && container.contains(span)) extend(span);
    }, { passive: false });
    const done = () => {
      cancelTimer();
      if (active) { active = false; pressed = false; suppressMouseUntil = performance.now() + 450; finish(); }
      else release();   // a tap or abandoned hold
      span0 = null;
    };
    container.addEventListener("touchend", done);
    container.addEventListener("touchcancel", done);
  }

  // Keep a touch-scroll that starts inside `scroller` from leaking to the page
  // behind it. On mobile the page itself scrolls and the explanation panel floats
  // over it (position:sticky), so a touch on the panel that the panel can't use
  // for its own scroll falls through and scrolls the page underneath instead.
  // CSS overscroll-behavior:contain covers this only on newer browsers AND only
  // when the panel's content actually overflows — older iOS Safari ignores it, and
  // a short explanation that fits the panel has nothing to scroll, so either way
  // the page scrolls through. This guard makes the panel always swallow vertical
  // touch scrolls: it lets the browser scroll the panel's own content when there's
  // room, and blocks the page (preventDefault) when there isn't — at the top/bottom
  // edge or when the content fits. Horizontal/multi-touch gestures are left alone.
  function keepScrollInside(scroller) {
    let lastY = 0;
    scroller.addEventListener("touchstart", (e) => {
      if (e.touches.length === 1) lastY = e.touches[0].clientY;
    }, { passive: true });
    scroller.addEventListener("touchmove", (e) => {
      if (e.touches.length !== 1) return;       // pinch/zoom — not our gesture
      const y = e.touches[0].clientY;
      const dy = y - lastY;                      // >0: finger moved down (scroll toward the top)
      lastY = y;
      if (dy === 0) return;
      const canScroll = scroller.scrollHeight - scroller.clientHeight > 0;
      const atTop = scroller.scrollTop <= 0;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      // Block the page only when the panel can't take this scroll itself; otherwise
      // let it through so the panel's own content scrolls normally.
      if ((!canScroll || (atTop && dy > 0) || (atBottom && dy < 0)) && e.cancelable) {
        e.preventDefault();
      }
    }, { passive: false });
  }




  /* ---------- panels: create / allocate / reset ---------- */

  // Build the panel: a top-edge resize handle + a scrolling content box, plus
  // its thread state. Anchored to the bottom of the band (nearest the
  // reference line).
  function makePanel(slot) {
    const el = document.createElement("div");
    el.className = "explain-panel";
    el.style.order = String(-slot);
    const handle = document.createElement("div");
    handle.className = "panel-resize";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "horizontal");
    handle.setAttribute("aria-label", "Resize explanation panel");
    handle.tabIndex = 0;
    const content = document.createElement("div");
    content.className = "explain-content";
    el.appendChild(handle);
    el.appendChild(content);
    bandEl.appendChild(el);
    const panel = {
      slot, el, contentEl: content,
      rounds: [], streamItems: [], threadText: "",
      buffer: "", firstChunkSeen: false, streaming: false,
      errorMsg: "", inFlight: null, responseMarks: new Set(),
      liveRoundEl: null, liveRoundCount: -1,
    };
    wirePanelEvents(panel);
    wirePanelResize(handle);
    return panel;
  }

  // Clear a panel's thread back to empty and abort any in-flight request — used
  // when a slot is reused by a newer reference selection.
  function resetPanelThread(panel) {
    if (panel.inFlight) { try { panel.inFlight.abort(); } catch {} panel.inFlight = null; }
    panel.rounds = []; panel.streamItems = []; panel.threadText = "";
    panel.buffer = ""; panel.firstChunkSeen = false; panel.streaming = false;
    panel.errorMsg = ""; panel.responseMarks.clear();
    panel.liveRoundEl = null; panel.liveRoundCount = -1;
    panel.contentEl.innerHTML = "";
  }

  // Pick the panel a brand-new reference selection should fill: the next slot in
  // round-robin order, creating it the first time and reusing (resetting) it
  // afterwards.
  function nextPanelForSelection() {
    const slot = oSelectionCount % MAX_PANELS;
    oSelectionCount++;
    let panel = panels[slot];
    if (!panel) panel = panels[slot] = makePanel(slot);
    else resetPanelThread(panel);
    return panel;
  }

  function teardownAllPanels() {
    for (const p of panels) {
      if (!p) continue;
      if (p.inFlight) { try { p.inFlight.abort(); } catch {} }
      if (p.el && p.el.parentNode) p.el.parentNode.removeChild(p.el);
    }
    panels.length = 0;
    oSelectionCount = 0;
  }

  function renderAllPanels() {
    for (const p of panels) if (p) renderExplain(p);
  }

  // A drag in progress inside an explanation panel — the same click-a-word /
  // drag-a-phrase gesture as the reference line, adapted to the response's word
  // spans (which are keyed by rid, not a flat index array, so the range is
  // computed over the block's spans in document order). Shared module-wide
  // because only one mouse drags at a time; a single window-level mouseup
  // (below) commits it and fires, so a release outside the panel still finishes
  // cleanly. mousedown wipes every prior mark first, so the snapshot is a clean
  // slate — one contiguous word/phrase is ever live, exactly like the reference
  // line.
  let panelDrag = null;

  // Repaint the dragged run: every span outside [a,b] keeps its snapshot mark;
  // every span inside flips it. Mirrors the reference line's paintMarkRange.
  function applyPanelDragRange(ds) {
    const { panel, spans, snapshot, startIdx, currentIdx } = ds;
    const a = Math.min(startIdx, currentIdx), b = Math.max(startIdx, currentIdx);
    for (let i = 0; i < spans.length; i++) {
      const marked = (i >= a && i <= b) ? !snapshot[i] : snapshot[i];
      const rid = spans[i].dataset.rid;
      if (marked) panel.responseMarks.add(rid); else panel.responseMarks.delete(rid);
      spans[i].classList.toggle("marked", marked);
    }
  }

  function togglePanelWord(panel, span) {
    const rid = span.dataset.rid;
    if (panel.responseMarks.has(rid)) { panel.responseMarks.delete(rid); span.classList.remove("marked"); }
    else { panel.responseMarks.add(rid); span.classList.add("marked"); }
  }

  // Wipe every response mark across all rounds. A new pick starts from a clean
  // slate so only one contiguous word/phrase is ever selected — the same
  // one-highlight-at-a-time model as the reference line.
  function clearResponseMarks(panel) {
    panel.responseMarks.clear();
    for (const sp of panel.contentEl.querySelectorAll(".response-word.marked")) sp.classList.remove("marked");
  }

  // Commit + fire on release, exactly like the reference line: a click sends the
  // one word, a drag sends the one contiguous phrase, and it explains the
  // instant the mouse comes up — no "leave the block to ask" step. mousedown
  // already cleared every other mark, so only this single run is live;
  // disjoint multi-word/phrase picks aren't possible here, matching the
  // reference line.
  function finishPanelGesture() {
    if (!panelDrag) return;
    const ds = panelDrag; panelDrag = null;
    if (ds.moved) applyPanelDragRange(ds);
    else togglePanelWord(ds.panel, ds.spans[ds.startIdx]);   // a plain click marks the one word
    // One contiguous run, like O: gather the marked spans in document order into
    // a single item — even across bold/italic boundaries — so a drag is always
    // one phrase, never several disjoint picks.
    const words = ds.spans.filter((s) => ds.panel.responseMarks.has(s.dataset.rid)).map((s) => s.dataset.word);
    if (words.length) firePanelSelection(ds.panel, ds.block, [{ phrase: words.join(" "), words }]);
  }
  window.addEventListener("mouseup", finishPanelGesture);

  // Picking on round R_(k+1) — the answer rendered in `block` (data-round = k) —
  // regenerates the NEXT round and drops every round after it, so the answers
  // form a single drill-down chain instead of an ever-growing stack. slice keeps
  // the first k+1 rounds as the model's history; triggerExplain then appends
  // the fresh next round below them, overriding the old R_(k+2) and emptying
  // everything past it.
  function firePanelSelection(panel, block, items) {
    const k = Number(block.dataset.round);
    if (Number.isInteger(k)) panel.rounds = panel.rounds.slice(0, k + 1);
    triggerExplain(panel, items);
  }

  // Per-panel picks: click a word, or drag across a contiguous run, inside a
  // response — it fires the instant you release (see the window mouseup above),
  // the same gesture as the reference line, restricted to one word or one
  // contiguous phrase.
  function wirePanelEvents(panel) {
    // mousedown starts the gesture; mousemove extends the run to the word under
    // the cursor. The range is taken over the spans of the block the drag began
    // in, so a phrase can't straddle two answers. Native text-drag is suppressed
    // (the words already carry user-select:none).
    // Begin a pick at `span`: clear prior marks, snapshot the block's spans, and
    // seed panelDrag. Shared by mousedown and the touch hold. Returns false if the
    // span isn't inside a round block (nothing to select).
    const beginPanelPick = (span) => {
      const block = span.closest(".round-block");
      if (!block) return false;
      // One pick at a time, like O: starting a new gesture clears every existing
      // response mark so two disjoint runs can never be live together.
      clearResponseMarks(panel);
      const spans = [...block.querySelectorAll(".response-word")];
      const idx = spans.indexOf(span);
      panelDrag = {
        panel, block, spans, startIdx: idx, currentIdx: idx, moved: false,
        snapshot: spans.map(() => false),
      };
      return true;
    };
    const extendPanelPick = (span) => {
      if (!panelDrag || panelDrag.panel !== panel) return;
      const idx = panelDrag.spans.indexOf(span);   // -1 when over another block
      if (idx === -1 || idx === panelDrag.currentIdx) return;
      panelDrag.currentIdx = idx;
      if (idx !== panelDrag.startIdx) panelDrag.moved = true;
      applyPanelDragRange(panelDrag);
    };
    panel.contentEl.addEventListener("mousedown", (e) => {
      if (mouseSuppressed()) return;   // ignore the synthetic click trailing a touch gesture
      const span = e.target.closest && e.target.closest(".response-word");
      if (!span || e.button !== 0) return;
      e.preventDefault();
      beginPanelPick(span);
    });
    panel.contentEl.addEventListener("mousemove", (e) => {
      if (!panelDrag || panelDrag.panel !== panel) return;
      if (e.buttons === 0) { panelDrag = null; return; }
      const span = e.target.closest && e.target.closest(".response-word");
      if (!span) return;
      extendPanelPick(span);
    });
    // Touch: hold a word in the answer, then drag across it to select a phrase.
    enableTouchWordSelect(panel.contentEl, ".response-word",
      (span) => beginPanelPick(span), extendPanelPick, finishPanelGesture);
    // Touch: scroll the answer without leaking the gesture to the page behind it.
    keepScrollInside(panel.contentEl);
  }


  /* ---------- explanation flow ---------- */

  // Start (or, for a follow-up, extend) the panel's thread. The panel owns its
  // own AbortController, so a new request only aborts the panel's previous one.
  // For a fresh selection the rounds are already empty (history = []); for a
  // follow-up the prior rounds are sent as history and the new answer is
  // appended below them.
  async function triggerExplain(panel, items) {
    if (panel.inFlight) { try { panel.inFlight.abort(); } catch {} }
    panel.streamItems = items;
    panel.buffer = ""; panel.errorMsg = ""; panel.firstChunkSeen = false; panel.streaming = true;
    renderExplain(panel);
    // Bring the panel (and its new live round) into view once — never resized.
    panel.el.scrollIntoView({ block: "nearest" });
    panel.contentEl.scrollTop = panel.contentEl.scrollHeight;
    const ctrl = new AbortController();
    panel.inFlight = ctrl;
    try {
      await streamExplain(panel, { text: panel.threadText, items, history: panel.rounds.map((r) => r.text) }, ctrl.signal);
    } catch (e) {
      if (e.name !== "AbortError") console.error("explain threw", e);
    } finally {
      if (ctrl === panel.inFlight) {
        panel.streaming = false; panel.inFlight = null;
        if (panel.buffer) panel.rounds.push({ text: panel.buffer, items: panel.streamItems });
        panel.buffer = "";
        renderExplain(panel);
        checkCredits();
      }
    }
  }

  async function streamExplain(panel, body, signal) {
    const res = await fetch(apiBase() + "/api/explain", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) { panel.errorMsg = `Could not reach the explainer (HTTP ${res.status}).`; renderExplain(panel); return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", event = "", dataBuf = "";
    while (true) {
      let chunk;
      try { chunk = await reader.read(); }
      catch (e) { if (e.name !== "AbortError") console.error("reader threw", e); break; }
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") { if (event && dataBuf) handleSse(panel, event, dataBuf); event = ""; dataBuf = ""; continue; }
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) { event = line.slice(6).trim(); continue; }
        if (line.startsWith("data:")) dataBuf += (dataBuf ? "\n" : "") + line.slice(5).trim();
      }
    }
  }

  function handleSse(panel, event, data) {
    let obj;
    try { obj = JSON.parse(data); } catch { return; }
    if (event === "pron-data") {
      for (const [w, bundle] of Object.entries(obj.prons || {})) {
        const v0 = bundle.variants[0];
        pronCache.set(`${w}|`, {
          hword: bundle.hword,
          pos: (v0.posList && v0.posList[0]) || "",
          ipa: v0.ipa, mp3: v0.mp3, variants: bundle.variants,
        });
      }
      // The cache is shared, so refresh every panel that may show these words.
      renderAllPanels();
    } else if (event === "chunk") {
      panel.firstChunkSeen = true; panel.buffer += obj.text; renderExplain(panel, true);
    } else if (event === "error") {
      panel.errorMsg = obj.message || "Something went wrong."; renderExplain(panel);
    }
  }

  /* ---------- explanation rendering ---------- */

  // A tag still arriving over SSE is half-written ("…[[PRON word=\"cha"), so cut
  // the text back to where it opened rather than let a fragment flash on screen.
  // Both tag kinds count, and the LAST opener wins — an earlier, already-closed
  // one must not mask a later, still-open one.
  function hidePartialTag(s) {
    let open = -1;
    for (const t of ANY_TAG_OPENERS) open = Math.max(open, s.lastIndexOf(t));
    return open >= 0 && s.indexOf("]]", open) < 0 ? s.slice(0, open) : s;
  }

  function refreshPickedPosByWord(panel) {
    pickedPosByWord = new Map();
    llmIpaByWord = new Map();
    for (const src of [...panel.rounds.map((r) => r.text), panel.buffer]) {
      if (!src) continue;
      // Use the same lenient parser as inline() so any tag that renders a badge
      // also drives the highlight — order-/spacing-tolerant, never out of sync.
      for (const m of src.matchAll(PRON_BRACKET_RE)) {
        const attrs = parsePronAttrs(m[1]);
        if (!attrs) continue;
        const w = attrs.word.toLowerCase(), pos = attrs.pos;
        // FIRST occurrence wins for both maps, so the pron-only row and the
        // inline badge for the same word agree. First and not last matters now
        // that one word can carry two badges: under the Ambiguity rule a reply
        // may tag "charge" as both noun and verb, and the senses are written
        // most-likely-first — last-wins lit the LESS likely reading in the row.
        if (w && pos && !pickedPosByWord.has(w)) pickedPosByWord.set(w, pos);
        if (w && attrs.ipa && !llmIpaByWord.has(w)) llmIpaByWord.set(w, attrs.ipa);
      }
    }
  }

  function lemmaForUserWord(userWord) {
    const lw = userWord.toLowerCase();
    if (pickedPosByWord.has(lw)) return lw;
    for (const x of pickedPosByWord.keys()) {
      if (lw.startsWith(x) || x.startsWith(lw)) return x;
    }
    return userWord;
  }

  function pronOnlyBlock(words) {
    let inner = "";
    for (const w of words) {
      const lemma = lemmaForUserWord(w);
      inner += `<span class="pron-only-row"><strong>${escapeHtml(w)}</strong>${badgeHtml({ word: lemma, pos: "", multi: true })}</span>`;
    }
    return `<div class="pron-only">${inner}</div>`;
  }

  function renderExplain(panel, incremental) {
    refreshPickedPosByWord(panel);
    // Incremental fast-path for streaming chunks: each chunk only grows the live
    // answer's text, so rewrite just that one block in place. Rebuilding the whole
    // panel (contentEl.innerHTML) on every chunk resets the scroll container's
    // scrollTop and, on mobile, tears the container down under the user's finger —
    // which hands an in-progress touch-scroll off to the page, scrolling the
    // page instead of the panel (and only sorts itself out once streaming ends
    // and the rebuilds stop). Touching only the live block leaves the scroll
    // container, its scrollTop, and the committed rounds intact, so the panel
    // stays scrollable while text streams in.
    if (incremental && panel.streaming && panel.firstChunkSeen &&
        panel.liveRoundEl && panel.liveRoundCount === panel.rounds.length) {
      panel.liveRoundEl.innerHTML = renderMarkdown(hidePartialTag(panel.buffer));
      wirePronBadges(panel);
      return;
    }
    let html = "";
    for (let i = 0; i < panel.rounds.length; i++) html += roundBlockHtml(panel.rounds[i].text, panel.rounds[i].items, i > 0, false, i);
    if (panel.streaming) {
      html += roundBlockHtml(hidePartialTag(panel.buffer), panel.streamItems, panel.rounds.length > 0, true, panel.rounds.length);
    }
    if (panel.streaming && !panel.firstChunkSeen) {
      html += '<div class="thinking" aria-label="Loading"><span></span><span></span><span></span></div>';
    }
    if (panel.errorMsg) html += `<p class="err">${escapeHtml(panel.errorMsg)}</p>`;
    if (!html) { panel.contentEl.innerHTML = ""; panel.liveRoundEl = null; return; }
    panel.contentEl.innerHTML = html;
    wirePronBadges(panel);
    wrapResponseWords(panel);
    // Cache the live block so the streaming fast-path above can update it in place.
    panel.liveRoundEl = (panel.streaming && panel.firstChunkSeen)
      ? panel.contentEl.querySelector(`.round-block[data-round="${panel.rounds.length}"] .round.live`)
      : null;
    panel.liveRoundCount = panel.rounds.length;
  }

  function roundBlockHtml(text, items, divided, live, roundIdx) {
    let h = `<div class="round-block${divided ? " divided" : ""}" data-round="${roundIdx}">`;
    const seen = new Set(), pronWords = [];
    for (const it of items || []) {
      for (const w of it.words || []) {
        const k = w.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k); pronWords.push(w);
      }
    }
    if (pronWords.length) h += pronOnlyBlock(pronWords);
    h += `<div class="round${live ? " live" : ""}">${renderMarkdown(text)}</div>`;
    return h + "</div>";
  }

  /* ---------- follow-ups: mark words inside an explanation ---------- */

  function wrapResponseWords(panel) {
    const walker = document.createTreeWalker(panel.contentEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentNode;
        if (!parent || !(parent instanceof Element)) return NodeFilter.FILTER_REJECT;
        // .sense-odds too: its "70%" is metadata about the answer, not a word of
        // the answer, so it must not become a clickable drill-down target.
        if (parent.closest(".round.live") || parent.closest(".pron-badge") ||
            parent.closest(".pron-only") || parent.closest(".response-word") ||
            parent.closest(".sense-odds")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const textNodes = [];
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);
    const counter = new Map();
    for (const tn of textNodes) {
      const text = tn.nodeValue;
      if (!text) continue;
      const re = new RegExp(WORD_RE.source, WORD_RE.flags);
      let m, frag = null, last = 0;
      while ((m = re.exec(text)) !== null) {
        if (!frag) frag = document.createDocumentFragment();
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const w = m[0], lower = w.toLowerCase();
        const occ = counter.get(lower) || 0;
        counter.set(lower, occ + 1);
        const rid = `${lower}#${occ}`;
        const span = document.createElement("span");
        span.className = "word response-word";
        span.dataset.word = w; span.dataset.rid = rid;
        if (panel.responseMarks.has(rid)) span.classList.add("marked");
        span.textContent = w;
        frag.appendChild(span);
        last = re.lastIndex;
      }
      if (frag) {
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        tn.parentNode.replaceChild(frag, tn);
      }
    }
  }

  /* ---------- pronunciation badges ---------- */

  function speakerSvg() {
    return '<svg class="speaker" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M11 5 7 9H4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h3l4 4z" fill="currentColor"/>' +
      '<path d="M15.5 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round"/></svg>';
  }

  function warnSvg() {
    return '<svg class="warn" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M12 4 2.5 20h19L12 4z" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linejoin="round"/>' +
      '<path d="M12 10v4.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
      '<circle cx="12" cy="17.6" r="1.15" fill="currentColor"/></svg>';
  }

  function singleBadgeHtml({ key, ipa, mp3, label, hword, pos, fallbackPos, picked }) {
    const cls = picked ? "pron-badge is-picked" : "pron-badge";
    const title = `${hword} (${pos || fallbackPos || ""})`.trim().replace(/\s*\(\)$/, "");
    return `<button type="button" class="${cls}" data-key="${escapeHtml(key)}" ` +
      `data-mp3="${escapeHtml(mp3)}" title="${escapeHtml(title)}" ` +
      `aria-label="Play pronunciation ${escapeHtml(ipa)}">` +
      (label ? `<span class="badge-pos">${escapeHtml(label)}</span>` : "") +
      `<span class="ipa">${escapeHtml(ipa)}</span>${speakerSvg()}</button>`;
  }

  // Fallback badge for a word Merriam-Webster has no pronunciation for: the
  // LLM's own best-effort respelling, marked unmistakably as AI-made (violet,
  // dashed, leading "≈", trailing "AI"). There is no recording, so it isn't
  // playable — the IPA text itself is the value. The pos is picked up from the
  // LLM's placeholder so the label matches the real badges.
  function aiBadgeHtml({ word, ipa, pos }) {
    const labelPos = pos || pickedPosByWord.get(word.toLowerCase()) || "";
    const label = posAbbrev(labelPos);
    const title = `Approximate pronunciation for "${word}"`
      + (labelPos ? ` (${labelPos})` : "")
      + " — generated by AI, not from Merriam-Webster";
    return `<button type="button" class="pron-badge ai-made" disabled ` +
      `title="${escapeHtml(title)}" ` +
      `aria-label="AI-made approximate pronunciation ${escapeHtml(ipa)}, not from a dictionary">` +
      (label ? `<span class="badge-pos">${escapeHtml(label)}</span>` : "") +
      `<span class="approx" aria-hidden="true">≈</span>` +
      `<span class="ipa">${escapeHtml(ipa)}</span>` +
      `<span class="ai-tag" aria-hidden="true">AI</span></button>`;
  }

  // Pick which MW variant a badge should show, given the committed POS head and
  // the LLM's own context-aware respelling. POS narrows first; the ipa then
  // breaks ties between same-POS homographs — Merriam-Webster lists *tear* as
  // both a "verb (1)"/"noun (1)" pair pronounced ˈter (to rip) AND a
  // "noun (2)"/"verb (2)" pair pronounced ˈtir (the eye kind), so "noun" alone
  // matches both and would always grab the first (ˈter). The LLM, which knows
  // the sense from the passage, supplies ˈtir, so we follow it. Returns an index
  // into `variants`; falls back to the first POS match (then 0) when nothing
  // disambiguates, i.e. the old behaviour for ordinary single-pron words.
  function chooseVariantIdx(variants, head, llmIpa) {
    if (!variants.length) return 0;
    const all = variants.map((_, i) => i);
    const posPool = head
      ? all.filter((i) => (variants[i].posList || []).some((p) => posHead(p) === head))
      : [];
    const pool = posPool.length ? posPool : all;
    if (pool.length === 1) return pool[0];
    const want = ipaSkeleton(llmIpa);
    if (want) {
      const exact = pool.find((i) => ipaSkeleton(variants[i].ipa) === want);
      if (exact != null) return exact;
    }
    return pool[0];
  }

  // The server pre-fetches each selected word's MW pron in the form the USER
  // picked (its surface form, e.g. "flyers") and pushes it as pron-data keyed
  // "<word>|". The LLM, told to tag the dictionary base form, writes the same
  // word as "flyer" — a different key — and for a few words (variant spellings
  // like flyer/flier) that base form has no MW pron of its own. So before a badge
  // re-fetches or drops to the AI respelling, reuse a real pron already in hand
  // for the same word under a related spelling. Prefer an exact word match (any
  // pos); else a prefix-related form — the same loose pairing lemmaForUserWord
  // uses — guarded to 3+ char stems so a tiny fragment can't grab a stranger.
  function prefetchedRealFor(word) {
    const lw = word.toLowerCase();
    let near = null;
    for (const [k, v] of pronCache) {
      if (!v || v.error || !Array.isArray(v.variants)) continue;
      const bar = k.indexOf("|");
      const w = bar < 0 ? k : k.slice(0, bar);
      if (!w) continue;
      if (w === lw) return v;
      if (!near && Math.min(w.length, lw.length) >= 3 &&
          (w.startsWith(lw) || lw.startsWith(w))) near = v;
    }
    return near;
  }

  function badgeHtml({ word, pos, ipa, multi = false }) {
    const key = badgeKey({ word, pos });
    let cached = pronCache.get(key);
    const safeWord = escapeHtml(word);
    const safePos = escapeHtml(pos);
    // The LLM's fallback respelling: the one passed inline on this placeholder,
    // else the one captured for this word from anywhere in the reply. Doubles as
    // the tie-breaker between same-POS variants below.
    const llmIpa = (ipa && normIpa(ipa)) || llmIpaByWord.get(word.toLowerCase()) || "";
    // No real pron of its own yet (never fetched, or MW had none for this exact
    // spelling) — reuse one already fetched for the same word under a related
    // surface form rather than re-fetch or fall to the AI badge.
    if (!cached || cached.error) {
      const reuse = prefetchedRealFor(word);
      if (reuse) cached = reuse;
    }
    if (cached && !cached.error) {
      const variants = Array.isArray(cached.variants) && cached.variants.length
        ? cached.variants
        : [{ ipa: cached.ipa, mp3: cached.mp3, posList: cached.pos ? [cached.pos] : [] }];
      const committedPos = pos ||
        pickedPosByWord.get(word.toLowerCase()) ||
        pickedPosByWord.get((cached.hword || "").toLowerCase()) || "";
      const head = posHead(committedPos);
      const pickedIdx = chooseVariantIdx(variants, head, llmIpa);
      if (!multi || variants.length <= 1) {
        const v = variants[pickedIdx] || variants[0];
        const posList = v.posList || [];
        const labelPos = (head && posList.find((p) => posHead(p) === head)) || posList[0] || cached.pos;
        return singleBadgeHtml({ key, ipa: v.ipa, mp3: v.mp3, label: posAbbrev(labelPos), hword: cached.hword, pos: labelPos, fallbackPos: pos });
      }
      const html = variants.map((v, i) => {
        const labelPos = (v.posList && v.posList[0]) || cached.pos;
        return singleBadgeHtml({ key: `${key}#${i}`, ipa: v.ipa, mp3: v.mp3, label: posAbbrev(labelPos), hword: cached.hword, pos: labelPos, fallbackPos: pos, picked: !!committedPos && i === pickedIdx });
      }).join("");
      return `<span class="pron-variants">${html}</span>`;
    }
    if (cached && cached.error) {
      // Two distinct failure reasons, handled differently:
      //   notfound    — MW served the page but has NO pronunciation for this
      //                 word (e.g. "suddenly"). Permanent, so show the LLM's
      //                 fallback respelling, clearly marked as AI-made.
      //   unavailable — we couldn't REACH MW (the Cloudflare 403, a 5xx, or a
      //                 network blip). MW may well have a real pronunciation,
      //                 so don't paper a transient outage over with a guess —
      //                 keep the loud, retryable red badge instead.
      const unreachable = cached.reason !== "notfound";
      if (!unreachable && llmIpa) return aiBadgeHtml({ word, ipa: llmIpa, pos });
      // No usable AI fallback (the outage case above, the LLM omitted ipa, or
      // this is an old reply): surface the failure EXPLICITLY — never the bare
      // word, which reads like a real result. Red "pron unavailable" = couldn't
      // reach MW; amber "no pron" = MW answered but has none for this word.
      const cls = unreachable ? "pron-badge failed err-mw" : "pron-badge failed err-none";
      const label = unreachable ? "pron unavailable" : "no pron";
      const title = unreachable
        ? `Couldn't reach Merriam-Webster for "${word}" — pronunciation unavailable, try again later`
        : `Merriam-Webster has no pronunciation for "${word}"`;
      return `<button type="button" class="${cls}" disabled title="${escapeHtml(title)}">` +
        `${warnSvg()}<span class="err-label">${escapeHtml(label)}</span></button>`;
    }
    return `<button type="button" class="pron-badge loading" data-key="${escapeHtml(key)}" ` +
      `data-word="${safeWord}" data-pos="${safePos}" disabled><span class="dot-loader">…</span></button>`;
  }

  function wirePronBadges(panel) {
    for (const btn of panel.contentEl.querySelectorAll(".pron-badge.loading")) {
      const key = btn.dataset.key;
      if (!key || pronInflight.has(key)) continue;
      const word = btn.dataset.word, pos = btn.dataset.pos;
      pronInflight.add(key);
      fetch(`${apiBase()}/api/pron?word=${encodeURIComponent(word)}&pos=${encodeURIComponent(pos)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((data) => { pronCache.set(key, data); renderAllPanels(); })
        .catch((status) => {
          // 404 = MW has no pronunciation for this word; anything else (502 from
          // a Cloudflare block, or a thrown network error with no status) = MW
          // was unreachable. badgeHtml renders a distinct, explicit badge for
          // each. Caching the error (not clearing it) also stops a re-render →
          // re-fetch loop when MW keeps refusing.
          const reason = status === 404 ? "notfound" : "unavailable";
          pronCache.set(key, { error: true, reason });
          renderAllPanels();
        })
        .finally(() => pronInflight.delete(key));
    }
    for (const btn of panel.contentEl.querySelectorAll(".pron-badge:not(.loading):not(.failed):not(.ai-made)")) {
      if (btn.dataset.wired) continue;
      btn.dataset.wired = "1";
      btn.addEventListener("click", (e) => {
        // A mouse click leaves focus on the badge, where it has no use and only
        // invites the browser to re-activate it. Hand focus back to the document
        // so the player's keys own the keyboard again. e.detail is 0 for a
        // keyboard-driven click — those keep focus, as a keyboard user expects.
        if (e.detail > 0) btn.blur();
        playBadge(btn);
      });
    }
  }

  let currentBadgeAudio = null;
  function playBadge(btn) {
    if (!btn.dataset.mp3) return;                 // no clip URL → nothing to play
    if (currentBadgeAudio) {
      try { currentBadgeAudio.audio.pause(); } catch {}
      currentBadgeAudio.btn.classList.remove("is-playing");
      currentBadgeAudio = null;
    }
    const audio = new Audio(btn.dataset.mp3);
    const token = { audio, btn };
    currentBadgeAudio = token;
    btn.classList.add("is-playing");
    // Identity-checked so a superseded clip's late 'ended'/'error' can't clear the
    // button a newer click is now playing.
    const stop = () => { if (currentBadgeAudio !== token) return; currentBadgeAudio = null; btn.classList.remove("is-playing"); };
    audio.addEventListener("ended", stop);
    audio.addEventListener("error", stop);
    audio.play().catch(stop);
  }

  /* ---------- credit balance hint ---------- */

  async function checkCredits() {
    try {
      const r = await fetch(apiBase() + "/api/credits");
      if (!r.ok) return;
      const data = await r.json();
      if (data && data.low) {
        const amount = typeof data.remaining === "number" ? `$${data.remaining.toFixed(2)}` : "low";
        warnEl.textContent = `SkyDeck credits ${amount}`;
        warnEl.hidden = false;
      } else { warnEl.textContent = ""; warnEl.hidden = true; }
    } catch {}
  }

  /* ---------- audio bar wiring ---------- */

  function togglePlay() {
    if (!audioEl.src) return;
    if (audioEl.paused) {
      if (audioEl.ended) audioEl.currentTime = 0;   // resume after the end restarts from the top
      const p = audioEl.play();
      if (p && p.catch) p.catch(() => { paintPlay(); });   // keep the button truthful if play() is refused
    } else audioEl.pause();
  }
  // Seek to an ABSOLUTE time (clamped to the clip). Owns the seek-in-flight
  // machinery: set seekTarget so a rapid follow-up jump reads the pending target
  // rather than the stale audioEl.currentTime, arm the failsafe, then repaint.
  function seekTo(t) {
    if (!audioEl.src) return;
    t = Math.max(0, t);
    const d = audioEl.duration;
    if (isFinite(d) && d > 0) t = Math.min(t, d);
    seekTarget = t;
    try { audioEl.currentTime = t; } catch {}
    // Failsafe: if 'seeked' never fires, don't strand the time display on the target.
    setTimeout(() => { if (seekTarget === t) seekTarget = null; }, 1000);
    paintTime();
  }
  function seekBy(delta) {
    if (!audioEl.src) return;
    // Base the jump on the pending target (effPos), not audioEl.currentTime, so
    // mashing ← / → fast accumulates the full distance instead of stalling.
    seekTo(effPos() + delta);
  }
  playBtn.addEventListener("click", () => { togglePlay(); });
  // Mobile ← / → buttons: same ±5s jump as the arrow keys (which touch devices
  // lack). seekBy already no-ops when nothing is loaded.
  // The loop (if any) is already cleared by the document mousedown above, so these are
  // plain ±5s jumps.
  backBtn.addEventListener("click", () => seekBy(-5));
  fwdBtn.addEventListener("click", () => seekBy(5));
  // Play/pause drive the real-time clock: start it advancing on play, freeze the
  // accumulated position on pause.
  audioEl.addEventListener("play", paintPlay);
  audioEl.addEventListener("pause", paintPlay);
  // Safari can fire a spurious 'ended' when currentTime is set during a seek;
  // only repaint for a real end-of-track.
  audioEl.addEventListener("ended", () => {
    const d = audioEl.duration;
    if (isFinite(d) && d > 0 && audioEl.currentTime < d - 0.5) return;
    // Auto-replay: restart the whole track from the top instead of stopping.
    seekTo(0);
    const p = audioEl.play(); if (p && p.catch) p.catch(() => { paintPlay(); });
  });
  audioEl.addEventListener("timeupdate", paintTime);
  audioEl.addEventListener("loadedmetadata", paintTime);
  // Drop the seek override only once the audio has actually reached the target —
  // a 'seeked' from an earlier jump (while the user is still mashing) must NOT
  // clear a newer, still-pending target.
  audioEl.addEventListener("seeked", () => {
    // Tight tolerance: a 0.5s slop could clear the override after the audio had
    // drifted somewhere unexpected; 0.15s still absorbs normal seek
    // inaccuracy, and the 1s failsafe covers a keyframe-snapped landing.
    if (seekTarget != null && Math.abs((audioEl.currentTime || 0) - seekTarget) < 0.15) {
      seekTarget = null;
    }
  });
  // If the file can't be decoded/played (unsupported codec, corrupt bytes, a
  // revoked URL) the element fires 'error'. Without this the time display would
  // keep advancing against a dead clock with no sound and no explanation. The
  // 150ms ticker self-pauses on audioEl.error; here we just tell the user.
  audioEl.addEventListener("error", () => {
    if (!audioEl.src) return;                          // ignore the empty-src reset
    const code = audioEl.error && audioEl.error.code;
    if (code === 1) return;                            // MEDIA_ERR_ABORTED — benign (load replaced)
    seekTarget = null;
    paintPlay();
    warnEl.textContent = "This audio can't be played in your browser.";
    warnEl.hidden = false;
  });
  // Some containers (WebM/Ogg, especially MediaRecorder output) report duration
  // as Infinity/NaN until the element has seen the end of the stream — which
  // would leave the seek bar dead and the total time stuck at 0:00. Force it to
  // resolve once, on load, by seeking to the end and snapping straight back. A
  // guard stops the timeupdate we cause from re-triggering the seek.
  let fixingDuration = false;
  audioEl.addEventListener("loadedmetadata", () => {
    if (isFinite(audioEl.duration) && audioEl.duration > 0) return;
    fixingDuration = true;
    const onTU = () => {
      if (!fixingDuration) return;
      fixingDuration = false;
      audioEl.removeEventListener("timeupdate", onTU);
      if (seekTarget == null) { try { audioEl.currentTime = 0; } catch {} }   // don't clobber a user seek
      paintTime();
    };
    audioEl.addEventListener("timeupdate", onTU);
    try { audioEl.currentTime = 1e101; } catch { audioEl.removeEventListener("timeupdate", onTU); fixingDuration = false; }
  });

  // ---- Firefox / macOS silent-audio workaround ----
  // On Apple Silicon, Firefox tears down its CoreAudio output stream on pause
  // and rebuilds it from scratch on every seek (Mozilla bug 1134263; the M1
  // Mac-mini symptom match is bug 1876668). That rebuild sometimes fails
  // SILENTLY: currentTime keeps advancing — so the time display keeps moving —
  // but no sound comes out, until another seek forces a fresh rebuild. Users
  // hit it after resume or an arrow-key jump and fix it by hand by clicking
  // elsewhere on the seek bar. We do that automatically: after a resume or a
  // resume or a seek, give the output a sub-perceptible currentTime "nudge"
  // (~10 ms) to force the stream to re-arm. It's well under the 150 ms time
  // tick and inaudible, but it is a REAL new seek target — assigning currentTime
  // to itself is a no-op in Firefox and would not rebuild the stream. It can't
  // be a 100% guarantee (the defect is in Firefox), but it makes the silence
  // rare instead of routine. Gated to Firefox so it never adds a stray seek on
  // Chrome/Safari/other engines, which don't have this bug.
  const isFirefox = /firefox/i.test(navigator.userAgent || "");
  let nudging = false;   // guard: a nudge's own 'seeked' must not re-trigger one
  function wakeAudioOutput() {
    if (nudging || fixingDuration) return;            // don't fight the duration probe
    // Bail on a dead element or while a user seek is still pending — a nudge mid-seek
    // would fight the in-flight ± jumps and could strand the seek override.
    if (!audioEl.src || audioEl.error || audioEl.paused || audioEl.seeking || seekTarget != null) return;
    const d = audioEl.duration;
    if (!isFinite(d) || d <= 0) return;               // need a known duration to clamp
    const t = audioEl.currentTime || 0;
    const eps = 0.01;                                 // ~10 ms: inaudible, sub-tick
    let target = (t + eps < d - 0.05) ? t + eps : t - eps;  // back off near the very end
    target = Math.max(0, Math.min(target, d));
    if (Math.abs(target - t) < 1e-4) return;          // too small to count as a seek
    nudging = true;
    try { audioEl.currentTime = target; } catch {}
    const p = audioEl.play(); if (p && p.catch) p.catch(() => { nudging = false; });   // re-assert output
    setTimeout(() => { nudging = false; }, 400);       // failsafe if 'seeked' never fires
  }
  // A resume fires 'play'; a real seek (arrow keys or a track click) fires
  // 'seeked'. In both cases wake the output a beat later, so the nudge is a
  // fresh rebuild and isn't coalesced with the transition that just happened.
  if (isFirefox) {
    audioEl.addEventListener("play", () => { if (seekTarget == null) setTimeout(wakeAudioOutput, 80); });
    audioEl.addEventListener("seeked", () => {
      if (nudging) { nudging = false; return; }        // this 'seeked' was our own nudge
      // Wait until the user's seek run has fully settled (seekTarget cleared)
      // so a mid-mash nudge can't fight the in-flight ± jumps.
      if (fixingDuration || audioEl.paused || seekTarget != null) return;
      setTimeout(wakeAudioOutput, 60);
    });
  }

  trackEl.addEventListener("click", (e) => {
    const d = audioEl.duration;
    if (!d || !isFinite(d)) return;
    const r = trackEl.getBoundingClientRect();
    let frac = (e.clientX - r.left) / r.width;
    frac = frac < 0 ? 0 : frac > 1 ? 1 : frac;
    const t = frac * d;
    seekTarget = t;   // the loop (if any) was already cleared by the document mousedown
    try { audioEl.currentTime = t; } catch {}
    setTimeout(() => { if (seekTarget === t) seekTarget = null; }, 1000);
    paintTime();
  });
  function paintPlay() {
    const on = !audioEl.paused && !audioEl.ended;
    bar.classList.toggle("playing", on);
    playBtn.setAttribute("aria-label", on ? "Pause" : "Play");
  }
  function paintTime() {
    const fmtClock = (s) => {
      s = Math.max(0, Math.floor(s || 0));
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
      const pad = (n) => String(n).padStart(2, "0");
      return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
    };
    const d = isFinite(audioEl.duration) ? audioEl.duration : 0;
    const p = effPos();
    fillEl.style.width = (d ? (p / d) * 100 : 0) + "%";
    timeEl.textContent = fmtClock(p) + " / " + fmtClock(d);
  }

  function startTicker() {
    if (ticker) return;
    ticker = setInterval(() => {
      // Dictation owns the <audio> element outright now: just keep the bar's
      // time fresh on the 150ms tick (timeupdate already drives it while playing).
      if (document.hidden || !audioEl.src || audioEl.error) return;
      paintTime();
    }, 150);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !audioEl.src) return;
    paintTime();
  });

  /* ---------- playback keyboard shortcuts ----------
     ← back 5s · → forward 5s · Space play/pause. Disabled while typing in a text
     field and while a resize handle is focused, so those keep
     their normal behaviour. */
  function isEditableTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT" ||
           el.isContentEditable || el.getAttribute("role") === "separator";
  }

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isEditableTarget(document.activeElement)) return;
    if (!audioEl.src) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      seekBy(-5);
    }
    else if (e.key === "ArrowRight") {
      e.preventDefault();
      seekBy(5);
    }
    else if (e.key === " " || e.key === "Spacebar") {
      // Space belongs to the player, full stop. A button keeps focus after being
      // clicked, so the browser's native "Space activates the focused button"
      // would re-fire it — click a pronunciation badge, hit Space, and the clip
      // replays instead of the segment pausing. Buttons stay reachable with
      // Enter. The mic transcript card is the one exception: it has its own clip
      // player, so a button inside it keeps native Space.
      const ae = document.activeElement;
      if (ae && ae.closest && ae.closest(".mic-modal")) return;
      e.preventDefault();
      togglePlay();
    }
  });

  /* ---------- resizable panel height ----------
     The explanation panel's height (--panel-h, set on the band) is dragged via
     the handle on its top edge — it grows upward, its bottom pinned near the
     reference line. Pointer events cover mouse + touch, arrow keys nudge for
     a11y. Persisted to localStorage. */
  const isDesktopBand = () => window.matchMedia("(min-width: 761px)").matches;
  // Desktop and mobile each remember their own panel height — a height that feels
  // right on a wide screen would swamp a phone, and vice-versa.
  // The "zx-" prefix and "-dictation" suffix are kept as-is so existing installs
  // don't lose their saved heights.
  const panelHKey = () =>
    isDesktopBand() ? "zx-panel-h-dictation" : "zx-panel-h-mobile-dictation";
  const clampPanelH = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const MIN_PANEL_H = 140;
  // Desktop: most of the viewport. Mobile: keep the panel within the band by
  // leaving the fixed player's reserved height (--player-h) plus a small margin
  // free, so dragging to the max can't overflow the band and re-cover the screen.
  const maxPanelH = () => {
    if (isDesktopBand()) return Math.round(window.innerHeight * 0.85);
    const playerH = parseFloat(getComputedStyle(bandEl).getPropertyValue("--player-h")) || 130;
    return Math.max(MIN_PANEL_H, Math.round(window.innerHeight - playerH - 24));
  };
  function applyPanelH(px) {
    const h = clampPanelH(Math.round(px), MIN_PANEL_H, maxPanelH());
    bandEl.style.setProperty("--panel-h", h + "px");
    return h;
  }
  function curPanelH() {
    const v = parseFloat(getComputedStyle(bandEl).getPropertyValue("--panel-h"));
    return v > 0 ? v : Math.round(window.innerHeight * 0.6);
  }
  (function initPanelH() {
    const stored = parseFloat(localStorage.getItem(panelHKey()));
    applyPanelH(stored > 0 ? stored : Math.round(window.innerHeight * 0.6));
  })();

  /* ---------- mobile: reserve the player's real height ----------
     On desktop the player is in normal flow, so it pushes the band up and never
     overlaps it. On mobile the player is position:fixed (so it stays put while
     the page scrolls), which means we must reserve its height ourselves —
     otherwise a tall reference line makes the dark player float up over the
     text. We measure the player's real height (it already includes its
     safe-area padding) and feed it to the band as --player-h; the mobile rules
     size the band around it. Kept in sync as the reference grows and shrinks.
     Harmless on desktop, where the CSS doesn't read --player-h. */
  function syncPlayerReserve() {
    const h = Math.ceil(playerEl.getBoundingClientRect().height);
    bandEl.style.setProperty("--player-h", h + "px");
  }
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(syncPlayerReserve);
    ro.observe(playerEl);
  } else {
    window.addEventListener("resize", syncPlayerReserve);
  }
  window.addEventListener("orientationchange", syncPlayerReserve);
  syncPlayerReserve();

  /* ---------- mobile: collapse the player to a floating show-player button ----------
     Mobile only (the CSS gates every rule to the max-width:760px media query).
     Collapsing hides the whole player — reference, controls and seek — and
     floats a show-player button (.ln-fab, bottom-right) to bring it back. The
     page boots collapsed (body.player-collapsed in the markup) so the learner
     gets the full screen until they want the controls. */
  function setPlayerCollapsed(collapsed) {
    document.body.classList.toggle("player-collapsed", collapsed);
    // aria-expanded reflects the player's visibility on both toggles.
    if (collapseBtn) collapseBtn.setAttribute("aria-expanded", String(!collapsed));
    if (fabEl) fabEl.setAttribute("aria-expanded", String(!collapsed));
    // The player's measured height feeds the band's reserved space (--player-h):
    // collapsing drops it to 0 so the band reclaims the screen; reopening restores
    // it. (getBoundingClientRect forces the reflow, so this reads the new height.)
    syncPlayerReserve();
  }
  if (collapseBtn) collapseBtn.addEventListener("click", function () { setPlayerCollapsed(true); });
  if (fabEl) fabEl.addEventListener("click", function () { setPlayerCollapsed(false); });

  function wirePanelResize(handle) {
    // Drag to resize works on both desktop and mobile (the handle is touch-action:
    // none, so a touch-drag on it resizes instead of scrolling the page).
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("dragging");
      document.body.classList.add("resizing");
      // Seed from the RENDERED box, not from --panel-h. The panel is allowed to
      // shrink below the variable (app.html's .explain-panel flex rule) so the
      // notepad keeps its floor, and seeding from the variable would make the
      // first N px of every drag do nothing. curPanelH() is the fallback for a
      // panel that has not been laid out yet.
      const boxH = Math.round(handle.parentElement.getBoundingClientRect().height);
      const startY = e.clientY, startH = boxH || curPanelH();
      // Drag up (smaller clientY) → taller panel.
      const move = (ev) => applyPanelH(startH + (startY - ev.clientY));
      const up = () => {
        handle.classList.remove("dragging");
        document.body.classList.remove("resizing");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        localStorage.setItem(panelHKey(), String(curPanelH()));
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
    handle.addEventListener("keydown", (e) => {
      const cur = curPanelH();
      const next = e.key === "ArrowUp" ? cur + 24 : e.key === "ArrowDown" ? cur - 24 : null;
      if (next === null) return;
      e.preventDefault();
      localStorage.setItem(panelHKey(), String(applyPanelH(next)));
    });
  }
  // Re-apply on viewport change, re-deriving from the SAVED height (not the live,
  // possibly already-clamped value). Otherwise a transient innerHeight dip — the
  // mobile URL bar showing/hiding fires resize repeatedly — would ratchet a tall
  // panel permanently smaller, since clamping the live value down can't recover
  // when the viewport grows back. Reading the stored target also restores each
  // form factor's own height when the 760px breakpoint is crossed (panelHKey
  // flips). rAF-coalesced so the URL-bar resize stream doesn't thrash layout.
  let reclampQueued = false;
  window.addEventListener("resize", () => {
    if (reclampQueued) return;
    reclampQueued = true;
    requestAnimationFrame(() => {
      reclampQueued = false;
      const stored = parseFloat(localStorage.getItem(panelHKey()));
      // Fall back to the 60%-of-viewport default (re-derived from innerHeight, like
      // initPanelH) rather than the live value, so a never-dragged panel can't
      // ratchet on a tiny viewport either.
      applyPanelH(stored > 0 ? stored : Math.round(window.innerHeight * 0.6));
    });
  });


  /* ---------- boot ---------- */

  playerEl.hidden = false;
  document.title = "Daily Dictation";
  startTicker();
  checkCredits();


  // Exposed for dictation: trigger the same explanation panel from the
  // Reference line. `phrase` is the clicked word/phrase, `contextText`
  // is the surrounding passage for the model's context window: the current
  // session wrapped in >>> <<< (the click came from inside the marks) plus
  // one neighboring session per side outside them, with a header line saying
  // so — or just the session itself when it has no neighbors.
  window.__dictationExplain = function(phrase, contextText) {
    if (!phrase || !String(phrase).trim()) return;
    const panel = nextPanelForSelection();
    panel.threadText = String(contextText || phrase).trim() || String(phrase).trim();
    const words = String(phrase).trim().split(/\s+/).filter(Boolean);
    triggerExplain(panel, [{ phrase: String(phrase).trim(), words }]);
  };

  // Exposed for dictation: Next moves to a new session, so the old session's
  // explanation is stale — close all panels (aborting any in-flight stream).
  window.__dictationCloseExplanations = function() {
    teardownAllPanels();
  };
})();
