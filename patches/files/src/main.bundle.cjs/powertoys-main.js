// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): the main-process half.
//
// Started by one line in main.bundle.cjs/33229-main (fragment 0050), right after Slack's store exists:
//   __webpack_require__("powertoys/main").start(appStore);
// Data lives in %APPDATA%\Slack\powertoys\:
//   settings.json  Powertoys' settings (missing keys take the defaults below)
//   mods\          *.css inserted into, and *.js run in, every Slack page (app.slack.com) when it loads
//   bridge.json    while Slack runs: the port and token of the bridge to Claude (powertoys-claude.js)
// Logs go to Slack's own log (logs\default\browser.log) with a "[powertoys]" prefix.
// ---------------------------------------------------------------------------------------------
(function (module, exports, __webpack_require__) {
  "use strict";

  const electron = __webpack_require__(84157);
  const fs = __webpack_require__(79896);
  const path = __webpack_require__(16928);
  const logger = __webpack_require__(11227).vF;

  const DEFAULTS = { mods: true, bridge: true };
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

  /** Changes settings.json: change(current) returns the new settings, which are written whole. */
  function updateSettings(change) {
    const file = path.join(powertoysDir(), "settings.json");
    let current = {};
    try {
      current = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (caught) {
      if (caught.code !== "ENOENT") throw caught;
    }
    fs.mkdirSync(powertoysDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(change(current), null, 2));
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

  // --- Slack's Web API, with the web client's own session -------------------------------------------------
  /** The Slack page's web contents (app.slack.com in the main window). */
  function slackPage() {
    return electron.webContents.getAllWebContents().find((each) => !each.isDestroyed() && isSlackPage(each)) ?? null;
  }

  /** The signed-in workspaces as the web client stores them: [{ id, name, url, token, enterprise_id }]. */
  async function signedInTeams(page) {
    const teams = await page.executeJavaScript(
      `Object.values(JSON.parse(localStorage.getItem("localConfig_v2") || "{}").teams || {}).map((t) => ({ id: t.id, name: t.name, url: t.url, token: t.token, enterprise_id: t.enterprise_id || null }))`,
      true,
    );
    return teams.filter((team) => team.url && team.token);
  }

  /** A Web API call for a workspace, through the page's session (its cookies) and the workspace's token. */
  async function api(page, team, method, params = {}) {
    const body = new URLSearchParams({ token: team.token, ...params });
    const response = await page.session.fetch(`${team.url}api/${method}`, {
      method: "POST",
      body: body.toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    return response.json();
  }

  // For powertoys/claude.
  Object.assign(exports, { log, warn, powertoysDir, readSettings, updateSettings, slackPage, signedInTeams, api });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // --- Mark everything as read ----------------------------------------------------------------------------
  // What Slack's own "Mark all as read" does, for every signed-in workspace (or one): each channel, DM and group DM
  // with unreads is marked read at its latest message (conversations.mark). Slack's servers then tell the app, which
  // updates its sidebar itself. A workspace the org already covers answers team_is_restricted and is skipped.
  let marking = null;
  function markAllRead(teamId = null) {
    marking ??= (async () => {
      const page = slackPage();
      if (!page) throw new Error("Slack's page is not open");
      let marked = 0;
      let failed = 0;
      const teams = await signedInTeams(page);
      // One workspace: it, its org (an org's workspace is marked through the org) and the org's own entry.
      const chosen = teamId ? teams.find((team) => team.id === teamId) : null;
      if (teamId && !chosen) throw new Error(`workspace ${teamId} is not signed in`);
      for (const team of teams) {
        if (chosen && team.id !== chosen.id && team.id !== chosen.enterprise_id) continue;
        const counts = await api(page, team, "client.counts");
        if (!counts.ok) {
          if (counts.error !== "team_is_restricted") warn(`mark all read: ${team.id}: ${counts.error}`);
          continue;
        }
        const unread = [...(counts.channels ?? []), ...(counts.ims ?? []), ...(counts.mpims ?? [])].filter((each) => each.has_unreads && each.latest);
        for (const conversation of unread) {
          let result = await api(page, team, "conversations.mark", { channel: conversation.id, ts: conversation.latest });
          if (result.error === "ratelimited") {
            await sleep(3000);
            result = await api(page, team, "conversations.mark", { channel: conversation.id, ts: conversation.latest });
          }
          result.ok ? marked++ : (failed++, warn(`mark all read: ${team.id}/${conversation.id}: ${result.error}`));
        }
      }
      log(`marked ${marked} conversation(s) read${failed ? `, ${failed} failed` : ""}${teamId ? ` in ${teamId}` : " in every workspace"}`);
      return { marked, failed };
    })().finally(() => (marking = null));
    return marking;
  }
  exports.markAllRead = markAllRead;

  // --- Menus ----------------------------------------------------------------------------------------------
  /** Called by the tray's menu builder (33229-main fragment 0037) before it adds Preferences. */
  exports.addTrayItems = function addTrayItems(menu) {
    menu.append(new electron.MenuItem({ type: "separator" }));
    menu.append(
      new electron.MenuItem({
        label: "Mark everything as read (all workspaces)",
        click: () => markAllRead().catch((caught) => warn(`mark all read failed: ${caught.message}`)),
      }),
    );
    __webpack_require__("powertoys/assist").addTrayItems(menu);
  };

  // --- Why Slack quit -----------------------------------------------------------------------------------------
  // When Slack starts quitting, one log line says what led to it: the code path that sent Slack's QUIT_APP (its
  // stack), the last keys pressed with Ctrl, Alt or Windows held (AltGr shows as Ctrl+Alt; plain typing is never
  // recorded) and the last outside events (Windows ending the session, a second instance, windows closing).
  const recent = [];
  const remember = (what) => {
    recent.push(`${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(11, 23)} ${what}`);
    if (recent.length > 30) recent.shift();
  };
  function watchQuit(store) {
    let reported = false;
    const report = (how, stack) => {
      if (reported) return;
      reported = true;
      log(`quitting (${how}); recent: ${recent.join(" · ") || "nothing"}${stack ? `; sent from: ${stack}` : ""}`);
    };
    const stackOf = () =>
      (new Error().stack ?? "")
        .split("\n")
        .slice(3, 18)
        .map((line) => line.trim().replace(/^at /, ""))
        .join(" < ");
    // Who calls Slack's store with QUIT_APP (a caller holding the store's own dispatch is seen when the state flips).
    if (store) {
      const dispatch = store.dispatch;
      store.dispatch = (action) => {
        if (action?.type === "QUIT_APP" || action?.type === "QUIT_APPLICATION") report(`store ${action.type}`, stackOf());
        return dispatch(action);
      };
      // (A subscriber runs inside the dispatch that changed the state, so its stack shows who sent it.)
      store.subscribe(() => store.getState()?.app?.isQuitting && report("Slack's state says it is quitting", stackOf()));
    }
    const watchKeys = (contents) =>
      contents.on("before-input-event", (event, input) => {
        if (input.type !== "keyDown" || input.isAutoRepeat || !(input.control || input.alt || input.meta)) return;
        const keys = [input.control && "Ctrl", input.alt && "Alt", input.shift && "Shift", input.meta && "Win", input.code].filter(Boolean).join("+");
        remember(`keys ${keys} (${contents.getType()} ${contents.id})`);
      });
    for (const contents of electron.webContents.getAllWebContents()) watchKeys(contents);
    electron.app.on("web-contents-created", (event, contents) => watchKeys(contents));
    electron.app.on("browser-window-created", (event, window) => window.on("close", () => remember(`window closing: ${window.getTitle()}`)));
    for (const window of electron.BrowserWindow.getAllWindows()) window.on("close", () => remember(`window closing: ${window.getTitle()}`));
    electron.app.on("second-instance", (event, argv) => remember(`second instance: ${argv.slice(1).join(" ").slice(0, 200)}`));
    // (Before Slack's own before-quit listener, which sends QUIT_APP at once.)
    electron.app.prependListener("before-quit", () => remember("before-quit"));
    electron.app.on("will-quit", () => report("will-quit"));
    electron.powerMonitor.on("shutdown", () => remember("Windows shutting down"));
    electron.app.on("session-end", () => remember("Windows ending the session"));
    electron.app.on("query-session-end", (event) => remember(`Windows asking to end the session (${event.reasons?.join(", ") ?? ""})`));
    process.on("exit", (code) => report(`process exit ${code}`));
  }

  exports.start = function start(store) {
    fs.mkdirSync(path.join(powertoysDir(), "mods"), { recursive: true });
    watchQuit(store);
    // The page half's messages go to Slack's log.
    electron.ipcMain.on("powertoys:log", (event, message) => log(`[page] ${String(message).slice(0, 4000)}`));
    electron.ipcMain.handle("powertoys:mark-all-read", (event, teamId) => markAllRead(teamId ?? null));
    __webpack_require__("powertoys/claude").start();
    __webpack_require__("powertoys/assist").start(store);
    __webpack_require__("powertoys/huddle").start();
    __webpack_require__("powertoys/history").start();
    __webpack_require__("powertoys/tickets").start();
    electron.app.on("web-contents-created", (event, webContents) => {
      webContents.on("did-finish-load", () => applyMods(webContents));
    });
    for (const webContents of electron.webContents.getAllWebContents()) {
      webContents.on("did-finish-load", () => applyMods(webContents));
    }
    log(`started (store ${store ? "ready" : "missing"}; data in ${powertoysDir()})`);
  };
});
