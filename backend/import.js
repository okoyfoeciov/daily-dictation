"use strict";

// Bring a media file into the library, or create a bare "collection" entry
// to group segments under. Used as a library by backend/pbs-sync.js, which
// imports segments programmatically — collections can nest (a "day"
// collection's parentId points at a "show" collection), since nothing here
// or in db.js/server.js assumes only one level.
//
// importMedia() copies the source into library/<type>s/<slug>/ (the
// original is never moved or deleted), registers it in the DB, then
// transcribes it once — verbatim via ai-service (see backend/transcribe.js)
// — and stores the transcript alongside the file.
//
// The transcription itself goes through transcribeEntry(), the one path shared
// with pbs-sync's repair pass. It sends one random short clip per segment
// (backend/clip.js), shifts the result back to file time, trims it to whole
// sentences, and keeps the attempt/give-up bookkeeping and the paid-audio log
// (library/stt-usage.jsonl) in one place.

const fs = require("fs");
const os = require("os");
const path = require("path");
const db = require("./db");
const paths = require("./paths");
const clip = require("./clip");
const { transcribeVerbatim } = require("./transcribe");

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "untitled";
}

// A bare "collection" entry — no media file of its own, just a title, to
// group segments (or nested collections) imported separately with a
// matching parentId.
async function createCollection({ title, id, parentId } = {}) {
  if (!title) throw new Error("createCollection: title is required");
  if (parentId && !db.getEntry(parentId)) {
    throw new Error(`Parent entry "${parentId}" not found — create it first.`);
  }
  const slug = id || slugify(title);
  const destDir = path.join(db.LIBRARY_DIR, "collections", slug);
  fs.mkdirSync(destDir, { recursive: true });
  return db.upsertEntry({
    id: slug,
    type: "collection",
    title,
    dir: destDir,
    ...(parentId ? { parentId } : {}),
  });
}

// Append one line per HTTP request to ai-service. A log failure must never stop
// a sync, hence the empty catch.
function logUsage(line) {
  try {
    fs.appendFileSync(
      path.join(paths.getLibraryDir(), "stt-usage.jsonl"),
      JSON.stringify(line) + "\n",
    );
  } catch { /* read-only library or full disk: not worth failing the import */ }
}

// The "YYYY-MM-DD" editorial day that decides clip length: passed by the
// importer, or read back from the entry's day collection id on a repair.
function dateIdOf(entry, dateId) {
  return dateId || String(entry.parentId || "").slice(-10);
}

/**
 * Transcribe one entry through the random-clip pipeline.
 *
 * Steps: walk the mp3 frames; reuse the saved sttClip or choose a new window
 * and persist it before the call; send only those frames; shift the result to
 * file time; trim to whole sentences; write transcript.json with `clip`.
 *
 * Bookkeeping (Change 2):
 *   sttAttempts  +1 before each sync-level try; undone for a free failure
 *                (ai-service down); removed on success.
 *   sttGaveUp    set on a permanent failure or at the third attempt; removed
 *                on success. A given-up entry returns normally, because the
 *                day can still have good segments and must be prunable.
 *
 * A permanent or capacity failure is therefore not thrown; a retryable one is,
 * so the caller reports the run as failed and keeps the older day.
 */
