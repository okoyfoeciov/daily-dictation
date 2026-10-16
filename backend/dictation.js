"use strict";

/**
 * Dictation — session selection & grading.
 *
 * Three pieces:
 *   1. Turning a transcript's per-word array into short audio sessions, cut at
 *      boundaries the SPEAKER produced (terminal punctuation confirmed by a
 *      pause, or a pause on its own) rather than at boundaries the ASR guessed.
 *   2. A scheduler that spaces items, re-exposes what was failed, and aims at a
 *      success band — instead of retiring every item on first sight.
 *   3. A WER-based checker that scores the learner, not the transcriber.
 *
 * Design notes
 * ────────────
 * WER is defined everywhere as (S + D + I) / N, where S = substitutions,
 * D = deletions, I = insertions, N = words in reference. Accuracy is reported
 * as max(0, 1 - WER), clamped because insertions can push WER > 1.
 *
 * The normalisation applied before alignment is deliberately NOT the ASR
 * benchmark recipe. A benchmark wants to forgive everything that isn't a
 * recognition error; a dictation drill wants to forgive everything that isn't a
 * LISTENING error, and those are different sets:
 *
 *   - Contractions stay whole tokens, so "we're" heard as "were" is scored as
 *     the error it is. (An earlier version deleted apostrophes before
 *     tokenising, which made every contraction/homophone confusion — the single
 *     thing this drill exists to train, per Field 2008 — score 100%.)
 *   - Expansions are free: "it is" typed for "it's" canonicalises to the same
 *     token, because writing the long form proves you decoded the short one.
 *   - Possessive 's is folded away for ordinary nouns ("America's" == "Americas")
 *     since it is not audible, but NOT for the pronoun contractions where 's is
 *     "is"/"has".
 *   - Numbers, currency and percent are canonicalised to a numeric form on both
 *     sides, so "thirty million dollars" == "$30 million". This is the step
 *     Whisper's own EnglishTextNormalizer exists to provide (Radford et al.
 *     2023, App. C).
 *
 * Segmentation cuts on PAUSES, not on ASR punctuation. Published period
 * restoration on ASR output tops out around F1 82 and commas around 62-66, so
 * punctuation alone is a boundary signal that is wrong roughly one time in five;
 * the word timings are already in the transcript and are not a guess. A gap
 * larger than HARD_GAP_S is a hard boundary that no session may straddle, which
 * is what stops a session spanning speech the ASR dropped entirely.
 *
 * Scheduling follows the retrieval-practice literature rather than a
 * seen/unseen bit: SM-2 intervals (Woźniak) over an append-only attempt log,
 * candidate scoring after Papoušek & Pelánek (2015), a success target between
 * Wilson et al. (2019) and Papoušek's deployed 0.75, and Rawson & Dunlosky's
 * 3-correct criterion before an item retires. Failing an item re-queues it;
 * it does not burn it.
 */

const fs = require("fs");
const path = require("path");
const db = require("./db");
const paths = require("./paths");

// Resolved per call (not a captured constant) so a setLibraryDir() call from
// the packaged app takes effect without re-requiring this module.
function dictationPath() {
  return paths.getDictationPath();
}

// ---------------------------------------------------------------------------
// Tuning — every threshold in the pipeline, in one place.
// ---------------------------------------------------------------------------

const TUNING = {
  // --- segmentation ---
  // A gap at least this long is a hard boundary: no session may span it. Matches
  // LINE_GAP_S in the upstream transcriber, which already breaks lines here.
  HARD_GAP_S: 1.25,
  // A unit longer than this is a split candidate…
  SPLIT_ABOVE_WORDS: 24,
  SPLIT_ABOVE_S: 14,
  // …but only splits at a pause this long, searched in the middle band below.
  // Under it, the unit is left whole and validation decides — a forced cut at a
  // guessed midpoint produces two fragments instead of one honest reject.
  MIN_SPLIT_PAUSE_S: 0.35,
  // A pause at least this long is treated as a boundary the SPEAKER made, so
  // both halves count as properly closed/opened rather than as loose ends.
  // LibriSpeech splits utterances on silences from 0.5 s up; this sits just
  // above that, since the pauses here are measured between ASR word timings
  // rather than against a real VAD.
  PROSODIC_PAUSE_S: 0.6,
  SPLIT_BAND: [0.28, 0.72], // fraction of the unit to search for that pause

  // --- session assembly ---
  TARGET_WORDS: 18,
  MAX_BUNDLE_UNITS: 3,
  BUNDLE_MAX_WORDS: 30,
  BUNDLE_MAX_S: 16,

  // --- validation ---
  MIN_WORDS: 6,
  MAX_WORDS: 32,
  MIN_S: 2.0,
  MAX_S: 18,
  MIN_CHARS: 12,
  // Speech rate. Above the ceiling the timings are corrupt (no human speaks
  // there), below the floor the window is mostly dead air. Griffiths (1990)
  // puts "fast" at 200 wpm for this population; the ceiling here is a
  // corrupt-data detector, not a difficulty gate.
  MIN_WPM: 100,
  MAX_WPM: 260,
  // Residual gap allowed inside a session, below HARD_GAP_S.
  MAX_INNER_GAP_S: 1.0,
  // Degenerate ASR timings: this many consecutive words inside this span.
  COLLAPSE_RUN: 4,
  COLLAPSE_SPAN_S: 0.12,
  // Hallucination loops.
  MAX_CONSECUTIVE_REPEATS: 2,
  MIN_DISTINCT_RATIO: 0.5,
  // A duplicated word whose copy is no longer than this has no real audio behind
  // it — the transcriber floors a squashed word at 0.050 s, so a token at that
  // length repeating its neighbour is a line-stitching artifact, not speech.
  STITCH_MAX_S: 0.07,
  // Entry-level gate: a transcript this bad is excluded wholesale rather than
  // having its survivors served.
  MAX_ENTRY_REJECT_RATIO: 0.65,

  // --- scheduling ---
  P_TARGET: 0.8,
  W_PROB: 1,
  W_COUNT: 1,
  W_TIME: 12,
  RETIRE_REPS: 3,
  RETIRE_SCORE: 90,
  // The score at or above which an attempt counts as a pass and the interval
  // grows. SM-2's own 0-5 quality scale passes at 3, which a plain
  // round(score/20) puts at 50% — but half a dictation clip transcribed is not
  // a recall worth spacing a day out. 70 is the boundary here; below it the item
  // comes back the same session.
  PASS_SCORE: 70,
  // Draw uniformly from this many best-scoring candidates rather than taking a
  // strict argmax. Pure argmax is deterministic for a fixed state, so browsing
  // without answering shows the same item every time and the scheduler never
  // explores; Papoušek & Pelánek randomise among the best scorers for the same
  // reason.
  CANDIDATE_POOL: 8,
  RELEARN_DELAY_MS: 20 * 60 * 1000,
  ROLLING_WINDOW: 10,
  DEFAULT_LEARNER_MEAN: 0.75,
};

const ALGORITHM_VERSION = 2;

// ---------------------------------------------------------------------------
// Persistence
//
// v2 shape:
//   { algorithmVersion, items: { <sessionId>: Item }, updatedAt }
//   Item = { entryId, wordStart, wordEnd, text, attempts: [Attempt],
//            reps, ease, intervalDays, dueAt, lastAt, retired }
//   Attempt = { at, score|null, wordCount, duration, wpm, skipped? }
//
// v1 shape was { completed: [row], completedSet: {id: true} } and treated
// completion as a write-once tombstone. It is migrated in place on first load.
//
// sessionId is a partition coordinate (`<entryId>:<wordStart>-<wordEnd>`), so
// any change to segmentation renames every session and would orphan the whole
// history. resolveItem() therefore falls back to word-range overlap within the
// same entry, and rekeys the item when it resolves that way.
// ---------------------------------------------------------------------------

