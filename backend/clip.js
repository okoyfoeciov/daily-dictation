"use strict";

// Pure helpers for cutting one random short clip out of a segment mp3, so STT
// is billed for the clip instead of the whole segment.
//
// A clip is expressed in MPEG-1 Layer III frame coordinates, never byte
// offsets: every frame is 1152 samples, so a slice cut on a frame boundary
// decodes at exactly k0 * 1152 / sampleRate seconds. The first 2-3 frames of a
// mid-file slice decode as garbage because of the bit reservoir, which is why a
// mid-file window carries a small pre-pad before its nominal start.
//
// The walk is deliberately strict: MPEG-1 Layer III only, a valid bitrate and
// sample rate in every header, one sample rate throughout, and the last frame
// ending exactly at EOF. A file this cannot parse is not sent at all — there is
// no fallback that would upload the whole segment.

const CLIP_S_FRIDAY = 100;
const CLIP_S_OTHER = 50;
const PRE_PAD_FRAMES = 4;

// dictation.js does not require this module, so this is a one-way dependency.
const { endsUnit } = require("./dictation");

const SAMPLES_PER_FRAME = 1152;

// MPEG-1 Layer III bitrate table (kbps); 0 = free, 15 = invalid.
const BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const SAMPLE_RATES = [44100, 48000, 32000, 0];

// ID3v2 tags sit in front of the audio. Its syncsafe size excludes the ten
// header bytes; v2.4 can append a ten-byte footer.
function id3TagSize(buf) {
  if (buf.length < 10 || buf.toString("latin1", 0, 3) !== "ID3") return 0;
  const major = buf[3];
  const flags = buf[5];
  const size =
    ((buf[6] & 0x7f) << 21) |
    ((buf[7] & 0x7f) << 14) |
    ((buf[8] & 0x7f) << 7) |
    (buf[9] & 0x7f);
  const footer = major === 4 && (flags & 0x10) ? 10 : 0;
  return 10 + size + footer;
}

// The Xing/Info frame (and Fraunhofer's VBRI variant) is metadata, not audio.
// Xing/Info starts after the side information; VBRI at a fixed 32 bytes after
// the header.
function isInfoFrame(buf, offset, header) {
  if (offset + 40 > buf.length) return false;
  const mono = ((header >>> 6) & 3) === 3;
  const xingAt = offset + 4 + (mono ? 17 : 32);
  const xing = buf.toString("latin1", xingAt, xingAt + 4);
  const vbri = buf.toString("latin1", offset + 36, offset + 40);
  return xing === "Xing" || xing === "Info" || vbri === "VBRI";
}

/**
 * Walk the mp3's frame headers.
 *
 * Returns either { ok: true, tagSize, sampleRate, frameSeconds, frames,
 * offsets, hasInfoFrame } — where `offsets` are the start byte of each AUDIO
 * frame — or { ok: false, reason }.
 */
function walkFrames(buf) {
  if (!buf || !buf.length) return { ok: false, reason: "empty file" };
  const tagSize = id3TagSize(buf);
  if (tagSize > buf.length) return { ok: false, reason: "truncated ID3v2 tag" };

  const offsets = [];
  let sampleRate = 0;
  let off = tagSize;
  let hasInfoFrame = false;

  while (off < buf.length) {
    if (off + 4 > buf.length) return { ok: false, reason: `truncated header at byte ${off}` };
    const header = buf.readUInt32BE(off);
    if (((header >>> 21) & 0x7ff) !== 0x7ff) return { ok: false, reason: `bad sync at byte ${off}` };
    if (((header >>> 19) & 3) !== 3) return { ok: false, reason: "not MPEG-1" };
    if (((header >>> 17) & 3) !== 1) return { ok: false, reason: "not Layer III" };

    const bitrateKbps = BITRATES[(header >>> 12) & 15];
    const rate = SAMPLE_RATES[(header >>> 10) & 3];
    if (!bitrateKbps) return { ok: false, reason: `bad bitrate at byte ${off}` };
    if (!rate) return { ok: false, reason: `bad sample rate at byte ${off}` };
    if (!sampleRate) sampleRate = rate;
    else if (rate !== sampleRate) return { ok: false, reason: "sample rate changes mid-file" };

    if (!offsets.length && isInfoFrame(buf, off, header)) hasInfoFrame = true;
    offsets.push(off);

    const padding = (header >>> 9) & 1;
    const length = Math.floor((144 * bitrateKbps * 1000) / rate) + padding;
    if (off + length > buf.length) return { ok: false, reason: `truncated frame at byte ${off}` };
    off += length;
  }

  // The walk is only trustworthy if it consumed the file exactly. Trailing
  // metadata, an APE tag or garbage would land here.
  if (off !== buf.length) return { ok: false, reason: `walk ended at byte ${off}, not EOF` };
  if (!offsets.length) return { ok: false, reason: "no frames" };
  if (hasInfoFrame && offsets.length === 1) return { ok: false, reason: "metadata frame only" };

  // frame 0 holding Xing/Info/VBRI is metadata, not audio
  const audioOffsets = hasInfoFrame ? offsets.slice(1) : offsets;
  return {
    ok: true,
    tagSize,
    sampleRate,
    frameSeconds: SAMPLES_PER_FRAME / sampleRate,
    frames: audioOffsets.length,
    offsets: audioOffsets,
    hasInfoFrame,
  };
}

