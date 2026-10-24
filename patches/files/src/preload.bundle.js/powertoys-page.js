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
    </style>`;
    document.body.appendChild(host);
    return host.shadowRoot;
  }

  function closeMenu() {
    host?.shadowRoot.querySelector(".menu")?.remove();
  }

  /** A short notice; with an action, a button (and a close button) that stays a minute. */
  function notice(text, action = null) {
    const root = ui();
    root.querySelector(".notice")?.remove();
    const node = document.createElement("div");
    node.className = "notice";
    node.append(text);
    if (action) {
      const button = document.createElement("button");
      button.textContent = action.label;
      button.addEventListener("click", () => (node.remove(), action.run()));
      const close = document.createElement("button");
      close.className = "close";
      close.textContent = "×";
      close.title = "Close";
      close.addEventListener("click", () => node.remove());
      node.append(button, close);
    }
    root.appendChild(node);
    setTimeout(() => node.remove(), action ? 60000 : 4000);
  }

  const reason = (caught) => caught.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

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
  // addMessageMenuItem({ label, show(message), run(message) }); a message is { link, teamId, text, element }.
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

  function addMenuItems(menu) {
    if (!lastMessage || Date.now() - lastMessage.at > 5000 || menu.querySelector(".powertoys-menu-item")) return;
    let after = menu.querySelector('[data-qa="copy_link-wrapper"]');
    if (!after) return;
    const message = lastMessage;
    for (const item of menuItems) {
      if (item.show && !item.show(message)) continue;
      const wrapper = after.cloneNode(true);
      wrapper.dataset.qa = `powertoys_${item.label.toLowerCase().replace(/\W+/g, "_")}-wrapper`;
      wrapper.classList.add("powertoys-menu-item");
      for (const node of wrapper.querySelectorAll("[id]")) node.removeAttribute("id");
      wrapper.querySelector(".c-menu_item__shortcut")?.remove();
      const icon = wrapper.querySelector(".c-menu_item__icon");
      if (icon) icon.innerHTML = SPARKLE;
      wrapper.querySelector(".c-menu_item__label").textContent = item.label;
      const button = wrapper.querySelector("button") ?? wrapper;
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

  exports.addMessageMenuItem({ label: "Ask Claude about this", run: ({ link, teamId }) => askClaude({ link, teamId, kind: "message" }) });

  // --- A pop-over for longer answers (Claude's explanations, digests, check results) -----------------------
  function popover({ title, text, actions = [], x = null, y = null }) {
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
    body.textContent = text;
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
    return { box, body, setText: (value) => (body.textContent = value) };
  }

  const POPOVER_STYLE = `
      .popover { position: fixed; z-index: 2147483647; left: 50%; top: 18%; transform: translateX(-50%); width: min(560px, 90vw);
        max-height: 60vh; display: flex; flex-direction: column; border-radius: 8px; background: #222529; color: #d1d2d3;
        font: 14px/1.45 Lato, "Segoe UI", sans-serif; box-shadow: 0 0 0 1px rgba(255,255,255,.13), 0 8px 24px rgba(0,0,0,.5); }
      .popover-head { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; font-weight: 700;
        border-bottom: 1px solid rgba(255,255,255,.1); }
      .popover-close { background: none; border: 0; color: #d1d2d3; font-size: 18px; cursor: pointer; }
      .popover-body { padding: 12px 14px; overflow: auto; white-space: pre-wrap; }
      .popover-actions { display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid rgba(255,255,255,.1); }
      .popover-actions button { font: inherit; font-weight: 700; color: #fff; background: #007a5a; border: 0; border-radius: 4px;
        padding: 5px 12px; cursor: pointer; }
      .popover-actions button + button { background: #3f4246; }`;

  const invoke = (name, request) => electron.ipcRenderer.invoke(`powertoys:${name}`, request);
  const currentTeamId = () => /\/client\/([A-Z0-9]+)/.exec(location.pathname)?.[1] ?? null;
  Object.assign(exports, { ui, notice, popover, invoke, reason, workspaceOf, currentTeamId, log, on: (channel, fn) => electron.ipcRenderer.on(channel, (event, payload) => fn(payload)) });

  const PAGE_STYLE = ".powertoys-menu-item button:hover, .powertoys-menu-item button:focus { background: #1264a3; color: #fff; }";
  const PAGE_MODULES = ["powertoys/page-dev", "powertoys/page-compose", "powertoys/page-panel"];

  exports.start = function start(store) {
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
          }
      }).observe(document.body, { childList: true, subtree: true });
      document.addEventListener("keydown", (event) => event.key === "Escape" && closeMenu(), true);
      log("page module started");
    });
    return store;
  };
});
