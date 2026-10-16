"use strict";

// The dictation backend. Streams PBS segment media files (range-request
// capable, for seeking) for Daily Dictation playback, serves the dictation
// session/grading/scheduling API, runs the catch-up sync for new PBS segments
// (backend/pbs-sync.js), and proxies the explanation, pronunciation, credit,
// and mic-transcription calls through to ai-service. Embedded in the Electron app
// — main.js starts it in-process via start() before the window loads, so the
// app is a single local-only program with no separate backend process.
// Reached at the loopback URL app-base.js resolves.

const fs = require("fs");
const express = require("express");
const db = require("./db");
const paths = require("./paths");
const pbsSync = require("./pbs-sync");

const DEFAULT_PORT = Number(process.env.PORT) || 8768;
// ai-service's local server, which backs the explain/pron/credits/transcribe
// proxies below (word explanations, MW pronunciation badges, Groq mic clips).
const AI_SERVICE_BASE = "http://127.0.0.1:8770";
const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// The explain panel (word/phrase explanations, MW pronunciation badges,
// credit warnings) is shared by Daily Dictation's reference-word lookup, so
// those three routes are transparently proxied through to ai-service here. Raw
// body passthrough (not express.json()) so arbitrary request shapes forward
// untouched.
const EXPLAIN_PATHS = ["/api/explain", "/api/pron", "/api/credits"];
app.all(EXPLAIN_PATHS, express.raw({ type: () => true, limit: "10mb" }), async (req, res) => {
  try {
    const upstream = await fetch(`${AI_SERVICE_BASE}${req.originalUrl}`, {
      method: req.method,
      headers: req.get("Content-Type") ? { "Content-Type": req.get("Content-Type") } : {},
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("Content-Type", ct);
    res.send(buf);
  } catch {
    res.status(502).json({ error: "Could not reach the explain service." });
  }
});

// The floating microphone button's transcription call (mic.js) — a single
// short recording POSTed as a raw audio blob, proxied straight through to
// ai-service's own /api/transcribe (a one-shot short-clip endpoint, capped
// client-side at 60s). Raw body passthrough, same shape as the EXPLAIN_PATHS
// proxy above, sized for a ~60s opus clip (well under 1MB) with headroom.
app.post("/api/transcribe", express.raw({ type: () => true, limit: "20mb" }), async (req, res) => {
  try {
    const upstream = await fetch(`${AI_SERVICE_BASE}/api/transcribe`, {
      method: "POST",
      headers: req.get("Content-Type") ? { "Content-Type": req.get("Content-Type") } : {},
      body: req.body,
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("Content-Type", ct);
    res.send(buf);
  } catch {
    res.status(502).json({ error: "Could not reach the transcription service." });
  }
});

app.use(express.json());

// ---------------------------------------------------------------------------
// Dictation — daily dictation sessions from PBS NewsHour (audio-only, 1-2
// sentences per session, looped). See backend/dictation.js for the algorithm
// and WER definition.
// ---------------------------------------------------------------------------
const dictation = require("./dictation");

app.get("/api/dictation/stats", (req, res) => {
  try {
    // Counted with the same resolver pickNextSession uses, so the number shown
    // to the learner and the number governing selection cannot disagree. The
    // old version subtracted set size from pool size, which silently
    // undercounted once any completed id fell out of the pool.
    res.json(dictation.getProgress());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/dictation/session", (req, res) => {
  try {
    const pick = dictation.pickNextSession();
    if (!pick) return res.status(404).json({ error: "No dictation sessions available." });
    // An empty pool is a STATE, not an error: a learner who has mastered the
    // corpus must see their totals, not the same blank screen an unreachable
    // backend produces. 404 here erased the progress panel at exactly the moment
    // it was most worth showing.
    if (!pick.session) {
      return res.json({
        session: null,
        exhausted: true,
        stats: dictation.getProgress(),
      });
    }
    const s = pick.session;
    // Surrounding sessions' texts (same entry, one per side when they exist)
    // so a word lookup can send the LLM more than the current 1-2 sentences.
    // The client marks which span the click came from; never crossing entries.
    let contextBefore = "", contextAfter = "";
    try {
      const ctx = dictation.getSessionContext(s, 1);
      if (ctx) {
        contextBefore = String(ctx.before || "");
        contextAfter = String(ctx.after || "");
      }
    } catch {}
    res.json({
      sessionId: s.sessionId,
      entryId: s.entryId,
      entryTitle: s.entryTitle,
      start: s.start,
      end: s.end,
      duration: s.duration,
      wordCount: s.wordCount,
      wpm: s.wpm,
      // Per-word ASR timings for this segment, so the client can loop a phrase
      // inside it (right-click / right-drag on a reference word). [] when the
      // transcript can't be read — the client falls back to segment-only replay.
      words: dictation.getSessionWords(s),
      // Reference text is intentionally included so the client can display it
      // *after* checking — the grading itself is server-side on /api/dictation/check,
      // so a client that peeks early gains nothing.
      reference: s.text,
      contextBefore,
      contextAfter,
      exhausted: pick.exhausted,
      stats: {
        total: pick.total,
        remaining: pick.remaining,
        unseen: pick.unseen,
        due: pick.due,
        retired: pick.retired,
      },
    });
  } catch (e) {
    console.error("dictation session error", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/dictation/check", (req, res) => {
  const { sessionId, hypothesis } = req.body || {};
  if (!sessionId || typeof hypothesis !== "string") {
    return res.status(400).json({ error: "sessionId and hypothesis (string) required." });
  }
  try {
    const session = dictation.getSessionById(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found." });
    const reference = session.text;
    const result = dictation.gradeDictation(reference, hypothesis);
    res.json({
      sessionId,
      reference,
      hypothesis,
      score: result.score,
      wer: result.wer,
      accuracy: result.accuracy,
      n: result.n,
      S: result.S,
      D: result.D,
      I: result.I,
      C: result.C,
      dist: result.dist,
      refTokens: result.refTokens,
      hypTokens: result.hypTokens,
      ops: result.ops,
    });
  } catch (e) {
    console.error("dictation check error", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Records an attempt. Append-only, and NOT a retirement: a low score reschedules
// the item for ~20 minutes' time rather than burning it, and `skipped: true`
// (the learner pressed Next without checking) is logged without scheduling
// anything at all. The route it replaces marked a session done on every Next,
// which destroyed items from a finite pool at one keypress each.
app.post("/api/dictation/complete", (req, res) => {
  const { sessionId, score, skipped } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "sessionId required." });
  try {
    const session = dictation.getSessionById(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found." });
    const result = dictation.recordAttempt(
      session,
      typeof score === "number" ? score : null,
      { skipped: !!skipped },
    );
    res.json({ ...result, progress: dictation.getProgress() });
  } catch (e) {
    console.error("dictation complete error", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------------------------------------------------------------------
// Catch-up sync — the app checks for new PBS segments on launch and every few
// hours while it runs (see backend/pbs-sync.js). It runs in the background;
// the app's status line polls /api/sync/status.
// ---------------------------------------------------------------------------
const SYNC_START_DELAY_MS = 5 * 1000;
const SYNC_INTERVAL_MS = 3 * 60 * 60 * 1000;

let syncState = { state: "idle", at: 0 };
let syncRunning = false;
let syncStartTimer = null;
let syncIntervalTimer = null;

function publishSyncProgress(p) {
  if (p.phase === "fetch") {
    syncState = { ...syncState, state: "checking" };
  } else if (p.phase === "importing" || p.phase === "repairing") {
    syncState = { ...syncState, state: p.phase, current: p.current, total: p.total, title: p.title || "" };
  }
}

async function runSyncCheck() {
  if (syncRunning) return;
  syncRunning = true;
  syncState = { state: "checking", at: Date.now(), imported: 0, repaired: 0, failed: 0, current: 0, total: 0, title: "" };
  try {
    const r = await pbsSync.sync({ onProgress: publishSyncProgress });
    syncState = {
      state: r.locked ? "idle" : "done",
      at: Date.now(),
      imported: r.imported || 0,
      repaired: r.repaired || 0,
      failed: r.failed || 0,
      current: 0, total: 0, title: "",
    };
  } catch (e) {
    console.error("catch-up sync failed", e);
    syncState = { state: "error", at: Date.now(), error: String(e.message || e), imported: 0, repaired: 0, failed: 0, current: 0, total: 0, title: "" };
  } finally {
    syncRunning = false;
  }
}

app.get("/api/sync/status", (req, res) => res.json(syncState));

// Manual trigger — a forced check without waiting for the launch/interval one.
app.post("/api/sync/run", (req, res) => {
  runSyncCheck();
  res.json({ started: true });
});

// Media streaming for Daily Dictation playback. The dictation client loops a
// small window inside the PBS segment's file, served here with HTTP Range +
// conditional GET (via res.sendFile, which implements both), so seeking works.
app.get("/api/library/:id/stream", (req, res) => {
  const entry = db.getEntry(req.params.id);
  if (!entry || !entry.filePath || !fs.existsSync(entry.filePath)) return res.sendStatus(404);
  // res.sendFile (built on the `send` package) already implements HTTP
  // Range + conditional GET, so this is seekable media for free.
  res.sendFile(entry.filePath, (err) => {
    if (err && !res.headersSent) res.sendStatus(404);
  });
});

// In-process lifecycle for the Electron shell (main.js). Idempotent:
// a second start() with the same port is a no-op returning the live server.
// Rejects with EADDRINUSE if a foreign process holds the port (e.g. a stale
// standalone `node backend/server.js`), so the caller can report it instead
// of silently serving two backends.
let server = null;
let livePort = null;

function start({ port = DEFAULT_PORT, libraryDir = null } = {}) {
  if (libraryDir) paths.setLibraryDir(libraryDir);
  if (server && livePort === port) return Promise.resolve(server);
  return new Promise((resolve, reject) => {
    const s = app.listen(port, "127.0.0.1", () => {
      server = s;
      livePort = port;
      console.log(`daily-dictation backend listening on http://127.0.0.1:${port}`);
      // Catch-up check: shortly after boot, then on a timer while the app runs.
      clearTimeout(syncStartTimer);
      clearInterval(syncIntervalTimer);
      syncStartTimer = setTimeout(runSyncCheck, SYNC_START_DELAY_MS);
      syncIntervalTimer = setInterval(runSyncCheck, SYNC_INTERVAL_MS);
      resolve(s);
    });
    s.on("error", reject);
  });
}

function stop() {
  return new Promise((resolve) => {
    clearTimeout(syncStartTimer);
    clearInterval(syncIntervalTimer);
    syncStartTimer = null;
    syncIntervalTimer = null;
    if (!server) return resolve();
    const s = server;
    server = null;
    livePort = null;
    s.close(() => resolve());
  });
}

// Standalone CLI preserved for debugging: `node backend/server.js` /
// `npm run backend`. The Electron app path is start() from main.js.
if (require.main === module) {
  start().catch((err) => {
    console.error(`daily-dictation backend failed to listen: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { start, stop, DEFAULT_PORT };