function emptyState() {
  return { algorithmVersion: ALGORITHM_VERSION, items: {}, updatedAt: 0 };
}

function newItem(session) {
  return {
    entryId: session.entryId,
    wordStart: session.wordStart,
    wordEnd: session.wordEnd,
    text: session.text,
    attempts: [],
    reps: 0,
    ease: 2.5,
    intervalDays: 0,
    dueAt: 0,
    lastAt: 0,
    retired: false,
  };
}

function migrateV1(raw) {
  const state = emptyState();
  const rows = Array.isArray(raw.completed) ? raw.completed : [];
  for (const row of rows) {
    // v1 briefly stored bare id strings before it stored objects.
    const r = typeof row === "string" ? { sessionId: row } : row;
    if (!r || !r.sessionId) continue;
    const [entryId] = String(r.sessionId).split(":");
    const at = Number(r.completedAt) || 0;
    const score = typeof r.score === "number" ? r.score : null;
    const item = {
      entryId: r.entryId || entryId,
      wordStart: Number(r.wordStart) || 0,
      wordEnd: Number(r.wordEnd) || 0,
      text: r.text || "",
      // v1 never recorded wordCount/duration, so the historical scores cannot be
      // length-normalised retrospectively. They are kept as-is and marked.
      attempts: [{ at, score, wordCount: null, duration: null, wpm: null, v1: true }],
      reps: 0,
      ease: 2.5,
      intervalDays: 0,
      dueAt: 0,
      lastAt: at,
      retired: false,
    };
    // Replay the v1 row through the same interval rule new attempts use, so a
    // migrated history schedules identically to one recorded natively.
    applyAttemptSchedule(item, score, at);
    state.items[r.sessionId] = item;
  }
  // Ids that only ever lived in the legacy set, with no row behind them.
  for (const id of Object.keys(raw.completedSet || {})) {
    if (state.items[id]) continue;
    const [entryId, range] = String(id).split(":");
    const [ws, we] = String(range || "").split("-");
    const item = newItem({
      entryId,
      wordStart: Number(ws) || 0,
      wordEnd: Number(we) || 0,
      text: "",
    });
    applyAttemptSchedule(item, null, 0);
    item.attempts.push({ at: 0, score: null, wordCount: null, duration: null, wpm: null, v1: true });
    state.items[id] = item;
  }
  return state;
}

function loadState() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(dictationPath(), "utf8"));
  } catch {
    return emptyState();
  }
  if (!raw || typeof raw !== "object") return emptyState();
  if (raw.algorithmVersion >= 2 && raw.items && typeof raw.items === "object") {
    return {
      algorithmVersion: raw.algorithmVersion,
      items: raw.items,
      updatedAt: raw.updatedAt || 0,
    };
  }
  return migrateV1(raw);
}

