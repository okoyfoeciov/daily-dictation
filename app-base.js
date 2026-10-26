// app-base.js — resolves the base URL of this app's own backend: the Express
// server main.js starts embedded in this same app process on loopback.
//
// Every apiBase() call site gets that prefixed: the dictation endpoints
// (/api/dictation/*), the segment stream (/api/library/:id/stream), the
// explanation/pronunciation/credit proxies (/api/explain, /api/pron,
// /api/credits), and the mic transcription proxies (/api/transcribe/stream,
// /api/transcribe/ws, /api/transcribe). The renderer never talks to ai-service
// or any other host directly.

(() => {
  "use strict";

  const DEFAULT_BASE = "http://127.0.0.1:8768";

  window.apiBase = () => DEFAULT_BASE;
})();
