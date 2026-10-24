// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): the main-process half.
//
// Started by one line in main.bundle.cjs/33229-main (fragment 0050), right after Slack's store exists:
//   __webpack_require__("powertoys/main").start(appStore);
// Data lives in %APPDATA%\Slack\powertoys\:
//   settings.json  Powertoys' settings (missing keys take the defaults below)
//   mods\          *.css inserted into, and *.js run in, every Slack page (app.slack.com) when it loads
//   bridge.json    while Slack runs: the port and token of the clip-transcript bridge (for mcp/slack-transcripts.mjs)
// Logs go to Slack's own log (logs\default\browser.log) with a "[powertoys]" prefix.
// ---------------------------------------------------------------------------------------------
(function (module, exports, __webpack_require__) {
  "use strict";

  const electron = __webpack_require__(84157);
  const fs = __webpack_require__(79896);
  const path = __webpack_require__(16928);
  const http = __webpack_require__(58611);
  const crypto = __webpack_require__(76982);
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
  };

  // --- Clip transcripts, for Claude Desktop ----------------------------------------------------------------
  // Slack's video and audio clips have transcripts (the clip's "View transcript"). files.info returns them with
  // include_transcription: transcription.status ("complete", "none", ...) and transcription.lines, one per caption.
  // A localhost bridge serves them to mcp/slack-transcripts.mjs, the MCP server Claude Desktop runs.

  /** The workspaces to ask, best first: those whose address is the link's host, then the rest. */
  function teamsInOrder(teams, host) {
    if (!host) return teams;
    const matches = (team) => new URL(team.url).hostname === host;
    return [...teams.filter(matches), ...teams.filter((team) => !matches(team))];
  }

  /** A clip reference: a file id (F...), a file link (/files/<user>/<id>/...), or a message link (/archives/<channel>/p<ts>). */
  function parseClipRef(ref) {
    ref = String(ref ?? "").trim();
    if (/^F[A-Z0-9]{6,}$/.test(ref)) return { file: ref };
    let url;
    try {
      url = new URL(ref);
    } catch {
      throw new Error("expected a Slack clip link or a file id (F...)");
    }
    const file = /\/files\/[^/]+\/(F[A-Z0-9]+)/.exec(url.pathname)?.[1];
    if (file) return { file, host: url.hostname };
    const message = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(url.pathname);
    if (message) return { host: url.hostname, channel: message[1], ts: `${message[2]}.${message[3]}`, threadTs: url.searchParams.get("thread_ts") };
    throw new Error("that link is neither a Slack file link nor a message link");
  }

  const isClip = (file) => /^(video|audio)\//.test(file.mimetype ?? "");

  /** The clips a message link points to: the message's video and audio files. */
  async function clipsOfMessage(page, teams, { channel, ts, threadTs }) {
    let lastError = "message_not_found";
    for (const team of teams) {
      let result = await api(page, team, "conversations.history", { channel, latest: ts, inclusive: true, limit: 1 });
      let message = result.messages?.find((each) => each.ts === ts);
      if (!message && (result.ok || threadTs)) {
        // A reply in a thread is not in the channel's history.
        result = await api(page, team, "conversations.replies", { channel, ts: threadTs ?? ts, latest: ts, inclusive: true, limit: 1 });
        message = result.messages?.find((each) => each.ts === ts);
      }
      if (message) return (message.files ?? []).filter(isClip).map((file) => file.id);
      if (!result.ok) lastError = result.error;
    }
    throw new Error(`the message could not be read (${lastError})`);
  }

  const userNames = new Map();
  async function userName(page, team, userId) {
    if (!userId) return null;
    if (!userNames.has(userId)) {
      const result = await api(page, team, "users.info", { user: userId });
      userNames.set(userId, result.user?.real_name || result.user?.name || userId);
    }
    return userNames.get(userId);
  }

  async function describeClip(page, team, file) {
    return {
      id: file.id,
      title: file.title || file.name,
      kind: file.mimetype?.startsWith("audio/") ? "audio" : "video",
      created: new Date(file.created * 1000).toISOString(),
      durationSeconds: file.duration_ms ? Math.round(file.duration_ms / 1000) : null,
      author: await userName(page, team, file.user),
      workspace: team.name,
      permalink: file.permalink,
      transcript: file.transcription?.status ?? null,
    };
  }

  /** A clip's transcript: { ...clip, locale, lines: [{ start, end, text }] } (times in milliseconds). */
  async function clipTranscript(page, teams, fileId) {
    let lastError = "file_not_found";
    for (const team of teams) {
      const result = await api(page, team, "files.info", { file: fileId, include_transcription: true });
      if (!result.ok) {
        lastError = result.error;
        continue;
      }
      const transcription = result.file.transcription ?? {};
      return {
        ...(await describeClip(page, team, result.file)),
        locale: transcription.locale ?? null,
        lines: (transcription.lines ?? []).map((line) => ({ start: line.start_time_ms, end: line.end_time_ms, text: line.contents })),
      };
    }
    throw new Error(`clip ${fileId} could not be read (${lastError})`);
  }

  async function clipTranscripts(ref) {
    const page = slackPage();
    if (!page) throw new Error("Slack's page is not open");
    const target = parseClipRef(ref);
    const teams = teamsInOrder(await signedInTeams(page), target.host);
    const files = target.file ? [target.file] : await clipsOfMessage(page, teams, target);
    if (!files.length) throw new Error("that message has no video or audio clip");
    const clips = [];
    for (const file of files) clips.push(await clipTranscript(page, teams, file));
    return { clips };
  }

  /** The newest clips (video and audio), newest first, in one workspace (by name or id) or all. */
  async function listClips({ workspace = null, limit = 20 } = {}) {
    const page = slackPage();
    if (!page) throw new Error("Slack's page is not open");
    const wanted = workspace?.toLowerCase();
    const teams = (await signedInTeams(page)).filter((team) => !wanted || team.id.toLowerCase() === wanted || team.name.toLowerCase().includes(wanted));
    if (!teams.length) throw new Error(`no signed-in workspace matches "${workspace}"`);
    const seen = new Map();
    for (const team of teams) {
      const result = await api(page, team, "files.list", { count: 200 });
      if (!result.ok) {
        if (result.error !== "team_is_restricted") warn(`clips: ${team.id}: ${result.error}`);
        continue;
      }
      for (const file of result.files ?? []) if (isClip(file) && !seen.has(file.id)) seen.set(file.id, { team, file });
    }
    const newest = [...seen.values()].sort((x, y) => y.file.created - x.file.created).slice(0, limit);
    const clips = [];
    for (const { team, file } of newest) clips.push(await describeClip(page, team, file));
    return { clips };
  }

  /** The bridge: http://127.0.0.1:<port>/clips?workspace=&limit= and /transcript?clip=<link or id>, with a bearer
   * token. Its port and token are in powertoys\bridge.json while Slack runs. */
  function startBridge() {
    const token = crypto.randomBytes(24).toString("hex");
    const file = path.join(powertoysDir(), "bridge.json");
    const server = http.createServer(async (request, response) => {
      const send = (status, body) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.headers.authorization !== `Bearer ${token}`) return send(401, { error: "unauthorized" });
      const url = new URL(request.url, "http://127.0.0.1");
      try {
        if (url.pathname === "/clips") {
          const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 100);
          return send(200, await listClips({ workspace: url.searchParams.get("workspace") || null, limit }));
        }
        if (url.pathname === "/transcript") return send(200, await clipTranscripts(url.searchParams.get("clip")));
        send(404, { error: "not found" });
      } catch (caught) {
        warn(`bridge ${url.pathname}: ${caught.message}`);
        send(500, { error: caught.message });
      }
    });
    server.listen(0, "127.0.0.1", () => {
      fs.writeFileSync(file, JSON.stringify({ port: server.address().port, token, pid: process.pid }), { mode: 0o600 });
      log(`bridge listening on 127.0.0.1:${server.address().port}`);
    });
    electron.app.on("will-quit", () => fs.rmSync(file, { force: true }));
  }

  exports.start = function start(store) {
    fs.mkdirSync(path.join(powertoysDir(), "mods"), { recursive: true });
    // The page half's messages go to Slack's log.
    electron.ipcMain.on("powertoys:log", (event, message) => log(`[page] ${String(message).slice(0, 4000)}`));
    electron.ipcMain.handle("powertoys:mark-all-read", (event, teamId) => markAllRead(teamId ?? null));
    if (readSettings().bridge) startBridge();
    electron.app.on("web-contents-created", (event, webContents) => {
      webContents.on("did-finish-load", () => applyMods(webContents));
    });
    for (const webContents of electron.webContents.getAllWebContents()) {
      webContents.on("did-finish-load", () => applyMods(webContents));
    }
    log(`started (store ${store ? "ready" : "missing"}; data in ${powertoysDir()})`);
  };
});
