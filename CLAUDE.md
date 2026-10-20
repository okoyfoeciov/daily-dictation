# CLAUDE.md — daily-dictation

Guidance for Claude Code (and any other agent) working in this repository.

---

## Remote access — `gh` directly

Auth is the `gh` CLI via the OS keyring (single account `okoyfoeciov` —
verified with `gh auth status`). No tokens in files, no credential helpers:
this repo has no local `credential.helper` config by design, so plain
`git push` / `git fetch` just work through the global
`gh auth git-credential` helper.

### Rules for agents

1. **Push / fetch / pull:** just run `git push` / `git fetch`. Do not embed a
   token in the remote URL, do not pass `-c credential.helper=`.
2. **GitHub API calls:** use bare `gh` (e.g. `gh repo view`). Do not set a
   `GH_TOKEN` env var — it would override the keyring. Never paste tokens
   into `curl` commands, logs, terminal output, commit messages, or a PR body.
3. **Never run** `gh auth login`, `gh auth switch`, `gh auth setup-git`, or
   `gh auth token` as part of work in this repo.
4. If `gh auth status` ever shows anything other than the single
   `okoyfoeciov` account, stop and ask before touching the remote.

### Commit identity

Set locally (explicit beats global):

```
user.name  = okoyfoeciov
user.email = 92897177+okoyfoeciov@users.noreply.github.com
```

Check with `git config --local --list` before the first commit of a session.

### Remote

`origin` is `https://github.com/okoyfoeciov/daily-dictation.git` (private).

---

## Repo conventions

### Staging

**Never** `git add .` or `git add -A`. `.claude-session-active` is an untracked
worktree marker that must stay untracked *and* must not be added to
`.gitignore`; blanket staging would sweep it in. Use explicit paths or
`git add -u`.

### What is intentionally not in git

`.gitignore` excludes `node_modules/` (~565 MB, reinstalled via `npm install`),
`dist/` (electron-builder output), and `library/` (machine-local user data:
media, `db.json`, `dictation.json`). `.env` must never be committed. Everything
else — including `build/icon.png` and `build/icons/`, which `package.json`'s
`build.mac`/`build.linux` config references directly — is tracked. The
legacy `pbs-sync.log` (from when the sync ran from cron) is untracked by omission, not by rule.

### About this project

A dictation-only Electron desktop app: daily dictation sessions cut from PBS
NewsHour segments (audio-only, 1–2 sentences per session, looped), with
WER-based grading, SM-2 spaced scheduling, and click-a-word AI explanations.
The corpus is every entry under a source's show collection
(`library/collections/pbs-newshour*` — the source list lives in
`backend/sources.js`), with media in
`library/movies/*` (the older mp4 corpus) and `library/audios/*` (the RSS
audio imports), and the only media route is
`GET /api/library/:id/stream`, which serves the segment audio the dictation
loop plays inside of.

`app-player.js` owns the shared `<audio>` transport (play/pause/seek/time,
mobile collapse, keyboard) and the explanation panel (via `/api/explain`,
`/api/pron`, `/api/credits`, all proxied to ai-service on 127.0.0.1:8770); `app-dictation.js` owns
the notepad UI, the session loop, and grading, and reaches the panel through
`window.__dictationExplain` / `window.__dictationCloseExplanations`.
`app-base.js` resolves the API base URL (see its own header comment) — this
app's embedded backend (`main.js` starts `backend/server.js` in-process on
loopback; library lives in `<repo>/library` in dev, `<userData>/library`
packaged — see `backend/paths.js`). `backend/dictation.js` holds the session-partition algorithm, the scheduler,
and the WER grader. `backend/pbs-sync.js` is the catch-up sync: the embedded
backend runs it on app launch and every few hours, pulling new PBS segments
from the segments podcast RSS audio (`backend/sources.js`) with verbatim
transcription via ai-service
(`backend/transcribe.js` → `POST 127.0.0.1:8770/api/transcribe-verbatim`,
Azure MAI-Transcribe-2 under the hood — this app holds no Azure credentials),
repairing broken transcripts. It keeps one broadcast day (`KEEP_DAYS` = 1): the
newest weekday in the feed, with all of that episode's segments. Today's
episode once it is out, otherwise the last one aired, so Saturday and Sunday
keep Friday's; older days and weekend days are pruned, but only once the kept
day has a readable transcript and this run imported all of it. The segments
feed also carries "Settle In" podcast episodes (guid under
`/newshour/podcasts/`); `sources.js` drops them, since they are not part of the
NewsHour episode. Preview a run with `node backend/pbs-sync.js --dry-run`.
`main.js` is the Electron shell. Avoid changing `app-player.js`'s explanation
engine unless the task requires it.

## Packaging

### CI/CD (GitHub Actions, same pattern as ~/source-viewer)

`.github/workflows/ci.yml` runs on pushes to `main` and on PRs: `npm ci`
plus `node --check` over the plain-JS frontend and `backend/*.js`. There is
no TypeScript and no unit-test suite, so that syntax check is the whole gate.

`.github/workflows/release.yml` runs on every push to `main` (plus manual
dispatch): it builds the `.deb` on `ubuntu-latest` via `npm run dist:linux`
and the `.dmg` on `macos-14` via `npm run dist:mac`, then (re)publishes both
to the single fixed `v1.0.7` tag with `--clobber`. Bump `package.json`'s
`version` and the tag in `release.yml` together when the version changes.

The cross-build wall below is why CI builds each platform on its own
runner instead of cross-building: neither platform can build the other's
package locally.

### Build

```
npm install
npm run dist:linux   # → dist/daily-dictation_<version>_amd64.deb
npm run dist:mac     # → dist/*.dmg (plus a .zip side-artifact) — Mac only, see below
```

`version` in `package.json` names the output file and the release tag
(`v1.0.7`). Bump it together with `.github/workflows/release.yml` — not on
every commit.

### Why each platform must build its own

`build.mac.target` is `"dmg"`; electron-builder emits a plain `.zip` alongside
it as an auto-update side-artifact, so a Mac build produces both.

Building the mac target **on Linux does not work**. It needs `dmg-license`, a
macOS-only optional dependency (`"os": ["darwin"]` in `package-lock.json`) that
a plain `npm install` prunes on any other platform — that alone fails the build
with `Cannot find module 'dmg-license'` before packaging even starts.
Force-installing it —

```
npm install --no-save --force --os=darwin --cpu=x64 dmg-license
```

gets past that, but its own dependency `iconv-corefoundation` ships a **native
Mach-O binary** (compiled for Darwin), which fails immediately on Linux with
`invalid ELF header`. There is no further workaround short of building on an
actual Mac, or setting up real cross-compilation tooling, which this project
does not have.