function saveState(state) {
  const DICTATION_PATH = dictationPath();
  const dir = path.dirname(DICTATION_PATH);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  state.algorithmVersion = ALGORITHM_VERSION;
  state.updatedAt = Date.now();
  // Unique tmp name: two concurrent writers sharing one ".tmp" path can rename
  // a half-written file over the real one.
  const tmp = `${DICTATION_PATH}.${process.pid}.${state.updatedAt}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, JSON.stringify(state, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, DICTATION_PATH);
}

/**
 * The item for a session, tolerant of segmentation changes.
 *
 * Exact id first. Failing that, the item in the same entry whose recorded word
 * range overlaps this session's by more than 60% of the shorter range — which
 * is what keeps a learner's history attached when a re-cut moves a boundary by
 * a word or two. A resolved-by-overlap item is rekeyed to the new id, so the
 * fallback runs once per renamed session rather than on every pick.
 */
// entryId -> [key, item] pairs, built once per state object. resolveItem is
// called once per session in the eligibility pass and again per candidate when
// scoring, so rescanning the whole map on every miss is O(sessions × items) per
// request — which is exactly the situation right after a re-segmentation, when
// every old key misses. Keyed by the state object so it is never serialised.
const itemIndexCache = new WeakMap();

function itemsForEntry(state, entryId) {
  let index = itemIndexCache.get(state);
  if (!index) {
    index = new Map();
    for (const [key, it] of Object.entries(state.items)) {
      let bucket = index.get(it.entryId);
      if (!bucket) { bucket = []; index.set(it.entryId, bucket); }
      bucket.push([key, it]);
    }
    itemIndexCache.set(state, index);
  }
  return index.get(entryId) || [];
}

function invalidateItemIndex(state) {
  itemIndexCache.delete(state);
}

function resolveItem(state, session, { rekey = false } = {}) {
  const direct = state.items[session.sessionId];
  if (direct) return direct;

  let best = null, bestKey = null, bestOverlap = 0;
  for (const [key, it] of itemsForEntry(state, session.entryId)) {
    const lo = Math.max(it.wordStart, session.wordStart);
    const hi = Math.min(it.wordEnd, session.wordEnd);
    const overlap = hi - lo + 1;
    if (overlap <= 0) continue;
    const shorter = Math.min(it.wordEnd - it.wordStart, session.wordEnd - session.wordStart) + 1;
    const ratio = overlap / shorter;
    if (ratio > 0.6 && ratio > bestOverlap) { bestOverlap = ratio; best = it; bestKey = key; }
  }
  if (best && rekey && bestKey !== session.sessionId) {
    delete state.items[bestKey];
    state.items[session.sessionId] = best;
    best.wordStart = session.wordStart;
    best.wordEnd = session.wordEnd;
    best.text = session.text;
    invalidateItemIndex(state);   // keys moved; the cached buckets are stale
  }
  return best || null;
}

// ---------------------------------------------------------------------------
// Transcript hygiene
// ---------------------------------------------------------------------------

// Chyron / lower-third speaker labels. Legacy CrisperWhisper transcripts render
// the on-screen
// name card as speech, so the reference ends up containing "NICK TIMORES, Chief
// Economics Correspondent, The Wall Street Journal" — text nobody said at that
// moment and nobody can be expected to spell. Two or more consecutive all-caps
// tokens is the signature; single all-caps tokens are left alone because that is
// where real acronyms live (US, NATO, FBI, CEO, mRNA).
const ALLCAPS_RE = /^[A-Z][A-Z'’.-]*[A-Z][A-Z'’.-]*$/;
const CAPS_TITLE_RE = /^(DR|MR|MRS|MS|SEN|REP|GOV|GEN|LT|COL|PROF|ST)\.?$/;

// Acronyms that are ordinary spoken vocabulary. Two of these in a row ("the US
// CDC said", "a U.S. NATO summit") is speech, not a name card, and deleting it
// would charge a learner who transcribed correctly for words they really heard.
const ACRONYMS = new Set([
  "US", "USA", "UK", "EU", "UN", "NATO", "FBI", "CIA", "CDC", "NASA", "NIH",
  "WHO", "GDP", "CEO", "CFO", "COO", "AI", "ID", "TV", "PBS", "BBC", "CNN",
  "NPR", "GOP", "IRS", "FDA", "EPA", "DOJ", "DHS", "ICE", "FEMA", "NYPD",
  "LGBTQ", "COVID", "HIV", "DNA", "RNA", "MRNA", "PHD", "MD", "OK", "AM", "PM",
]);

function isAllCapsName(text) {
  const bare = String(text || "").replace(/[^A-Za-z'’.-]/g, "");
  if (bare.length < 2) return false;
  const upper = bare.toUpperCase();
  if (ACRONYMS.has(upper.replace(/[.'’-]/g, ""))) return false;
  if (CAPS_TITLE_RE.test(upper) && bare === upper) return true;
  return ALLCAPS_RE.test(bare);
}

/**
 * Drop chyron runs from the word array.
 *
 * The timestamp matters as much as the text: a chyron is stamped where the
 * caption appears on screen, not where speech is, so a session that starts on
 * one takes its play window from a moment nothing was said. Removing the words
 * removes the false anchor with them.
 */
function stripChyrons(words) {
  const out = [];
  let i = 0;
  while (i < words.length) {
    let j = i;
    while (j < words.length && isAllCapsName(words[j].text)) j++;
    const runLen = j - i;
    if (runLen >= 2 && looksLikeNameCard(words, i, j)) { i = skipTitleClauses(words, j); continue; }
    out.push(words[i]);
    i++;
  }
  return out;
}

// Words that appear inside an organisation name without being capitalised.
const TITLE_GLUE = new Set(["the", "of", "for", "and", "at", "on", "in", "a", "an"]);

/**
 * After a name run, skip the job title and outlet that complete the lower third.
 *
 * The caption is "NICK TIMORES, Chief Economics Correspondent, The Wall Street
 * Journal," and dropping only the name leaves the rest of the card in the
 * reference — where the ASR has written the card's comma in place of the
 * preposition the anchor actually spoke ("Correspondent FROM The Wall Street
 * Journal"). A learner transcribing what they heard is then charged an insertion
 * for being right.
 *
 * Only comma-delimited runs whose every word is capitalised (or organisation
 * glue) are skipped, and a sentence end stops the scan, so ordinary speech
 * following a name is kept.
 */
function skipTitleClauses(words, k) {
  while (k < words.length) {
    let e = k;
    while (e < words.length && !/,$/.test(String(words[e].text || ""))) {
      if (/[.!?…]['"’”)\]]?$/.test(String(words[e].text || ""))) return k;  // real speech
      e++;
    }
    if (e >= words.length) return k;   // no closing comma — not a card segment
    let isTitle = true;
    for (let t = k; t <= e; t++) {
      const w = String(words[t].text || "").replace(/[^A-Za-z]/g, "");
      if (!w || TITLE_GLUE.has(w.toLowerCase())) continue;
      if (!/^[A-Z]/.test(w)) { isTitle = false; break; }
    }
    if (!isTitle) return k;
    k = e + 1;
  }
  return k;
}

/**
 * Corroborate an all-caps run before deleting it.
 *
 * A lower third reads "NICK TIMORES, Chief Economics Correspondent…", so the run
 * ends on a comma; and because the caption is stamped where it appears on screen
 * rather than where speech is, its words often carry degenerate timings. Either
 * signal is enough. Requiring one of them is what keeps a genuine run of spoken
 * acronyms from being deleted out of the reference on some future clip.
 */
function looksLikeNameCard(words, i, j) {
  const last = String(words[j - 1].text || "");
  if (/[,:]$/.test(last)) return true;
  const span = (Number(words[j - 1].end) || 0) - (Number(words[i].start) || 0);
  if (span <= TUNING.COLLAPSE_SPAN_S) return true;
  // Any word in the run pinned at the transcriber's floor length has no audio of
  // its own — the caption was stamped, not spoken. "AMNA NAWAZANI" is exactly
  // this: the surname carries 205.24-205.29, the same 0.05 s slot as the word
  // after it.
  for (let k = i; k < j; k++) {
    if ((Number(words[k].end) || 0) - (Number(words[k].start) || 0) <= TUNING.STITCH_MAX_S) return true;
  }
  // A title token ("DR.", "SEN.") only ever leads a name here.
  if (CAPS_TITLE_RE.test(String(words[i].text || "").toUpperCase().replace(/[^A-Z.]/g, ""))) return true;
  return false;
}

/**
 * Drop words duplicated by line stitching.
 *
 * Legacy CrisperWhisper output repeats a word across its own line boundary, so the
 * reads "Nepal's Nepal's army says…" and a learner who transcribes what was
 * actually said takes a deletion for it. The duplicate is distinguishable from
 * genuine disfluency by duration, not by text: a stitched copy carries the
 * transcriber's 0.050 s floor because no audio underlies it, while a real
 * repetition ("far, far, far") has ordinary word durations and audible gaps
 * between the copies. Only the former is removed.
 */
function dropStitchDuplicates(words) {
  const norm = (w) => String(w.text || "").toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
  const out = [];
  for (const w of words) {
    const prev = out[out.length - 1];
    if (prev && norm(w) && norm(w) === norm(prev)) {
      const dur = (Number(w.end) || 0) - (Number(w.start) || 0);
      const prevDur = (Number(prev.end) || 0) - (Number(prev.start) || 0);
      if (dur <= TUNING.STITCH_MAX_S) continue;               // this copy is the artifact
      if (prevDur <= TUNING.STITCH_MAX_S) { out.pop(); out.push(w); continue; }
    }
    out.push(w);
  }
  return out;
}

/**
 * Longest run of consecutive words squashed into one timestamp.
 *
 * A true sliding window, not a fixed anchor: anchoring each window at i and
 * restarting at j+1 splits a run that begins one word after the anchor's window
 * closes, so the real length is never seen and the collapse gate can be passed
 * by exactly the degenerate timings it exists to catch.
 */
function longestCollapsedRun(words) {
  let worst = 0, left = 0;
  for (let right = 0; right < words.length; right++) {
    while (left < right && words[right].start - words[left].start > TUNING.COLLAPSE_SPAN_S) left++;
    worst = Math.max(worst, right - left + 1);
  }
  return worst;
}

// ---------------------------------------------------------------------------
// Transcript → units → sessions
// ---------------------------------------------------------------------------

const SENT_END_RE = /[.!?…]['"’”)\]]?$/;

// A token ending in "." that is an abbreviation, an initial, or an ordinal is
// not a sentence end. Without this every "Dr.", "U.S." and "No." closes a unit.
const ABBREV_RE = /^(mr|mrs|ms|dr|prof|st|sen|rep|gov|gen|lt|col|sgt|jr|sr|inc|corp|co|no|vs|etc|approx|dept|univ|[a-z])\.$/i;

function endsUnit(text, nextText) {
  if (!SENT_END_RE.test(text)) return false;
  if (ABBREV_RE.test(text)) return false;
  // "…the U.S. said" — a lowercase continuation means the period was internal.
  if (nextText && /^[a-z]/.test(nextText)) return false;
  return true;
}

/**
 * Split the word array into units.
 *
 * A unit ends at terminal punctuation (abbreviation-guarded) OR at a gap of at
 * least HARD_GAP_S, whichever comes first. The gap rule is the load-bearing one:
 * Whisper-family models drop whole stretches of speech and the word array simply
 * jumps forward in time with no marker, so a unit that may not span a large gap
 * is a unit that cannot contain audio missing from its own reference text.
 *
 * Each unit carries the quality of the boundary at each end:
 *   "sentence" — terminal punctuation, or the start of the transcript
 *   "prosodic" — a pause long enough to be a break the speaker made
 *   "broken"   — a cut through the middle of a clause
 *
 * A hard gap is deliberately NOT "prosodic". Measuring the audio inside these
 * gaps shows them running at the same level as the speech either side, i.e. they
 * are usually dropped speech rather than silence, so the words across such a cut
 * are mid-clause even though a long time passed.
 */
function unitsFromWords(words) {
  const units = [];
  let cur = [];
  let openQuality = "sentence";   // the transcript's first word starts one

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const text = String(w.text || "").trim();
    if (!text) continue;
    cur.push({
      text,
      start: Number(w.start) || 0,
      end: Number(w.end) || Number(w.start) || 0,
      idx: w.idx != null ? w.idx : i,
    });

    const next = words[i + 1];
    const nextText = next ? String(next.text || "").trim() : "";
    const gapAfter = next ? (Number(next.start) || 0) - (Number(w.end) || 0) : 0;

    const punctEnd = endsUnit(text, nextText);
    const gapEnd = next && gapAfter >= TUNING.HARD_GAP_S;

    if (punctEnd || gapEnd) {
      cur.openQuality = openQuality;
      cur.closeQuality = punctEnd ? "sentence" : "broken";
      units.push(cur);
      cur = [];
      openQuality = punctEnd ? "sentence" : "broken";
    }
  }
  if (cur.length) {
    cur.openQuality = openQuality;
    cur.closeQuality = "broken";   // ran out of transcript mid-clause
    units.push(cur);
  }
  return units;
}

/** The largest inter-word gap inside a word run, and where it is. */
function largestGap(u, from, to) {
  let best = 0, at = -1;
  for (let k = Math.max(1, from); k <= Math.min(u.length - 1, to); k++) {
    const gap = u[k].start - u[k - 1].end;
    if (gap > best) { best = gap; at = k; }
  }
  return { gap: best, at };
}

function unitDuration(u) {
  return u[u.length - 1].end - u[0].start;
}

/**
 * Split an over-long unit at the biggest pause near its middle, recursively.
 *
 * A pause is where the speaker actually broke the stream, so both halves are
 * prosodically real chunks even though the second one does not start a sentence.
 * When no pause in the search band clears MIN_SPLIT_PAUSE_S the unit is returned
 * WHOLE and left for validation to reject — the previous version cut at
 * Math.floor(n/2) in that case, which is what manufactured references like
 * "of wood that's in your shed…".
 */
function splitUnitByPause(u, depth = 0) {
  const n = u.length;
  const tooLong = n > TUNING.SPLIT_ABOVE_WORDS || unitDuration(u) > TUNING.SPLIT_ABOVE_S;
  if (!tooLong || depth > 4 || n < 2 * TUNING.MIN_WORDS) return [u];

  const [lo, hi] = TUNING.SPLIT_BAND;
  const { gap, at } = largestGap(u, Math.floor(n * lo), Math.ceil(n * hi));
  if (at < 0 || gap < TUNING.MIN_SPLIT_PAUSE_S) return [u];
  if (at < TUNING.MIN_WORDS || n - at < TUNING.MIN_WORDS) return [u];

  // Only a pause the speaker plainly made counts as a clean edge. A shorter one
  // still splits an over-long unit — better than serving it whole — but both
  // halves are marked broken, so validation will drop them unless the other end
  // redeems them.
  const quality = gap >= TUNING.PROSODIC_PAUSE_S ? "prosodic" : "broken";

  const a = u.slice(0, at);
  const b = u.slice(at);
  a.openQuality = u.openQuality;
  a.closeQuality = quality;
  b.openQuality = quality;
  b.closeQuality = u.closeQuality;
  return [...splitUnitByPause(a, depth + 1), ...splitUnitByPause(b, depth + 1)];
}

/**
 * Partition a transcript into candidate sessions.
 *
 * Units are bundled greedily toward TARGET_WORDS, never across a hard gap (units
 * already can't span one) and never past the bundle ceilings. Returns raw
 * candidates; isSessionValid() is the gate.
 */
function partitionTranscript(rawWords) {
  const indexed = rawWords.map((w, i) => ({ ...w, idx: i }));
  const words = dropStitchDuplicates(stripChyrons(indexed));
  if (!words.length) return [];

  const units = [];
  for (const u of unitsFromWords(words)) {
    for (const part of splitUnitByPause(u)) units.push(part);
  }
  if (!units.length) return [];

  const sessions = [];
  let i = 0;
  while (i < units.length) {
    let take = 1;
    let wc = units[i].length;
    let dur = unitDuration(units[i]);

    // Bundle forward while that gets us closer to the target without breaching a
    // ceiling — and never across a hard gap. A unit ends at punctuation OR at a
    // hard gap, so the gap AFTER a punctuation-closed unit is unbounded; without
    // this check a bundle straddles it and isSessionValid then rejects the whole
    // bundle, discarding the good unit along with the bad join.
    while (take < TUNING.MAX_BUNDLE_UNITS && i + take < units.length) {
      const nxt = units[i + take];
      const prev = units[i + take - 1];
      if (nxt[0].start - prev[prev.length - 1].end >= TUNING.HARD_GAP_S) break;
      const wc2 = wc + nxt.length;
      const dur2 = nxt[nxt.length - 1].end - units[i][0].start;
      if (wc2 > TUNING.BUNDLE_MAX_WORDS || dur2 > TUNING.BUNDLE_MAX_S) break;
      // Stop once adding another unit would overshoot the target by more than
      // staying put undershoots it.
      if (Math.abs(wc2 - TUNING.TARGET_WORDS) >= Math.abs(wc - TUNING.TARGET_WORDS)) break;
      take++; wc = wc2; dur = dur2;
    }

    const chunk = units.slice(i, i + take);
    const flat = chunk.flat();
    const text = chunk.map((u) => u.map((w) => w.text).join(" ")).join(" ");
    const duration = flat[flat.length - 1].end - flat[0].start;
    const { gap: maxGap } = largestGap(flat, 1, flat.length - 1);

    sessions.push({
      wordStart: flat[0].idx,
      wordEnd: flat[flat.length - 1].idx,
      text,
      wordCount: flat.length,
      start: flat[0].start,
      end: flat[flat.length - 1].end,
      duration,
      maxGap,
      wpm: duration > 0 ? (flat.length * 60) / duration : Infinity,
      openQuality: chunk[0].openQuality || "broken",
      closeQuality: chunk[chunk.length - 1].closeQuality || "broken",
      collapsedRun: longestCollapsedRun(flat),
      words: flat,
    });
    i += take;
  }
  return sessions;
}

/** Verbatim repetition — the Whisper hallucination-loop signature. */
function hasRepetitionLoop(text) {
  const toks = String(text).toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
  if (toks.length < 4) return false;
  let run = 1;
  for (let i = 1; i < toks.length; i++) {
    run = toks[i] === toks[i - 1] ? run + 1 : 1;
    if (run > TUNING.MAX_CONSECUTIVE_REPEATS) return true;
  }
  // Repeated n-grams ("what's the data center going to do?" ×4).
  for (let n = 3; n <= 6; n++) {
    for (let i = 0; i + 2 * n <= toks.length; i++) {
      if (toks.slice(i, i + n).join(" ") === toks.slice(i + n, i + 2 * n).join(" ")) return true;
    }
  }
  if (new Set(toks).size / toks.length < TUNING.MIN_DISTINCT_RATIO) return true;
  return false;
}

/**
 * Is this candidate fit to be served?
 *
 * The rate check is the important one and is not a difficulty gate: above
 * MAX_WPM no human is speaking, so the timings are corrupt and the audio window
 * does not contain the reference; below MIN_WPM the window is mostly dead air.
 * Checking words and seconds as independent ranges — as this function used to —
 * cannot see either case.
 */
function isSessionValid(s) {
  if (!s) return false;
  if (s.wordCount < TUNING.MIN_WORDS || s.wordCount > TUNING.MAX_WORDS) return false;
  if (!(s.duration >= TUNING.MIN_S) || s.duration > TUNING.MAX_S) return false;
  if (String(s.text || "").trim().length < TUNING.MIN_CHARS) return false;

  const wpm = s.wpm != null ? s.wpm : (s.duration > 0 ? (s.wordCount * 60) / s.duration : Infinity);
  if (!isFinite(wpm) || wpm < TUNING.MIN_WPM || wpm > TUNING.MAX_WPM) return false;

  if ((s.maxGap || 0) > TUNING.MAX_INNER_GAP_S) return false;
  if ((s.collapsedRun || 0) >= TUNING.COLLAPSE_RUN) return false;
  if (hasRepetitionLoop(s.text)) return false;

  // Shape: both edges must be boundaries somebody actually produced — a sentence
  // end, or a pause long enough to be a break the speaker made. A reference that
  // opens mid-clause takes away the grammatical expectancies the listener uses
  // to reconstruct what they heard, which is the compensatory strategy dictation
  // is meant to exercise, and one that ends mid-clause stops the audio somewhere
  // the learner has no way to anticipate.
  if (s.openQuality === "broken" || s.closeQuality === "broken") return false;

  return true;
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

function getPBSEntries() {
  const all = db.listEntries();
  const byId = new Map(all.map((e) => [e.id, e]));

  // Membership is decided by the collection tree. sourceId is not evidence of
  // it — it only says the entry came from somewhere with an id, which is true of
  // every imported file. The walk is depth-capped because a cyclic parentId
  // would otherwise spin forever inside a request and hang the server.
  function isUnderPBS(e) {
    let cur = e;
    for (let hops = 0; cur && hops < 32; hops++) {
      if (cur.id === "pbs-newshour" || cur.parentId === "pbs-newshour") return true;
      if (!cur.parentId) return false;
      cur = byId.get(cur.parentId);
    }
    return false;
  }

  // "movie" is the older mp4 corpus, "audio" the RSS podcast imports — the
  // dictation loop only ever plays the sound track either way.
  return all.filter(
    (e) => (e.type === "movie" || e.type === "audio") && isUnderPBS(e) && e.transcriptStatus === "ready" && e.transcriptPath,
  );
}

// Memoised per (path, mtime). getAllSessionsDetailed is a pure function of the
// transcript files, which change only when pbs-sync runs, and it was previously
// re-reading and re-partitioning the entire corpus on every single API call.
const sessionCache = new Map();

function sessionsForEntry(entry) {
  let stat;
  try { stat = fs.statSync(entry.transcriptPath); } catch { return null; }
  const key = entry.transcriptPath;
  const hit = sessionCache.get(key);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;

  let words;
  try {
    const data = JSON.parse(fs.readFileSync(entry.transcriptPath, "utf8"));
    words = Array.isArray(data.words) ? data.words : [];
  } catch (e) {
    console.warn(`dictation: unreadable transcript for ${entry.id}: ${e.message}`);
    return null;
  }
  if (!words.length) return null;

  const candidates = partitionTranscript(words);
  const valid = candidates.filter(isSessionValid);
  const rejectRatio = candidates.length ? 1 - valid.length / candidates.length : 1;

  const rec = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    words,
    candidates: candidates.length,
    rejected: candidates.length - valid.length,
    rejectRatio,
    sessions: valid.map((s, idx) => ({
      sessionId: `${entry.id}:${s.wordStart}-${s.wordEnd}`,
      entryId: entry.id,
      entryTitle: entry.title,
      wordStart: s.wordStart,
      wordEnd: s.wordEnd,
      text: s.text,
      wordCount: s.wordCount,
      start: s.start,
      end: s.end,
      duration: s.duration,
      maxGap: s.maxGap,
      wpm: s.wpm,
      words: s.words.map((w) => ({ text: w.text, start: w.start, end: w.end })),
      partitionIndex: idx,
    })),
  };
  sessionCache.set(key, rec);
  return rec;
}

function getAllSessionsDetailed() {
  const out = [];
  for (const e of getPBSEntries()) {
    const rec = sessionsForEntry(e);
    if (!rec) continue;
    // A transcript this badly damaged is excluded wholesale: its surviving
    // sessions are as likely to be artefacts as the rejected ones, and serving
    // them lets one bad entry contribute as much practice as a clean one.
    if (rec.rejectRatio > TUNING.MAX_ENTRY_REJECT_RATIO) {
      console.warn(
        `dictation: excluding ${e.id} — ${(rec.rejectRatio * 100).toFixed(0)}% of ` +
        `${rec.candidates} candidates rejected`,
      );
      continue;
    }
    // totalPartitions is per-entry and only meaningful once the entry is kept.
    for (const s of rec.sessions) out.push({ ...s, totalPartitions: rec.sessions.length });
  }
  return out;
}

/**
 * The session's own words with their ASR timings, so the client can A-B loop a
 * phrase inside the segment. Comes from the same memoised partition that
 * produced the session, so the reference text the server grades against and the
 * words the client renders can no longer come from two different reads of the
 * file.
 */
function getSessionWords(session) {
  if (!session) return [];
  if (Array.isArray(session.words) && session.words.length) return session.words;
  const found = getSessionById(session.sessionId);
  return (found && found.words) || [];
}

function getSessionById(sessionId) {
  return getAllSessionsDetailed().find((s) => s.sessionId === sessionId) || null;
}

/**
 * Neighboring sessions' texts around `session`, same entry only — the extra
 * context the explanation lookup sends to the LLM alongside the session
 * itself. A one-sentence session alone often cannot fix a word's sense, so the
 * client wraps the session in one valid session before and after it (when they
 * exist) and marks which span the clicked word comes from; without the marks
 * a word appearing both inside and outside the session would be ambiguous.
 *
 * Neighbors are the adjacent VALID sessions in partition order, so every line
 * served here already passed isSessionValid. `radius` is sessions per side.
 */
function getSessionContext(session, radius = 1) {
  const empty = { before: "", after: "" };
  if (!session || !session.entryId || !session.sessionId) return empty;
  const r = Math.max(0, Math.floor(Number(radius) || 0));
  if (!r) return empty;
  let entry = null;
  try {
    entry = db.getEntry(session.entryId);
  } catch {
    return empty;
  }
  if (!entry || !entry.transcriptPath) return empty;
  const rec = sessionsForEntry(entry);
  if (!rec || !Array.isArray(rec.sessions) || !rec.sessions.length) return empty;
  const idx = rec.sessions.findIndex((s) => s.sessionId === session.sessionId);
  if (idx < 0) return empty;
  const before = rec.sessions
    .slice(Math.max(0, idx - r), idx)
    .map((s) => String(s.text || "").trim())
    .filter(Boolean)
    .join(" ");
  const after = rec.sessions
    .slice(idx + 1, idx + 1 + r)
    .map((s) => String(s.text || "").trim())
    .filter(Boolean)
    .join(" ");
  return { before, after };
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * Item difficulty in [0,1], from features the partition already computed.
 * Length and speech rate are the two variables the listening literature puts
 * first (Griffiths 1990/1992 on rate; the elicited-imitation work on length).
 */
function difficulty(s) {
  const wpm = s.wpm != null ? s.wpm : (s.duration > 0 ? (s.wordCount * 60) / s.duration : 180);
  const dLen = clamp01((s.wordCount - 8) / 22);
  const dRate = clamp01((wpm - 130) / 130);
  const dGap = (s.maxGap || 0) > 0.8 ? 0.3 : 0;
  return clamp01(0.5 * dLen + 0.4 * dRate + dGap);
}

function daysSince(ms, now) {
  if (!ms) return Infinity;
  return Math.max(0, (now - ms) / 864e5);
}

/** Probability the learner succeeds on this item right now. */
function pSuccess(item, s, learnerMean, now) {
  if (item && item.attempts.length) {
    const scored = [...item.attempts].reverse().find((a) => typeof a.score === "number");
    if (scored) {
      const recall = Math.exp(
        (-Math.LN2 * daysSince(item.lastAt, now)) / Math.max(1, item.intervalDays || 1),
      );
      return clamp01(0.15 + 0.85 * (scored.score / 100) * recall);
    }
  }
  return clamp01(learnerMean - 0.45 * (difficulty(s) - 0.5));
}

/** Papoušek & Pelánek (2015): probability term + recency penalty + novelty bonus. */
function scoreCandidate(s, item, learnerMean, now) {
  const p = pSuccess(item, s, learnerMean, now);
  const sProb = TUNING.P_TARGET >= p
    ? p / TUNING.P_TARGET
    : (1 - p) / (1 - TUNING.P_TARGET);
  const t = item && item.lastAt ? (now - item.lastAt) / 1000 : Infinity;
  const sTime = t === Infinity ? 0 : -1 / Math.max(1, t);
  const sCount = 1 / Math.sqrt(1 + (item ? item.attempts.length : 0));
  return TUNING.W_PROB * sProb + TUNING.W_TIME * sTime + TUNING.W_COUNT * sCount;
}

function rollingMean(state, n) {
  const scored = [];
  for (const it of Object.values(state.items)) {
    for (const a of it.attempts) {
      if (typeof a.score === "number") scored.push({ at: a.at, score: a.score });
    }
  }
  if (!scored.length) return TUNING.DEFAULT_LEARNER_MEAN;
  scored.sort((a, b) => b.at - a.at);
  const take = scored.slice(0, n);
  return clamp01(take.reduce((acc, a) => acc + a.score, 0) / take.length / 100);
}

/**
 * SM-2 interval update. Woźniak's rule for a failure is "start repetitions for
 * the item from the beginning" — the item comes BACK, soon. The version this
 * replaces retired it forever, which inverted the one thing the algorithm is
 * for.
 */
/**
 * Map a 0-100 dictation score onto SM-2's 0-5 quality scale, with the pass/fail
 * line at PASS_SCORE rather than at the 50% a plain round(score/20) implies.
 * Failures spread over 0-2, passes over 3-5, so ease still moves with how well
 * the attempt went rather than switching on a single threshold.
 */
function qualityFromScore(score) {
  const pass = TUNING.PASS_SCORE;
  if (score < pass) return Math.max(0, Math.min(2, Math.floor((3 * score) / pass)));
  return 3 + Math.max(0, Math.min(2, Math.floor((3 * (score - pass)) / (100 - pass))));
}

function applyAttemptSchedule(item, score, now) {
  if (typeof score !== "number") return;   // skipped: recorded, never scheduled
  const q = qualityFromScore(score);
  const wasDue = (item.dueAt || 0) <= now;
  item.lastAt = now;

  if (q < 3) {
    // A failure resets whether or not the item was due — you do not get to keep
    // a schedule you have just failed.
    item.reps = 0;
    item.intervalDays = 0;
    item.ease = Math.max(1.3, item.ease - 0.2);
    item.dueAt = now + TUNING.RELEARN_DELAY_MS;
    return;
  }

  // Practised ahead of schedule: the attempt is recorded, but the interval does
  // not advance and the rep does not count toward retirement. Rawson &
  // Dunlosky's 3-correct criterion means three SPACED recalls; without this
  // check three passes seconds apart retire an item, and a learner grinding
  // through the corpus could retire all of it in a few days — which is the
  // permanent dead end this scheduler exists to remove.
  if (!wasDue) return;

  item.reps += 1;
  item.intervalDays = item.reps === 1 ? 1
    : item.reps === 2 ? 6
    : Math.max(1, Math.round((item.intervalDays || 1) * item.ease));
  item.ease = Math.max(1.3, item.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  item.dueAt = now + item.intervalDays * 864e5;
  if (item.reps >= TUNING.RETIRE_REPS && score >= TUNING.RETIRE_SCORE) item.retired = true;
}

/** Weighted draw over entries, so one long segment can't own the practice. */
function pickEntry(pool, rand) {
  const byEntry = new Map();
  for (const s of pool) byEntry.set(s.entryId, (byEntry.get(s.entryId) || 0) + 1);
  const entries = [...byEntry.keys()];
  if (entries.length <= 1) return entries[0];
  // sqrt weighting: a 90-session entry gets more draws than a 30-session one,
  // but 3x the material no longer means 3x the airtime.
  const weights = entries.map((id) => Math.sqrt(byEntry.get(id)));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < entries.length; i++) {
    r -= weights[i];
    if (r <= 0) return entries[i];
  }
  return entries[entries.length - 1];
}

function pickNextSession({ now = Date.now(), rand = Math.random } = {}) {
  const all = getAllSessionsDetailed();
  if (!all.length) return null;

  const state = loadState();
  const learnerMean = rollingMean(state, TUNING.ROLLING_WINDOW);

  let unseen = 0, retired = 0, due = 0;
  const eligible = [];
  const notRetired = [];
  const retiredSessions = [];
  for (const s of all) {
    const it = resolveItem(state, s);
    if (!it) { unseen++; eligible.push(s); notRetired.push(s); continue; }
    if (it.retired) { retired++; retiredSessions.push(s); continue; }
    notRetired.push(s);
    if ((it.dueAt || 0) <= now) { due++; eligible.push(s); }
  }

  // Nothing due yet and nothing new: study ahead rather than show an empty
  // screen. Failing that, fall back to what has been mastered, oldest first —
  // retirement has to be a resting state, not a grave. A learner who masters the
  // whole corpus must still get a session, or the app dead-ends on a 404 the
  // moment they succeed at it.
  let pool = eligible.length ? eligible : notRetired;
  let fromRetired = false;
  if (!pool.length && retiredSessions.length) {
    pool = retiredSessions
      .slice()
      .sort((a, b) => {
        const ia = resolveItem(state, a), ib = resolveItem(state, b);
        return ((ia && ia.lastAt) || 0) - ((ib && ib.lastAt) || 0);
      })
      .slice(0, TUNING.CANDIDATE_POOL);
    fromRetired = true;
  }
  if (!pool.length) {
    return {
      session: null, exhausted: true, total: all.length,
      remaining: 0, unseen, retired, due, fromRetired: false,
    };
  }

  const entryId = pickEntry(pool, rand);
  const cands = pool.filter((s) => s.entryId === entryId);

  const ranked = cands
    .map((s) => ({ s, v: scoreCandidate(s, resolveItem(state, s), learnerMean, now) }))
    .sort((a, b) => b.v - a.v)
    .slice(0, TUNING.CANDIDATE_POOL);
  const best = ranked.length ? ranked[Math.floor(rand() * ranked.length)].s : null;

  return {
    session: best,
    exhausted: eligible.length === 0,
    fromRetired,
    total: all.length,
    remaining: unseen,
    unseen,
    retired,
    due,
    learnerMean,
  };
}

/**
 * Record an attempt. Append-only: unlike the write-once tombstone this replaces,
 * a second attempt on the same session is kept and reschedules the item.
 *
 * `score === null` means the learner moved on without checking. That is recorded
 * for the record but does NOT schedule and does NOT retire — pressing Next twice
 * while deciding what to study used to destroy two items from a finite pool.
 */
function recordAttempt(session, score, { now = Date.now(), skipped = false } = {}) {
  if (!session) return { ok: false, reason: "no session" };
  const state = loadState();
  let item = resolveItem(state, session, { rekey: true });
  if (!item) {
    item = newItem(session);
    state.items[session.sessionId] = item;
    invalidateItemIndex(state);
  }
  item.attempts.push({
    at: now,
    score: typeof score === "number" ? score : null,
    wordCount: session.wordCount,
    duration: session.duration,
    wpm: session.wpm,
    ...(skipped ? { skipped: true } : {}),
  });
  applyAttemptSchedule(item, typeof score === "number" ? score : null, now);
  saveState(state);
  return {
    ok: true,
    attempts: item.attempts.length,
    reps: item.reps,
    intervalDays: item.intervalDays,
    dueAt: item.dueAt,
    retired: item.retired,
  };
}

function getProgress({ now = Date.now() } = {}) {
  const all = getAllSessionsDetailed();
  const state = loadState();
  let unseen = 0, retired = 0, due = 0, seen = 0;
  for (const s of all) {
    const it = resolveItem(state, s);
    if (!it) { unseen++; continue; }
    seen++;
    if (it.retired) { retired++; continue; }
    if ((it.dueAt || 0) <= now) due++;
  }
  const scored = [];
  for (const it of Object.values(state.items)) {
    for (const a of it.attempts) if (typeof a.score === "number") scored.push(a);
  }
  scored.sort((a, b) => b.at - a.at);
  return {
    total: all.length,
    seen,
    unseen,
    retired,
    due,
    // Kept for the older client contract, which read `remaining` as "not done".
    remaining: unseen,
    attempts: scored.length,
    recentScores: scored.slice(0, TUNING.ROLLING_WINDOW).map((a) => a.score),
    learnerMean: rollingMean(state, TUNING.ROLLING_WINDOW),
  };
}

// ---------------------------------------------------------------------------
// Grading — normalisation
// ---------------------------------------------------------------------------

const ONES = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};
const SCALES = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };
const ORDINAL_WORDS = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
  twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50, hundredth: 100,
  thousandth: 1e3, millionth: 1e6,
};

// 's that is "is"/"has"/"us", not a possessive. These must stay distinct from
// their apostrophe-less homophones — that distinction is the whole point.
const S_CONTRACTIONS = new Set([
  "it", "he", "she", "that", "this", "there", "here", "what", "who", "where",
  "when", "why", "how", "let", "one", "someone", "everyone", "somebody",
  "everybody", "nobody", "something", "everything", "nothing", "anything",
]);

// Expansions collapse INTO the contraction on both sides, so writing the long
// form is free (it proves the short form was decoded) while the homophone
// confusion it exists to catch still scores as an error.
const EXPANSIONS = new Map(Object.entries({
  "it is": "it's", "it has": "it's", "he is": "he's", "she is": "she's",
  "that is": "that's", "there is": "there's", "what is": "what's",
  "who is": "who's", "here is": "here's", "let us": "let's",
  "we are": "we're", "they are": "they're", "you are": "you're",
  "i am": "i'm", "i have": "i've", "we have": "we've", "they have": "they've",
  "you have": "you've", "i will": "i'll", "we will": "we'll",
  "they will": "they'll", "you will": "you'll", "he will": "he'll",
  "she will": "she'll", "it will": "it'll", "i would": "i'd", "we would": "we'd",
  "they would": "they'd", "you would": "you'd", "he would": "he'd",
  "she would": "she'd", "do not": "don't", "does not": "doesn't",
  "did not": "didn't", "is not": "isn't", "are not": "aren't",
  "was not": "wasn't", "were not": "weren't", "has not": "hasn't",
  "have not": "haven't", "had not": "hadn't", "will not": "won't",
  "would not": "wouldn't", "could not": "couldn't", "should not": "shouldn't",
  "can not": "can't", "cannot": "can't", "must not": "mustn't",
}));

function preNormalize(text) {
  let s = String(text || "").toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"');

  // Legacy transcriber spacing artefacts (CrisperWhisper): "U .S.", "$2 .5 billion", "2 ,000",
  // "small -town". The transcriber emits a space before the punctuation it
  // inserts, which would otherwise split one number into several tokens and
  // inflate the reference length the WER denominator uses.
  s = s.replace(/(\d)\s+\.\s*(\d)/g, "$1.$2");
  s = s.replace(/(\d)\s+,\s*(\d)/g, "$1,$2");
  s = s.replace(/([a-z])\s+-\s*([a-z])/g, "$1-$2");
  s = s.replace(/\b([a-z])\s*\.\s*([a-z])\s*\./g, "$1$2");   // u .s. -> us

  // Currency and percent, reordered into the form the spoken version uses:
  // "$30 million" -> "30 million dollars", "61%" -> "61 percent".
  s = s.replace(
    /\$\s*([\d.,]+)(\s+(?:hundred|thousand|million|billion|trillion))?/g,
    (_, num, scale) => `${num}${scale || ""} dollars`,
  );
  s = s.replace(/([\d.,]+)\s*%/g, "$1 percent");
  return s;
}

const TOKEN_RE = /\d[\d,]*(?:\.\d+)?(?:st|nd|rd|th)?|[\p{L}]+(?:'[\p{L}]+)*(?:-[\p{L}]+)*/gu;

function numToken(value, ordinal) {
  return `#${value}${ordinal ? "o" : ""}`;
}

