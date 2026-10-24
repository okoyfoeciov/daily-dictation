const { app, BrowserWindow, dialog, nativeImage, ipcMain, session, systemPreferences } = require("electron");
const path = require("node:path");
const backend = require("./backend/server");

// The transcript card (mic.js) plays its clip back the instant it opens, with
// no click in between — the fetch() that transcribes it breaks the click's
// user-activation window before play() ever runs. Chromium's default
// autoplay policy would silently block that. This is a process-wide
// Chromium flag (Electron has no narrower per-window/per-origin knob), so it
// really does relax autoplay for anything this app ever loads — today that
// blast radius happens to equal "the mic feature" only because app.html is
// the one and only page this app loads at all.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// Linux: keep Chromium from exporting this app's media playback over MPRIS.
//
// mic.js autoplays each recorded clip as soon as its transcript arrives. That
// clip is a MediaRecorder WebM with no duration header, so Chromium reports
// mpris:length as INT64_MAX and GNOME Shell re-reads the whole metadata
// dictionary on every position update (about ten times a second while the clip
// plays). Each read logs "Value 9223372036854775807 cannot be safely stored in
// a JS Number", and media-aware shell extensions re-render their controller on
// every one of those updates. Measured on 2026-10-24: 2814 of those lines in
// one mic session, followed by the shell missing key-repeat deadlines and the
// whole desktop freezing. This app has no OS media-key/media-control feature,
// so the MPRIS bridge is pure overhead here; disabling it leaves <audio>
// playback untouched. Keep any --disable-features value already supplied.
const disabledFeatures = app.commandLine.getSwitchValue("disable-features");
if (process.platform === "linux") {
  app.commandLine.appendSwitch(
    "disable-features",
    [disabledFeatures, "MediaSessionService"].filter(Boolean).join(","),
  );
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 480,
    title: "Daily Dictation",
    icon: path.join(__dirname, "build", "icons", "256x256.png"),
    backgroundColor: "#181818", // matches app.html's <meta name="theme-color">
    show: false,
    // Frameless on every platform, with a custom title bar of our own (see
    // titlebar.js/preload.js) — the app has no header of its own to sit under
    // a native title-bar row, so a native one is just a bare strip over dark
    // content.
    frame: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // Keep "Daily Dictation" as the OS window title — app.html's own <title> is
  // only the in-tab fallback, so without this Electron's default page-title
  // sync would rename the window to it after load.
  win.on("page-title-updated", (event) => event.preventDefault());

  // Wait for ready-to-show so the window appears already maximized instead of
  // flashing at its default size first.
  win.once("ready-to-show", () => {
    win.maximize();
    win.show();
  });

  // Keep the custom title bar's maximize/restore icon (see titlebar.js) in
  // sync with state changes that don't originate from its own button: the
  // launch-time maximize() above, the OS's own maximize shortcut, or a drag
  // to/from a screen edge.
  const notifyMaximizedChange = () => win.webContents.send("window:maximized-changed", win.isMaximized());
  win.on("maximize", notifyMaximizedChange);
  win.on("unmaximize", notifyMaximizedChange);

  // F11 (Electron's default "Toggle Full Screen" accelerator, from the
  // implicit application menu — this app sets none of its own) hits
  // win.setFullScreen(), which is native OS fullscreen and has no idea our
  // title bar is just a <div> in the page, not real window chrome. Tell the
  // renderer so titlebar.js can hide it — window controls (minimize included)
  // are meaningless once there's no window to see.
  const notifyFullscreenChange = () => win.webContents.send("window:fullscreen-changed", win.isFullScreen());
  win.on("enter-full-screen", notifyFullscreenChange);
  win.on("leave-full-screen", notifyFullscreenChange);

  win.loadFile(path.join(__dirname, "app.html"));

  return win;
}

ipcMain.on("window:minimize", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});
ipcMain.on("window:toggle-maximize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on("window:close", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});
ipcMain.handle("window:is-maximized", (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
});

app.whenReady().then(async () => {
  // Embedded dictation backend (single app, local-only). The asar bundle
  // is read-only and ships no library, so packaged builds keep their data in
  // <userData>/library; dev runs (`electron .` from source) keep using
  // <repo>/library, which is also what the pbs-sync CLI defaults to.
  const libraryDir = app.isPackaged
    ? path.join(app.getPath("userData"), "library")
    : path.join(__dirname, "library");
  try {
    await backend.start({ port: backend.DEFAULT_PORT, libraryDir });
  } catch (err) {
    const code = err && err.code;
    const detail = code === "EADDRINUSE"
      ? `Port ${backend.DEFAULT_PORT} is already in use — another copy of this app (or a standalone "node backend/server.js") is still running. Stop it and relaunch.`
      : String((err && err.message) || err);
    console.error(`embedded backend failed to start: ${detail}`);
    dialog.showErrorBox("Daily Dictation — backend failed to start", detail);
    app.quit();
    return;
  }
  // BrowserWindow's `icon` option only reaches the Windows/Linux taskbar — on
  // macOS the dock icon is read from the packaged .app's Info.plist, which
  // doesn't exist yet in an unpackaged `electron .` dev run. Without this, dev
  // runs show the generic Electron icon in the dock instead of ours.
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, "build", "icon.png")));
  }
  if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("microphone") !== "granted") {
    systemPreferences.askForMediaAccess("microphone");
  }

  // The mic button (mic.js) calls getUserMedia (permission "media") and, on
  // a successful transcription, navigator.clipboard.writeText (permission
  // "clipboard-sanitized-write" — Electron denies that too by default;
  // measured, it throws NotAllowedError without this). There is no other
  // origin this window ever loads, so granting both unconditionally is
  // safe. session.defaultSession only exists once the app is ready, hence
  // this lives in here rather than at module load time.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media" || permission === "clipboard-sanitized-write");
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  // Fire-and-forget: releases the loopback port; process exit doesn't wait.
  backend.stop().catch(() => {});
});
