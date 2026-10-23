"use strict";

// Transcription client for the import pipeline, run once server-side at
// import time (backend/import.js, backend/pbs-sync.js) instead of once per
// playback session.
//
//   transcribeVerbatim() — verbatim transcript via ai-service's
//                          POST /api/transcribe-verbatim (127.0.0.1:8770 —
//                          Azure MAI-Transcribe-2 under the hood, word
//                          timestamps, verbatim), single-shot multipart POST,
//                          suited to PBS clips up to ~2 h / 300 MB. Used by
//                          pbs-sync, since the dictation checker scores against
//                          the verbatim reference.
//
// What is uploaded is one short random clip per segment (see backend/clip.js),
// not the whole segment, so a response's timings are in clip time and the
// caller shifts them back to file time.
//
// This app holds no Azure credentials at all: the key lives in ai-service's
// own ai-service.env and the model call happens over there. The response
// already carries this repo's shape { lines, words }, so what comes back is
// validated and returned as-is.
//
// Error bodies are ai-service's own shape ({error: "..."}), since nothing
// here renders to a browser. Failures are classified for the caller:
//   - `err.permanent` — no transcript, or an Azure 4xx that is not auth,
//     timeout or rate limiting. Retrying cannot succeed, so the entry gives up
//     at once instead of burning attempts.
//   - `err.free` — ai-service itself is not running (ECONNREFUSED), so Azure
//     was never called. The caller does not count this toward its 3-attempt
//     cap.
// Everything else (5xx, 401/403/408/429, unreachable Azure, unparseable JSON,
// timeouts) keeps the in-call retry below.
//
// onTry({ status, error, ms }) fires once per HTTP request, including each
// failed try, for the usage log in backend/import.js.
//
// No result cache here: every transcript produced is persisted permanently at
// library/<type>s/<slug>/transcript.json, so a second content-addressed cache
// in front of that would only help re-importing byte-identical media under a
// new entry — not worth a database db.js deliberately refuses to become (see
// its header: plain JSON by design).

const fs = require("fs/promises");
const { statSync } = require("fs");
const path = require("path");

// ai-service caps the audio at Azure Fast Transcription's ceiling.
const TX_MAX = 300 * 1024 * 1024;
const TX_TIMEOUT_MS = 600 * 1000;
const TX_RETRIES = 3;

// ai-service's local address. Same loopback contract as the explain/mic
// proxies in backend/server.js — this machine only, no auth.
const AI_SERVICE_URL =
  process.env.AI_SERVICE_URL || "http://127.0.0.1:8770";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Retry policy: network blips, 5xx, and busy/not-ready (409/429) are worth
// retrying; other 4xx means the request itself is wrong.
function retryable(status) {
  return !status || status >= 500 || status === 409 || status === 429;
}

// ai-service expresses Azure failures as HTTP 502 with the upstream status in
// `azureStatus`. A no-transcript result and an Azure 4xx (other than auth,
// timeout and rate limiting) can never succeed by repeating the same upload.
function permanentFailure(body) {
  if (!body) return null;
  if (body.error === "azure returned no transcript") return "azure returned no transcript";
  const azureStatus = Number(body.azureStatus);
  if (
    body.azureStatus != null &&
    Number.isFinite(azureStatus) &&
    azureStatus >= 400 && azureStatus < 500 &&
    ![401, 403, 408, 429].includes(azureStatus)
  ) {
    return `azureStatus ${azureStatus}`;
  }
  return null;
}

// Only ECONNREFUSED proves the request never reached Azure. Anything else may
// have been billed somewhere, so it keeps the normal retry/attempt accounting.
function connectionRefused(err) {
  for (let cur = err; cur; cur = cur.cause) {
    if (cur.code === "ECONNREFUSED") return true;
  }
  return /ECONNREFUSED/.test(String((err && err.message) || ""));
}

function reportTry(onTry, info) {
  try {
    onTry(info);
  } catch { /* a broken logger must not break transcription */ }
}

function validShape(t) {
  return (
    t &&
    Array.isArray(t.lines) && t.lines.length > 0 &&
    Array.isArray(t.words) && t.words.length > 0 &&
    t.words.every(
      (w) =>
        typeof w.text === "string" &&
        typeof w.start === "number" &&
        typeof w.end === "number",
    )
  );
}

// The verbatim transcriber for daily dictation — ai-service's
// /api/transcribe-verbatim. A single-shot synchronous multipart POST: PBS
// clips fit the 300 MB cap, so there is no chunked upload protocol and no
// polling loop.
async function transcribeVerbatim(filePath, { onProgress = () => {}, onTry = () => {} } = {}) {
  const size = statSync(filePath).size;
  if (size > TX_MAX) throw new Error("File is too large to transcribe (over 300 MB).");
  onProgress("uploading to ai-service (verbatim)...");
  const buf = await fs.readFile(filePath);
  const form = new FormData();
  form.append("audio", new Blob([buf]), path.basename(filePath));
  onProgress("waiting for verbatim transcription...");
  let lastErr = null;
  for (let attempt = 0; attempt < TX_RETRIES; attempt++) {
    const started = Date.now();
    let res = null;
    let fetchErr = null;
    try {
      res = await fetch(`${AI_SERVICE_URL}/api/transcribe-verbatim`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(TX_TIMEOUT_MS),
      });
    } catch (e) {
      fetchErr = e;
    }

    let j = null;
    if (res) {
      try { j = await res.json(); } catch { /* non-JSON error body */ }
    }
    const status = res ? res.status : null;
    const httpError = res && !res.ok
      ? ((j && j.error) || `transcribe-verbatim ${res.status}`)
      : null;
    reportTry(onTry, {
      status,
      error: fetchErr ? String(fetchErr.message || fetchErr) : httpError,
      ms: Date.now() - started,
    });

    if (fetchErr) {
      lastErr = fetchErr;
      if (connectionRefused(fetchErr)) {
        // ai-service is not running: no Azure call happened, so this try is
        // free and the next sync can retry without touching the cap.
        fetchErr.free = true;
        throw fetchErr;
      }
      onProgress(`retrying after network error (${attempt + 1}/${TX_RETRIES})...`);
      await sleep(2000 * (attempt + 1));
      continue;
    }

    if (!res.ok) {
      const err = new Error(httpError);
      err.status = res.status;
      const permanent = permanentFailure(j);
      if (permanent) {
        err.permanent = true;
        err.permanentReason = permanent;
        throw err;
      }
      if (!retryable(res.status) || attempt === TX_RETRIES - 1) throw err;
      lastErr = err;
      onProgress(`retrying after status ${res.status} (${attempt + 1}/${TX_RETRIES})...`);
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (!validShape(j)) throw new Error("transcribe-verbatim returned no transcript");
    return { lines: j.lines, words: j.words };
  }
  throw lastErr || new Error("verbatim transcription failed");
}

module.exports = { transcribeVerbatim };
