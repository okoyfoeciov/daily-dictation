"use strict";

// The audio sources the catch-up sync (backend/pbs-sync.js) pulls from, and the
// per-source facts the rest of the backend needs: which collection ids belong to
// a source (dictation.js builds its corpus from them) and how its feed is read.
//
// A source is a podcast RSS feed whose items each carry one audio enclosure.
// Everything source-specific is data here, so the sync loop does not name a show.
//
//   id          collection id of the show; day collections are "<id>-YYYY-MM-DD"
//   title       display title of the show collection
//   rssUrl      the public podcast feed
//   dayTz       time zone that decides which broadcast day an item belongs to
//               (PBS: UTC, its editorial day)
//   keep(item)  false drops feed items that are not part of the daily programme
//   entryTitle  title of the imported entry (its slug becomes the entry id)

const PBS_SEGMENTS_RSS = "https://www.pbs.org/newshour/feeds/rss/podcasts/segments";

const SOURCES = [
  {
    id: "pbs-newshour",
    title: "PBS NewsHour",
    rssUrl: PBS_SEGMENTS_RSS,
    dayTz: "UTC",
    // The segments feed also carries "Settle In with PBS News" podcast episodes
    // (29-59 min, guid under /newshour/podcasts/), stamped hours before the
    // evening segments. They are not part of the day's NewsHour episode, and one
    // alone would make today the newest day while it holds nothing else.
    keep: (item) => !/\/newshour\/podcasts\//.test(item.guid),
    entryTitle: (item) => item.title,
  },
];

const BY_ID = new Map(SOURCES.map((s) => [s.id, s]));

// The source an entry belongs to, decided by the collection tree: a show
// collection, a day under it, or a segment under a day. sourceId is not
// evidence of membership — it only says the entry came from somewhere with an
// id, which is true of every imported file. The walk is depth-capped because a
// cyclic parentId would otherwise spin forever inside a request and hang the
// server.
function sourceOf(entry, byId) {
  let cur = entry;
  for (let hops = 0; cur && hops < 32; hops++) {
    const src = BY_ID.get(cur.id);
    if (src) return src;
    if (!cur.parentId) return null;
    cur = byId.get(cur.parentId);
  }
  return null;
}

module.exports = { SOURCES, sourceOf };
