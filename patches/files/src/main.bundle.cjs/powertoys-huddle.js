// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): huddles and Claude. Slack draws a huddle's window itself (an about:blank window its page
// opened), so Powertoys adds a script to it once the huddle shows there:
//   - the side panel shows Captions rather than the huddle's Thread;
//   - a faint "Claude" chip picks one of the Claude Code sessions of the workspace's folder (Claude Desktop's or the
//     CLI's, worktrees included, from ~/.claude/projects);
//   - right-click a caption, "Ask Claude": the question is asked in that session itself (it stays there, with the
//     answer), and the answer shows in a pop-up.
// When an incoming huddle rings, the Bluetooth radio goes on and Windows connects your paired headphones
// ("huddle": { "headphones": "AirPods" }, a part of their name; null: off).
// The scripts talk to the main process through tagged console messages; answers go back with executeJavaScript.
// ---------------------------------------------------------------------------------------------
(function (module, exports, __webpack_require__) {
  "use strict";

  const electron = __webpack_require__(84157);
  const fs = __webpack_require__(79896);
  const path = __webpack_require__(16928);
  const os = __webpack_require__(48161);
  const { log, warn, readSettings, slackPage } = __webpack_require__("powertoys/main");
  const ai = __webpack_require__("powertoys/ai");

  // --- The workspace folder's Claude Code sessions -----------------------------------------------------------
  const projectsDir = () => path.join(process.env.USERPROFILE ?? "", ".claude", "projects");

  /** The last lines of a session file (they can be very large), parsed. */
  function sessionTail(file, bytes = 256 * 1024) {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - bytes);
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf8").split("\n").slice(start ? 1 : 0).flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    } finally {
      fs.closeSync(fd);
    }
  }

  /** The sessions with a title in a folder (and its worktrees), newest first -> [{ id, title, cwd, updated }]. */
  function projectSessions(folder) {
    const project = folder.replace(/[:\\/.]/g, "-");
    return fs
      .readdirSync(projectsDir())
      .filter((dir) => dir === project || dir.startsWith(`${project}--claude-worktrees-`))
      .flatMap((dir) =>
        fs.readdirSync(path.join(projectsDir(), dir)).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(projectsDir(), dir, name)),
      )
      .map((file) => ({ file, updated: fs.statSync(file).mtimeMs }))
      .sort((a, b) => b.updated - a.updated)
      .slice(0, 15)
      .flatMap(({ file, updated }) => {
        const lines = sessionTail(file);
        const titled = lines.findLast((line) => line.type === "custom-title" || line.type === "ai-title");
        const title = titled?.customTitle ?? titled?.aiTitle;
        return title ? [{ id: path.basename(file, ".jsonl"), title, cwd: lines.find((line) => line.cwd)?.cwd ?? folder, updated }] : [];
      });
  }

  // --- What runs in the huddle window ------------------------------------------------------------------------
  // Serialized with toString() and run there (no access to anything here).
  function huddleWindowScript() {
    if (window.__powertoys) return;
    const send = (message) => console.debug(`powertoys:huddle ${JSON.stringify(message)}`);
    const host = document.createElement("div");
    host.dataset.powertoys = "huddle";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      * { box-sizing: border-box; font: 12px/1.4 Lato, "Segoe UI", sans-serif; }
      .chip { position: fixed; z-index: 2147483646; left: 10px; bottom: 76px; max-width: 260px; padding: 3px 9px; border: 0;
        border-radius: 999px; background: rgba(255,255,255,.08); color: #d1d2d3; opacity: .45; cursor: pointer;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: opacity .2s; }
      .chip:hover, .chip.open { opacity: 1; }
      .menu { position: fixed; z-index: 2147483647; min-width: 240px; max-width: 360px; max-height: 50vh; overflow: auto; padding: 4px 0;
        border-radius: 8px; background: #222529; color: #d1d2d3; box-shadow: 0 0 0 1px rgba(255,255,255,.13), 0 4px 12px rgba(0,0,0,.4); }
      .menu .head { padding: 4px 12px; opacity: .6; }
      .menu .item { padding: 5px 12px; cursor: default; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .menu .item:hover { background: #1264a3; color: #fff; }
      .menu .item .when { opacity: .55; margin-left: 6px; }
      .answer { position: fixed; z-index: 2147483647; width: 380px; max-height: 50vh; display: flex; flex-direction: column;
        border-radius: 8px; background: #222529; color: #d1d2d3; box-shadow: 0 0 0 1px rgba(255,255,255,.13), 0 8px 24px rgba(0,0,0,.5); }
      .answer .top { display: flex; justify-content: space-between; gap: 8px; padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,.1); }
      .answer .top span { opacity: .7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .answer .top button { background: none; border: 0; color: #d1d2d3; font-size: 16px; line-height: 1; cursor: pointer; }
      .answer .q { padding: 8px 12px 0; opacity: .7; font-style: italic; }
      .answer .text { padding: 8px 12px 12px; overflow: auto; white-space: pre-wrap; font-size: 14px; }
    </style>`;
    document.body.appendChild(host);
    const el = (tag, className, text) => Object.assign(document.createElement(tag), className ? { className } : {}, text !== undefined ? { textContent: text } : {});

    let session = null;
    let sessions = [];
    let asked = 0;
    const answers = new Map();

    const chip = el("button", "chip", "Claude");
    chip.tabIndex = -1;
    const showChip = () => (chip.textContent = session ? `Claude: ${session.title}` : "Claude · pick a session");
    root.appendChild(chip);
    send({ type: "hello" });

    let menu = null;
    const closeMenu = () => (menu?.remove(), (menu = null), chip.classList.remove("open"));
    const ago = (time) => {
      const minutes = Math.round((Date.now() - time) / 60000);
      return minutes < 60 ? `${minutes} min` : minutes < 2880 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} d`;
    };
    function openMenu(x, y, items, head) {
      closeMenu();
      menu = el("div", "menu");
      if (head) menu.append(el("div", "head", head));
      for (const item of items) {
        const row = el("div", "item", item.label);
        if (item.when) row.append(el("span", "when", item.when));
        row.addEventListener("mousedown", (event) => (event.preventDefault(), closeMenu(), item.run()));
        menu.append(row);
      }
      root.appendChild(menu);
      const rect = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(x, innerWidth - rect.width - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(y, innerHeight - rect.height - 8))}px`;
    }
    const sessionItems = (then) =>
      sessions.length
        ? sessions.map((each) => ({ label: each.title, when: ago(each.updated), run: () => (send({ type: "assign", id: each.id }), then?.(each)) }))
        : [{ label: "No Claude Code sessions in this workspace's folder", run: () => {} }];

    chip.addEventListener("mousedown", (event) => {
      event.preventDefault();
      if (menu) return closeMenu();
      chip.classList.add("open");
      const rect = chip.getBoundingClientRect();
      openMenu(rect.left, rect.top - 8 - Math.min(sessions.length + 1, 12) * 26, sessionItems(), "Questions go to");
    });
    document.addEventListener("mousedown", (event) => menu && !event.composedPath().includes(host) && closeMenu(), true);
    document.addEventListener("keydown", (event) => event.key === "Escape" && (closeMenu(), root.querySelector(".answer")?.remove()), true);

    // A caption: the side-by-side list's lines, or the overlay's.
    const LINE = ".p-huddle_event_log__base_event, .p-huddle_closed_caption_event__wrapper";
    const textOf = (line) => line.querySelector('[data-qa="huddle_transcribe_event"], .p-huddle_closed_caption_event__transcription')?.textContent.trim() ?? "";
    const nameOf = (line) => line.querySelector(".p-huddle_event_log__member_name, .p-huddle_closed_caption_event__member_name")?.textContent.trim() ?? "";
    document.addEventListener(
      "contextmenu",
      (event) => {
        const line = event.target.closest?.(LINE);
        if (!line || !textOf(line)) return;
        event.preventDefault();
        event.stopPropagation();
        const lines = [...document.querySelectorAll(LINE)].filter((each) => textOf(each));
        const at = lines.indexOf(line);
        let speaker = "";
        for (let i = at; i >= 0 && !speaker; i--) speaker = nameOf(lines[i]);
        const before = [];
        let name = "";
        for (const each of lines.slice(Math.max(0, at - 6), at)) {
          name = nameOf(each) || name;
          before.push(`${name ? `${name}: ` : ""}${textOf(each)}`);
        }
        const question = { question: textOf(line), speaker, before };
        const ask = (chosen) => showAnswer(event.clientX, event.clientY, chosen, question);
        if (session) openMenu(event.clientX, event.clientY, [{ label: `Ask Claude (${session.title})`, run: () => ask(session) }]);
        else openMenu(event.clientX, event.clientY, sessionItems(ask), "Ask Claude in");
      },
      true,
    );

    function showAnswer(x, y, chosen, { question, speaker, before }) {
      root.querySelector(".answer")?.remove();
      const id = ++asked;
      const box = el("div", "answer");
      const top = el("div", "top");
      const close = el("button", "", "×");
      close.tabIndex = -1;
      close.addEventListener("mousedown", (event) => (event.preventDefault(), box.remove()));
      top.append(el("span", "", `Claude · ${chosen.title}`), close);
      const text = el("div", "text", "Thinking…");
      box.append(top, el("div", "q", `${speaker ? `${speaker}: ` : ""}${question}`), text);
      root.appendChild(box);
      box.style.left = `${Math.max(8, Math.min(x, innerWidth - 388))}px`;
      box.style.top = `${Math.max(8, Math.min(y, innerHeight - box.getBoundingClientRect().height - 8))}px`;
      answers.set(id, text);
      send({ type: "ask", id, sessionId: chosen.id, question, speaker, before });
    }

    // Captions rather than the Thread in the side panel, once, when the huddle starts.
    let tabbed = false;
    const started = Date.now();
    const pickCaptions = () => {
      if (tabbed || Date.now() - started > 60000) return;
      const tabs = [...document.querySelectorAll('[data-qa="tabs_item"]')];
      const captions = tabs.find((tab) => tab.textContent.trim() === "Captions");
      if (!captions) return;
      tabbed = true;
      if (captions.getAttribute("aria-selected") !== "true") captions.click();
    };
    new MutationObserver(pickCaptions).observe(document.body, { childList: true, subtree: true });
    pickCaptions();

    window.__powertoys = {
      receive(message) {
        if (message.type === "sessions") {
          sessions = message.sessions;
          session = message.session;
          showChip();
        } else if (message.type === "assigned") {
          session = message.session;
          showChip();
        } else if (message.type === "answer") {
          const text = answers.get(message.id);
          if (text) text.textContent = message.answer ?? `Couldn't ask Claude: ${message.error}`;
        }
      },
    };
  }

  // --- The main process's half -------------------------------------------------------------------------------
  const huddles = new Map(); // web contents id -> { folder, session }
  const reply = (contents, message) => !contents.isDestroyed() && contents.executeJavaScript(`window.__powertoys?.receive(${JSON.stringify(message)})`).catch(() => {});

  /** The workspace the Slack page shows (/client/T.../), and its folder. */
  function currentFolder() {
    const teamId = /\/client\/([A-Z0-9]+)/.exec(slackPage()?.getURL() ?? "")?.[1];
    return readSettings().claude?.folders?.[teamId] ?? null;
  }

  async function onMessage(contents, message) {
    const huddle = huddles.get(contents.id);
    if (!huddle) return;
    if (message.type === "hello") {
      huddle.sessions = huddle.folder ? projectSessions(huddle.folder) : [];
      reply(contents, { type: "sessions", sessions: huddle.sessions.map(({ id, title, updated }) => ({ id, title, updated })), session: huddle.session });
    } else if (message.type === "assign") {
      const chosen = huddle.sessions.find((each) => each.id === message.id);
      huddle.session = chosen ? { id: chosen.id, title: chosen.title } : null;
      reply(contents, { type: "assigned", session: huddle.session });
      log(`huddle: questions go to "${chosen?.title}"`);
    } else if (message.type === "ask") {
      const chosen = huddle.sessions.find((each) => each.id === message.sessionId);
      try {
        if (!chosen) throw new Error("that session is gone");
        const answer = await ai.askSession({
          sessionId: chosen.id,
          cwd: chosen.cwd,
          timeoutMs: 120000,
          prompt:
            `I'm on a Slack call. ${message.speaker ? `${message.speaker} asked` : "Someone asked"}: "${message.question}"\n` +
            (message.before?.length ? `Just before that:\n${message.before.map((line) => `- ${line}`).join("\n")}\n` : "") +
            "Give me a quick answer I can say out loud: two to four short sentences, plain words, from what you know here " +
            "(look at the code only if you must). Don't change anything.",
        });
        reply(contents, { type: "answer", id: message.id, answer });
      } catch (caught) {
        reply(contents, { type: "answer", id: message.id, error: caught.message });
      }
    }
  }

  // --- Headphones when a huddle rings ------------------------------------------------------------------------
  // Turns the Bluetooth radio on and has Windows connect your paired headphones (asking a paired device for its
  // services makes Windows connect to it). Windows PowerShell 5.1: PowerShell 7 can't use these Windows APIs.
  const HEADPHONES_SCRIPT = `
param([string]$Name)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait() | Out-Null; $task.Result }
[Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null
[Windows.Devices.Bluetooth.BluetoothDevice,Windows.Devices.Bluetooth,ContentType=WindowsRuntime] | Out-Null
[Windows.Devices.Enumeration.DeviceInformation,Windows.Devices.Enumeration,ContentType=WindowsRuntime] | Out-Null
Await ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus]) | Out-Null
$radio = (Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])) | Where-Object { $_.Kind -eq 'Bluetooth' }
if (-not $radio) { 'no-radio'; exit }
if ($radio.State -ne 'On') { Await ($radio.SetStateAsync('On')) ([Windows.Devices.Radios.RadioAccessStatus]) | Out-Null; Start-Sleep -Seconds 2 }
$selector = [Windows.Devices.Bluetooth.BluetoothDevice]::GetDeviceSelectorFromPairingState($true)
$paired = Await ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($selector)) ([Windows.Devices.Enumeration.DeviceInformationCollection])
$found = $paired | Where-Object { $_.Name -like "*$Name*" } | Select-Object -First 1
if (-not $found) { 'not-paired'; exit }
$device = Await ([Windows.Devices.Bluetooth.BluetoothDevice]::FromIdAsync($found.Id)) ([Windows.Devices.Bluetooth.BluetoothDevice])
for ($i = 0; $i -lt 10 -and $device.ConnectionStatus -ne 'Connected'; $i++) {
  Await ($device.GetRfcommServicesAsync([Windows.Devices.Bluetooth.BluetoothCacheMode]::Uncached)) ([Windows.Devices.Bluetooth.Rfcomm.RfcommDeviceServicesResult]) | Out-Null
  Start-Sleep -Seconds 2
}
if ($device.ConnectionStatus -eq 'Connected') { "connected $($found.Name)" } else { "not-connected $($found.Name)" }
`;
  let connecting = false;
  async function headphonesOn() {
    const { headphones = "AirPods" } = readSettings().huddle ?? {};
    if (!headphones || connecting) return;
    connecting = true;
    try {
      const script = path.join(os.tmpdir(), "powertoys-headphones.ps1");
      fs.writeFileSync(script, HEADPHONES_SCRIPT);
      const notice = (text) => slackPage()?.send("powertoys:notice", { text });
      notice(`A huddle is ringing: Bluetooth on, looking for your ${headphones}…`);
      const output = await new Promise((resolve) =>
        __webpack_require__(35317).execFile(
          "powershell.exe",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Name", headphones],
          { windowsHide: true, timeout: 60000 },
          (caught, stdout) => resolve(caught && !stdout ? `error ${caught.message}` : String(stdout).trim().split("\n").pop()),
        ),
      );
      log(`huddle ringing: headphones ${output}`);
      const [result, ...name] = output.split(" ");
      notice(
        {
          connected: `${name.join(" ")} connected.`,
          "not-connected": `${name.join(" ")} didn't connect: take them out of the case, or connect them in Windows' Bluetooth settings.`,
          "not-paired": `No paired Bluetooth device named "${headphones}": pair them once in Windows' Bluetooth settings.`,
          "no-radio": "This computer has no Bluetooth radio Powertoys can turn on.",
        }[result] ?? `Couldn't turn on Bluetooth: ${output}`,
      );
    } finally {
      connecting = false;
    }
  }

  // --- Watching the windows Slack's page opens -----------------------------------------------------------------
  // A small watcher in each: it says when the window shows a huddle (then the huddle script goes in) and when an
  // incoming huddle rings (the invite window, .p-huddle_invite).
  function watcherScript() {
    if (window.__powertoysWatch || location.protocol === "https:") return true;
    window.__powertoysWatch = true;
    const send = (message) => console.debug(`powertoys:huddle ${JSON.stringify(message)}`);
    let huddle = false;
    let ringing = false;
    const check = () => {
      if (!huddle && document.querySelector('[data-qa="huddle_window_content_container"]')) {
        huddle = true;
        send({ type: "huddle" });
      }
      const now = !!document.querySelector(".p-huddle_invite");
      if (now && !ringing) send({ type: "ringing" });
      ringing = now;
    };
    new MutationObserver(check).observe(document.documentElement, { childList: true, subtree: true });
    check();
    return true;
  }

  function watchWindow(contents) {
    contents.on("console-message", (event) => {
      const text = event.message ?? "";
      if (!text.startsWith("powertoys:huddle ")) return;
      let message;
      try {
        message = JSON.parse(text.slice("powertoys:huddle ".length));
      } catch {
        return;
      }
      if (message.type === "ringing") return headphonesOn().catch((caught) => warn(`headphones: ${caught.message}`));
      if (message.type === "huddle") return addClaude(contents).catch((caught) => warn(`huddle: ${caught.message}`));
      onMessage(contents, message).catch((caught) => warn(`huddle: ${caught.message}`));
    });
    contents.once("destroyed", () => huddles.delete(contents.id));
    // The window is about:blank until Slack's page draws in it; the watcher goes in as soon as it can run.
    let tries = 0;
    const timer = setInterval(async () => {
      if (contents.isDestroyed() || ++tries > 20) return clearInterval(timer);
      if (await contents.executeJavaScript(`(${watcherScript.toString()})()`, true).catch(() => false)) clearInterval(timer);
    }, 500);
  }

  async function addClaude(contents) {
    huddles.set(contents.id, { folder: currentFolder(), session: null, sessions: [] });
    await contents.executeJavaScript(`(${huddleWindowScript.toString()})()`, true);
    log(`huddle window: Claude added (folder ${huddles.get(contents.id)?.folder ?? "none"})`);
  }

  exports.start = function start() {
    // The windows Slack's page opens (huddle, incoming call); the watcher leaves its main window alone.
    electron.app.on("web-contents-created", (event, contents) => {
      if (contents.getType() === "window") watchWindow(contents);
    });
  };
});
