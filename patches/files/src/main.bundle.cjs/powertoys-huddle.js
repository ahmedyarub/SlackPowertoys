// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): huddles and Claude. Slack draws a huddle's window itself (an about:blank window its page
// opened), so Powertoys adds a script to it once the huddle shows there:
//   - the window opens maximized, and its side panel shows Captions rather than the huddle's Thread;
//   - a "Claude session" dropdown, always in view (in the Captions list's header), picks one of the Claude Code
//     sessions of the workspace's folder (Claude Desktop's or the CLI's, worktrees included, from ~/.claude/projects),
//     or "(New session)", the default, started with the first question;
//   - double-click a caption (or right-click it, "Ask Claude"): the question is asked in that session itself (it
//     stays there, with the answer), and the answer shows in a pop-up.
// Each huddle is recorded to a file (the window, the call's sound, your microphone); when it ends, Slack asks whether
// to keep it ("huddle": { "autoRecord": true, "recordingsFolder": "<folder>" }).
// When a huddle starts or rings, the Bluetooth radio goes on and Windows connects your paired headphones (the paired
// device registered as headphones or a headset; "huddle": { "headphones": "<part of a name>" } picks one; null: off).
// The scripts talk to the main process through tagged console messages; answers go back with executeJavaScript.
// ---------------------------------------------------------------------------------------------
(function (module, exports, __webpack_require__) {
  "use strict";

  const electron = __webpack_require__(84157);
  const fs = __webpack_require__(79896);
  const path = __webpack_require__(16928);
  const os = __webpack_require__(48161);
  const { log, warn, readSettings, slackPage, powertoysDir, api, signedInTeams } = __webpack_require__("powertoys/main");
  const ai = __webpack_require__("powertoys/ai");
  const claude = __webpack_require__("powertoys/claude");

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
      .rec { bottom: 102px; }
      .rec.on { opacity: 1; color: #fff; background: #e01e5a; }
      .menu { position: fixed; z-index: 2147483647; min-width: 240px; max-width: 360px; max-height: 50vh; overflow: auto; padding: 4px 0;
        border-radius: 8px; background: #222529; color: #d1d2d3; box-shadow: 0 0 0 1px rgba(255,255,255,.13), 0 4px 12px rgba(0,0,0,.4); }
      .menu .head { padding: 4px 12px; opacity: .6; }
      .menu .item { padding: 5px 12px; cursor: default; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .menu .item:hover { background: #1264a3; color: #fff; }
      .menu .item .when { opacity: .55; margin-left: 6px; }
      .ask { position: fixed; z-index: 2147483647; padding: 4px 10px; border: 0; border-radius: 6px; background: #1264a3;
        color: #fff; font-weight: 700; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.4); }
      .answer { position: fixed; z-index: 2147483647; width: 420px; max-height: 60vh; display: flex; flex-direction: column;
        border-radius: 8px; background: #222529; color: #d1d2d3; box-shadow: 0 0 0 1px rgba(255,255,255,.13), 0 8px 24px rgba(0,0,0,.5); }
      .answer[hidden] { display: none; }
      .answer .top { display: flex; justify-content: space-between; gap: 8px; padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,.1); cursor: move; user-select: none; }
      .answer .top span { opacity: .7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .answer .top button { background: none; border: 0; color: #d1d2d3; font-size: 16px; line-height: 1; cursor: pointer; }
      .answer .log { flex: 1 1 auto; min-height: 0; overflow: auto; padding-bottom: 6px; }
      .answer .q { padding: 8px 12px 0; opacity: .7; font-style: italic; white-space: pre-wrap; }
      .answer .text { padding: 6px 12px 4px; font-size: 14px; }
      .answer .text p { margin: 0 0 6px; }
      .answer .text .md-heading { font-weight: 700; margin: 8px 0 4px; }
      .answer .text ul, .answer .text ol { margin: 0 0 6px; padding-left: 20px; }
      .answer .text code { font-family: Consolas, monospace; background: rgba(255,255,255,.08); padding: 0 3px; border-radius: 3px; }
      .answer .type { margin: 6px 10px 10px; resize: vertical; font: inherit; font-size: 13px; color: #fff; background: #1a1d21;
        border: 1px solid rgba(255,255,255,.2); border-radius: 6px; padding: 6px 8px; }
      .answer .type:focus-visible, .bar button:focus-visible { outline: 2px solid #1d9bd1; outline-offset: 1px; }
      .bar button { font: inherit; color: #fff; background: #1264a3; border: 0; border-radius: 6px; padding: 2px 10px; cursor: pointer; }
    </style>`;
    document.body.appendChild(host);
    const el = (tag, className, text) => Object.assign(document.createElement(tag), className ? { className } : {}, text !== undefined ? { textContent: text } : {});
    // Claude's Markdown as elements (headings, lists, bold, code), node by node: no HTML from the text.
    const markdown = (text) => {
      const fragment = document.createDocumentFragment();
      const inline = (parent, line) => {
        for (const piece of line.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
          if (/^\*\*[^*]+\*\*$/.test(piece)) parent.append(el("strong", "", piece.slice(2, -2)));
          else if (/^`[^`]+`$/.test(piece)) parent.append(el("code", "", piece.slice(1, -1)));
          else if (piece) parent.append(piece);
        }
        return parent;
      };
      let list = null;
      for (const line of text.split("\n")) {
        const item = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
        if (item) {
          if (!list) fragment.append((list = el(/^\s*\d/.test(line) ? "ol" : "ul")));
          list.append(inline(el("li"), item[1]));
          continue;
        }
        list = null;
        const heading = /^#{1,6}\s+(.*)$/.exec(line);
        if (heading) fragment.append(inline(el("div", "md-heading"), heading[1]));
        else if (line.trim()) fragment.append(inline(el("p"), line));
      }
      return fragment;
    };

    let session = { id: "new", title: "(New session)" };
    let sessions = [];
    let asked = 0;
    const answers = new Map();

    // The session questions go to: a dropdown always in view, in the Captions list's header (under "Captions are being
    // generated in …"), or at the bottom left while that list isn't showing. "(New session)" (the default) starts a
    // session in the workspace's folder with the first question; its name follows the one Claude gives it.
    const NEW = { id: "new", title: "(New session)" };
    const barHost = document.createElement("div");
    barHost.dataset.powertoys = "session";
    const barRoot = barHost.attachShadow({ mode: "open" });
    barRoot.innerHTML = `<style>
      * { box-sizing: border-box; font: 12px/1.4 Lato, "Segoe UI", sans-serif; }
:host { display: block; max-width: 100%; }
      .bar { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin: 6px 0 2px; color: #d1d2d3; max-width: 100%; }
      .bar select { flex: 1 1 160px; min-width: 0; }
      :host(.floating) .bar { position: fixed; z-index: 2147483646; left: 10px; bottom: 76px; max-width: 420px; margin: 0; padding: 3px 4px 3px 9px;
        border-radius: 999px; background: rgba(0,0,0,.45); }
      label { opacity: .8; }
      select { max-width: 100%; font: inherit; color: #fff; background: #222529; border: 1px solid rgba(255,255,255,.2); border-radius: 6px; padding: 2px 4px; }
      button { font: inherit; color: #fff; background: #1264a3; border: 0; border-radius: 6px; padding: 2px 10px; cursor: pointer; }
      select:focus-visible, button:focus-visible { outline: 2px solid #1d9bd1; outline-offset: 1px; }
    </style>`;
    const bar = el("div", "bar");
    const label = Object.assign(el("label", "", "Claude session:"), { htmlFor: "powertoys-session" });
    const picker = Object.assign(el("select"), { id: "powertoys-session", title: "The Claude Code session that answers questions from the captions" });
    const popupPlace = () => {
      const rect = bar.getBoundingClientRect();
      return [rect.left, rect.bottom + 8 + 300 > innerHeight ? rect.top - 350 : rect.bottom + 8];
    };
    // "Ask": the pop-up with nothing from the captions, to type a question.
    const askNow = el("button", "", "Ask");
    askNow.title = "Type a question to the session";
    askNow.addEventListener("click", () => openTalk(...popupPlace(), session).input.focus());
    // "Conversation": the pop-up again, as it was (after closing it by mistake), without asking anything.
    const showTalk = el("button", "", "Conversation");
    showTalk.title = "Show the questions and answers so far";
    showTalk.addEventListener("click", () => openTalk(...popupPlace(), session));
    bar.append(label, picker, askNow, showTalk);
    barRoot.append(bar);
    const showChip = () => {
      picker.replaceChildren(Object.assign(el("option", "", NEW.title), { value: NEW.id, selected: session.id === NEW.id }));
      for (const each of sessions) picker.append(Object.assign(el("option", "", `${each.title} · ${ago(each.updated)}`), { value: each.id, selected: each.id === session.id }));
    };
    picker.addEventListener("change", () => {
      if (picker.value === NEW.id) session = NEW;
      send({ type: "assign", id: picker.value });
    });
    // Keys typed in it stay here.
    for (const target of [host, barHost]) for (const type of ["keydown", "keypress", "keyup"]) target.addEventListener(type, (event) => event.stopPropagation());
    const mountBar = () => {
      const header = document.querySelector(".p-huddle_event_log__header_inner");
      const place = header ?? document.body;
      barHost.classList.toggle("floating", !header);
      if (barHost.parentNode !== place) place.appendChild(barHost);
    };
    new MutationObserver(mountBar).observe(document.body, { childList: true, subtree: true });
    mountBar();
    send({ type: "hello" });

    // Recording: the window, the call's sound and your microphone, to a file (see the main process's half).
    const rec = el("button", "chip rec", "● Rec");
    rec.tabIndex = -1;
    let recordingSince = null;
    const showRec = () => {
      const seconds = recordingSince ? Math.floor((Date.now() - recordingSince) / 1000) : 0;
      rec.textContent = recordingSince ? `● ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` : "● Rec";
      rec.classList.toggle("on", !!recordingSince);
    };
    setInterval(() => recordingSince && showRec(), 1000);
    rec.addEventListener("mousedown", (event) => (event.preventDefault(), (rec.disabled = true), send({ type: "record" })));
    root.appendChild(rec);

    let menu = null;
    const closeMenu = () => (menu?.remove(), (menu = null));
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

    document.addEventListener("mousedown", (event) => menu && !event.composedPath().includes(host) && closeMenu(), true);
    document.addEventListener("keydown", (event) => event.key === "Escape" && (closeMenu(), hideTalk()), true);

    // A caption: the side-by-side list's lines, or the overlay's.
    const LINE = ".p-huddle_event_log__base_event, .p-huddle_closed_caption_event__wrapper";
    const textOf = (line) => line.querySelector('[data-qa="huddle_transcribe_event"], .p-huddle_closed_caption_event__transcription')?.textContent.trim() ?? "";
    const nameOf = (line) => line.querySelector(".p-huddle_event_log__member_name, .p-huddle_closed_caption_event__member_name")?.textContent.trim() ?? "";
    /** A caption line as a question, with who said it and the lines before it. */
    function questionAt(line) {
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
      return { question: textOf(line), speaker, before };
    }
    const captionLine = (event) => {
      const line = event.target.closest?.(LINE);
      return line && textOf(line) ? line : null;
    };
    // Double-click a caption: asked at once (in the session chosen, or after choosing one); no text gets selected.
    document.addEventListener("mousedown", (event) => event.detail > 1 && captionLine(event) && event.preventDefault(), true);
    document.addEventListener(
      "dblclick",
      (event) => {
        const line = captionLine(event);
        if (!line) return;
        event.preventDefault();
        getSelection()?.removeAllRanges();
        const question = questionAt(line);
        const ask = (chosen) => showAnswer(event.clientX, event.clientY, chosen, question);
        if (session) ask(session);
        else openMenu(event.clientX, event.clientY, sessionItems(ask), "Ask Claude in");
      },
      true,
    );
    /** Caption lines selected with the mouse, whole, with who said them (and the lines before), or null. */
    function selectedQuestion() {
      const selection = getSelection();
      if (!selection || selection.isCollapsed) return null;
      const lines = [...document.querySelectorAll(LINE)].filter((each) => textOf(each));
      const chosen = lines.filter((line) => selection.containsNode(line, true));
      if (!chosen.length) return null;
      const said = [];
      let name = "";
      for (let i = 0; i <= lines.indexOf(chosen.at(-1)); i++) {
        name = nameOf(lines[i]) || name;
        if (chosen.includes(lines[i])) said.push(`${name ? `${name}: ` : ""}${textOf(lines[i])}`);
      }
      const { before } = questionAt(chosen[0]);
      return chosen.length === 1 ? questionAt(chosen[0]) : { question: said.join("\n"), speaker: "", before, selection: true };
    }
    const askIn = (x, y, question) => {
      const ask = (chosen) => showAnswer(x, y, chosen, question);
      if (session) ask(session);
      else openMenu(x, y, sessionItems(ask), "Ask Claude in");
    };
    // Captions selected with the mouse: an "Ask Claude" button beside them sends them all.
    let askButton = null;
    const dropAskButton = () => (askButton?.remove(), (askButton = null));
    document.addEventListener("mousedown", (event) => !event.composedPath().includes(host) && dropAskButton(), true);
    document.addEventListener(
      "mouseup",
      (event) =>
        setTimeout(() => {
          const question = selectedQuestion();
          if (!question?.selection) return;
          dropAskButton();
          askButton = el("button", "ask", "Ask Claude");
          askButton.tabIndex = -1;
          askButton.style.left = `${Math.min(event.clientX + 8, innerWidth - 110)}px`;
          askButton.style.top = `${Math.max(8, event.clientY - 34)}px`;
          askButton.addEventListener("mousedown", (down) => {
            down.preventDefault();
            dropAskButton();
            askIn(event.clientX, event.clientY, question);
          });
          root.appendChild(askButton);
        }),
      true,
    );

    // Right-click a caption (or a selection of them): the same, from a menu.
    document.addEventListener(
      "contextmenu",
      (event) => {
        const line = captionLine(event);
        if (!line) return;
        event.preventDefault();
        event.stopPropagation();
        const question = selectedQuestion() ?? questionAt(line);
        const ask = (chosen) => showAnswer(event.clientX, event.clientY, chosen, question);
        if (session) openMenu(event.clientX, event.clientY, [{ label: `Ask Claude (${session.title})`, run: () => ask(session) }]);
        else openMenu(event.clientX, event.clientY, sessionItems(ask), "Ask Claude in");
      },
      true,
    );

    // The pop-up: the exchanges with the session, and a box to type a question or a reply (Enter sends, Shift+Enter
    // starts a new line). It stays open (×, or Esc) and keeps its place.
    // Closing only hides it ("Conversation" shows it again); it is dragged by its title bar and keeps its place.
    let talk = null;
    let placed = null;
    const hideTalk = () => talk && (talk.box.hidden = true);
    function openTalk(x, y, chosen) {
      if (talk && talk.session.id === chosen.id) {
        talk.box.hidden = false;
        return talk;
      }
      talk?.box.remove();
      const box = el("div", "answer");
      const top = el("div", "top");
      const close = el("button", "", "×");
      close.tabIndex = -1;
      close.title = "Close (\"Conversation\" shows it again)";
      close.addEventListener("mousedown", (event) => (event.preventDefault(), event.stopPropagation(), hideTalk()));
      const title = el("span", "", `Claude · ${chosen.title}`);
      top.append(title, close);
      top.addEventListener("mousedown", (down) => {
        if (down.button !== 0) return;
        down.preventDefault();
        const rect = box.getBoundingClientRect();
        const dx = down.clientX - rect.left;
        const dy = down.clientY - rect.top;
        const move = (event) => {
          placed = { left: Math.max(0, Math.min(event.clientX - dx, innerWidth - 60)), top: Math.max(0, Math.min(event.clientY - dy, innerHeight - 40)) };
          box.style.left = `${placed.left}px`;
          box.style.top = `${placed.top}px`;
        };
        const up = () => (document.removeEventListener("mousemove", move, true), document.removeEventListener("mouseup", up, true));
        document.addEventListener("mousemove", move, true);
        document.addEventListener("mouseup", up, true);
      });
      const log = el("div", "log");
      log.setAttribute("aria-live", "polite");
      const input = Object.assign(el("textarea", "type"), { rows: 2, placeholder: "Type a question or a reply… (Enter sends)" });
      input.setAttribute("aria-label", `Ask ${chosen.title}`);
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.shiftKey || event.isComposing || !input.value.trim()) return;
        event.preventDefault();
        ask(talk, { question: input.value.trim(), typed: true });
        input.value = "";
      });
      box.append(top, log, input);
      root.appendChild(box);
      box.style.left = `${placed?.left ?? Math.max(8, Math.min(x, innerWidth - 428))}px`;
      box.style.top = `${placed?.top ?? Math.max(8, Math.min(y, innerHeight * 0.4 - 8))}px`;
      talk = { box, log, input, title, session: chosen };
      return talk;
    }
    function ask(where, { question, speaker = "", before = [], selection = false, typed = false }) {
      const id = ++asked;
      where.log.append(el("div", "q", typed ? `You: ${question}` : `${speaker ? `${speaker}: ` : ""}${question}`));
      const text = el("div", "text", "Thinking…");
      where.log.append(text);
      where.log.scrollTop = where.log.scrollHeight;
      answers.set(id, { text, log: where.log });
      send({ type: "ask", id, sessionId: where.session.id, question, speaker, before, selection, typed });
    }
    function showAnswer(x, y, chosen, question) {
      ask(openTalk(x, y, chosen), question);
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
          session = message.session ?? NEW;
          if (talk && (talk.session.id === NEW.id || talk.session.id === session.id)) {
            talk.session = session;
            talk.title.textContent = `Claude · ${session.title}`;
          }
          showChip();
        } else if (message.type === "assigned") {
          session = message.session ?? NEW;
          showChip();
        } else if (message.type === "recording") {
          rec.disabled = false;
          recordingSince = message.since ?? null;
          showRec();
        } else if (message.type === "answer") {
          const answer = answers.get(message.id);
          if (answer) {
            if (message.answer) answer.text.replaceChildren(markdown(message.answer));
            else answer.text.textContent = `Couldn't ask Claude: ${message.error}`;
            answer.log.scrollTop = answer.log.scrollHeight;
          }
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

  /** The folder's sessions to the huddle window (a session started from the huddle shows even before it has a name). */
  function sendSessions(contents, huddle) {
    huddle.sessions = huddle.folder ? projectSessions(huddle.folder) : [];
    for (const id of huddle.created) {
      if (!huddle.sessions.some((each) => each.id === id)) huddle.sessions.unshift({ id, title: "(New session)", cwd: huddle.folder, updated: Date.now() });
    }
    if (huddle.session) huddle.session = { id: huddle.session.id, title: huddle.sessions.find((each) => each.id === huddle.session.id)?.title ?? huddle.session.title };
    reply(contents, { type: "sessions", sessions: huddle.sessions.map(({ id, title, updated }) => ({ id, title, updated })), session: huddle.session });
  }

  async function onMessage(contents, message) {
    const huddle = huddles.get(contents.id);
    if (!huddle) return;
    if (message.type === "hello") {
      sendSessions(contents, huddle);
    } else if (message.type === "assign") {
      // "new": a session is started with the next question.
      const chosen = huddle.sessions.find((each) => each.id === message.id);
      huddle.session = chosen ? { id: chosen.id, title: chosen.title } : null;
      reply(contents, { type: "assigned", session: huddle.session });
      log(`huddle: questions go to "${chosen?.title ?? "a new session"}"`);
    } else if (message.type === "record") {
      if (recordings.has(contents.id)) await stopRecording(contents, false);
      else await startRecording(contents);
    } else if (message.type === "ask") {
      const fresh = message.sessionId === "new";
      const chosen = huddle.sessions.find((each) => each.id === message.sessionId);
      try {
        if (!fresh && !chosen) throw new Error("that session is gone");
        const prompt = message.typed
          ? `(Still on the Slack call; I typed this.) ${message.question}\n` +
            "Answer quickly, in a few short sentences, plain words (look at the code only if you must). Don't change anything."
          : (message.selection
              ? `I'm on a Slack call. This part of it, from the captions:\n${message.question}\n`
              : `I'm on a Slack call. ${message.speaker ? `${message.speaker} asked` : "Someone asked"}: "${message.question}"\n`) +
            (message.before?.length ? `Just before that:\n${message.before.map((line) => `- ${line}`).join("\n")}\n` : "") +
            "Give me a quick answer I can say out loud: two to four short sentences, plain words, from what you know here " +
            "(look at the code only if you must). Don't change anything.";
        // Answered by the fast model (huddle.answerModel, default the AI settings' fast model); a session too long for
        // it goes to Sonnet.
        const model = readSettings().huddle?.answerModel || ai.fastModel();
        let answer;
        if (fresh) {
          // A new session in the workspace's folder, which the next questions go to.
          if (!huddle.folder) throw new Error("this workspace has no folder linked");
          const started = await ai.askNew({ cwd: huddle.folder, timeoutMs: 120000, model, prompt });
          answer = started.text;
          huddle.created.add(started.sessionId);
          huddle.session = { id: started.sessionId, title: "(New session)" };
          log(`huddle: started session ${started.sessionId}`);
        } else {
          const ask = (useModel) => ai.askSession({ sessionId: chosen.id, cwd: chosen.cwd, timeoutMs: 120000, model: useModel, prompt });
          answer = await ask(model).catch((caught) => {
            if (model === "sonnet" || !/too long|context|token/i.test(caught.message)) throw caught;
            warn(`huddle: ${model} couldn't take the session (${caught.message}); asking Sonnet`);
            return ask("sonnet");
          });
        }
        reply(contents, { type: "answer", id: message.id, answer });
        // The list again: a new session's name, once Claude has given it one.
        sendSessions(contents, huddle);
        setTimeout(() => !contents.isDestroyed() && sendSessions(contents, huddle), 20000);
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
$found = $null
if ($Name) { $found = $paired | Where-Object { $_.Name -like "*$Name*" } | Select-Object -First 1 }
if (-not $found) {
  # The paired device Windows registered as headphones or a headset, whatever its name: its Bluetooth class (kept for
  # each paired device) is Audio/Video, headsets, hands-free and headphones first.
  $audio = foreach ($key in Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\BTHPORT\\Parameters\\Devices' -ErrorAction SilentlyContinue) {
    $cod = (Get-ItemProperty $key.PSPath -Name COD -ErrorAction SilentlyContinue).COD
    if ($cod -eq $null -or (($cod -shr 8) -band 0x1F) -ne 4) { continue }
    $address = ($key.PSChildName -replace '(..)(?!$)', '$1:').ToLower()
    $info = $paired | Where-Object { $_.Id.ToLower().EndsWith($address) } | Select-Object -First 1
    if ($info) { [pscustomobject]@{ Info = $info; Minor = ($cod -shr 2) -band 0x3F } }
  }
  $found = ($audio | Sort-Object { if (@(1, 2, 6) -contains $_.Minor) { 0 } else { 1 } } | Select-Object -First 1).Info
}
if (-not $found) { 'not-paired'; exit }
$device = Await ([Windows.Devices.Bluetooth.BluetoothDevice]::FromIdAsync($found.Id)) ([Windows.Devices.Bluetooth.BluetoothDevice])
if ($device.ConnectionStatus -eq 'Connected') { "already $($found.Name)"; exit }
for ($i = 0; $i -lt 10 -and $device.ConnectionStatus -ne 'Connected'; $i++) {
  Await ($device.GetRfcommServicesAsync([Windows.Devices.Bluetooth.BluetoothCacheMode]::Uncached)) ([Windows.Devices.Bluetooth.Rfcomm.RfcommDeviceServicesResult]) | Out-Null
  Start-Sleep -Seconds 2
}
if ($device.ConnectionStatus -eq 'Connected') { "connected $($found.Name)" } else { "not-connected $($found.Name)" }
`;
  // When a huddle starts (yours, one you join, or one ringing): "huddle": { "headphones": "" } picks the paired device
  // Windows registered as headphones or a headset, whatever its name; a name picks that device; null turns it off.
  let connecting = false;
  async function headphonesOn(why) {
    const { headphones = "" } = readSettings().huddle ?? {};
    if (headphones === null || connecting) return;
    connecting = true;
    try {
      const script = path.join(os.tmpdir(), "powertoys-headphones.ps1");
      fs.writeFileSync(script, HEADPHONES_SCRIPT);
      const notice = (text) => slackPage()?.send("powertoys:notice", { text });
      const output = await new Promise((resolve) =>
        __webpack_require__(35317).execFile(
          "powershell.exe",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...(headphones ? ["-Name", headphones] : [])],
          { windowsHide: true, timeout: 60000 },
          (caught, stdout) => resolve(caught && !stdout ? `error ${caught.message}` : String(stdout).trim().split("\n").pop()),
        ),
      );
      log(`huddle ${why}: headphones ${output}`);
      const [result, ...name] = output.split(" ");
      if (result === "already") return;
      notice(
        {
          connected: `Bluetooth on; ${name.join(" ")} connected.`,
          "not-connected": `Bluetooth on, but ${name.join(" ")} didn't connect: take them out of the case, or connect them in Windows' Bluetooth settings.`,
          "not-paired": headphones ? `No paired Bluetooth device named "${headphones}".` : "No paired Bluetooth headphones: pair them once in Windows' Bluetooth settings.",
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
    if (window.__powertoysWatch) return true;
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
      if (message.type === "ringing") return headphonesOn("ringing").catch((caught) => warn(`headphones: ${caught.message}`));
      if (message.type === "huddle") return addClaude(contents).catch((caught) => warn(`huddle: ${caught.message}`));
      onMessage(contents, message).catch((caught) => warn(`huddle: ${caught.message}`));
    });
    contents.once("destroyed", () => {
      huddles.delete(contents.id);
      stopRecording(contents, true).catch((caught) => warn(`recording: ${caught.message}`));
    });
    // The window is about:blank until Slack's page draws in it; the watcher goes in as soon as it can run.
    // (A window Slack's page opens says it is at the page's address from inside, so its main window is told apart
    // here, where it is the one at https://.)
    let tries = 0;
    const timer = setInterval(async () => {
      if (contents.isDestroyed() || ++tries > 20 || contents.getURL().startsWith("https://")) return clearInterval(timer);
      if (await contents.executeJavaScript(`(${watcherScript.toString()})()`, true).catch(() => false)) clearInterval(timer);
    }, 500);
  }

  async function addClaude(contents) {
    huddles.set(contents.id, { folder: currentFolder(), session: null, sessions: [], created: new Set() });
    // The huddle window opens maximized.
    const huddleWindow = electron.BrowserWindow.fromWebContents(contents);
    if (huddleWindow && !huddleWindow.isMaximized()) huddleWindow.maximize();
    headphonesOn("started").catch((caught) => warn(`headphones: ${caught.message}`));
    await contents.executeJavaScript(`(${huddleWindowScript.toString()})()`, true);
    log(`huddle window: Claude added (folder ${huddles.get(contents.id)?.folder ?? "none"})`);
    if (readSettings().huddle?.autoRecord !== false) startRecording(contents).catch((caught) => warn(`recording: ${caught.message}`));
  }

  // --- Recording a huddle --------------------------------------------------------------------------------------
  // Every huddle is recorded (huddle.autoRecord, default true; "● Rec" in the huddle window stops and starts it): the
  // huddle window's picture, the call's sound (Slack's own, nothing else) and your microphone, mixed, to .mkv in
  // huddle.recordingsFolder (default powertoys\recordings). When the huddle ends, Slack asks whether to keep it.
  //
  // A recording must never be lost or corrupted, so:
  //   - a hidden window of Powertoys' own records (MediaRecorder) the huddle window, the sound of Slack's page and of
  //     the huddle window (no other app's sound) and your microphone; every half second the main process takes what it
  //     recorded (H.264 from the graphics card's encoder), appends it to the file and flushes it to the disk (fsync):
  //     a crash loses at most about a second, and Matroska cut short still plays; the whole part is also kept in
  //     memory (while 8 GB stays free), so a refused write loses nothing;
  //   - <recording>.json beside it says whether it is still recording; one left "recording" or "stopped" by a crash
  //     or a quit is finished and offered again the next time Slack starts;
  //   - if the recorder fails (its page crashes, MediaRecorder errs, the disk refuses a write), a new part starts at
  //     once (in Powertoys' own folder if the disk was the problem), so the rest of the call is still recorded;
  //   - when it stops, ffmpeg (when there is one) rewrites each part with its duration and index into a copy, which
  //     replaces the part only once ffprobe reads the copy back as complete;
  //   - quitting Slack while recording finishes the recording first; "Delete" moves it to the Recycle Bin.
  // Slack closes any window without the sandbox and context isolation, so the recorder has no Node; it loads a local
  // page, as only a secure context may capture.
  const recordings = new Map(); // huddle window's web contents id -> recording
  const fallbackFolder = () => path.join(powertoysDir(), "recordings");
  const recordingsFolder = () => readSettings().huddle?.recordingsFolder || fallbackFolder();
  const execFile = (command, args) =>
    new Promise((resolve, reject) =>
      __webpack_require__(35317).execFile(command, args, { windowsHide: true, timeout: 30 * 60000 }, (caught, stdout, stderr) =>
        caught ? reject(new Error(String(stderr || caught.message).trim().split("\n").pop())) : resolve(String(stdout)),
      ),
    );

  /** Writes a recording's status file (via a temporary file, so it is never half written). */
  function writeStatus(recording, status) {
    recording.status = status;
    const json = `${recording.base}.json`;
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(json, "utf8"));
    } catch {}
    const fields = { status, where: recording.where, since: recording.since, parts: recording.parts, teamId: recording.teamId ?? saved.teamId ?? null };
    fs.writeFileSync(`${json}.tmp`, JSON.stringify({ ...saved, ...fields }, null, 2));
    fs.renameSync(`${json}.tmp`, json);
  }

  // Two captures (the main process answers them: the huddle window's picture with the sound of Slack's page, then
  // the sound of the huddle window), so the call is heard wherever Slack plays it, and nothing else on the computer.
  function recorderScript() {
    return (async () => {
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
      const second = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      second.getVideoTracks().forEach((track) => track.stop());
      let mic = null;
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {}
      const context = new AudioContext();
      const mix = context.createMediaStreamDestination();
      for (const source of [screen, second, mic]) if (source?.getAudioTracks().length) context.createMediaStreamSource(source).connect(mix);
      const stream = new MediaStream([...screen.getVideoTracks(), ...mix.stream.getAudioTracks()]);
      // H.264 is encoded by the graphics card (Media Foundation: NVENC, Quick Sync); VP8 only where it can't be.
      const mimeType = ["video/webm;codecs=h264,opus", "video/webm;codecs=vp8,opus"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8000000 });
      const chunks = [];
      let failed = null;
      recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
      recorder.onerror = (event) => (failed = event.error?.message ?? "MediaRecorder failed");
      // What was recorded since the last call, as base64, and whether the recorder failed.
      window.takeRecorded = async () => {
        const blob = new Blob(chunks.splice(0));
        let data = "";
        if (blob.size) {
          const url = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          });
          data = url.slice(url.indexOf(",") + 1);
        }
        return { data, failed };
      };
      window.stopRecording = () =>
        new Promise((resolve) => {
          if (recorder.state === "inactive") return resolve(true);
          recorder.onstop = () => {
            for (const track of [...screen.getTracks(), ...second.getTracks(), ...(mic?.getTracks() ?? [])]) track.stop();
            resolve(true);
          };
          recorder.stop();
        });
      recorder.start(500);
      return { sound: screen.getAudioTracks().length + second.getAudioTracks().length > 0, mic: !!mic, mimeType };
    })();
  }

  /** Starts a part: a recorder window and a file of its own. */
  async function startPart(recording) {
    const huddleWindow = !recording.contents.isDestroyed() && electron.BrowserWindow.fromWebContents(recording.contents);
    if (!huddleWindow) throw new Error("the huddle window is gone");
    const number = recording.parts.length + 1;
    const file = `${recording.base}${number > 1 ? ` (part ${number})` : ""}.mkv`;
    const part = { file, fd: fs.openSync(file, "a"), recorder: null, timer: null, crashed: false, busy: null, copy: [], copying: true };
    recording.part = part;
    recording.parts.push(file);
    writeStatus(recording, "recording");
    part.recorder = new electron.BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, partition: "powertoys-recorder" } });
    part.recorder.webContents.on("render-process-gone", (event, details) => {
      part.crashed = true;
      partFailed(recording, part, `the recorder's page is gone (${details.reason})`);
    });
    const page = path.join(os.tmpdir(), "powertoys-recorder.html");
    fs.writeFileSync(page, "<!doctype html><title>Powertoys recorder</title>");
    await part.recorder.loadFile(page);
    part.recorder.webContents.on("console-message", (event) => event.level === "error" && warn(`recorder: ${event.message}`));
    // The recorder's two captures, answered in order: the huddle window with Slack's page's sound, then the huddle
    // window's own sound.
    const source = (await electron.desktopCapturer.getSources({ types: ["window"] })).find((each) => each.id === huddleWindow.getMediaSourceId());
    if (!source) throw new Error("the huddle window can't be captured");
    const answers = [{ video: source, audio: slackPage()?.mainFrame ?? recording.contents.mainFrame }, { video: source, audio: recording.contents.mainFrame }];
    electron.session.fromPartition("powertoys-recorder").setDisplayMediaRequestHandler((request, callback) => callback(answers.shift() ?? {}));
    const got = await inRecorder(part, `(${recorderScript.toString()})()`, 15000);
    // One take at a time, so the pieces reach the file in order.
    part.timer = setInterval(() => {
      if (part.busy) return;
      part.busy = writeRecorded(recording, part)
        // (after this take has settled: the new part waits for it)
        .catch((caught) => setTimeout(() => partFailed(recording, part, caught.message)))
        .finally(() => (part.busy = null));
    }, 500);
    log(`recording the huddle in ${recording.where} to ${file} (${got.mimeType}, call sound ${got.sound ? "yes" : "no"}, microphone ${got.mic ? "yes" : "no"})`);
  }

  /** Runs a script in a part's recorder, giving up after `ms` (a crashed page never answers). */
  function inRecorder(part, script, ms = 3000) {
    if (part.crashed || part.recorder.isDestroyed()) return Promise.reject(new Error("the recorder is gone"));
    return Promise.race([
      part.recorder.webContents.executeJavaScript(script, true),
      new Promise((resolve, reject) => setTimeout(() => reject(new Error("the recorder didn't answer")), ms)),
    ]);
  }

  /**
   * Appends what the part's recorder has to its file and flushes it to the disk. The whole part is also kept in
   * memory while plenty is free (8 GB): if the disk refuses a write, the part is written again, whole, to Powertoys'
   * own folder and goes on there, so nothing recorded is lost.
   */
  async function writeRecorded(recording, part) {
    const { data, failed } = await inRecorder(part, "window.takeRecorded()");
    if (data) {
      const piece = Buffer.from(data, "base64");
      if (part.copying && os.freemem() < 8 * 1024 ** 3) {
        part.copying = false;
        part.copy = [];
        warn("recording: less than 8 GB of memory free, so the in-memory copy stops");
      }
      if (part.copying) part.copy.push(piece);
      try {
        fs.writeSync(part.fd, piece);
        fs.fsyncSync(part.fd);
      } catch (caught) {
        if (!part.copying) throw new Error(`couldn't write ${part.file}: ${caught.message}`);
        moveToFallback(recording, part, caught);
      }
    }
    if (failed) throw new Error(failed);
  }

  /** The disk refused a write: the part, whole from memory, goes on in Powertoys' own folder. */
  function moveToFallback(recording, part, caught) {
    fs.mkdirSync(fallbackFolder(), { recursive: true });
    const file = path.join(fallbackFolder(), path.basename(part.file));
    try {
      fs.closeSync(part.fd);
    } catch {}
    const fd = fs.openSync(file, "w");
    for (const piece of part.copy) fs.writeSync(fd, piece);
    fs.fsyncSync(fd);
    warn(`recording: couldn't write ${part.file} (${caught.message}); it goes on in ${file}`);
    recording.parts[recording.parts.indexOf(part.file)] = file;
    recording.base = path.join(fallbackFolder(), path.basename(recording.base));
    part.file = file;
    part.fd = fd;
    writeStatus(recording, "recording");
    slackPage()?.send("powertoys:notice", { text: `Couldn't write the recording to its folder; it goes on in ${fallbackFolder()}, nothing lost.` });
  }

  /** Ends a part's recorder and closes its file (taking what is left, unless the recorder is gone). */
  async function endPart(recording, part) {
    clearInterval(part.timer);
    await part.busy;
    if (part.recorder && !part.recorder.isDestroyed()) {
      if (!part.crashed) {
        await inRecorder(part, "window.stopRecording?.()", 5000).catch(() => {});
        await writeRecorded(recording, part).catch((caught) => warn(`recording: ${caught.message}`));
      }
      part.recorder.destroy();
    }
    part.copy = [];
    try {
      fs.fsyncSync(part.fd);
      fs.closeSync(part.fd);
    } catch {}
  }

  /** A part failed while the huddle goes on: it is closed as it is and a new part starts. */
  async function partFailed(recording, part, reason) {
    if (recording.part !== part || recording.stopping) return;
    warn(`recording: ${reason}; starting a new part`);
    await endPart(recording, part);
    dropEmptyPart(recording);
    for (let attempt = 1; attempt <= 3 && !recording.stopping; attempt++) {
      try {
        return await startPart(recording);
      } catch (caught) {
        warn(`recording: a new part didn't start (${caught.message})`);
        await endPart(recording, recording.part);
        dropEmptyPart(recording);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    slackPage()?.send("powertoys:notice", { text: "The huddle's recording stopped and couldn't restart; what was recorded is kept." });
  }

  async function startRecording(contents) {
    if (recordings.has(contents.id)) return;
    const huddleWindow = electron.BrowserWindow.fromWebContents(contents);
    if (!huddleWindow) throw new Error("no huddle window");
    const where = huddleWindow.getTitle().split(" - ")[0];
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    let folder = recordingsFolder();
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch (caught) {
      warn(`recording: can't use ${folder} (${caught.message}); using ${fallbackFolder()}`);
      folder = fallbackFolder();
      fs.mkdirSync(folder, { recursive: true });
    }
    const teamId = /\/client\/([A-Z0-9]+)/.exec(slackPage()?.getURL() ?? "")?.[1] ?? null;
    const recording = { contents, where, teamId, since: Date.now(), base: path.join(folder, `${stamp} ${where.replace(/[\\/:*?"<>|]/g, "_")}`), parts: [], part: null, stopping: false };
    recordings.set(contents.id, recording);
    let failure = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await startPart(recording);
        return reply(contents, { type: "recording", since: recording.since });
      } catch (caught) {
        failure = caught;
        warn(`recording: didn't start (attempt ${attempt}: ${caught.message})`);
        if (recording.part) await endPart(recording, recording.part);
        dropEmptyPart(recording);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    recordings.delete(contents.id);
    writeStatus(recording, recording.parts.length ? "stopped" : "empty");
    reply(contents, { type: "recording", since: null });
    throw failure;
  }

  /** A part that never got any data (its recorder didn't start) holds nothing: its empty file goes. */
  function dropEmptyPart(recording) {
    const file = recording.parts.at(-1);
    if (file && fs.existsSync(file) && fs.statSync(file).size === 0) {
      fs.rmSync(file);
      recording.parts.pop();
    }
  }

  /** Rewrites a part with its duration and index; the part is replaced only by a copy ffprobe reads as complete. */
  async function repair(file) {
    if (!fs.existsSync(file) || !fs.statSync(file).size) return;
    const copy = `${file}.repairing.mkv`;
    try {
      await execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-c", "copy", "-f", "matroska", copy]);
      const probe = JSON.parse(await execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", copy]));
      const duration = Number(probe.format?.duration);
      if (!(duration > 0) || !probe.streams?.length) throw new Error("the repaired copy isn't complete");
      fs.renameSync(copy, file);
      log(`recording repaired: ${file} (${Math.round(duration)} s)`);
    } catch (caught) {
      fs.rmSync(copy, { force: true });
      warn(`recording: ${file} kept as recorded (${caught.message})`);
    }
  }

  /** Finishes a recording's parts and asks (in Slack's page) whether to keep them. */
  async function finish(recording) {
    if (!recording.parts.length) return writeStatus(recording, "empty");
    for (const file of recording.parts) await repair(file);
    writeStatus(recording, "finished");
    const minutes = Math.max(1, Math.round((Date.now() - recording.since) / 60000));
    slackPage()?.send("powertoys:recording-done", { base: recording.base, parts: recording.parts.length, where: recording.where, minutes, recovered: recording.recovered });
  }

  async function stopRecording(contents, ended) {
    const recording = recordings.get(contents.id);
    if (!recording) return;
    recording.stopping = true;
    recordings.delete(contents.id);
    if (recording.part) await endPart(recording, recording.part);
    dropEmptyPart(recording);
    writeStatus(recording, "stopped");
    log(`recording stopped: ${recording.parts.join(", ")}`);
    if (!ended) reply(contents, { type: "recording", since: null });
    await finish(recording);
  }

  /** Recordings a crash or a quit left unfinished (started before this run of Slack): finished now, offered again. */
  const startedAt = Date.now();
  async function recoverRecordings() {
    const live = new Set([...recordings.values()].map((recording) => path.resolve(recording.base)));
    for (const folder of new Set([recordingsFolder(), fallbackFolder()])) {
      if (!fs.existsSync(folder)) continue;
      for (const name of fs.readdirSync(folder).filter((each) => each.endsWith(".json"))) {
        const json = path.join(folder, name);
        let saved;
        try {
          saved = JSON.parse(fs.readFileSync(json, "utf8"));
        } catch {
          continue;
        }
        if (saved.status !== "recording" && saved.status !== "stopped") continue;
        if (!(saved.since < startedAt) || live.has(path.resolve(json.slice(0, -".json".length)))) continue;
        // A part a dying recorder started without writing anything holds nothing: it goes.
        for (const file of saved.parts ?? []) if (fs.existsSync(file) && fs.statSync(file).size === 0) fs.rmSync(file);
        const recording = { ...saved, base: json.slice(0, -".json".length), parts: (saved.parts ?? []).filter((file) => fs.existsSync(file)), recovered: true };
        log(`recording recovered: ${recording.parts.join(", ")}`);
        await finish(recording);
      }
    }
  }

  // --- What can be done with a recording ------------------------------------------------------------------------
  // Offered when a huddle's recording ends, and in the Powertoys panel's Recordings tab:
  //   save        keep it (also what happens when the question is left unanswered);
  //   transcribe  Slack's own transcript: the audio (ffmpeg) is uploaded to Slack as a private file, shared nowhere,
  //               and transcribed in the language chosen in Settings; the transcript goes beside the recording
  //               (<recording>.transcript.txt);
  //   summarize   Claude summarizes that transcript (transcribing first if need be): <recording>.summary.md;
  //   delete      to the Recycle Bin, with the transcript, summary and status file.
  const notice = (text) => slackPage()?.send("powertoys:notice", { text });

  /** A recording by its status file (<base>.json), checked to be in a recordings folder. */
  function recordingAt(base) {
    const folder = path.resolve(path.dirname(base));
    if (folder !== path.resolve(recordingsFolder()) && folder !== path.resolve(fallbackFolder())) throw new Error("not a recording");
    const saved = JSON.parse(fs.readFileSync(`${base}.json`, "utf8"));
    return { ...saved, base, parts: (saved.parts ?? []).filter((file) => fs.existsSync(file)) };
  }

  function updateRecording(base, fields) {
    const json = `${base}.json`;
    const saved = JSON.parse(fs.readFileSync(json, "utf8"));
    fs.writeFileSync(`${json}.tmp`, JSON.stringify({ ...saved, ...fields }, null, 2));
    fs.renameSync(`${json}.tmp`, json);
  }

  /** Uploads a file to Slack as a private file (shared to no conversation) -> its id. */
  async function uploadPrivately(team, file, title) {
    const page = slackPage();
    const bytes = fs.readFileSync(file);
    const ticket = await api(page, team, "files.getUploadURLExternal", { filename: path.basename(file), length: bytes.length });
    if (!ticket.ok) throw new Error(`Slack didn't take the upload (${ticket.error})`);
    const response = await page.session.fetch(ticket.upload_url, { method: "POST", body: bytes });
    if (!response.ok) throw new Error(`the upload failed (HTTP ${response.status})`);
    const done = await api(page, team, "files.completeUploadExternal", { files: JSON.stringify([{ id: ticket.file_id, title }]) });
    if (!done.ok) throw new Error(`Slack didn't finish the upload (${done.error})`);
    return ticket.file_id;
  }

  /** Waits (up to 20 minutes) for Slack's transcript of a file -> its lines. */
  async function slackTranscript(fileId) {
    let requested = false;
    for (const started = Date.now(); Date.now() - started < 20 * 60000; await new Promise((resolve) => setTimeout(resolve, 10000))) {
      const [clip] = (await claude.clipTranscripts({ clip: fileId })).clips;
      if (clip.transcript === "complete") return clip.lines;
      if (clip.transcript === "failed" || clip.transcript === "fatal") throw new Error(`Slack couldn't transcribe it (${clip.transcript}: no speech, or an unsupported language?)`);
      if (clip.transcript === "none" && !requested) {
        await claude.requestTranscript({ clip: fileId });
        requested = true;
      }
    }
    throw new Error("Slack's transcript took more than 20 minutes");
  }

  const clock = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

  async function transcribeRecording(recording) {
    const transcript = `${recording.base}.transcript.txt`;
    if (fs.existsSync(transcript)) return transcript;
    const teams = await signedInTeams(slackPage());
    const team = teams.find((each) => each.id === recording.teamId) ?? teams[0];
    const sections = [];
    for (const [i, part] of recording.parts.entries()) {
      notice(`Transcribing the recording${recording.parts.length > 1 ? ` (part ${i + 1} of ${recording.parts.length})` : ""}: uploading its sound to Slack, privately…`);
      const audio = path.join(os.tmpdir(), `powertoys-${Date.now()}.m4a`);
      try {
        await execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", part, "-vn", "-c:a", "aac", "-b:a", "96k", audio]);
        const fileId = await uploadPrivately(team, audio, `${path.basename(recording.base)}${recording.parts.length > 1 ? ` (part ${i + 1})` : ""} (audio)`);
        updateRecording(recording.base, { slackFiles: [...(recordingAt(recording.base).slackFiles ?? []), fileId] });
        notice("Uploaded; Slack is transcribing it…");
        const lines = await slackTranscript(fileId);
        sections.push(`${recording.parts.length > 1 ? `# Part ${i + 1}\n` : ""}${lines.map((line) => `[${clock(line.start)}] ${line.text}`).join("\n")}`);
      } finally {
        fs.rmSync(audio, { force: true });
      }
    }
    fs.writeFileSync(transcript, `${recording.where ?? "Huddle"}, ${new Date(recording.since).toLocaleString()}\n\n${sections.join("\n\n")}\n`);
    log(`recording transcribed: ${transcript}`);
    return transcript;
  }

  async function summarizeRecording(recording) {
    const summaryFile = `${recording.base}.summary.md`;
    const transcript = fs.readFileSync(await transcribeRecording(recording), "utf8");
    notice("Claude is summarizing the recording…");
    const summary = await ai.ask({
      prompt:
        "This is the transcript of a recorded Slack huddle (a call). Summarize it in Markdown: a short summary, then " +
        "Decisions, Action items (with owners when said) and Open questions as lists; leave out a section with nothing in it.\n\n" +
        transcript.slice(0, 150000),
    });
    fs.writeFileSync(summaryFile, `${summary}\n`);
    log(`recording summarized: ${summaryFile}`);
    return summaryFile;
  }

  /** An operation on a recording -> what the page shows. */
  async function recordingOperation({ base, op }) {
    const recording = recordingAt(base);
    if (op === "save") {
      updateRecording(base, { status: "kept" });
      log(`recording kept: ${base}`);
      return { ok: true };
    }
    if (op === "delete") {
      // Every file of the recording: its parts, transcript, summary and status file.
      const name = path.basename(base);
      const files = fs.readdirSync(path.dirname(base)).filter((each) => each === `${name}.json` || each.startsWith(`${name}.`) || each.startsWith(`${name} (part `)).map((each) => path.join(path.dirname(base), each));
      for (const file of files) if (fs.existsSync(file)) await electron.shell.trashItem(file);
      log(`recording moved to the Recycle Bin: ${base}`);
      return { ok: true };
    }
    updateRecording(base, { status: "kept" });
    if (op === "transcribe") return { file: await transcribeRecording(recording) };
    if (op === "summarize") {
      const file = await summarizeRecording(recording);
      return { file, text: fs.readFileSync(file, "utf8") };
    }
    throw new Error(`unknown operation ${op}`);
  }

  /** The recordings kept, newest first, for the panel. */
  function listRecordings() {
    const found = [];
    for (const folder of new Set([recordingsFolder(), fallbackFolder()])) {
      if (!fs.existsSync(folder)) continue;
      for (const name of fs.readdirSync(folder).filter((each) => each.endsWith(".json"))) {
        try {
          const recording = recordingAt(path.join(folder, name.slice(0, -".json".length)));
          if (!recording.parts.length || !["finished", "kept"].includes(recording.status)) continue;
          found.push({
            base: recording.base,
            where: recording.where,
            since: recording.since,
            parts: recording.parts,
            megabytes: Math.round(recording.parts.reduce((sum, file) => sum + fs.statSync(file).size, 0) / 1048576),
            transcript: fs.existsSync(`${recording.base}.transcript.txt`),
            summary: fs.existsSync(`${recording.base}.summary.md`),
          });
        } catch {}
      }
    }
    return found.sort((a, b) => b.since - a.since);
  }

  /** Opens a recording's file (a part, its transcript or summary) in its default app. */
  async function openRecordingFile({ base, file }) {
    recordingAt(base);
    if (!path.resolve(file).startsWith(path.resolve(path.dirname(base)))) throw new Error("not a recording's file");
    const failed = await electron.shell.openPath(file);
    if (failed) throw new Error(failed);
    return { ok: true };
  }

  /** Quitting Slack while recording: the recordings are finished first, then Slack quits. */
  let quitting = false;
  function finishBeforeQuit(event) {
    if (!recordings.size || quitting) return;
    event.preventDefault();
    quitting = true;
    Promise.all([...recordings.values()].map((recording) => stopRecording(recording.contents, true).catch((caught) => warn(`recording: ${caught.message}`)))).finally(() => electron.app.quit());
  }

  exports.start = function start() {
    // The windows Slack's page opens (huddle, incoming call); the watcher leaves its main window alone.
    electron.app.on("web-contents-created", (event, contents) => {
      if (contents.getType() === "window") watchWindow(contents);
    });
    electron.ipcMain.handle("powertoys:recording", (event, request) => recordingOperation(request));
    electron.ipcMain.handle("powertoys:recordings", () => listRecordings());
    electron.ipcMain.handle("powertoys:recording-open", (event, request) => openRecordingFile(request));
    electron.app.on("before-quit", finishBeforeQuit);
    // Once Slack's page is up (it shows the question), recordings a crash or a quit left unfinished.
    const recover = setInterval(() => {
      if (!slackPage() || slackPage().isLoading()) return;
      clearInterval(recover);
      setTimeout(() => recoverRecordings().catch((caught) => warn(`recording: ${caught.message}`)), 15000);
    }, 5000);
  };
});