// 100 s for a Friday episode (it has to cover Saturday, Sunday and Monday),
// 50 s for every other weekday. The date is the collection's editorial day.
function clipSecondsForDate(dateId) {
  const dow = new Date(`${dateId}T12:00:00Z`).getUTCDay();
  return dow === 5 ? CLIP_S_FRIDAY : CLIP_S_OTHER;
}

/**
 * Choose the frame window. A file no longer than the clip plus fifteen seconds
 * is used whole; otherwise t0 is drawn uniformly from the positions that leave
 * a whole clip behind, and a start in the first fifteen seconds collapses to
 * zero (sending a sliver from the head would be worse than the full window).
 */
function chooseWindow(frames, frameSeconds, clipSeconds, random = Math.random) {
  const duration = frames * frameSeconds;
  const whole = duration < clipSeconds + 15;
  if (whole) {
    return { k0: 0, k1: frames, start: 0, end: duration, whole: true };
  }

  let t0 = random() * (duration - clipSeconds);
  if (t0 < 15) t0 = 0;
  const k0 = t0 === 0 ? 0 : Math.max(0, Math.floor(t0 / frameSeconds) - PRE_PAD_FRAMES);
  const k1 = Math.min(frames, Math.ceil((t0 + clipSeconds) / frameSeconds));
  return { k0, k1, start: k0 * frameSeconds, end: k1 * frameSeconds, whole: false };
}

/**
 * The clip's bytes: the original ID3v2 tag followed by frames [k0, k1). The
 * tag is copied so the temp file is a normal mp3 with its metadata intact.
 */
function sliceClip(buf, walk, clip) {
  const startByte = walk.offsets[clip.k0];
  const endByte = clip.k1 < walk.frames ? walk.offsets[clip.k1] : buf.length;
  return Buffer.concat([buf.subarray(0, walk.tagSize), buf.subarray(startByte, endByte)]);
}

// Translate a transcript produced from clip time back into file time. Lines on
// have a start; the plan only relies on that for the readability check.
function shiftTranscript(transcript, offset) {
  return {
    lines: (transcript.lines || []).map((line) => ({
      ...line,
      start: (Number(line.start) || 0) + offset,
    })),
    words: (transcript.words || []).map((word) => {
      const start = Number(word.start) || 0;
      return {
        ...word,
        start: start + offset,
        end: (Number(word.end) || start) + offset,
      };
    }),
  };
}

/**
 * Trim a shifted word array so its first word starts a sentence and its last
 * word ends one. Without this, unitsFromWords treats the first stored word as
 * a sentence start regardless, and a clip cut mid-sentence would become a
 * reference the learner cannot complete.
 *
 * The start trim only applies to a pre-padded mid-file window (k0 > 0); the end
 * trim only when the window stops before the end of the file.
 */
function trimWords(words, { start, end, trimStart, trimEnd }) {
  const list = Array.isArray(words) ? words : [];

  if (trimStart) {
    let keepFrom = -1;
    for (let k = 0; k + 1 < list.length; k++) {
      const w = list[k];
      const next = list[k + 1];
      if (
        w.start >= start + 1.1 &&
        endsUnit(w.text, next.text) &&
        next.start - w.end >= 0.25
      ) {
        keepFrom = k + 1;
        break;
      }
    }
    if (keepFrom < 0) return [];
    return trimEnd ? trimAtEnd(list.slice(keepFrom), end) : list.slice(keepFrom);
  }

  return trimEnd ? trimAtEnd(list, end) : list;
}

function trimAtEnd(words, end) {
  let keepThrough = -1;
  for (let j = 0; j + 1 < words.length; j++) {
    const next = words[j + 1];
    if (next.end <= end - 1.0 && endsUnit(words[j].text, next.text)) keepThrough = j;
  }
  return keepThrough < 0 ? [] : words.slice(0, keepThrough + 1);
}

module.exports = {
  CLIP_S_FRIDAY,
  CLIP_S_OTHER,
  PRE_PAD_FRAMES,
  walkFrames,
  clipSecondsForDate,
  chooseWindow,
  sliceClip,
  shiftTranscript,
  trimWords,
};