/**
 * Collapse a run of number words starting at i into a single value.
 *
 * Each group below a thousand is at most [hundreds][tens][ones], so a ones word
 * cannot follow another ones word: "one two three four" is four numbers, not
 * ten. Without that rule a spoken digit sequence collapses into one token and a
 * single missing digit scores as a total miss.
 *
 * Known limitation: a spoken year said in halves ("twenty twenty-four") reads as
 * two numbers and will not match the digits "2024". Disambiguating that from a
 * genuine "20, 24" needs context this function does not have; it does not occur
 * in the current corpus.
 */
function readNumberRun(toks, i) {
  let total = 0, cur = 0, used = 0, ordinal = false, any = false;
  let haveOnes = false, haveTens = false;

  while (i + used < toks.length) {
    const t = toks[i + used];

    if (ONES[t] != null) {
      if (haveOnes) break;                       // second bare ones word: new number
      if (haveTens && ONES[t] > 9) break;        // "twenty fifteen" is not a number
      cur += ONES[t]; haveOnes = true; used++; any = true; continue;
    }
    if (TENS[t] != null) {
      if (haveTens || haveOnes) break;
      cur += TENS[t]; haveTens = true; used++; any = true; continue;
    }
    if (ORDINAL_WORDS[t] != null) {
      const v = ORDINAL_WORDS[t];
      // English compounds an ordinal only onto a tens or scale word ("twenty
      // first"), never onto a bare ones word. Without this guard "one second"
      // reads as #3o and "10 first responders" stops matching "ten first
      // responders", because the digits path never merges the two.
      if (v < 100 && haveOnes) break;
      if (v >= 100) cur = (cur || 1) * v; else cur += v;
      used++; any = true; ordinal = true;
      break;
    }
    if (SCALES[t] != null) {
      if (!any) break;
      if (SCALES[t] === 100) cur = (cur || 1) * 100;
      else { total += (cur || 1) * SCALES[t]; cur = 0; }
      haveOnes = false; haveTens = false; used++; continue;
    }
    if (t === "and" && any) {
      // Only swallow "and" when the word after it would actually join this
      // number ("two hundred and five"). In "twenty and thirty" the loop would
      // eat the conjunction and then break on "thirty" anyway, dropping a token
      // the digits path ("20 and 30") keeps — an asymmetry that costs the
      // learner an error for writing the numbers out.
      const nxt = toks[i + used + 1];
      const joins = nxt && (
        (ONES[nxt] != null && !haveOnes && !(haveTens && ONES[nxt] > 9)) ||
        (TENS[nxt] != null && !haveTens && !haveOnes)
      );
      if (joins) { used++; continue; }
    }
    break;
  }
  if (!any) return null;

  let value = total + cur;

  // "two point five" — decimal digits read one at a time after "point".
  if (!ordinal && toks[i + used] === "point") {
    let k = i + used + 1, digits = "";
    while (k < toks.length && ONES[toks[k]] != null && ONES[toks[k]] < 10) {
      digits += String(ONES[toks[k]]); k++;
    }
    if (digits) { value = Number(`${value}.${digits}`); used = k - i; }
  }

  // A scale word may follow the decimal: "two point five billion".
  const after = toks[i + used];
  if (!ordinal && after && SCALES[after] != null && SCALES[after] > 100) {
    value *= SCALES[after];
    used++;
  }

  return { value, used, ordinal };
}

