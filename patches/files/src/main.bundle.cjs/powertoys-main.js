// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): the main-process half.
//
// Started by one line in main.bundle.cjs/33229-main (fragment 0050), right after Slack's store exists:
//   __webpack_require__("powertoys/main").start(appStore);
// Data lives in %APPDATA%\Slack\powertoys\:
//   settings.json  Powertoys' settings (missing keys take the defaults below)
//   mods\          *.css inserted into, and *.js run in, every Slack page (app.slack.com) when it loads
// Logs go to Slack's own log (logs\default\browser.log) with a "[powertoys]" prefix.
// ---------------------------------------------------------------------------------------------
(function (module, exports, __webpack_require__) {
  "use strict";

  const electron = __webpack_require__(84157);
  const fs = __webpack_require__(79896);
  const path = __webpack_require__(16928);
  const logger = __webpack_require__(11227).vF;

  const DEFAULTS = { mods: true };
  const log = (message, ...rest) => logger.info(`[powertoys] ${message}`, ...rest);
  const warn = (message, ...rest) => logger.warn(`[powertoys] ${message}`, ...rest);

  function powertoysDir() {
    return path.join(electron.app.getPath("userData"), "powertoys");
  }

  function readSettings() {
    try {
      return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(powertoysDir(), "settings.json"), "utf8")) };
    } catch (caught) {
      if (caught.code !== "ENOENT") warn(`settings.json could not be read: ${caught.message}`);
      return { ...DEFAULTS };
    }
  }

  /** The mods folder's files: { css: [text], js: [text] }, read fresh each time a page loads. */
  function readMods() {
    const dir = path.join(powertoysDir(), "mods");
    const mods = { css: [], js: [] };
    let names = [];
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      return mods;
    }
    for (const name of names) {
      const kind = path.extname(name).slice(1).toLowerCase();
      if (kind !== "css" && kind !== "js") continue;
      try {
        mods[kind].push(fs.readFileSync(path.join(dir, name), "utf8"));
      } catch (caught) {
        warn(`mod ${name} could not be read: ${caught.message}`);
      }
    }
    return mods;
  }

  /** Slack's pages are the web contents showing app.slack.com (the main window, and huddle or pop-out windows). */
  function isSlackPage(webContents) {
    try {
      return new URL(webContents.getURL()).hostname.endsWith(".slack.com");
    } catch {
      return false;
    }
  }

  function applyMods(webContents) {
    if (!readSettings().mods || !isSlackPage(webContents)) return;
    const mods = readMods();
    for (const css of mods.css) webContents.insertCSS(css).catch((caught) => warn(`a CSS mod failed: ${caught.message}`));
    for (const js of mods.js) webContents.executeJavaScript(js, true).catch((caught) => warn(`a JS mod failed: ${caught.message}`));
    if (mods.css.length || mods.js.length) log(`mods applied: ${mods.css.length} CSS, ${mods.js.length} JS`);
  }

  exports.start = function start(store) {
    fs.mkdirSync(path.join(powertoysDir(), "mods"), { recursive: true });
    electron.app.on("web-contents-created", (event, webContents) => {
      webContents.on("did-finish-load", () => applyMods(webContents));
    });
    for (const webContents of electron.webContents.getAllWebContents()) {
      webContents.on("did-finish-load", () => applyMods(webContents));
    }
    log(`started (store ${store ? "ready" : "missing"}; data in ${powertoysDir()})`);
  };
});
