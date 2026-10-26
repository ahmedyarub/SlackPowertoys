// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): the preload half, in Slack's page (app.slack.com).
//
// Started by one line in preload.bundle.js/_runtime.js, right after the preload's store exists:
//   webpackRequire("powertoys/page").start(store);
// It runs in the preload's isolated world: it reads and changes the page through the DOM, shares the page's storage
// (same origin), and talks to the main process over IPC ("powertoys:*" channels, see powertoys-main.js).
//
// Right-clicking a workspace icon (the switcher button in the left rail, or a workspace in the switcher) shows a
// small menu: mark everything read in that workspace, or in every workspace (the main process does the marking with
// Slack's API; Slack's servers then update the sidebar), and link the workspace to a folder for Claude Code.
// Slack's message menu (right-click a message, or its "More actions") gets "Ask Claude about this", which opens Claude
// (a Code session in the workspace's folder, or a chat); a notice offers a summary when a huddle you were in ends.
// ---------------------------------------------------------------------------------------------
(function (module, exports, __webpack_require__) {
  "use strict";

  const electron = __webpack_require__(261);
  const log = (message) => electron.ipcRenderer.send("powertoys:log", String(message));

  // Elements that stand for a workspace, by Slack's test ids.
  const WORKSPACE_ICON = '[data-qa="account_switcher_team_icon"], [data-qa^="team-switcher"], [data-qa^="team_switcher"]';

  /** The workspace an element stands for: its team id (data-team-id, or the current one from the URL) and name. */
  function workspaceOf(element) {
    const teamId = element.closest("[data-team-id]")?.dataset.teamId ?? /\/client\/([A-Z0-9]+)/.exec(location.pathname)?.[1] ?? null;
    const label = element.getAttribute("aria-label") ?? element.querySelector("[aria-label]")?.getAttribute("aria-label") ?? "";
    const name = /\(([^)]+)\)\s*$/.exec(label)?.[1] ?? label.replace(/^Switch workspaces…\s*/, "") ?? "";
    return { teamId, name: name.trim() || "this workspace" };
  }

  // --- A small menu and a short notice, in the page (styled like Slack's dark menus) -----------------------
  let host = null;
  function ui() {
    if (host?.isConnected) return host.shadowRoot;
    host = document.createElement("div");
    host.dataset.powertoys = "ui";
    host.attachShadow({ mode: "open" }).innerHTML = `<style>
      .menu { position: fixed; z-index: 2147483647; min-width: 260px; padding: 6px 0; border-radius: 8px;
        background: #222529; color: #d1d2d3; font: 14px/1.4 Lato, "Segoe UI", sans-serif;
        box-shadow: 0 0 0 1px rgba(255,255,255,.13), 0 4px 12px rgba(0,0,0,.4); }
      .item { padding: 5px 24px; cursor: default; white-space: nowrap; }
      .item:hover { background: #1264a3; color: #fff; }
      .separator { margin: 6px 0; border-top: 1px solid rgba(255,255,255,.13); }
      .notice { position: fixed; z-index: 2147483647; left: 50%; bottom: 72px; transform: translateX(-50%); padding: 8px 16px;
        display: flex; gap: 12px; align-items: center;
        border-radius: 8px; background: #222529; color: #d1d2d3; font: 14px/1.4 Lato, "Segoe UI", sans-serif;
        box-shadow: 0 0 0 1px rgba(255,255,255,.13), 0 4px 12px rgba(0,0,0,.4); }
      .notice button { font: inherit; font-weight: 700; color: #fff; background: #007a5a; border: 0; border-radius: 4px;
        padding: 4px 10px; cursor: pointer; }
      .notice button.close { background: transparent; color: #d1d2d3; font-weight: 400; padding: 0 4px; }
      .notice label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; white-space: nowrap; }
      .notice input[type=checkbox] { width: 16px; height: 16px; margin: 0; accent-color: #007a5a; cursor: pointer; }
      .notice input:focus-visible, .notice button:focus-visible { outline: 2px solid #1d9bd1; outline-offset: 2px; }
      .notice select { font: inherit; max-width: 320px; padding: 3px 6px; border-radius: 4px; border: 1px solid rgba(255,255,255,.25); background: #1a1d21; color: #fff; }
      .notice select:focus-visible { outline: 2px solid #1d9bd1; outline-offset: 2px; }
      .notice .verdict { font-size: 12px; opacity: .85; }
      .notice .verdict.warn { color: #ecb22e; opacity: 1; }
    </style>`;
    // Slack sends keys typed outside a text field to the message box; from outside the shadow root our fields don't
    // look like text fields, so their keys stop here.
    for (const type of ["keydown", "keypress", "keyup"]) {
      host.addEventListener(type, (event) => event.composedPath()[0]?.matches?.("input, textarea, select") && event.stopPropagation());
    }
    document.body.appendChild(host);
    return host.shadowRoot;
  }

  function closeMenu() {
    host?.shadowRoot.querySelector(".menu")?.remove();
  }

  /** A short notice; with actions (one or a list), buttons (and a close button) that stay a minute, or `ms`. */
  function notice(text, action = null, ms = null) {
    const root = ui();
    root.querySelector(".notice")?.remove();
    const node = document.createElement("div");
    node.className = "notice";
    node.append(text);
    const actions = [].concat(action ?? []);
    for (const each of actions) {
      const button = document.createElement("button");
      button.textContent = each.label;
      button.addEventListener("click", () => (node.remove(), each.run()));
      node.append(button);
    }
    if (actions.length) {
      const close = document.createElement("button");
      close.className = "close";
      close.textContent = "×";
      close.title = "Close";
      close.addEventListener("click", () => node.remove());
      node.append(close);
    }
    root.appendChild(node);
    setTimeout(() => node.remove(), ms ?? (actions.length ? 60000 : 4000));
  }

  const reason = (caught) => caught.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

  /** What can be done with a huddle's recording (powertoys/huddle): transcribe, summarize, save, delete. */
  /**
   * Which Claude Code session a share goes to: "(New session)" (the default) or one of the workspace's linked folder's
   * (newest first), in a small dialog -> the session's id, null for a new one, undefined if closed.
   */
  async function chooseSession(request) {
    const { folder, sessions } = await invoke("claude-sessions", request).catch(() => ({ folder: null, sessions: [] }));
    const root = ui();
    root.querySelector(".notice")?.remove();
    return new Promise((resolve) => {
      const node = Object.assign(document.createElement("div"), { className: "notice" });
      node.setAttribute("role", "dialog");
      node.setAttribute("aria-label", "Share with Claude");
      const label = Object.assign(document.createElement("label"), { textContent: "Share with" });
      const select = document.createElement("select");
      select.append(Object.assign(document.createElement("option"), { value: "", textContent: "(New session)" }));
      for (const session of sessions) select.append(Object.assign(document.createElement("option"), { value: session.id, textContent: session.title }));
      label.append(select);
      const done = (value) => (node.remove(), resolve(value));
      const send = Object.assign(document.createElement("button"), { textContent: "Send" });
      send.addEventListener("click", () => done(select.value || null));
      const close = Object.assign(document.createElement("button"), { textContent: "×", className: "close", title: "Don't share" });
      close.addEventListener("click", () => done(undefined));
      node.addEventListener("keydown", (event) => event.key === "Escape" && done(undefined));
      const where = folder ? "" : " (this workspace has no linked folder: a new session)";
      node.append(label, send, close, where);
      root.appendChild(node);
      select.focus();
    });
  }

  /** A share's outcome: a new session opening, or the chosen session's answer. */
  const shared = ({ folder, session, queued, clipboard }) =>
    queued
      ? notice(`Sent to "${session}" in Claude Desktop (it goes in as soon as its current turn is over).`)
      : clipboard
        ? notice(`"${session}" is open in Claude Desktop, and the share is on the clipboard: paste it there (Ctrl+V) and send.`, null, 20000)
        : notice(`Opening Claude Code in ${folder} with the transcript…`);

  function recordingActions(base) {
    const open = (file) => invoke("recording-open", { base, file }).catch((caught) => notice(reason(caught)));
    return [
      {
        label: "Transcribe",
        run: () =>
          invoke("recording", { base, op: "transcribe" }).then(
            ({ file }) => notice("Transcript saved beside the recording.", { label: "Open", run: () => open(file) }),
            (caught) => notice(`Couldn't transcribe: ${reason(caught)}`),
          ),
      },
      {
        label: "Summarize",
        run: () =>
          invoke("recording", { base, op: "summarize" }).then(
            ({ file, text }) => popover({ title: "The huddle, summarized", text, markdown: true, actions: [{ label: "Open the file", run: () => open(file) }] }),
            (caught) => notice(`Couldn't summarize: ${reason(caught)}`),
          ),
      },
      {
        label: "Share with Claude",
        run: async () => {
          const sessionId = await chooseSession({ base });
          if (sessionId === undefined) return;
          return invoke("recording", { base, op: "share", sessionId }).then(shared, (caught) => notice(`Couldn't share it with Claude: ${reason(caught)}`));
        },
      },
      {
        label: "Propose tickets",
        run: async () => {
          const sessionId = await chooseSession({ base });
          if (sessionId === undefined) return;
          return invoke("recording", { base, op: "tickets", sessionId }).then(shared, (caught) => notice(`Couldn't ask Claude for tickets: ${reason(caught)}`));
        },
      },
      { label: "Save", run: () => invoke("recording", { base, op: "save" }).then(() => notice("Recording saved.")) },
      { label: "Delete", run: () => invoke("recording", { base, op: "delete" }).then(() => notice("Recording moved to the Recycle Bin.")) },
    ];
  }

  /**
   * When a huddle's recording ends: check-boxes for what to do with it (Keep, checked; Transcribe; Summarize and Share
   * with Claude, which transcribe first) and OK. Unticking Keep and pressing OK asks before the recording goes to the Recycle Bin;
   * closing the prompt or leaving it keeps the recording.
   */
  function recordingPrompt({ base, parts, where, minutes, recovered, check: verdict }) {
    const root = ui();
    root.querySelector(".notice")?.remove();
    const node = document.createElement("div");
    node.className = "notice recording-prompt";
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-label", "Huddle recording");
    const title = `${recovered ? "Recovered an unfinished recording of" : "Recorded"} the huddle${where ? ` in ${where}` : ""}${recovered ? "" : ` (${minutes} min)`}${parts > 1 ? `, in ${parts} parts` : ""}.`;
    const check = (label, checked) => {
      const input = Object.assign(document.createElement("input"), { type: "checkbox", checked });
      const wrap = document.createElement("label");
      wrap.append(input, label);
      return { wrap, input };
    };
    const button = (label, run, className = "") => {
      const node2 = Object.assign(document.createElement("button"), { textContent: label, className });
      node2.addEventListener("click", run);
      return node2;
    };
    const keep = check("Keep the recording", true);
    const transcribe = check("Transcribe", false);
    const summarize = check("Summarize", false);
    const share = check("Share with Claude", false);
    const tickets = check("Propose tickets", false);
    // Summarize, Share and Tickets need the transcript, and all of them need the recording kept.
    for (const needsTranscript of [summarize, share, tickets]) {
      needsTranscript.input.addEventListener("change", () => needsTranscript.input.checked && ((transcribe.input.checked = true), (keep.input.checked = true)));
    }
    transcribe.input.addEventListener("change", () => (transcribe.input.checked ? (keep.input.checked = true) : (summarize.input.checked = share.input.checked = tickets.input.checked = false)));
    keep.input.addEventListener("change", () => keep.input.checked || (transcribe.input.checked = summarize.input.checked = share.input.checked = tickets.input.checked = false));
    const close = button("×", () => node.remove(), "close");
    close.title = "Close (the recording is kept)";
    // What the end-of-call check found (the call's sound recorded or not); a problem is announced.
    const verdictNode = verdict ? Object.assign(document.createElement("span"), { textContent: verdict, className: verdict.includes("⚠") ? "verdict warn" : "verdict" }) : "";
    if (verdict?.includes("⚠")) verdictNode.setAttribute("role", "alert");
    const choices = () => {
      node.replaceChildren(title, verdictNode, keep.wrap, transcribe.wrap, summarize.wrap, share.wrap, tickets.wrap, button("OK", apply), close);
      keep.input.focus();
    };
    const apply = () => {
      if (!keep.input.checked) {
        node.replaceChildren(
          "Move the recording to the Recycle Bin?",
          button("Yes", () => {
            node.remove();
            invoke("recording", { base, op: "delete" }).then(() => notice("Recording moved to the Recycle Bin."), (caught) => notice(`Couldn't delete it: ${reason(caught)}`));
          }),
          button("No", () => ((keep.input.checked = true), choices()), "close"),
        );
        return;
      }
      node.remove();
      const actions = recordingActions(base);
      const run = (label) => actions.find((action) => action.label === label).run();
      // One after the other: sharing needs the transcript that Transcribe or Summarize makes first.
      invoke("recording", { base, op: "save" })
        .then(async () => {
          if (summarize.input.checked) await run("Summarize");
          else if (transcribe.input.checked) await run("Transcribe");
          else notice("Recording kept.");
          if (share.input.checked) await run("Share with Claude");
          if (tickets.input.checked) await run("Propose tickets");
        })
        .catch((caught) => notice(`Couldn't keep it: ${reason(caught)}`));
    };
    choices();
    root.appendChild(node);
    setTimeout(() => node.remove(), 10 * 60000);
  }

  async function markAllRead(teamId, where) {
    notice(`Marking everything as read ${where}…`);
    try {
      const { marked, failed } = await electron.ipcRenderer.invoke("powertoys:mark-all-read", teamId);
      notice(`${marked ? `Marked ${marked} conversation${marked === 1 ? "" : "s"} as read` : "Nothing was unread"} ${where}${failed ? ` (${failed} failed)` : ""}`);
    } catch (caught) {
      notice(`Couldn't mark everything as read: ${reason(caught)}`);
    }
  }

  async function askClaude(request) {
    try {
      const { folder } = await electron.ipcRenderer.invoke("powertoys:ask-claude", request);
      notice(folder ? `Opening Claude Code in ${folder}…` : "Opening Claude…");
    } catch (caught) {
      notice(`Couldn't open Claude: ${reason(caught)}`);
    }
  }

  async function linkFolder(workspace) {
    try {
      const folder = await electron.ipcRenderer.invoke("powertoys:link-folder", workspace.teamId);
      if (folder) notice(`Claude Code sessions from ${workspace.name} start in ${folder}`);
    } catch (caught) {
      notice(`Couldn't link the folder: ${reason(caught)}`);
    }
  }

  async function unlinkFolder(workspace) {
    await electron.ipcRenderer.invoke("powertoys:unlink-folder", workspace.teamId);
    notice(`${workspace.name} has no Claude folder now (Ask Claude opens a chat)`);
  }

  async function showMenu(x, y, workspace) {
    closeMenu();
    const folder = workspace.teamId ? await electron.ipcRenderer.invoke("powertoys:claude-folder", workspace.teamId) : null;
    const folderName = folder?.split(/[\\/]/).filter(Boolean).pop();
    const menu = document.createElement("div");
    menu.className = "menu";
    const entries = [
      workspace.teamId && [`Mark all as read in ${workspace.name}`, () => markAllRead(workspace.teamId, `in ${workspace.name}`)],
      ["Mark all as read in all workspaces", () => markAllRead(null, "in all workspaces")],
      workspace.teamId && "separator",
      workspace.teamId && [folder ? `Claude folder: ${folderName} (change…)` : "Link a folder for Claude…", () => linkFolder(workspace), folder],
      folder && ["Unlink the Claude folder", () => unlinkFolder(workspace)],
    ];
    for (const entry of entries.filter(Boolean)) {
      const item = document.createElement("div");
      if (entry === "separator") {
        item.className = "separator";
      } else {
        const [label, run, title] = entry;
        item.className = "item";
        item.textContent = label;
        if (title) item.title = title;
        item.addEventListener("click", () => {
          closeMenu();
          run();
        });
      }
      menu.appendChild(item);
    }
    ui().appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, innerWidth - rect.width - 8)}px`;
    menu.style.top = `${Math.min(y, innerHeight - rect.height - 8)}px`;
  }

  // --- Items in Slack's message menu ----------------------------------------------------------------------
  // Slack draws the menu (.p-message_actions_menu) when a message is right-clicked or its "More actions" clicked; the
  // message is the list item the click was in, and its timestamp link is its permalink. Page modules add items with
  // addMessageMenuItem({ label, show(message), run(message), inFileMenu }); a message is { link, teamId, text,
  // element }. inFileMenu: also in the menu of a file in the message (its ⋮).
  let lastMessage = null;
  function rememberMessage(event) {
    const item = event.target.closest?.('[data-qa="virtual-list-item"]');
    const ts = item?.dataset.itemKey;
    if (!ts || !/^\d{10}\.\d{6}$/.test(ts)) return;
    const digits = `p${ts.replace(".", "")}`;
    const link = [...item.querySelectorAll('a[href*="/archives/"]')].find((anchor) => anchor.pathname.endsWith(digits))?.href;
    if (!link) return;
    const text = item.querySelector('[data-qa="message-text"]')?.innerText ?? "";
    lastMessage = { link, teamId: workspaceOf(item).teamId, text, element: item, at: Date.now() };
  }

  const SPARKLE =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M10 1.5l1.9 5.2 5.1 1.9-5.1 1.9L10 15.7l-1.9-5.2L3 8.6l5.1-1.9zM15.5 13l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></svg>';
  const menuItems = [];
  exports.addMessageMenuItem = (item) => menuItems.push(item);

  // The message's menu gets every item; a file's own menu (the ⋮ on a video: Download, Share file…, Copy link) gets
  // the items meant for files ({ inFileMenu: true }). They go at the end, after a divider: Slack's menu works out
  // the item under the mouse from its items' places, so one put between them made it highlight the item above.
  // Each is a copy of "Copy link" (a plain item), with our label and icon.
  function addMenuItems(menu, fileMenu = false) {
    if (!lastMessage || Date.now() - lastMessage.at > 5000 || menu.querySelector(".powertoys-menu-item")) return;
    if (fileMenu) return attachUnder(menu);
    let template = menu.querySelector('[data-qa="copy_link-wrapper"]');
    if (!template && fileMenu) {
      const copy = [...menu.querySelectorAll('[role="menuitem"]')].find((each) => each.textContent.trim() === "Copy link");
      template = copy?.closest('[data-qa$="-wrapper"]') ?? copy?.parentElement;
    }
    if (!template) return log(`a ${fileMenu ? "file" : "message"} menu without "Copy link": nothing added`);
    // After the last item: its own wrapper (the largest element around it holding no other item), in its list.
    let after = [...menu.querySelectorAll('[role="menuitem"]')].at(-1) ?? template;
    while (after.parentElement && after.parentElement !== menu && after.parentElement.querySelectorAll('[role="menuitem"]').length === 1) after = after.parentElement;
    const message = lastMessage;
    const wanted = menuItems.filter((item) => (!fileMenu || item.inFileMenu) && (!item.show || item.show(message)));
    if (!wanted.length) return;
    const divider = menu.querySelector('[role="separator"], [class*="menu_separator"], hr')?.cloneNode(true);
    if (divider) {
      divider.classList.add("powertoys-menu-item");
      after.after(divider);
      after = divider;
    }
    for (const item of wanted) {
      const wrapper = template.cloneNode(true);
      wrapper.dataset.qa = `powertoys_${item.label.toLowerCase().replace(/\W+/g, "_")}-wrapper`;
      wrapper.classList.add("powertoys-menu-item");
      for (const node of wrapper.querySelectorAll("[id]")) node.removeAttribute("id");
      // The item copied may be the highlighted one (under the mouse): the copy starts plain, and highlights on hover.
      // Any state modifier goes (…--highlighted, --hover, --active, --selected, --focus…), and state attributes too.
      for (const node of [wrapper, ...wrapper.querySelectorAll("*")]) {
        for (const name of [...node.classList]) if (/--[\w-]*(highlight|hover|active|selected|focus)/i.test(name)) node.classList.remove(name);
        for (const attribute of ["aria-selected", "aria-current", "data-highlighted", "data-hover", "data-active", "data-focus"]) node.removeAttribute(attribute);
      }
      wrapper.querySelector(".c-menu_item__shortcut")?.remove();
      const icon = wrapper.querySelector(".c-menu_item__icon");
      if (icon) icon.innerHTML = SPARKLE;
      const label = wrapper.querySelector(".c-menu_item__label") ?? [...wrapper.querySelectorAll("*")].findLast((node) => !node.children.length && node.textContent.trim()) ?? wrapper;
      label.textContent = item.label;
      const button = wrapper.querySelector("button") ?? wrapper;
      // Slack's menu keeps which of its items is highlighted in its own state, and ours isn't one of its items: under
      // the mouse, ours would be highlighted beside the item Slack last marked. Its state is left alone; while the
      // mouse is on ours, the menu only hides Slack's highlight (drawn as an ordinary item's colors), so moving back
      // onto that item shows it highlighted again.
      button.addEventListener("mouseenter", () => {
        const plain = [...menu.querySelectorAll('[role="menuitem"]')].find((item) => !/--highlighted/.test(item.className) && !item.closest(".powertoys-menu-item"));
        if (plain) menu.style.setProperty("--powertoys-menu-color", getComputedStyle(plain).color);
        menu.classList.add("powertoys-menu-over");
      });
      button.addEventListener("mouseleave", () => menu.classList.remove("powertoys-menu-over"));
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        // Slack's menu closes on Escape pressed inside it.
        button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
        item.run(message);
      });
      after.after(wrapper);
      after = wrapper;
    }
  }

  // A file's own menu (the ⋮ on a video): Slack's menu tracks its items and their places itself, and an item put
  // inside it made the wrong neighbour highlight. Ours are drawn just under the menu instead, in Powertoys' own layer,
  // looking like its items, and go when it closes; the menu itself is left as Slack made it.
  let underMenu = null;
  function attachUnder(menu) {
    underMenu?.remove();
    const message = lastMessage;
    const wanted = menuItems.filter((item) => item.inFileMenu && (!item.show || item.show(message)));
    if (!wanted.length) return;
    const box = document.createElement("div");
    box.className = "under-menu";
    box.setAttribute("role", "menu");
    const plain = [...menu.querySelectorAll('[role="menuitem"]')].find((item) => !/--highlighted/.test(item.className));
    const style = plain ? getComputedStyle(plain) : null;
    for (const item of wanted) {
      const button = document.createElement("button");
      button.setAttribute("role", "menuitem");
      button.innerHTML = SPARKLE;
      button.append(item.label);
      if (style) Object.assign(button.style, { font: style.font, color: style.color, padding: style.padding });
      // On press (Slack closes its menu on a press outside it, before a click would come).
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        underMenu?.remove();
        underMenu = null;
        document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
        item.run(message);
      });
      box.append(button);
    }
    const place = () => {
      if (!menu.isConnected) {
        box.remove();
        if (underMenu === box) underMenu = null;
        return;
      }
      const rect = menu.getBoundingClientRect();
      const fitsBelow = rect.bottom + 8 + box.offsetHeight <= innerHeight;
      Object.assign(box.style, { left: `${rect.left}px`, width: `${rect.width}px`, top: `${fitsBelow ? rect.bottom + 4 : rect.top - box.offsetHeight - 4}px` });
      requestAnimationFrame(place);
    };
    ui().appendChild(box);
    underMenu = box;
    place();
  }

  exports.addMessageMenuItem({ label: "Ask Claude about this", run: ({ link, teamId }) => askClaude({ link, teamId, kind: "message" }) });

  // --- A pop-over for longer answers (Claude's explanations, digests, check results) -----------------------
  /** Claude's Markdown as page elements (headings, lists, bold, code), built node by node: no HTML from the text. */
  function renderMarkdown(text) {
    const fragment = document.createDocumentFragment();
    const inline = (parent, line) => {
      for (const piece of line.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
        if (/^\*\*[^*]+\*\*$/.test(piece)) parent.append(Object.assign(document.createElement("strong"), { textContent: piece.slice(2, -2) }));
        else if (/^`[^`]+`$/.test(piece)) parent.append(Object.assign(document.createElement("code"), { textContent: piece.slice(1, -1) }));
        else if (piece) parent.append(piece);
      }
    };
    let list = null;
    for (const line of text.split("\n")) {
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      const item = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
      if (item) {
        if (!list) fragment.append((list = document.createElement(/^\s*\d/.test(line) ? "ol" : "ul")));
        const li = document.createElement("li");
        inline(li, item[1].replace(/^\[[ x]\]\s*/i, ""));
        list.append(li);
        continue;
      }
      list = null;
      if (heading) {
        const node = document.createElement("div");
        node.className = "md-heading";
        inline(node, heading[1]);
        fragment.append(node);
      } else if (line.trim()) {
        const node = document.createElement("p");
        inline(node, line);
        fragment.append(node);
      }
    }
    return fragment;
  }

  function popover({ title, text, actions = [], x = null, y = null, markdown = false }) {
    const root = ui();
    root.querySelector(".popover")?.remove();
    const box = document.createElement("div");
    box.className = "popover";
    const head = document.createElement("div");
    head.className = "popover-head";
    head.textContent = title;
    const close = document.createElement("button");
    close.className = "popover-close";
    close.textContent = "×";
    close.addEventListener("click", () => box.remove());
    head.appendChild(close);
    const body = document.createElement("div");
    body.className = "popover-body";
    if (markdown) body.append(renderMarkdown(text));
    else body.textContent = text;
    box.append(head, body);
    if (actions.length) {
      const row = document.createElement("div");
      row.className = "popover-actions";
      for (const action of actions) {
        const button = document.createElement("button");
        button.textContent = action.label;
        button.addEventListener("click", () => (action.keepOpen || box.remove(), action.run(box)));
        row.appendChild(button);
      }
      box.appendChild(row);
    }
    root.appendChild(box);
    if (x !== null) {
      const rect = box.getBoundingClientRect();
      box.style.left = `${Math.max(8, Math.min(x, innerWidth - rect.width - 8))}px`;
      box.style.top = `${Math.max(8, Math.min(y, innerHeight - rect.height - 8))}px`;
      box.style.transform = "none";
    }
    return { box, body, setText: (value) => (body.textContent = value), setMarkdown: (value) => body.replaceChildren(renderMarkdown(value)), setContent: (node) => body.replaceChildren(node) };
  }

  const POPOVER_STYLE = `
      .popover { position: fixed; z-index: 2147483647; left: 50%; top: 18%; transform: translateX(-50%); width: min(560px, 90vw);
        max-height: 60vh; display: flex; flex-direction: column; border-radius: 8px; background: #222529; color: #d1d2d3;
        font: 14px/1.45 Lato, "Segoe UI", sans-serif; box-shadow: 0 0 0 1px rgba(255,255,255,.13), 0 8px 24px rgba(0,0,0,.5); }
      .popover-head { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; font-weight: 700;
        border-bottom: 1px solid rgba(255,255,255,.1); }
      .popover-close { background: none; border: 0; color: #d1d2d3; font-size: 18px; cursor: pointer; }
      .popover-body { padding: 12px 14px; overflow: auto; white-space: pre-wrap; }
      .popover-body:has(.md-heading, p, ul, ol) { white-space: normal; }
      .popover-body .md-heading { font-weight: 700; margin: 10px 0 4px; }
      .popover-body .md-heading:first-child { margin-top: 0; }
      .popover-body p { margin: 0 0 6px; }
      .popover-body ul, .popover-body ol { margin: 0 0 8px; padding-left: 20px; }
      .popover-body code { font-family: Consolas, monospace; background: rgba(255,255,255,.08); padding: 0 3px; border-radius: 3px; }
      .popover-actions { display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid rgba(255,255,255,.1); }
      .popover-actions button { font: inherit; font-weight: 700; color: #fff; background: #007a5a; border: 0; border-radius: 4px;
        padding: 5px 12px; cursor: pointer; }
      .popover-actions button + button { background: #3f4246; }
      .under-menu { position: fixed; z-index: 2147483647; padding: 6px 0; border-radius: 8px; background: #222529;
        box-shadow: 0 0 0 1px rgba(255,255,255,.13), 0 4px 12px rgba(0,0,0,.4); }
      .under-menu button { display: flex; align-items: center; gap: 8px; width: 100%; border: 0; background: none; color: #d1d2d3;
        text-align: left; cursor: pointer; font: 15px Lato, sans-serif; padding: 6px 24px; }
      .under-menu button svg { width: 16px; height: 16px; flex: none; }
      .under-menu button:hover, .under-menu button:focus-visible { background: #1264a3; color: #fff !important; }`;

  const invoke = (name, request) => electron.ipcRenderer.invoke(`powertoys:${name}`, request);
  const currentTeamId = () => /\/client\/([A-Z0-9]+)/.exec(location.pathname)?.[1] ?? null;
  Object.assign(exports, { ui, notice, popover, renderMarkdown, invoke, reason, recordingActions, chooseSession, shared, workspaceOf, currentTeamId, log, on: (channel, fn) => electron.ipcRenderer.on(channel, (event, payload) => fn(payload)) });

  // Highlighted under the mouse, or when the keyboard moved to it; not on :focus, which Slack's menu gives an item as
  // the mouse moves over its neighbours (that left ours highlighted beside "Copy link").
  const PAGE_STYLE =
    ".powertoys-menu-item button:hover, .powertoys-menu-item button:focus-visible { background: #1264a3; color: #fff; }" +
    ".powertoys-menu-over [class*='--highlighted']:not(.powertoys-menu-item *) { background: transparent !important; color: var(--powertoys-menu-color, inherit) !important; }";
  const PAGE_MODULES = ["powertoys/page-dev", "powertoys/page-compose", "powertoys/page-panel", "powertoys/page-history", "powertoys/page-media"];

  exports.start = function start(store) {
    // Before Slack's own scripts run: copies of edited and deleted messages (powertoys/page-history).
    try {
      __webpack_require__("powertoys/page-history").hookSocket();
    } catch (caught) {
      log(`powertoys/page-history did not hook Slack's connection: ${caught.message}`);
    }
    // Also before Slack's scripts: the huddle's incoming sound, for recordings (powertoys/page-call).
    try {
      __webpack_require__("powertoys/page-call").hookCall();
    } catch (caught) {
      log(`powertoys/page-call did not hook the huddle's sound: ${caught.message}`);
    }
    electron.ipcRenderer.on("powertoys:notice", (event, { text }) => notice(text));
    // A huddle's recording, when the huddle ends: keep it (and show it) or delete it; kept unless you say otherwise.
    electron.ipcRenderer.on("powertoys:recording-done", (event, recording) => recordingPrompt(recording));
    electron.ipcRenderer.on("powertoys:huddle-ended", (event, { teamId, link, where }) =>
      notice(`A huddle in ${where} ended with a transcript.`, { label: "Summarize with Claude", run: () => askClaude({ link, teamId, kind: "huddle" }) }),
    );
    globalThis.addEventListener?.("DOMContentLoaded", () => {
      document.documentElement.dataset.powertoys = "1";
      document.addEventListener(
        "contextmenu",
        (event) => {
          const icon = event.target.closest?.(WORKSPACE_ICON);
          if (!icon) return;
          event.preventDefault();
          event.stopPropagation();
          showMenu(event.clientX, event.clientY, workspaceOf(icon));
        },
        true,
      );
      document.addEventListener("mousedown", (event) => event.composedPath().includes(host) || closeMenu(), true);
      document.addEventListener("contextmenu", rememberMessage, true);
      document.addEventListener("click", rememberMessage, true);
      document.addEventListener("pointerdown", rememberMessage, true);
      const style = document.createElement("style");
      style.textContent = PAGE_STYLE;
      document.head.appendChild(style);
      ui().querySelector("style").textContent += POPOVER_STYLE;
      for (const name of PAGE_MODULES) {
        try {
          __webpack_require__(name).start(exports);
        } catch (caught) {
          log(`${name} did not start: ${caught.message}`);
        }
      }
      new MutationObserver((mutations) => {
        for (const mutation of mutations)
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1) continue;
            const menus = node.matches(".p-message_actions_menu") ? [node] : node.querySelectorAll(".p-message_actions_menu");
            for (const menu of menus) addMenuItems(menu);
            // A file's own menu: told apart by its "Share file…" item.
            const lists = node.matches('[role="menu"]') ? [node] : node.querySelectorAll('[role="menu"]');
            for (const list of lists) {
              if (list.closest(".p-message_actions_menu")) continue;
              if ([...list.querySelectorAll('[role="menuitem"]')].some((each) => /^Share file/.test(each.textContent.trim()))) addMenuItems(list, true);
            }
          }
      }).observe(document.body, { childList: true, subtree: true });
      // A huddle ringing or about to start in this window (an incoming huddle's card, or the screen before joining or
      // starting one): Bluetooth and headphones on (powertoys/huddle; the same goes for the windows Slack opens).
      let ringing = false;
      new MutationObserver(() => {
        const now = !!document.querySelector('.p-huddle_invite, [data-qa^="huddle_invite_window_with_preview"]');
        if (now !== ringing) invoke(now ? "huddle-ringing" : "huddle-ring-ended").catch((caught) => log(`ringing: ${reason(caught)}`));
        ringing = now;
      }).observe(document.body, { childList: true, subtree: true });
      // Cancel or Decline there: Bluetooth off at once.
      document.addEventListener(
        "click",
        (event) => {
          const button = event.target.closest?.("button, [role=button]");
          if (!button || !ringing) return;
          const qa = button.dataset?.qa ?? "";
          if (/cancel|decline|dismiss/i.test(qa) || /^(cancel|decline|not now)$/i.test(button.textContent.trim())) invoke("huddle-cancelled").catch(() => {});
        },
        true,
      );
      document.addEventListener("keydown", (event) => event.key === "Escape" && closeMenu(), true);
      log("page module started");
    });
    return store;
  };
});