/**
 * Tokenise for scoring.
 *
 * Case and punctuation are ignored; apostrophes are NOT — a contraction stays a
 * single token distinct from its homophone. Numbers, currency and percent are
 * canonicalised so the digits the ASR emits and the words the learner heard
 * compare equal.
 */
function normalizeWords(text) {
  const raw = preNormalize(text).match(TOKEN_RE) || [];

  // Split hyphenated compounds — "small-town" == "small town" either way round.
  const toks = [];
  for (const t of raw) {
    if (t.includes("-")) toks.push(...t.split("-").filter(Boolean));
    else toks.push(t);
  }

  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];

    // Digits, with optional ordinal suffix.
    const digits = /^(\d[\d,]*(?:\.\d+)?)(st|nd|rd|th)?$/.exec(t);
    if (digits) {
      const value = Number(digits[1].replace(/,/g, ""));
      if (isFinite(value)) {
        // A bare digit run may be followed by a spoken scale word: "30 million".
        const nxt = toks[i + 1];
        if (!digits[2] && nxt && SCALES[nxt] != null && SCALES[nxt] > 100) {
          out.push(numToken(value * SCALES[nxt], false));
          i++;
          continue;
        }
        out.push(numToken(value, !!digits[2]));
        continue;
      }
    }

    // Spelled-out numbers.
    if (ONES[t] != null || TENS[t] != null || SCALES[t] != null || ORDINAL_WORDS[t] != null) {
      const run = readNumberRun(toks, i);
      if (run && run.used > 0) {
        out.push(numToken(run.value, run.ordinal));
        i += run.used - 1;
        continue;
      }
    }

    // Possessive 's on an ordinary noun is inaudible — fold it. On the pronoun
    // contractions it is "is"/"has", so it stays.
    const poss = /^(.+)'s$/.exec(t);
    if (poss && !S_CONTRACTIONS.has(poss[1])) { out.push(poss[1] + "s"); continue; }

    out.push(t);
  }

  // Collapse expansions to contractions.
  //
  // Overlapping pairs have to be resolved in favour of the negation. In "they
  // have not", both "they have" and "have not" are expansion keys; taking the
  // leftmost yields ["they've", "not"] while the reference holds ["they",
  // "haven't"], so writing the long form of a negated contraction scored as TWO
  // errors — the exact opposite of the rule that expansions are free.
  const collapsed = [];
  for (let i = 0; i < out.length; i++) {
    const two = i + 1 < out.length ? `${out[i]} ${out[i + 1]}` : null;
    const next2 = i + 2 < out.length ? `${out[i + 1]} ${out[i + 2]}` : null;
    if (two && EXPANSIONS.has(two) && !(next2 && out[i + 2] === "not" && EXPANSIONS.has(next2))) {
      collapsed.push(EXPANSIONS.get(two));
      i++;
      continue;
    }
    const one = EXPANSIONS.get(out[i]);
    collapsed.push(one || out[i]);
  }
  return collapsed;
}

