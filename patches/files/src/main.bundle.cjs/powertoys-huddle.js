// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): huddles and Claude. Slack draws a huddle's window itself (an about:blank window its page
// opened), so Powertoys adds a script to it once the huddle shows there:
//   - the window is maximized from the screen before joining or starting the huddle; its side panel shows Captions
//     rather than the huddle's Thread; captions are side-by-side only, never the closed-caption overlay (set through
//     Slack's own state: powertoys/page-slack), and the "AI notes are on" notice is closed as "Got It" would;
//   - a "Claude session" dropdown, always in view (in the Captions list's header), picks one of the Claude Code
//     sessions of the workspace's folder (Claude Desktop's or the CLI's, worktrees included, from ~/.claude/projects),
//     or "(New session)", the default, started with the first question;
//   - double-click a caption (or right-click it, "Ask Claude"): the question is asked in that session itself (it
//     stays there, with the answer), and the answer shows in a pop-up; while recording, its caption lines carry their
//     time in the recording, with where the video is, so the session can take a frame at that moment;
//   - Ctrl+A after a click in the captions selects the caption lines only.
// Each huddle is recorded to a file (the window, the call's sound, your microphone); when it ends, Slack asks whether
// to keep it ("huddle": { "autoRecord": true, "recordingsFolder": "<folder>" }).
// When a huddle starts or rings, the Bluetooth radio goes on and Windows connects your paired headphones (the paired
// device registered as headphones or a headset; "huddle": { "headphones": "<part of a name>" } picks one; null: off);
// if Bluetooth was off, it goes off again when the huddle ends, at Cancel or Decline, when the window that rang is
// closed without a huddle, or when a ring stops unanswered (a headphones step still connecting is stopped first).
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

  /** The sessions with a title in a folder (and its worktrees), newest first -> [{ id, title, cwd, updated }] (also for powertoys/assist). */
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
  exports.projectSessions = projectSessions;

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
      .chip { position: fixed; z-index: 2147483646; left: 10px; bottom: 76px; max-width: 260px; padding: 3px 9px;
        border: 1px solid rgba(255,255,255,.18); border-radius: 999px; background: rgba(29,28,29,.82); color: #f8f8f8;
        box-shadow: 0 1px 3px rgba(0,0,0,.3); opacity: .7; cursor: pointer;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: opacity .2s; }
      .chip:hover, .chip.open { opacity: 1; }
      .rec { bottom: 102px; }
      .mark { bottom: 128px; }
      .mark.done { opacity: 1; color: #fff; background: #2eb67d; }
      .brief { bottom: 154px; }
      .rec.on { opacity: 1; color: #fff; background: #e01e5a; }
      .rec.alarm { opacity: 1; color: #1d1c1d; background: #ecb22e; }
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
      .answer .text a { color: #1d9bd1; text-decoration: none; cursor: pointer; }
      .answer .text a:hover { text-decoration: underline; }
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
        for (const piece of line.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((?:https|claude):\/\/[^)\s]+\))/)) {
          const link = /^\[([^\]]+)\]\(((?:https|claude):\/\/[^)\s]+)\)$/.exec(piece);
          if (link) {
            // Opened by the main process (a ticket, a PR, a Claude Code session in Claude Desktop).
            const anchor = Object.assign(el("a", "", link[1]), { href: link[2] });
            anchor.addEventListener("click", (event) => (event.preventDefault(), send({ type: "open", url: link[2] })));
            parent.append(anchor);
          } else if (/^\*\*[^*]+\*\*$/.test(piece)) parent.append(el("strong", "", piece.slice(2, -2)));
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
    // A problem with the recording while it runs (the call's sound not being recorded): shown on the chip.
    let recordingAlarm = null;
    const showRec = () => {
      const seconds = recordingSince ? Math.floor((Date.now() - recordingSince) / 1000) : 0;
      const time = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
      rec.textContent = recordingSince ? `${recordingAlarm ? "⚠" : "●"} ${time}` : "● Rec";
      rec.title = recordingAlarm ?? "";
      rec.setAttribute("aria-label", recordingAlarm ? `Recording problem: ${recordingAlarm}` : recordingSince ? `Recording, ${time}` : "Start recording");
      rec.classList.toggle("on", !!recordingSince && !recordingAlarm);
      rec.classList.toggle("alarm", !!recordingSince && !!recordingAlarm);
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
    // (The overlay's names end with a colon.)
    const nameOf = (line) => line.querySelector(".p-huddle_event_log__member_name, .p-huddle_closed_caption_event__member_name")?.textContent.trim().replace(/:$/, "") ?? "";
    // When a caption line was first seen (its time in the recording, worked out by the main process), if known.
    const atOf = (line) => captions.get(line)?.at ?? null;
    /** A caption line as a question, with who said it and the lines before it (each with its time). */
    function questionAt(line) {
      const lines = [...document.querySelectorAll(LINE)].filter((each) => textOf(each));
      const at = lines.indexOf(line);
      let speaker = "";
      for (let i = at; i >= 0 && !speaker; i--) speaker = nameOf(lines[i]);
      const before = [];
      let name = "";
      for (const each of lines.slice(Math.max(0, at - 6), at)) {
        name = nameOf(each) || name;
        before.push({ at: atOf(each), text: `${name ? `${name}: ` : ""}${textOf(each)}` });
      }
      return { question: textOf(line), at: atOf(line), speaker, before };
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
        if (chosen.includes(lines[i])) said.push({ at: atOf(lines[i]), text: `${name ? `${name}: ` : ""}${textOf(lines[i])}` });
      }
      const { before } = questionAt(chosen[0]);
      return chosen.length === 1 ? questionAt(chosen[0]) : { question: said.map((each) => each.text).join("\n"), lines: said, speaker: "", before, selection: true };
    }
    const askIn = (x, y, question) => {
      const ask = (chosen) => showAnswer(x, y, chosen, question);
      if (session) ask(session);
      else openMenu(x, y, sessionItems(ask), "Ask Claude in");
    };
    // Ctrl+A after a click in the side panel's captions (or with some of them selected): the captions only, not the
    // whole window. In a text box it stays the box's own.
    let lastDown = null;
    document.addEventListener("mousedown", (event) => (lastDown = event.target), true);
    document.addEventListener(
      "keydown",
      (event) => {
        if (!event.ctrlKey || event.shiftKey || event.altKey || event.code !== "KeyA" || event.target.closest?.('input, textarea, [contenteditable="true"], [contenteditable=""]')) return;
        const lines = [...document.querySelectorAll(".p-huddle_event_log__base_event")].filter((each) => textOf(each));
        if (!lines.length) return;
        let list = lines[0].parentElement;
        while (list && !list.contains(lines.at(-1))) list = list.parentElement;
        const inList = (node) => !!node && list.contains(node.nodeType === Node.TEXT_NODE ? node.parentNode : node);
        if (!inList(getSelection()?.anchorNode) && !inList(lastDown)) return;
        event.preventDefault();
        event.stopPropagation();
        const range = document.createRange();
        range.setStartBefore(lines[0]);
        range.setEndAfter(lines.at(-1));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      },
      true,
    );
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
    function ask(where, { question, at = null, lines = [], speaker = "", before = [], selection = false, typed = false }) {
      const id = ++asked;
      where.log.append(el("div", "q", typed ? `You: ${question}` : `${speaker ? `${speaker}: ` : ""}${question}`));
      const text = el("div", "text", "Thinking…");
      where.log.append(text);
      where.log.scrollTop = where.log.scrollHeight;
      answers.set(id, { text, log: where.log });
      send({ type: "ask", id, sessionId: where.session.id, question, at, lines, speaker, before, selection, typed });
    }
    function showAnswer(x, y, chosen, question) {
      ask(openTalk(x, y, chosen), question);
    }

    // The Captions tab and side-by-side captions (not the overlay) are set through Slack's own state, from its page
    // (powertoys/page-slack): nothing here clicks Slack's tabs or menus.

    // The side-by-side list when it shows, else the overlay: when the list replaces the overlay it shows the same lines
    // again (new elements), so a line already seen (same speaker, same words) keeps its first id and time.
    const captions = new WeakMap(); // line element -> { id, name, text, at }
    const seenLines = new Map(); // "name|words" -> the caption first seen with them
    let captionCount = 0;
    let lastCaptionAt = 0;
    setInterval(() => {
      const list = document.querySelectorAll(".p-huddle_event_log__base_event");
      const lines = [...list].some((line) => textOf(line)) ? list : document.querySelectorAll(".p-huddle_closed_caption_event__wrapper");
      let name = "";
      for (const line of lines) {
        name = nameOf(line) || name;
        const text = textOf(line);
        if (!text) continue;
        let caption = captions.get(line);
        if (!caption) {
          caption = seenLines.get(`${name}|${text}`) ?? { id: ++captionCount, at: Date.now(), name: "", text: "" };
          captions.set(line, caption);
        }
        if (caption.text === text && caption.name === name) continue;
        Object.assign(caption, { name, text });
        seenLines.set(`${name}|${text}`, caption);
        lastCaptionAt = Date.now();
        send({ type: "caption", ...caption });
      }
    }, 2000);
    // Captions can stop reaching the recording (a call had them for its first 82 s only): every 2 minutes without a new
    // line, what the window shows, for the log.
    setInterval(() => {
      if (Date.now() - lastCaptionAt < 120000) return;
      const tab = [...document.querySelectorAll('[data-qa="tabs_item"]')].find((each) => each.getAttribute("aria-selected") === "true")?.textContent.trim() ?? "none";
      send({
        type: "log",
        text: `captions: none new for ${Math.round((Date.now() - lastCaptionAt) / 60000)} min; side panel tab "${tab}", list lines ${document.querySelectorAll(".p-huddle_event_log__base_event").length}, overlay lines ${document.querySelectorAll(".p-huddle_closed_caption_event__wrapper").length}, "Captions are being generated" ${/captions are being generated/i.test(document.body.innerText) ? "shown" : "not shown"}`,
      });
    }, 120000);
    const lastLines = (count) => {
      let name = "";
      const said = [];
      for (const line of document.querySelectorAll(LINE)) {
        name = nameOf(line) || name;
        if (textOf(line)) said.push(`${name ? `${name}: ` : ""}${textOf(line)}`);
      }
      return said.slice(-count);
    };

    // "★ Mark" (or Ctrl+Shift+M): this moment, with the last caption lines, becomes a chapter of the recording.
    const mark = el("button", "chip mark", "★ Mark");
    mark.tabIndex = -1;
    mark.title = "Mark this moment in the recording (Ctrl+Shift+M)";
    const markNow = () => send({ type: "mark", lines: lastLines(3) });
    mark.addEventListener("mousedown", (event) => (event.preventDefault(), markNow()));
    document.addEventListener("keydown", (event) => event.ctrlKey && event.shiftKey && event.code === "KeyM" && (event.preventDefault(), markNow()), true);
    root.appendChild(mark);

    // "Brief": what to know before talking (the conversation, its tickets, the last call), or the standup's summary.
    const brief = el("button", "chip brief", "Brief");
    brief.tabIndex = -1;
    brief.title = "A short brief for this call";
    let briefBox = null;
    const showBrief = (text) => {
      briefBox?.remove();
      briefBox = el("div", "answer");
      const top = el("div", "top");
      const close = el("button", "", "×");
      close.addEventListener("mousedown", (event) => (event.preventDefault(), briefBox.remove(), (briefBox = null)));
      top.append(el("span", "", "Brief"), close);
      const log = el("div", "log");
      log.append(Object.assign(el("div", "text"), {}));
      log.firstChild.append(typeof text === "string" ? markdown(text) : text);
      briefBox.append(top, log);
      briefBox.style.left = "10px";
      briefBox.style.top = `${Math.max(8, innerHeight - 560)}px`;
      root.appendChild(briefBox);
    };
    brief.addEventListener("mousedown", (event) => {
      event.preventDefault();
      showBrief("Preparing the brief…");
      send({ type: "brief" });
    });
    root.appendChild(brief);

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
        } else if (message.type === "marked") {
          // Said on the chip for a moment: "★ 12:34" (or why not).
          mark.textContent = message.error ? `★ ${message.error}` : `★ Marked ${message.time}`;
          mark.classList.toggle("done", !message.error);
          setTimeout(() => ((mark.textContent = "★ Mark"), mark.classList.remove("done")), 2500);
        } else if (message.type === "brief") {
          showBrief(message.error ? `Couldn't prepare the brief: ${message.error}` : message.markdown);
        } else if (message.type === "recording") {
          rec.disabled = false;
          recordingSince = message.since ?? null;
          recordingAlarm = message.alarm ?? null;
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

  const currentTeamId = () => /\/client\/([A-Z0-9]+)/.exec(slackPage()?.getURL() ?? "")?.[1] ?? null;

  /** The workspace the Slack page shows (/client/T.../), and its folder. */
  function currentFolder() {
    const teamId = /\/client\/([A-Z0-9]+)/.exec(slackPage()?.getURL() ?? "")?.[1];
    return readSettings().claude?.folders?.[teamId] ?? null;
  }

  // A caption's time in the call's recording ("[mm:ss] ", from its start, as in the recording's transcripts and its
  // key frames' names), so an answer can point at that moment of the video; nothing when not recording.
  const timeIn = (recording, at) => (recording && at ? `[${clock(Math.max(0, at - recording.since))}] ` : "");
  /** Where the call is being recorded, and how a time maps to a moment of a part's video (for frames), or "". */
  function whereRecorded(recording) {
    if (!recording) return "";
    const parts = recording.parts.map((file) => `"${file}" from ${clock(Math.max(0, (recording.starts[file] ?? recording.since) - recording.since))}`);
    return (
      `The call is being recorded (times above are from the recording's start): ${parts.join(", ")}; a frame at a time T is in the ` +
      "part that covers it, at T minus the part's start (ffmpeg -ss <seconds> -i <part> -frames:v 1 <file>.png). Stills of the screen " +
      `when it changed are in "${recording.base}.frames" (named by time). Look at the screen only if the question needs it.\n`
    );
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
    } else if (message.type === "log") {
      log(`huddle window: ${String(message.text).slice(0, 300)}`);
    } else if (message.type === "open") {
      // A link in the brief: a ticket or PR (the browser), a Claude Code session (Claude Desktop); nothing else.
      if (/^(https|claude):\/\//.test(String(message.url))) electron.shell.openExternal(String(message.url));
    } else if (message.type === "caption") {
      // Appended as it comes (a crash keeps it); the last version of each line is the one used.
      const recording = recordings.get(contents.id);
      if (recording) {
        try {
          fs.appendFileSync(`${recording.base}.captions.jsonl`, `${JSON.stringify({ id: message.id, at: message.at, name: message.name, text: message.text })}\n`);
        } catch (caught) {
          if (!recording.captionsBroken) warn(`recording: couldn't keep the captions (${caught.message})`);
          recording.captionsBroken = true;
        }
      }
    } else if (message.type === "mark") {
      const recording = recordings.get(contents.id);
      if (!recording) return reply(contents, { type: "marked", error: "not recording" });
      const seconds = Math.floor((Date.now() - recording.since) / 1000);
      recording.marks.push({ at: Date.now(), lines: (message.lines ?? []).slice(-3).map(String) });
      writeStatus(recording, recording.status ?? "recording");
      log(`recording: marked ${seconds} s in`);
      reply(contents, { type: "marked", time: `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` });
    } else if (message.type === "brief") {
      try {
        const where = electron.BrowserWindow.fromWebContents(contents)?.getTitle().split(" - ")[0] ?? "";
        reply(contents, { type: "brief", markdown: await __webpack_require__("powertoys/brief").forCall({ where, teamId: currentTeamId() }) });
      } catch (caught) {
        warn(`brief: ${caught.message}`);
        reply(contents, { type: "brief", error: caught.message });
      }
    } else if (message.type === "record") {
      if (recordings.has(contents.id)) await stopRecording(contents, false);
      else await startRecording(contents);
    } else if (message.type === "ask") {
      const recording = recordings.get(contents.id);
      const fresh = message.sessionId === "new";
      const chosen = huddle.sessions.find((each) => each.id === message.sessionId);
      try {
        if (!fresh && !chosen) throw new Error("that session is gone");
        const timed = (line) => `${timeIn(recording, line.at)}${line.text}`;
        const prompt = message.typed
          ? `(Still on the Slack call; I typed this.) ${message.question}\n${whereRecorded(recording)}` +
            "Answer quickly, in a few short sentences, plain words (look at the code only if you must). Don't change anything."
          : (message.selection
              ? `I'm on a Slack call. This part of it, from the captions:\n${(message.lines?.length ? message.lines.map(timed) : [message.question]).join("\n")}\n`
              : `I'm on a Slack call. ${timeIn(recording, message.at)}${message.speaker ? `${message.speaker} asked` : "Someone asked"}: "${message.question}"\n`) +
            (message.before?.length ? `Just before that:\n${message.before.map((line) => `- ${timed(line)}`).join("\n")}\n` : "") +
            whereRecorded(recording) +
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
if ($radio.State -ne 'On') { [Console]::Out.WriteLine('radio-turned-on'); [Console]::Out.Flush(); Await ($radio.SetStateAsync('On')) ([Windows.Devices.Radios.RadioAccessStatus]) | Out-Null; Start-Sleep -Seconds 2 }
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
  let connectingChild = null; // the headphones step's PowerShell: stopped when the huddle is cancelled or its window closed
  let connectingStopped = false;
  // Bluetooth was off and Powertoys turned it on: it goes off again when the huddle ends (or the ringing stops
  // without a huddle), once no huddle window is open.
  // (Kept in powertoys\bluetooth.json, so a restart of Slack in between doesn't forget it.)
  const bluetoothFile = () => path.join(powertoysDir(), "bluetooth.json");
  let bluetoothOurs = (() => {
    try {
      return JSON.parse(fs.readFileSync(bluetoothFile(), "utf8")).turnedOnByPowertoys === true;
    } catch {
      return false;
    }
  })();
  function setBluetoothOurs(value) {
    bluetoothOurs = value;
    try {
      fs.writeFileSync(bluetoothFile(), JSON.stringify({ turnedOnByPowertoys: value, at: new Date().toISOString() }));
    } catch (caught) {
      warn(`bluetooth: ${caught.message}`);
    }
  }
  let offWanted = null; // why Bluetooth should go off once the headphones step now running has finished
  const BLUETOOTH_OFF_SCRIPT = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait() | Out-Null; $task.Result }
[Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null
$radio = (Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])) | Where-Object { $_.Kind -eq 'Bluetooth' }
if ($radio -and $radio.State -eq 'On') { Await ($radio.SetStateAsync('Off')) ([Windows.Devices.Radios.RadioAccessStatus]) | Out-Null; 'off' } else { 'was-off' }
`;
  // Where a huddle is ringing or about to start right now (a window's id, or "main" for Slack's main window), and the
  // one pending "off" (a new ring, start screen or huddle cancels it): Bluetooth never goes off while either is open.
  const ringingIn = new Set();
  const rang = new Set(); // the windows that rang (or showed the screen before joining) and haven't closed
  let offTimer = null;
  function bluetoothOffLater(why, ms) {
    clearTimeout(offTimer);
    offTimer = setTimeout(() => {
      offTimer = null;
      bluetoothOff(why).catch((caught) => warn(`bluetooth: ${caught.message}`));
    }, ms);
  }
  function keepBluetooth() {
    clearTimeout(offTimer);
    offTimer = null;
  }

  async function bluetoothOff(why) {
    if (connecting) return void (offWanted = why);
    if (!bluetoothOurs || huddles.size || ringingIn.size) return;
    setBluetoothOurs(false);
    const script = path.join(os.tmpdir(), "powertoys-bluetooth-off.ps1");
    fs.writeFileSync(script, BLUETOOTH_OFF_SCRIPT);
    const output = await new Promise((resolve) =>
      __webpack_require__(35317).execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { windowsHide: true, timeout: 30000 }, (caught, stdout) =>
        resolve(caught && !stdout ? `error ${caught.message}` : String(stdout).trim()),
      ),
    );
    log(`huddle ${why}: Bluetooth ${output}`);
  }

  /** A huddle rings or is about to start (in a window Slack opened, or in its main window: "main"). */
  function ringStarted(where) {
    log("huddle ringing");
    ringingIn.add(where);
    rang.add(where);
    keepBluetooth();
    headphonesOn("ringing").catch((caught) => warn(`headphones: ${caught.message}`));
  }
  /** Cancel (before starting or joining) or Decline (an incoming huddle): Bluetooth off now. */
  function ringCancelled(where) {
    log("huddle cancelled");
    ringingIn.delete(where);
    keepBluetooth();
    stopConnecting();
    bluetoothOff("cancelled").catch((caught) => warn(`bluetooth: ${caught.message}`));
  }
  /** The window that rang closed without a huddle: Bluetooth off 3 s later, unless a huddle or another ring is on. */
  function ringWindowClosed() {
    log("huddle ring window closed");
    clearTimeout(offTimer);
    offTimer = setTimeout(() => {
      offTimer = null;
      if (huddles.size || ringingIn.size) return;
      stopConnecting();
      bluetoothOff("ring window closed").catch((caught) => warn(`bluetooth: ${caught.message}`));
    }, 3000);
  }
  /** Still connecting the headphones: stopped, so Bluetooth goes off now rather than when that step gives up. */
  function stopConnecting() {
    if (!connectingChild) return;
    connectingStopped = true;
    connectingChild.kill();
  }
  /** The ringing stopped some other way (answered, missed): off 15 s later, unless a huddle or another ring is on. */
  function ringEnded(where) {
    if (!ringingIn.delete(where)) return;
    bluetoothOffLater("ring ended", 15000);
  }

  async function headphonesOn(why) {
    const { headphones = "" } = readSettings().huddle ?? {};
    if (headphones === null || connecting) return;
    connecting = true;
    try {
      const script = path.join(os.tmpdir(), "powertoys-headphones.ps1");
      fs.writeFileSync(script, HEADPHONES_SCRIPT);
      const notice = (text) => slackPage()?.send("powertoys:notice", { text });
      const output = await new Promise((resolve) => {
        connectingChild = __webpack_require__(35317).execFile(
          "powershell.exe",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...(headphones ? ["-Name", headphones] : [])],
          { windowsHide: true, timeout: 60000 },
          (caught, stdout) => resolve(caught && !stdout ? `error ${caught.message}` : String(stdout).trim()),
        );
      });
      const lines = output.split(/\r?\n/);
      if (lines.includes("radio-turned-on")) setBluetoothOurs(true);
      if (connectingStopped) return log(`huddle ${why}: headphones step stopped${bluetoothOurs ? " (Bluetooth turned on by Powertoys)" : ""}`);
      log(`huddle ${why}: headphones ${lines.at(-1)}${bluetoothOurs ? " (Bluetooth turned on by Powertoys)" : ""}`);
      const [result, ...name] = lines.at(-1).split(" ");
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
      connectingChild = null;
      connectingStopped = false;
      if (offWanted) {
        const why = offWanted;
        offWanted = null;
        bluetoothOff(why).catch((caught) => warn(`bluetooth: ${caught.message}`));
      }
    }
  }

  // --- Watching the windows Slack's page opens -----------------------------------------------------------------
  // A small watcher in each: it says when the window shows a huddle (then the huddle script goes in) and when a huddle
  // rings or is about to start (an incoming huddle's card, or the screen before joining or starting one).
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
      // An incoming huddle's card, or the screen before joining or starting one (Slack's invite window with a preview).
      const now = !!document.querySelector('.p-huddle_invite, [data-qa^="huddle_invite_window_with_preview"]');
      if (now && !ringing) send({ type: "ringing", preview: !!document.querySelector('[data-qa^="huddle_invite_window_with_preview"]') });
      if (!now && ringing) send({ type: "ring-ended" });
      ringing = now;
    };
    new MutationObserver(check).observe(document.documentElement, { childList: true, subtree: true });
    check();
    // Cancel (the screen before starting or joining) or Decline (an incoming huddle). In the window with a preview they
    // are icon buttons, named only by their aria-label.
    document.addEventListener(
      "click",
      (event) => {
        const button = event.target.closest?.("button, [role=button]");
        if (!button || !ringing) return;
        const qa = button.dataset?.qa ?? "";
        const name = (button.getAttribute("aria-label") || button.textContent).trim();
        if (/cancel|decline|dismiss/i.test(qa) || /^(cancel|decline|not now)$/i.test(name)) send({ type: "cancelled" });
      },
      true,
    );
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
      if (message.type === "ringing") {
        if (message.preview) maximize(contents, "the screen before joining");
        return ringStarted(contents.id);
      }
      if (message.type === "ring-ended") return ringEnded(contents.id);
      if (message.type === "cancelled") return ringCancelled(contents.id);
      if (message.type === "huddle") return addClaude(contents).catch((caught) => warn(`huddle: ${caught.message}`));
      onMessage(contents, message).catch((caught) => warn(`huddle: ${caught.message}`));
    });
    contents.once("destroyed", () => {
      const wasHuddle = huddles.delete(contents.id);
      ringingIn.delete(contents.id);
      const wasRinging = rang.delete(contents.id);
      stopRecording(contents, true).catch((caught) => warn(`recording: ${caught.message}`));
      // The huddle ended (or its ringing / start screen closed): Bluetooth off again if Powertoys turned it on. Any
      // other window (Powertoys' recorder, ...) has nothing to do with it.
      if (wasHuddle) bluetoothOffLater("ended", 3000);
      else if (wasRinging) ringWindowClosed();
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

  /** The huddle window is maximized as soon as it shows the screen before joining (else when the huddle shows). */
  function maximize(contents, shown) {
    const huddleWindow = electron.BrowserWindow.fromWebContents(contents);
    if (!huddleWindow || huddleWindow.isMaximized()) return;
    huddleWindow.maximize();
    log(`huddle window: maximized (it shows ${shown})`);
  }

  async function addClaude(contents) {
    huddles.set(contents.id, { folder: currentFolder(), session: null, sessions: [], created: new Set() });
    keepBluetooth();
    maximize(contents, "the huddle");
    headphonesOn("started").catch((caught) => warn(`headphones: ${caught.message}`));
    await contents.executeJavaScript(`(${huddleWindowScript.toString()})()`, true);
    log(`huddle window: Claude added (folder ${huddles.get(contents.id)?.folder ?? "none"})`);
    if (readSettings().huddle?.autoRecord !== false) startRecording(contents).catch((caught) => warn(`recording: ${caught.message}`));
  }

  // --- Recording a huddle --------------------------------------------------------------------------------------
  // Every huddle is recorded (huddle.autoRecord, default true; "● Rec" in the huddle window stops and starts it): the
  // huddle window's picture, the call's sound (taken in Slack's page from the huddle's incoming tracks, whatever speaker
  // plays it) and your microphone, to .mkv in huddle.recordingsFolder (default powertoys\recordings), with the
  // computer's sound as a backup track. When the huddle ends, Slack asks whether to keep it, and says whether the call's
  // sound was recorded.
  //
  // A recording must never be lost or corrupted, so:
  //   - a hidden window of Powertoys' own records (MediaRecorder) the huddle window with your microphone, and the
  //     computer's sound output (loopback, which leaves the call playing) beside it; every half second the main process
  //     takes what it recorded (H.264 from the graphics card's encoder), appends it to the file and flushes it to the
  //     disk (fsync): a crash loses at most about a second, and Matroska cut short still plays; the whole part is also
  //     kept in memory (while 8 GB stays free), so a refused write loses nothing;
  //   - the call's sound comes in half-second pieces from Slack's page, appended and flushed the same way; if they stop
  //     coming, or no sound from the huddle reaches the recording, the huddle window's chip turns yellow, a notice
  //     says so, and the tap restarts; at Slack's start the tap is checked;
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
    const fields = {
      status,
      where: recording.where,
      since: recording.since,
      parts: recording.parts,
      teamId: recording.teamId ?? saved.teamId ?? null,
      // For lining the call's sound up with the parts, also after a crash.
      starts: recording.starts ?? saved.starts ?? {},
      sounds: recording.sounds ?? saved.sounds ?? {},
      // (only what the file needs: a live call also holds its file handle, timer and callbacks)
      calls: (recording.calls ?? saved.calls ?? []).map(({ file, startedAt }) => ({ file, startedAt })),
      callStats: recording.callStats ?? saved.callStats ?? null,
      marks: recording.marks ?? saved.marks ?? [],
      check: recording.check ?? saved.check ?? null,
    };
    fs.writeFileSync(`${json}.tmp`, JSON.stringify({ ...saved, ...fields }, null, 2));
    fs.renameSync(`${json}.tmp`, json);
  }

  // One capture (the main process answers it): the huddle window's picture and the sound the computer plays
  // ("loopback"). Not the audio of Slack's page: capturing a page's audio takes it off the speakers (Electron forces
  // it), so the call would go silent. Echo cancellation, noise suppression and auto gain are off for it: echo
  // cancellation would remove exactly what the speakers play.
  // Two recorders: the picture with your microphone (the part's file), and the computer's sound on its own (a backup
  // beside it, <part>.sound.webm). The call itself is recorded in Slack's page (powertoys/page-call): the computer's
  // sound is only what the default speakers play, which misses a call played on other ones (headphones, say).
  // withVideo false: the huddle window couldn't be captured (minimized, hidden), so the capture's picture (a screen,
  // which getDisplayMedia needs) is dropped and the sound alone is recorded.
  function recorderScript({ withVideo }) {
    return (async () => {
      const screen = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      let mic = null;
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {}
      if (!withVideo) screen.getVideoTracks().forEach((track) => track.stop());
      let failed = null;
      // A recorder whose pieces are kept until the main process takes them.
      const recorderOf = (tracks, types, options = {}) => {
        if (!tracks.length) return null;
        const mimeType = types.find((type) => MediaRecorder.isTypeSupported(type));
        const recorder = new MediaRecorder(new MediaStream(tracks), { mimeType, ...options });
        recorder.chunks = [];
        recorder.ondataavailable = (event) => event.data.size && recorder.chunks.push(event.data);
        recorder.onerror = (event) => (failed = event.error?.message ?? "MediaRecorder failed");
        return recorder;
      };
      // H.264 is encoded by the graphics card (Media Foundation: NVENC, Quick Sync); VP8 only where it can't be.
      const main = recorderOf(
        [...(withVideo ? screen.getVideoTracks() : []), ...(mic?.getAudioTracks() ?? [])],
        withVideo ? ["video/webm;codecs=h264,opus", "video/webm;codecs=vp8,opus"] : ["audio/webm;codecs=opus"],
        { videoBitsPerSecond: 8000000 },
      );
      const sound = recorderOf(screen.getAudioTracks(), ["audio/webm;codecs=opus"]);
      if (!main && !sound) throw new Error("nothing to record: no picture, microphone or sound");
      const blobBase64 = async (blob) => {
        if (!blob.size) return "";
        const url = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
        return url.slice(url.indexOf(",") + 1);
      };
      const base64 = (recorder) => blobBase64(new Blob(recorder?.chunks.splice(0) ?? []));
      // Key frames: every 2 s a small grey copy of the picture is compared with the last frame kept; a big change (a
      // new slide, another screen shared), 15 s or more after the last one, keeps a full-size JPEG.
      const frames = [];
      if (withVideo) {
        const video = Object.assign(document.createElement("video"), { muted: true, srcObject: new MediaStream(screen.getVideoTracks()) });
        await video.play().catch(() => {});
        const small = new OffscreenCanvas(160, 90);
        const smallContext = small.getContext("2d", { willReadFrequently: true });
        let kept = null;
        let keptAt = 0;
        setInterval(async () => {
          if (!video.videoWidth || Date.now() - keptAt < 15000) return;
          smallContext.drawImage(video, 0, 0, 160, 90);
          const pixels = smallContext.getImageData(0, 0, 160, 90).data;
          const grey = new Uint8Array(160 * 90);
          for (let i = 0; i < grey.length; i++) grey[i] = (pixels[i * 4] * 3 + pixels[i * 4 + 1] * 6 + pixels[i * 4 + 2]) / 10;
          let change = 255;
          if (kept) {
            change = 0;
            for (let i = 0; i < grey.length; i++) change += Math.abs(grey[i] - kept[i]);
            change /= grey.length;
          }
          if (change < 12) return;
          kept = grey;
          keptAt = Date.now();
          const full = new OffscreenCanvas(video.videoWidth, video.videoHeight);
          full.getContext("2d").drawImage(video, 0, 0);
          frames.push({ at: keptAt, data: await blobBase64(await full.convertToBlob({ type: "image/jpeg", quality: 0.85 })) });
        }, 2000);
      }
      // What was recorded since the last call, as base64, the key frames, and whether a recorder failed.
      window.takeRecorded = async () => ({ data: await base64(main), sound: await base64(sound), frames: frames.splice(0), failed });
      const stopped = (recorder) =>
        new Promise((resolve) => {
          if (!recorder || recorder.state === "inactive") return resolve(true);
          recorder.onstop = () => resolve(true);
          recorder.stop();
        });
      window.stopRecording = async () => {
        await Promise.all([stopped(main), stopped(sound)]);
        for (const track of [...screen.getTracks(), ...(mic?.getTracks() ?? [])]) track.stop();
        return true;
      };
      const startedAt = Date.now();
      main?.start(500);
      sound?.start(500);
      return { startedAt, sound: !!sound, mic: !!mic, mimeType: main?.mimeType ?? sound.mimeType };
    })();
  }

  /** Starts a part: a recorder window and a file of its own. */
  async function startPart(recording) {
    const huddleWindow = !recording.contents.isDestroyed() && electron.BrowserWindow.fromWebContents(recording.contents);
    if (!huddleWindow) throw new Error("the huddle window is gone");
    const number = recording.parts.length + 1;
    const file = `${recording.base}${number > 1 ? ` (part ${number})` : ""}.mkv`;
    const soundFile = file.replace(/\.mkv$/, ".sound.webm");
    const part = { file, fd: fs.openSync(file, "a"), soundFile, soundFd: fs.openSync(soundFile, "a"), recorder: null, timer: null, crashed: false, busy: null, copy: [], copying: true };
    recording.part = part;
    recording.parts.push(file);
    recording.sounds[file] = soundFile;
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
    // The recorder's capture: the huddle window, with the sound the computer plays.
    const source = (await electron.desktopCapturer.getSources({ types: ["window"] })).find((each) => each.id === huddleWindow.getMediaSourceId());
    // A window Windows can't capture (minimized, hidden): the sound alone, rather than nothing.
    const screen = source ? null : (await electron.desktopCapturer.getSources({ types: ["screen"] }))[0];
    if (!source && !screen) throw new Error("nothing to capture the sound with");
    if (!source) warn("recording: the huddle window can't be captured; recording the sound only");
    electron.session.fromPartition("powertoys-recorder").setDisplayMediaRequestHandler((request, callback) => callback({ video: source ?? screen, audio: "loopback" }));
    const got = await inRecorder(part, `(${recorderScript.toString()})(${JSON.stringify({ withVideo: Boolean(source) })})`, 15000);
    // When the part's first moment was recorded: the call's sound is lined up with it when the recording finishes.
    recording.starts[file] = got.startedAt;
    writeStatus(recording, "recording");
    // One take at a time, so the pieces reach the file in order.
    part.timer = setInterval(() => {
      if (part.busy) return;
      part.busy = writeRecorded(recording, part)
        // (after this take has settled: the new part waits for it)
        .catch((caught) => setTimeout(() => partFailed(recording, part, caught.message)))
        .finally(() => (part.busy = null));
    }, 500);
    log(`recording the huddle in ${recording.where} to ${file} (${got.mimeType}, computer sound ${got.sound ? "yes" : "no"}, microphone ${got.mic ? "yes" : "no"})`);
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
    const { data, sound, frames = [], failed } = await inRecorder(part, "window.takeRecorded()");
    // Key frames, named by their time from the recording's start (a refused write loses only that frame).
    for (const frame of frames) {
      try {
        const folder = `${recording.base}.frames`;
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, `${clock(frame.at - recording.since).replace(":", "-")}.jpg`), Buffer.from(frame.data, "base64"));
      } catch (caught) {
        warn(`recording: a key frame wasn't saved (${caught.message})`);
      }
    }
    // The computer's sound is a backup: a refused write is reported once, and the part goes on.
    if (sound && !part.soundBroken) {
      try {
        fs.writeSync(part.soundFd, Buffer.from(sound, "base64"));
        fs.fsyncSync(part.soundFd);
      } catch (caught) {
        part.soundBroken = true;
        warn(`recording: couldn't write the computer's sound to ${part.soundFile} (${caught.message}); the backup stops for this part`);
      }
    }
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
    for (const map of [recording.starts, recording.sounds]) {
      map[file] = map[part.file];
      delete map[part.file];
    }
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
    for (const fd of [part.fd, part.soundFd]) {
      try {
        fs.fsyncSync(fd);
        fs.closeSync(fd);
      } catch {}
    }
  }

  /** A part failed while the huddle goes on: it is closed as it is and a new part starts. */
  async function partFailed(recording, part, reason) {
    // Once: a take still running when the part failed can fail too, while the part is being ended (it stays the
    // recording's part until the new one starts); a second new part would get the same file and both would write to it.
    if (part.failed) return warn(`recording: ${reason} (the part is already being replaced)`);
    if (recording.part !== part || recording.stopping) return;
    part.failed = true;
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

  // --- The call's sound, where Slack's page receives it (powertoys/page-call) ------------------------------------
  // The other people's sound is recorded from the huddle's incoming WebRTC tracks in Slack's page, before it is played,
  // so it doesn't matter which speaker plays it. Half-second pieces come here and are appended and flushed to
  // <recording>.call.webm (.call-2.webm… after a restart); when the recording finishes it goes into each part as its own
  // track, and mixed with the microphone. Alarms (the chip in the huddle window turns yellow, and a notice): no piece
  // for 5 seconds, or no incoming track for 15 seconds; the tap then restarts.
  const calls = new Map(); // tap id -> { recording, call }
  let tapNumber = 0;
  const callCommand = (action, id) => slackPage()?.send("powertoys:call-command", { action, id });

  function alarm(recording, text) {
    if (recording.alarm === text) return;
    recording.alarm = text;
    if (text) {
      warn(`recording: ${text}`);
      slackPage()?.send("powertoys:notice", { text: `Recording: ${text}` });
    } else log("recording: the call's sound is being recorded again");
    if (!recording.stopping) reply(recording.contents, { type: "recording", since: recording.since, alarm: text });
  }

  /** A message from the page's tap. */
  function callEvent(message) {
    if (message.type === "probe") return probes.get(message.id)?.(message);
    const tapped = calls.get(message.id);
    if (!tapped) return;
    const { recording, call } = tapped;
    if (message.type === "started") return call.started?.(message);
    if (message.type === "stopped") return call.ended?.();
    if (message.type === "error") return restartCall(recording, `the tap failed (${message.error})`);
    if (message.type === "chunk") {
      if (message.sequence !== call.next) warn(`recording: call piece ${message.sequence} came when ${call.next} was due`);
      call.next = message.sequence + 1;
      call.lastPiece = Date.now();
      try {
        fs.writeSync(call.fd, Buffer.from(message.data, "base64"));
        fs.fsyncSync(call.fd);
      } catch (caught) {
        restartCall(recording, `couldn't write ${call.file} (${caught.message})`);
      }
      return;
    }
    if (message.type === "level") {
      const stats = recording.callStats;
      stats.seconds++;
      stats.peak = Math.max(stats.peak, message.level);
      if (message.level > 0.001) stats.heard++;
      recording.noTrack = message.tracks ? 0 : (recording.noTrack ?? 0) + 1;
      if (recording.noTrack === 15) alarm(recording, "no sound from the huddle has reached the recording for 15 seconds");
      else if (message.tracks && recording.alarm?.startsWith("no sound")) alarm(recording, null);
      if (stats.seconds % 30 === 0) writeStatus(recording, recording.status ?? "recording");
    }
  }

  async function startCall(recording) {
    const number = recording.calls.length + 1;
    const id = `${recording.contents.id}-${++tapNumber}`;
    const call = { file: `${recording.base}.call${number > 1 ? `-${number}` : ""}.webm`, startedAt: null, next: 0, id };
    call.fd = fs.openSync(call.file, "a");
    recording.calls.push(call);
    calls.set(id, { recording, call });
    try {
      const started = await new Promise((resolve, reject) => {
        call.started = resolve;
        setTimeout(() => reject(new Error("Slack's page didn't start the tap within 5 seconds")), 5000);
        callCommand("start", id);
      });
      call.startedAt = started.startedAt;
      call.lastPiece = Date.now();
      writeStatus(recording, recording.status ?? "recording");
      log(`recording the huddle's sound from Slack's page to ${call.file} (${started.tracks} track${started.tracks === 1 ? "" : "s"} so far)`);
      // Pieces stopping is the tap failing (the page reloaded, the recorder died): alarm, and a new tap.
      call.watchdog = setInterval(() => {
        if (Date.now() - call.lastPiece < 5000) return;
        alarm(recording, "the huddle's sound stopped reaching the recording; restarting it");
        restartCall(recording, "no piece for 5 seconds");
      }, 1000);
    } catch (caught) {
      endCall(recording, call);
      recording.calls.pop();
      if (fs.existsSync(call.file) && !fs.statSync(call.file).size) fs.rmSync(call.file);
      throw caught;
    }
  }

  function endCall(recording, call) {
    clearInterval(call.watchdog);
    calls.delete(call.id);
    try {
      fs.fsyncSync(call.fd);
      fs.closeSync(call.fd);
    } catch {}
  }

  /** Stops the current tap, taking its last piece (within 5 seconds). */
  async function stopCall(recording) {
    const call = recording.calls.at(-1);
    if (!call || !calls.has(call.id)) return;
    clearInterval(call.watchdog);
    await new Promise((resolve) => {
      call.ended = resolve;
      setTimeout(resolve, 5000);
      callCommand("stop", call.id);
    });
    endCall(recording, call);
  }

  /** The tap failed or went quiet: a new file and a new tap, a few tries; the computer's sound is the backup meanwhile. */
  async function restartCall(recording, why) {
    if (recording.stopping || recording.callRestarting) return;
    recording.callRestarting = true;
    warn(`recording: ${why}; restarting the call's tap`);
    recording.callStats.restarts++;
    try {
      await stopCall(recording);
      for (let attempt = 1; attempt <= 3 && !recording.stopping; attempt++) {
        try {
          await startCall(recording);
          if (recording.alarm?.startsWith("the huddle's sound stopped")) alarm(recording, null);
          return;
        } catch (caught) {
          warn(`recording: the call's tap didn't restart (${caught.message})`);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      if (!recording.stopping) alarm(recording, "the huddle's sound can't be recorded; only the computer's sound and your microphone are");
    } finally {
      recording.callRestarting = false;
    }
  }

  // At Slack's start: the tap is in the page and can record, known before any huddle.
  const probes = new Map();
  async function probeCall() {
    const id = `probe-${++tapNumber}`;
    const answer = await new Promise((resolve) => {
      probes.set(id, resolve);
      setTimeout(() => resolve(null), 10000);
      callCommand("probe", id);
    });
    probes.delete(id);
    if (answer?.recorder) return log("recording: the huddle's sound can be recorded (the page's tap answered)");
    const why = answer ? "Slack's page can't record Opus" : "the tap in Slack's page didn't answer";
    warn(`recording: ${why}`);
    slackPage()?.send("powertoys:notice", { text: `Huddle recordings can't record the call's sound (${why}); only the computer's sound and your microphone would be.` });
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
    const recording = {
      contents,
      where,
      teamId,
      since: Date.now(),
      base: path.join(folder, `${stamp} ${where.replace(/[\\/:*?"<>|]/g, "_")}`),
      parts: [],
      part: null,
      stopping: false,
      starts: {},
      sounds: {},
      calls: [],
      callStats: { seconds: 0, heard: 0, playing: 0, missed: 0, peak: 0, restarts: 0 },
      marks: [],
    };
    recordings.set(contents.id, recording);
    // The call's sound first: Slack's own, whatever speaker it plays on.
    try {
      await startCall(recording);
    } catch (caught) {
      alarm(recording, `Slack's own sound can't be recorded (${caught.message}); only the computer's sound and your microphone are`);
    }
    let failure = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await startPart(recording);
        return reply(contents, { type: "recording", since: recording.since, alarm: recording.alarm ?? null });
      } catch (caught) {
        failure = caught;
        warn(`recording: didn't start (attempt ${attempt}: ${caught.message})`);
        if (recording.part) await endPart(recording, recording.part);
        dropEmptyPart(recording);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    recordings.delete(contents.id);
    recording.stopping = true;
    await stopCall(recording);
    // The call's sound may be all there is: it is finished (and offered) like any recording.
    writeStatus(recording, recording.parts.length || recording.calls.length ? "stopped" : "empty");
    reply(contents, { type: "recording", since: null });
    if (!recording.parts.length && recording.calls.length) finish(recording).catch((caught) => warn(`recording: ${caught.message}`));
    throw failure;
  }

  /** A part that never got any data (its recorder didn't start) holds nothing: its empty file goes. */
  function dropEmptyPart(recording) {
    const file = recording.parts.at(-1);
    if (file && fs.existsSync(file) && fs.statSync(file).size === 0) {
      fs.rmSync(file);
      recording.parts.pop();
      const sound = recording.sounds?.[file];
      if (sound && fs.existsSync(sound) && fs.statSync(sound).size === 0) fs.rmSync(sound);
      delete recording.sounds?.[file];
      delete recording.starts?.[file];
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

  const probeOf = async (file) => JSON.parse(await execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", file]));

  /**
   * Puts the call's sound into a part, as tracks: "Call and microphone" (the one players and transcription use),
   * "Call (from Slack)", "Microphone", "Computer sound (backup)". Each piece of the call (one per tap) goes where it
   * was recorded, by its first moment against the part's. The part is replaced only by a copy ffprobe reads back whole,
   * with every track -> { call: seconds of the call it holds }.
   */
  async function addCallTracks(recording, file) {
    const probe = await probeOf(file);
    const duration = Number(probe.format?.duration);
    if (!(duration > 0)) throw new Error("its length can't be read");
    const hasVideo = probe.streams.some((stream) => stream.codec_type === "video");
    const hasMic = probe.streams.some((stream) => stream.codec_type === "audio");
    const start = recording.starts?.[file];
    const sound = recording.sounds?.[file];
    const hasSound = Boolean(sound && fs.existsSync(sound) && fs.statSync(sound).size > 0);
    // The call's pieces that overlap the part, and where each begins in it (seconds; negative: before the part).
    const pieces = [];
    for (const call of recording.calls ?? []) {
      if (!start || !call.startedAt || !call.duration) continue;
      const at = (call.startedAt - start) / 1000;
      const overlap = Math.min(duration, at + call.duration) - Math.max(0, at);
      if (overlap > 0) pieces.push({ file: call.file, at, overlap });
    }
    if (!pieces.length && !hasSound) return { call: 0 };
    const inputs = ["-i", file];
    const filters = [];
    pieces.forEach((piece, i) => {
      inputs.push("-i", piece.file);
      filters.push(piece.at >= 0 ? `[${i + 1}:a]adelay=${Math.round(piece.at * 1000)}:all=1[p${i}]` : `[${i + 1}:a]atrim=start=${-piece.at},asetpts=PTS-STARTPTS[p${i}]`);
    });
    const soundInput = hasSound ? (inputs.push("-i", sound), inputs.length / 2 - 1) : null;
    let other = `[${soundInput}:a]`;
    if (pieces.length) {
      filters.push(pieces.length > 1 ? `${pieces.map((piece, i) => `[p${i}]`).join("")}amix=inputs=${pieces.length}:duration=longest:normalize=0[call]` : "[p0]anull[call]");
      filters.push("[call]apad,asplit=2[callmix][callout]"); // as long as the part (-t ends it)
      other = "[callmix]";
    }
    filters.push(hasMic ? `${other}[0:a:0]amix=inputs=2:duration=longest:normalize=0[mix]` : `${other}anull[mix]`);
    const maps = [...(hasVideo ? ["-map", "0:v"] : []), "-map", "[mix]"];
    const tracks = [pieces.length ? "Call and microphone" : "Computer sound and microphone"];
    if (pieces.length) {
      maps.push("-map", "[callout]");
      tracks.push("Call (from Slack)");
    }
    if (hasMic) {
      maps.push("-map", "0:a:0");
      tracks.push("Microphone");
    }
    if (hasSound) {
      maps.push("-map", `${soundInput}:a`);
      tracks.push("Computer sound (backup)");
    }
    const encoded = pieces.length ? 2 : 1; // the mix (and the call) are encoded (AAC); the microphone and backup are copied
    const perTrack = tracks.flatMap((title, i) => [
      `-c:a:${i}`,
      ...(i < encoded ? ["aac", `-b:a:${i}`, "160k"] : ["copy"]),
      `-metadata:s:a:${i}`,
      `title=${title}`,
      `-disposition:a:${i}`,
      i === 0 ? "default" : "0",
    ]);
    const copy = `${file}.tracks.mkv`;
    try {
      await execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", filters.join(";"), ...maps, "-c:v", "copy", ...perTrack, "-t", String(duration), "-f", "matroska", copy]);
      const check = await probeOf(copy);
      const audio = check.streams.filter((stream) => stream.codec_type === "audio").length;
      if (!(Number(check.format?.duration) >= duration - 1) || audio !== tracks.length) throw new Error(`the copy isn't whole (${check.format?.duration} s, ${audio} sound tracks)`);
      fs.renameSync(copy, file);
    } catch (caught) {
      fs.rmSync(copy, { force: true });
      throw caught;
    }
    if (hasSound) fs.rmSync(sound, { force: true });
    const call = pieces.reduce((sum, piece) => sum + piece.overlap, 0);
    log(`recording: ${path.basename(file)} has ${tracks.join(", ")} (${Math.round(call)} s of the call)`);
    return { call };
  }

  /** Finishes a recording's parts and asks (in Slack's page) whether to keep them. */
  async function finish(recording) {
    const callFiles = (recording.calls ?? []).filter((call) => fs.existsSync(call.file) && fs.statSync(call.file).size > 0);
    // MediaRecorder's WebM has no length: rewritten with it (like the parts), then measured.
    for (const call of callFiles) {
      await repair(call.file);
      call.duration = Number((await probeOf(call.file).catch(() => ({}))).format?.duration) || 0;
    }
    // Only the call's sound got recorded (the picture and microphone never started): that is the recording.
    const callOnly = !recording.parts.length && callFiles.length > 0;
    if (callOnly) recording.parts = callFiles.map((call) => call.file);
    if (!recording.parts.length) return writeStatus(recording, "empty");
    const problems = [];
    let callSeconds = 0;
    if (!callOnly) {
      for (const file of recording.parts) await repair(file);
      for (const file of recording.parts) {
        try {
          callSeconds += (await addCallTracks(recording, file)).call;
        } catch (caught) {
          problems.push(`${path.basename(file)}: ${caught.message}`);
          warn(`recording: couldn't add the call's tracks to ${file} (${caught.message}); its files are kept`);
        }
      }
      // The call's own files go only once every second of them is in the parts.
      const recorded = callFiles.reduce((sum, call) => sum + call.duration, 0);
      if (!problems.length && recorded > 0 && callSeconds >= recorded - 1) for (const call of callFiles) fs.rmSync(call.file, { force: true });
      else if (recorded > 0) warn(`recording: the call's sound is kept beside the recording (${Math.round(recorded)} s recorded, ${Math.round(callSeconds)} s in the parts)`);
    }
    // The speaker-named transcript (from the captions), the marked moments as chapters, the key frames' list.
    for (const [what, step] of [["captions", captionsTranscript], ["marks", addMarks], ["frames", indexFrames]]) {
      try {
        await step(recording);
      } catch (caught) {
        warn(`recording: ${what}: ${caught.message}`);
      }
    }
    const stats = recording.callStats;
    const checks = [];
    const span = (seconds) => (seconds < 90 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`);
    if (callOnly) checks.push("⚠ Only the call's sound was recorded: the picture and microphone couldn't be.");
    else if (callSeconds > 0) checks.push(`Call sound recorded from Slack (${span(callSeconds)}${stats?.heard ? `, with sound in ${span(stats.heard)} of it` : ""}).`);
    else checks.push("⚠ The call's sound wasn't recorded from Slack; the computer's sound is in its place.");
    if (stats?.restarts) checks.push(`The call's recording restarted ${stats.restarts} time${stats.restarts === 1 ? "" : "s"}.`);
    if (problems.length) checks.push(`⚠ The call's tracks couldn't be added (${problems.join("; ")}); all its files are kept beside the recording.`);
    recording.check = checks.join(" ");
    writeStatus(recording, "finished");
    log(`recording finished: ${recording.check}`);
    const minutes = Math.max(1, Math.round((Date.now() - recording.since) / 60000));
    slackPage()?.send("powertoys:recording-done", { base: recording.base, parts: recording.parts.length, where: recording.where, minutes, recovered: recording.recovered, check: recording.check });
  }

  async function stopRecording(contents, ended) {
    const recording = recordings.get(contents.id);
    if (!recording) return;
    recording.stopping = true;
    recordings.delete(contents.id);
    if (recording.part) await endPart(recording, recording.part);
    await stopCall(recording).catch((caught) => warn(`recording: ${caught.message}`));
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
  //               (<recording>.transcript.txt) and into it, as a subtitle track;
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

  /**
   * The transcript inside the video too: a subtitle track (SRT, in the transcription language) added to a part with
   * ffmpeg (streams copied as they are) into a copy, which replaces the part only once ffprobe reads it back complete
   * with its subtitles; otherwise the part is left as it was.
   */
  const SUBTITLE_LANGUAGES = { en: "eng", de: "ger", es: "spa", fr: "fre", it: "ita", pt: "por", ja: "jpn", ko: "kor", zh: "chi" };
  async function addSubtitles(file, lines, title = "Transcript (Slack)") {
    if (!lines.length) return;
    const time = (ms) => {
      const pad = (n, width = 2) => String(n).padStart(width, "0");
      return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
    };
    const srt = `${file}.srt`;
    fs.writeFileSync(srt, lines.map((line, i) => `${i + 1}\n${time(line.start)} --> ${time(Math.max(line.end ?? line.start + 2000, line.start + 500))}\n${line.text}\n`).join("\n"));
    const copy = `${file}.subtitled.mkv`;
    const language = SUBTITLE_LANGUAGES[claude.transcriptLanguage().slice(0, 2)] ?? "und";
    try {
      // Other subtitle tracks stay (the captions' and Slack's transcript live side by side); one of the same title goes.
      const existing = JSON.parse(await execFile("ffprobe", ["-v", "error", "-show_entries", "stream=index,codec_type:stream_tags=title", "-of", "json", file])).streams ?? [];
      const subtitles = existing.filter((stream) => stream.codec_type === "subtitle");
      const replaced = subtitles.filter((stream) => stream.tags?.title === title);
      const at = subtitles.length - replaced.length; // the new track's number among the subtitles
      await execFile("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y", "-i", file, "-i", srt,
        "-map", "0", ...replaced.flatMap((stream) => ["-map", `-0:${stream.index}`]), "-map", "1",
        "-c", "copy", "-c:s", "srt", `-metadata:s:s:${at}`, `language=${language}`, `-metadata:s:s:${at}`, `title=${title}`, "-f", "matroska", copy,
      ]);
      const probe = JSON.parse(await execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", copy]));
      const duration = Number(probe.format?.duration);
      if (!(duration > 0) || !probe.streams?.some((stream) => stream.codec_type === "subtitle")) throw new Error("the copy with subtitles isn't complete");
      fs.renameSync(copy, file);
      log(`recording subtitled: ${file} (${title}, ${lines.length} lines)`);
    } catch (caught) {
      fs.rmSync(copy, { force: true });
      warn(`recording: ${file} kept without subtitles (${caught.message})`);
    } finally {
      fs.rmSync(srt, { force: true });
    }
  }

  /** The captions seen during a recording (powertoys appended each version of a line): the last of each, in order. */
  function captionLines(recording) {
    const file = `${recording.base}.captions.jsonl`;
    if (!fs.existsSync(file)) return [];
    const latest = new Map();
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      try {
        const caption = JSON.parse(line);
        latest.set(caption.id, caption);
      } catch {}
    }
    return [...latest.values()].filter((caption) => caption.text).sort((a, b) => a.at - b.at);
  }

  /**
   * The speaker-named transcript, from the captions: <recording>.captions.txt ("[mm:ss] Name: words", from the
   * recording's start), and a subtitle track "Captions (speakers)" in each part -> the file, or null without captions.
   */
  async function captionsTranscript(recording) {
    const lines = captionLines(recording);
    if (!lines.length) return null;
    const file = `${recording.base}.captions.txt`;
    fs.writeFileSync(file, `${recording.where ?? "Huddle"}, ${new Date(recording.since).toLocaleString()} (from Slack's live captions, with who spoke)\n\n${lines.map((line) => `[${clock(line.at - recording.since)}] ${line.name ? `${line.name}: ` : ""}${line.text}`).join("\n")}\n`);
    for (const part of recording.parts) {
      const start = recording.starts?.[part];
      if (!start || !/\.mkv$/.test(part)) continue;
      const inPart = lines.map((line, i) => ({ start: line.at - start, end: (lines[i + 1]?.at ?? line.at + 4000) - start, text: `${line.name ? `${line.name}: ` : ""}${line.text}` })).filter((line) => line.end > 0);
      await addSubtitles(part, inPart.map((line) => ({ ...line, start: Math.max(0, line.start) })), "Captions (speakers)");
    }
    log(`recording: speaker-named transcript from ${lines.length} captions: ${file}`);
    return file;
  }

  /** The key frames kept while recording (<recording>.frames\mm-ss.jpg): their list, <recording>.frames\index.txt. */
  function indexFrames(recording) {
    const folder = `${recording.base}.frames`;
    if (!fs.existsSync(folder)) return null;
    const names = fs.readdirSync(folder).filter((name) => name.endsWith(".jpg")).sort();
    if (!names.length) return null;
    fs.writeFileSync(path.join(folder, "index.txt"), `Stills of the huddle window when it changed a lot (a new slide, another screen shared), by time from the recording's start:\n${names.map((name) => `${name.slice(0, -4).replace("-", ":")}  ${name}`).join("\n")}\n`);
    log(`recording: ${names.length} key frame${names.length === 1 ? "" : "s"} in ${folder}`);
    return folder;
  }

  /** The marks as chapters of each part ("★ mm:ss Name: words"), and in <recording>.marks.txt. */
  async function addMarks(recording) {
    const marks = recording.marks ?? [];
    if (!marks.length) return null;
    const title = (mark) => `★ ${clock(mark.at - recording.since)} ${mark.lines.at(-1) ?? ""}`.slice(0, 120);
    const file = `${recording.base}.marks.txt`;
    fs.writeFileSync(file, `Moments marked during the huddle (time from the recording's start; the caption lines just before)\n\n${marks.map((mark) => `[${clock(mark.at - recording.since)}]\n${mark.lines.map((line) => `  ${line}`).join("\n")}`).join("\n\n")}\n`);
    for (const part of recording.parts) {
      const start = recording.starts?.[part];
      if (!start || !/\.mkv$/.test(part)) continue;
      const inPart = marks.filter((mark) => mark.at >= start);
      if (!inPart.length) continue;
      const escape = (text) => text.replace(/[=;#\\\n]/g, (c) => (c === "\n" ? " " : `\\${c}`));
      const meta = `${part}.chapters.txt`;
      const ends = [...inPart.slice(1).map((mark) => mark.at - start), null];
      fs.writeFileSync(meta, `;FFMETADATA1\n${inPart.map((mark, i) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${mark.at - start}\nEND=${ends[i] ?? mark.at - start + 1000 * 60 * 60 * 24}\ntitle=${escape(title(mark))}\n`).join("")}`);
      const copy = `${part}.chapters.mkv`;
      try {
        await execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", part, "-i", meta, "-map", "0", "-map_metadata", "0", "-map_chapters", "1", "-c", "copy", "-f", "matroska", copy]);
        const probe = JSON.parse(await execFile("ffprobe", ["-v", "error", "-show_chapters", "-show_entries", "format=duration", "-of", "json", copy]));
        if (!(Number(probe.format?.duration) > 0) || probe.chapters?.length !== inPart.length) throw new Error("the copy with chapters isn't complete");
        fs.renameSync(copy, part);
      } catch (caught) {
        fs.rmSync(copy, { force: true });
        warn(`recording: ${part} kept without chapters (${caught.message})`);
      } finally {
        fs.rmSync(meta, { force: true });
      }
    }
    log(`recording: ${marks.length} marked moment${marks.length === 1 ? "" : "s"}: ${file}`);
    return file;
  }

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
        await execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", part, "-map", "0:a:0", "-c:a", "aac", "-b:a", "96k", audio]);
        const fileId = await uploadPrivately(team, audio, `${path.basename(recording.base)}${recording.parts.length > 1 ? ` (part ${i + 1})` : ""} (audio)`);
        updateRecording(recording.base, { slackFiles: [...(recordingAt(recording.base).slackFiles ?? []), fileId] });
        notice("Uploaded; Slack is transcribing it…");
        const lines = await slackTranscript(fileId);
        sections.push(`${recording.parts.length > 1 ? `# Part ${i + 1}\n` : ""}${lines.map((line) => `[${clock(line.start)}] ${line.text}`).join("\n")}`);
        await addSubtitles(part, lines);
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
    const captions = `${recording.base}.captions.txt`;
    const transcript = fs.readFileSync(fs.existsSync(captions) ? captions : await transcribeRecording(recording), "utf8");
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

  /**
   * Shares a recording with Claude: a Claude Code session (one of the workspace's linked folder, chosen, or a new one
   * there, else in the recordings folder) gets the transcript attached (an @ mention; transcribed first if need be) and only the video's path, to
   * be looked at only when the transcript isn't enough.
   */
  async function shareRecording(recording, sessionId = null, purpose = "share") {
    // The speaker-named transcript (from the captions) when there is one; Slack's transcription otherwise.
    const captions = `${recording.base}.captions.txt`;
    const transcript = fs.existsSync(captions) ? captions : await transcribeRecording(recording);
    const folder = __webpack_require__("powertoys/claude").settings().folders[recording.teamId] ?? path.dirname(recording.base);
    const when = new Date(recording.since).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    const videos = recording.parts.map((file) => `"${file}"`).join(", ");
    const marks = `${recording.base}.marks.txt`;
    const frames = `${recording.base}.frames`;
    const prompt =
      `A Slack huddle in ${recording.where} was recorded on ${when}. Its transcript${transcript === captions ? " (from the live captions, with who spoke)" : ""} is attached: @"${transcript}"\n` +
      (fs.existsSync(marks) ? `I marked moments during the call; they are attached: @"${marks}"; start from them.\n` : "") +
      (fs.existsSync(path.join(frames, "index.txt")) ? `Stills of the screen when it changed (shared screens, slides) are in "${frames}" (index.txt lists them by time); look at those before the video.\n` : "") +
      `\nThe video is at ${videos} (the huddle window's picture; sound tracks: call and microphone, call, microphone, computer sound). ` +
      "Work from the transcript. Only when the transcript isn't enough for something (what was on screen, or speech it got wrong), " +
      "look at the video, and only at the parts you need.\n\n" +
      (purpose === "tickets"
        ? "From this call, propose ticket work in Notion's Issues database (Issues & Sprints → Core DBs → Issues), written the way tickets " +
          "are written there: comments on existing tickets the call is about (ISS-… mentioned, or clearly the same work), and new tickets " +
          "for new work, each with its fields filled as the others are. List every proposal first and create or change nothing in Notion " +
          "until I approve it, one by one."
        : "Tell me in a few lines what the call was about, then wait for my questions.");
    log(`${purpose === "tickets" ? "proposing tickets from" : "sharing"} a recording with Claude (${sessionId ? `session ${sessionId}` : "a new Code session"} in ${folder}): ${recording.base}`);
    return __webpack_require__("powertoys/assist").toClaude({ prompt, folder, sessionId });
  }

  /** An operation on a recording -> what the page shows. */
  async function recordingOperation({ base, op, sessionId }) {
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
    if (op === "share") return shareRecording(recording, sessionId);
    if (op === "tickets") return shareRecording(recording, sessionId, "tickets");
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

  /**
   * Quitting Slack while recording: the recordings are finished first, then Slack quits. This runs before Slack's own
   * before-quit listener, and holds both before-quit and will-quit (Slack calls app.quit again ~60 ms later) until
   * every recording is stopped, written and repaired; otherwise the last seconds were lost.
   */
  let finishing = null;
  function finishBeforeQuit(event) {
    if (finishing === "done") return;
    if (!finishing && !recordings.size) return;
    event.preventDefault();
    if (finishing) return;
    log(`quitting: finishing ${recordings.size} recording(s) first`);
    finishing = Promise.all([...recordings.values()].map((recording) => stopRecording(recording.contents, true).catch((caught) => warn(`recording: ${caught.message}`)))).finally(() => {
      finishing = "done";
      electron.app.quit();
    });
  }

  exports.start = function start() {
    // The windows Slack's page opens (huddle, incoming call); the watcher leaves its main window alone.
    electron.app.on("web-contents-created", (event, contents) => {
      if (contents.getType() === "window") watchWindow(contents);
    });
    electron.ipcMain.handle("powertoys:recording", (event, request) => recordingOperation(request));
    electron.ipcMain.handle("powertoys:huddle-ringing", () => ringStarted("main"));
    electron.ipcMain.handle("powertoys:huddle-ring-ended", () => ringEnded("main"));
    electron.ipcMain.handle("powertoys:huddle-cancelled", () => ringCancelled("main"));
    electron.ipcMain.handle("powertoys:recordings", () => listRecordings());
    electron.ipcMain.handle("powertoys:recording-open", (event, request) => openRecordingFile(request));
    // The Claude Code sessions a share can go to: the linked folder's of a workspace (or of a recording's workspace).
    electron.ipcMain.handle("powertoys:claude-sessions", (event, { teamId, base } = {}) => {
      const folder = readSettings().claude?.folders?.[teamId ?? (base ? recordingAt(base).teamId : null)] ?? null;
      return { folder, sessions: folder ? projectSessions(folder).map(({ id, title, updated }) => ({ id, title, updated })) : [] };
    });
    electron.ipcMain.on("powertoys:call-event", (event, detail) => {
      try {
        callEvent(JSON.parse(detail));
      } catch (caught) {
        warn(`recording: a message from the call's tap: ${caught.message}`);
      }
    });
    electron.app.prependListener("before-quit", finishBeforeQuit);
    electron.app.prependListener("will-quit", finishBeforeQuit);
    // Once Slack's page is up (it shows the question), recordings a crash or a quit left unfinished.
    const recover = setInterval(() => {
      if (!slackPage() || slackPage().isLoading()) return;
      clearInterval(recover);
      setTimeout(() => recoverRecordings().catch((caught) => warn(`recording: ${caught.message}`)), 15000);
      // Whether the call's sound can be recorded, known before any call: a notice if it can't.
      if (readSettings().huddle?.autoRecord !== false) {
        probeCall().catch((caught) => warn(`recording: ${caught.message}`));
      }
    }, 5000);
  };
});