async function transcribeEntry(entry, { purpose = "import", dateId = null, onProgress = () => {} } = {}) {
  const transcriptPath = entry.transcriptPath || path.join(entry.dir, "transcript.json");
  db.upsertEntry({ id: entry.id, transcriptStatus: "processing", transcriptPath });

  let tmpDir = null;
  try {
    const buf = fs.readFileSync(entry.filePath);
    const walk = clip.walkFrames(buf);
    if (!walk.ok) {
      console.warn(`pbs-sync: giving up on "${entry.id}": clip_unsupported (${walk.reason})`);
      db.upsertEntry({
        id: entry.id,
        transcriptStatus: "error",
        transcriptPath,
        sttGaveUp: true,
        sttGiveUpReason: "clip_unsupported",
      });
      return db.getEntry(entry.id);
    }

    let c = entry.sttClip;
    if (
      !c ||
      !Number.isInteger(c.k0) || !Number.isInteger(c.k1) || c.k0 < 0 || c.k1 <= c.k0 || c.k1 > walk.frames ||
      !Number.isFinite(c.start) || !Number.isFinite(c.end)
    ) {
      const clipSeconds = clip.clipSecondsForDate(dateIdOf(entry, dateId));
      c = clip.chooseWindow(walk.frames, walk.frameSeconds, clipSeconds);
      // Persisted before the call: an interrupted or failed call must re-send
      // the same bytes, never a freshly drawn window.
      db.upsertEntry({ id: entry.id, sttClip: { k0: c.k0, k1: c.k1, start: c.start, end: c.end } });
    }

    const bytes = c.k0 === 0 && c.k1 === walk.frames
      ? buf
      : clip.sliceClip(buf, walk, c);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dd-clip-"));
    const tempPath = path.join(tmpDir, `${entry.id}__${c.start.toFixed(3)}__${c.end.toFixed(3)}.mp3`);
    fs.writeFileSync(tempPath, bytes);

    const attempt = (Number(entry.sttAttempts) || 0) + 1;
    db.upsertEntry({ id: entry.id, sttAttempts: attempt });

    let tryNo = 0;
    const onTry = ({ status, error, ms }) => {
      tryNo++;
      logUsage({
        at: new Date().toISOString(),
        entryId: entry.id,
        purpose,
        attempt,
        try: tryNo,
        clipStart: c.start,
        clipEnd: c.end,
        seconds: (c.k1 - c.k0) * walk.frameSeconds,
        bytes: bytes.length,
        status: status == null ? null : status,
        error: error == null ? null : error,
        ms,
      });
    };

    console.log(`Starting transcription (${purpose}, ${(c.k1 - c.k0) * walk.frameSeconds} s clip)...`);
    const raw = await transcribeVerbatim(tempPath, { onProgress, onTry });

    const shifted = clip.shiftTranscript(raw, c.start);
    const words = clip.trimWords(shifted.words, {
      start: c.start,
      end: c.end,
      trimStart: c.k0 > 0,
      trimEnd: c.k1 < walk.frames,
    });
    const transcript = { lines: shifted.lines, words, clip: { start: c.start, end: c.end } };
    fs.writeFileSync(transcriptPath, JSON.stringify(transcript));
    console.log(`Transcript ready: ${transcriptPath} (${words.length} words)`);
    return db.upsertEntry({
      id: entry.id,
      transcriptStatus: "ready",
      transcriptPath,
      sttAttempts: undefined,
      sttGaveUp: undefined,
      sttGiveUpReason: undefined,
    });
  } catch (err) {
    const current = db.getEntry(entry.id) || entry;

    if (err && err.free) {
      // ai-service was down: no Azure call, no attempt consumed.
      db.upsertEntry({
        id: entry.id,
        transcriptStatus: "error",
        transcriptPath,
        sttAttempts: Math.max(0, (Number(current.sttAttempts) || 0) - 1),
      });
      throw err;
    }

    const attempt = Number(current.sttAttempts) || 1;
    const permanent = !!(err && err.permanent);
    if (permanent || attempt >= 3) {
      const reason = permanent ? (err.permanentReason || err.message) : "attempts=3";
      console.warn(`pbs-sync: giving up on "${entry.id}": ${reason}`);
      db.upsertEntry({
        id: entry.id,
        transcriptStatus: "error",
        transcriptPath,
        sttGaveUp: true,
        sttGiveUpReason: reason,
      });
      return db.getEntry(entry.id);
    }

    db.upsertEntry({ id: entry.id, transcriptStatus: "error", transcriptPath });
    throw err;
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function importMedia({ sourcePath, type, title, id, parentId, dateId } = {}) {
  if (!sourcePath || !["movie", "audio", "podcast"].includes(type) || !title) {
    throw new Error("importMedia requires sourcePath, type (movie|audio|podcast), and title");
  }
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source file not found: ${sourcePath}`);
  }
  if (parentId && !db.getEntry(parentId)) {
    throw new Error(`Parent entry "${parentId}" not found — create it first.`);
  }

  const slug = id || slugify(title);
  const destDir = path.join(db.LIBRARY_DIR, `${type}s`, slug);
  fs.mkdirSync(destDir, { recursive: true });

  const filename = path.basename(sourcePath);
  const destPath = path.join(destDir, filename);

  console.log(`Copying "${filename}" into ${destPath} ...`);
  fs.copyFileSync(sourcePath, destPath);

  const entry = db.upsertEntry({
    id: slug,
    type,
    title,
    filePath: destPath,
    dir: destDir,
    transcriptStatus: "pending",
    ...(parentId ? { parentId } : {}),
  });
  console.log(`Registered entry "${entry.id}".`);

  return transcribeEntry(entry, {
    purpose: "import",
    dateId,
    onProgress: (msg) => console.log(`  [transcribe] ${msg}`),
  });
}

module.exports = { importMedia, createCollection, transcribeEntry, slugify };
