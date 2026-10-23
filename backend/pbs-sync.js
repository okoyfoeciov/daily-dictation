"use strict";

// Catch-up sync: pulls new episodes from each audio source in backend/sources.js
// (PBS NewsHour segments) into the library, grouped under one collection per
// show and then by day.
//
// Called by the embedded backend (backend/server.js) on app launch and every
// few hours while the app runs; also runnable standalone for debugging:
//
//   node backend/pbs-sync.js [--dry-run] [--limit=N] [--source=id[,id]]
//
// Source: each show's own podcast RSS. It is the authoritative list of what is
// a real episode (title + publish date) and every item carries a direct audio
// download link (the podcast file). Dictation only ever plays audio, so the
// RSS audio is the whole pipeline — no YouTube, no yt-dlp, no matching
// against a video feed that only carries the last ~15 uploads.
//
// Missing =an RSS item, from the newest weekday broadcast day only (KEEP_DAYS),
// with no library entry under the same normalized title (or sourceId). A day is
// the whole episode with all its segments. On a weekend, or before today's
// episode is out, the newest weekday in the feed is the last one aired, so
// Saturday and Sunday keep Friday's. Broken transcripts (interrupted writes,
// failed jobs) are re-transcribed from their media file in the same pass.
// Days beyond KEEP_DAYS, and weekend days, are pruned (entries + files).
//
// STT is paid by the second, so each segment is sent as one random short clip
// (50 s for a Monday–Thursday episode, 100 s for Friday's), not whole; see
// backend/clip.js. The clip is saved on the entry before the call, and a repair
// re-sends exactly the same bytes. An entry gets three attempts: a failure that
// cannot succeed (Azure's "no transcript", or a 4xx other than 401/403/408/429)
// gives up after one, and an ai-service that is not running is free and does not
// count. `sttGaveUp` stops the repair pass from paying again; every HTTP
// request is appended to library/stt-usage.jsonl by backend/import.js.
//
// Single-flight: a heartbeat lock in the library directory keeps a manual
// CLI run and the app's own check from overlapping.

const fs = require("fs");
const os = require("os");
const path = require("path");
const db = require("./db");
const paths = require("./paths");
const { importMedia, createCollection, transcribeEntry, slugify } = require("./import");
const { SOURCES, sourceOf } = require("./sources");

// How many weekday broadcast days of episodes to keep, per source: the newest
// one. Saturday and Sunday are not broadcast days here, so over a weekend the
// newest is Friday.
//
// This number is coupled to the dictation scheduler (backend/dictation.js's
// applyAttemptSchedule). Dictation items are keyed to these entries, so
// pruning a day deletes the sessions cut from it and orphans every attempt
// logged against them.
//
// An item retires after three spaced passes, at SM-2 intervals of 1 then 6 days,
// so the fastest possible path from first exposure to retirement is 7 days. With
// one day kept that path is closed: the 20-minute requeue after a failed
// attempt works, and so can the 1-day review if the next episode is not out yet,
// but the 6-day one never does — its session is pruned when the next episode
// lands. So nothing retires, and the history of an unfinished item goes with its
// session. What it buys is a small backlog (one episode, so a first run
// transcribes only that) and every session being fresh news. A mastered item
// never needs its audio again, so no permanent archive is kept.
const KEEP_DAYS = 1;

// A run heartbeats the lock before every item; a lock whose owner is gone, or
// that is older than this, belongs to a dead run and can be taken over.
const LOCK_STALE_MS = 15 * 60 * 1000;

const RSS_TIMEOUT_MS = 30 * 1000;
const ENCLOSURE_TIMEOUT_MS = 120 * 1000;

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(RSS_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'");
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  if (!m) return null;
  let text = m[1].trim();
  const cdata = text.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) text = cdata[1];
  return decodeEntities(text.trim());
}

// A podcast RSS 2.0 feed: title + pubDate + audio enclosure per <item>. The
// enclosure is the episode's own audio, which is all dictation needs.
function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const title = extractTag(block, "title");
    const pubDate = extractTag(block, "pubDate");
    const guid = extractTag(block, "guid") || "";
    const encTag = (block.match(/<enclosure\b[^>]*>/) || [""])[0];
    const encUrl = encTag.match(/\burl="([^"]+)"/);
    if (title && pubDate) {
      items.push({
        title,
        pubDate,
        guid,
        enclosure: encUrl ? decodeEntities(encUrl[1]) : "",
      });
    }
  }
  return items;
}