// ---------------------------------------------------------------------------
// Grading — alignment
// ---------------------------------------------------------------------------

function levenshteinWords(refTokens, hypTokens) {
  const n = refTokens.length;
  const m = hypTokens.length;

  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  const bt = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));

  for (let i = 0; i <= n; i++) { dp[i][0] = i; if (i > 0) bt[i][0] = "D"; }
  for (let j = 0; j <= m; j++) { dp[0][j] = j; if (j > 0) bt[0][j] = "I"; }
  bt[0][0] = null;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = refTokens[i - 1] === hypTokens[j - 1] ? 0 : 1;
      const sub = dp[i - 1][j - 1] + cost;
      const del = dp[i - 1][j] + 1;
      const ins = dp[i][j - 1] + 1;
      // Strict < on the alternatives keeps the diagonal on a tie, which is what
      // the "prefer C/S over D/I" intent needs: a substitution reads as one
      // error against one word, where D+I reads as two against two.
      let best = sub, op = cost === 0 ? "C" : "S";
      if (del < best) { best = del; op = "D"; }
      if (ins < best) { best = ins; op = "I"; }
      dp[i][j] = best;
      bt[i][j] = op;
    }
  }

  let i = n, j = m;
  const ops = [];
  let S = 0, D = 0, I = 0, C = 0;
  while (i > 0 || j > 0) {
    const op = bt[i][j];
    if (op === "C") { C++; ops.push({ op: "C", ref: refTokens[i - 1], hyp: hypTokens[j - 1] }); i--; j--; }
    else if (op === "S") { S++; ops.push({ op: "S", ref: refTokens[i - 1], hyp: hypTokens[j - 1] }); i--; j--; }
    else if (op === "D") { D++; ops.push({ op: "D", ref: refTokens[i - 1], hyp: null }); i--; }
    else if (op === "I") { I++; ops.push({ op: "I", ref: null, hyp: hypTokens[j - 1] }); j--; }
    else break;
  }
  ops.reverse();

  const dist = dp[n][m];
  const wer = n === 0 ? (m === 0 ? 0 : 1) : dist / n;
  const accuracy = Math.max(0, 1 - wer);
  return { refTokens, hypTokens, n, m, S, D, I, C, dist, wer, accuracy, score: Math.round(accuracy * 100), ops };
}

function gradeDictation(reference, hypothesis) {
  return levenshteinWords(normalizeWords(reference), normalizeWords(hypothesis));
}

// Everything else in this module is internal to the pipeline: the two
// functions server.js consumes from the scheduling side, plus the corpus
// lookups its routes need.
module.exports = {
  getProgress,
  pickNextSession,
  recordAttempt,
  getSessionWords,
  getSessionById,
  getSessionContext,
  gradeDictation,
};