function normalizeTitle(t) {
  return t
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Groups by the RSS item's own pubDate (the show's editorial day), not by when
// we fetched it, so an episode lands under the broadcast day it belongs to. Both
// dateId and title are derived from the same calendar day in the source's own
// time zone (sources.js dayTz) — forcing it on the title too, not just the id,
// keeps them from disagreeing on a machine whose local timezone is far from it.
function dayInfoFromPubDate(pubDate, tz = "UTC") {
  const d = new Date(pubDate);
  if (isNaN(d.getTime())) return null;
  // en-CA formats a date as YYYY-MM-DD.
  const dateId = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const title = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: tz });
  return { dateId, title };
}

// Downloads the episode audio to a fresh temp dir (caller must remove it) and
// returns the path to the file.
async function downloadEnclosure(item) {
  const res = await fetch(item.enclosure, { signal: AbortSignal.timeout(ENCLOSURE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET enclosure -> HTTP ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/html")) throw new Error("enclosure returned an HTML page, not audio");
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error("enclosure came back empty");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pbs-sync-"));
  const filePath = path.join(tmpDir, `${slugify(item.entryTitle)}.mp3`);
  fs.writeFileSync(filePath, buf);
  return { dir: tmpDir, filePath };
}

// Monday to Friday, for a "YYYY-MM-DD" day id. Read from the date string itself
// rather than a local-time Date, so it is the broadcast day's own weekday on a
// machine in any time zone.
function isWeekday(dateId) {
  const dow = new Date(`${dateId}T12:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
}

// Day ids are "<show id>-YYYY-MM-DD", which sorts correctly as plain strings —
// no separate stored date field needed. Keeps the newest KEEP_DAYS weekday days
// of that show; every other day goes, a weekend day left by an older library
// included (it would otherwise outrank Friday). A child collection whose id has
// no date is not a day and is left alone. Returns how many days of that show
// were pruned.
function pruneOldDays(showId) {
  let pruned = 0;
  const days = db.listChildren(showId)
    .filter((e) => e.type === "collection" && /-\d{4}-\d{2}-\d{2}$/.test(e.id))
    .sort((a, b) => b.id.localeCompare(a.id));
  const keep = new Set(days.filter((e) => isWeekday(e.id.slice(-10))).slice(0, KEEP_DAYS).map((e) => e.id));
  // The older days are the only usable material until a kept day has a readable
  // transcript of its own. With none (a transcription outage, a day of nothing
  // but errors) they stay, and a later run prunes them once the repair pass has
  // made the kept day usable.
  if (![...keep].some((id) => db.listChildren(id).some(transcriptIsReadable))) return 0;
  for (const day of days.filter((e) => !keep.has(e.id))) {
    for (const seg of db.listChildren(day.id)) {
      if (seg.dir) fs.rmSync(seg.dir, { recursive: true, force: true });
      db.deleteEntry(seg.id);
    }
    if (day.dir) fs.rmSync(day.dir, { recursive: true, force: true });
    db.deleteEntry(day.id);
    console.log(`Pruned old day "${day.id}" (${day.title}).`);
    pruned++;
  }
  return pruned;
}

// --- single-flight lock -----------------------------------------------------

function lockPath() {
  return path.join(paths.getLibraryDir(), ".pbs-sync.lock");
}

function acquireLock() {
  const p = lockPath();
  try {
    const st = fs.statSync(p);
    const pid = Number(fs.readFileSync(p, "utf8")) || 0;
    let alive = false;
    if (pid) { try { process.kill(pid, 0); alive = true; } catch { /* owner is gone */ } }
    if (alive && Date.now() - st.mtimeMs < LOCK_STALE_MS) return false;
  } catch { /* no lock held */ }
  try { fs.writeFileSync(p, String(process.pid)); } catch { /* unwritable: proceed without */ }
  return true;
}

function heartbeatLock() {
  try {
    const now = new Date();
    fs.utimesSync(lockPath(), now, now);
  } catch { /* lock gone; nothing to keep alive */ }
}

function releaseLock() {
  try {
    if (fs.readFileSync(lockPath(), "utf8") === String(process.pid)) {
      fs.rmSync(lockPath(), { force: true });
    }
  } catch { /* already gone */ }
}

// --- transcript health ------------------------------------------------------

// Ready means the file parses and carries lines. A crash can leave the
// metadata saying "ready" over a zero-filled or truncated file, which is
// exactly what the repair pass is for.
function transcriptIsReadable(entry) {
  if (entry.transcriptStatus !== "ready" || !entry.transcriptPath) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(entry.transcriptPath, "utf8"));
    return Array.isArray(parsed.lines) && parsed.lines.length > 0;
  } catch {
    return false;
  }
}

async function repairEntry(entry) {
  return transcribeEntry(entry, {
    purpose: "repair",
    onProgress: (msg) => console.log(`  [repair ${entry.id}] ${msg}`),
  });
}

// The day collection is created only once the download has succeeded: an empty
// day left behind by a failed download would still count toward KEEP_DAYS and
// push a good day out of the library.
async function importOne(item) {
  const { src, day } = item;
  const dayId = `${src.id}-${day.dateId}`;
  const { dir, filePath } = await downloadEnclosure(item);
  try {
    if (!db.getEntry(dayId)) {
      await createCollection({ title: day.title, id: dayId, parentId: src.id });
      console.log(`Created day entry "${dayId}".`);
    }
    const entry = await importMedia({
      sourcePath: filePath,
      type: "audio",
      title: item.entryTitle,
      parentId: dayId,
      dateId: day.dateId,
    });
    db.upsertEntry({ id: entry.id, sourceId: item.guid || item.enclosure });
    console.log(`Imported "${item.entryTitle}" as "${entry.id}".`);
    return entry;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// sync()
//
// Returns { locked, missing, repairs, imported, repaired, failed, feedFailures,
// pruned }; feedFailures counts the sources whose feed could not be read (also
// in failed). If every feed fails the run throws instead.
// onProgress receives { phase, current, total, title } with phases "fetch",
// "importing", "repairing", "prune", "done". `sources` limits the run to those
// source ids (default: all of backend/sources.js).
// ---------------------------------------------------------------------------
async function sync({ onProgress = () => {}, dryRun = false, limit = Infinity, sources: onlyIds = null } = {}) {
  const report = (p) => {
    heartbeatLock();
    try { onProgress(p); } catch { /* a broken listener must not stop the run */ }
  };

  const wanted = onlyIds && onlyIds.length ? SOURCES.filter((s) => onlyIds.includes(s.id)) : SOURCES;
  if (!wanted.length) throw new Error(`pbs-sync: unknown source(s): ${onlyIds.join(", ")}`);

  if (!dryRun && !acquireLock()) {
    console.log("pbs-sync: another run is already in progress — skipping.");
    return { locked: true, missing: 0, repairs: 0, imported: 0, repaired: 0, failed: 0, feedFailures: 0, pruned: 0 };
  }

  try {
    report({ phase: "fetch" });

    const known = new Set();
    const titles = new Set();
    const allEntries = db.listEntries();
    const byId = new Map(allEntries.map((e) => [e.id, e]));
    for (const e of allEntries) {
      if (e.sourceId) known.add(e.sourceId);
      if (e.type !== "collection") titles.add(normalizeTitle(e.title || ""));
    }

    const missing = [];
    // One source's feed being down must not stop the others.
    let feedFailures = 0;
    let firstFeedError = null;
    for (const src of wanted) {
      console.log(`Fetching ${src.title} RSS...`);
      let rss;
      try {
        rss = parseRssItems(await fetchText(src.rssUrl));
      } catch (err) {
        feedFailures++;
        firstFeedError = firstFeedError || err;
        console.error(`  ${src.title}: could not read the feed: ${err.message}`);
        continue;
      }
      console.log(`  ${rss.length} item(s) in the ${src.title} RSS.`);
      // The wanted day is the newest weekday in the feed — today's episode once
      // it is out, otherwise the last one aired (Friday's all weekend). It is
      // picked first and then each item tested against it, because a day is
      // several items (PBS publishes an episode as separate segments).
      const candidates = [];
      for (const it of rss) {
        if (!it.enclosure || !src.keep(it)) continue;
        const day = dayInfoFromPubDate(it.pubDate, src.dayTz);
        if (day && isWeekday(day.dateId)) candidates.push({ it, day });
      }
      const wantedDays = new Set([...new Set(candidates.map((c) => c.day.dateId))].sort().reverse().slice(0, KEEP_DAYS));
      for (const { it, day } of candidates) {
        if (!wantedDays.has(day.dateId)) continue;   // older than we keep: never refetch
        const entryTitle = src.entryTitle(it, day);
        if (known.has(it.guid) || known.has(it.enclosure) || titles.has(normalizeTitle(entryTitle))) continue;
        missing.push({ ...it, src, day, entryTitle, when: new Date(it.pubDate).getTime() });
      }
    }
    if (feedFailures === wanted.length) throw firstFeedError;   // nothing to work with
    missing.sort((a, b) => b.when - a.when);   // newest day first

    // A run limited to some sources repairs only their entries.
    const wantedIds = new Set(wanted.map((s) => s.id));
    const repairs = [];
    for (const e of allEntries) {
      if (e.type === "collection") continue;
      if (onlyIds) {
        const owner = sourceOf(e, byId);
        if (!owner || !wantedIds.has(owner.id)) continue;
      }
      if (transcriptIsReadable(e)) continue;
      if (e.sttGaveUp) {
        console.log(`pbs-sync: not re-sending "${e.id}": gave up (${e.sttGiveUpReason || "unknown"})`);
        continue;
      }
      if (e.filePath && fs.existsSync(e.filePath)) repairs.push(e);
      else console.warn(`pbs-sync: no media file for "${e.id}" — cannot repair.`);
    }

    console.log(`  ${missing.length} missing, ${repairs.length} to repair.`);

    if (dryRun) {
      for (const it of missing) console.log(`  would import "${it.entryTitle}" (${it.pubDate}) [${it.src.id}]`);
      for (const e of repairs) console.log(`  would repair "${e.id}"`);
      console.log("Dry run — nothing transcribed or written to the library.");
      return { locked: false, missing: missing.length, repairs: repairs.length, imported: 0, repaired: 0, failed: feedFailures, feedFailures, pruned: 0 };
    }

    for (const src of new Set(missing.map((m) => m.src))) {
      if (!db.getEntry(src.id)) {
        await createCollection({ title: src.title, id: src.id });
        console.log(`Created show entry "${src.id}".`);
      }
    }

    let imported = 0, repaired = 0, failed = feedFailures;
    // Sources whose newest day this run did not finish (an import failed, or
    // `limit` cut items off): the older day it would replace stays for now.
    const unfinished = new Set(missing.slice(limit).map((m) => m.src.id));
    const toImport = missing.slice(0, limit);
    for (let i = 0; i < toImport.length; i++) {
      // Two items can share a title (the feed re-issuing a broadcast under a new
      // guid). The first to import wins; a later one is tried only if the
      // earlier failed, and never overwrites an entry.
      if (titles.has(normalizeTitle(toImport[i].entryTitle))) continue;
      report({ phase: "importing", current: i + 1, total: toImport.length, title: toImport[i].entryTitle });
      try {
        await importOne(toImport[i]);
        imported++;
        titles.add(normalizeTitle(toImport[i].entryTitle));
      } catch (err) {
        failed++;
        unfinished.add(toImport[i].src.id);
        console.error(`  failed to import "${toImport[i].entryTitle}": ${err.message}`);
      }
    }

    for (let i = 0; i < repairs.length; i++) {
      report({ phase: "repairing", current: i + 1, total: repairs.length, title: repairs[i].title || repairs[i].id });
      try {
        const result = await repairEntry(repairs[i]);
        if (result && result.sttGaveUp) {
          console.log(`Gave up on "${repairs[i].id}" (${result.sttGiveUpReason || "unknown"}).`);
        } else {
          repaired++;
          console.log(`Repaired "${repairs[i].id}".`);
        }
      } catch (err) {
        failed++;
        console.error(`  failed to repair "${repairs[i].id}": ${err.message}`);
      }
    }

    report({ phase: "prune" });
    let pruned = 0;
    for (const src of wanted) {
      if (unfinished.has(src.id)) {
        console.log(`  ${src.title}: its newest day is not fully imported — keeping the older day for now.`);
        continue;
      }
      pruned += pruneOldDays(src.id);
    }
    report({ phase: "done", imported, repaired, failed, pruned });
    return { locked: false, missing: missing.length, repairs: repairs.length, imported, repaired, failed, feedFailures, pruned };
  } finally {
    if (!dryRun) releaseLock();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) || Infinity : Infinity;
  const sourceArg = args.find((a) => a.startsWith("--source="));
  const sources = sourceArg ? sourceArg.split("=")[1].split(",").filter(Boolean) : null;
  sync({ dryRun, limit, sources })
    .then((r) => console.log("sync result:", JSON.stringify(r)))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}

module.exports = { sync, KEEP_DAYS };
