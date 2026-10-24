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

  // --- "Ask Claude about this" in Slack's message menu -----------------------------------------------------
  // Slack draws the menu (.p-message_actions_menu) when a message is right-clicked or its "More actions" clicked; the
  // message is the list item the click was in, and its timestamp link is its permalink.
  let lastMessage = null;
  function rememberMessage(event) {
    const item = event.target.closest?.('[data-qa="virtual-list-item"]');
    const ts = item?.dataset.itemKey;
    if (!ts || !/^\d{10}\.\d{6}$/.test(ts)) return;
    const digits = `p${ts.replace(".", "")}`;
    const link = [...item.querySelectorAll('a[href*="/archives/"]')].find((anchor) => anchor.pathname.endsWith(digits))?.href;
    if (link) lastMessage = { link, teamId: workspaceOf(item).teamId, at: Date.now() };
  }

  const SPARKLE =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M10 1.5l1.9 5.2 5.1 1.9-5.1 1.9L10 15.7l-1.9-5.2L3 8.6l5.1-1.9zM15.5 13l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></svg>';
  function addAskClaude(menu) {
    if (!lastMessage || Date.now() - lastMessage.at > 5000 || menu.querySelector('[data-qa="powertoys_ask_claude-wrapper"]')) return;
    const model = menu.querySelector('[data-qa="copy_link-wrapper"]');
    if (!model) return;
    const { link, teamId } = lastMessage;
    const wrapper = model.cloneNode(true);
    wrapper.dataset.qa = "powertoys_ask_claude-wrapper";
    wrapper.classList.add("powertoys-ask-claude");
    for (const node of wrapper.querySelectorAll("[id]")) node.removeAttribute("id");
    wrapper.querySelector(".c-menu_item__shortcut")?.remove();
    const icon = wrapper.querySelector(".c-menu_item__icon");
    if (icon) icon.innerHTML = SPARKLE;
    wrapper.querySelector(".c-menu_item__label").textContent = "Ask Claude about this";
    const button = wrapper.querySelector("button") ?? wrapper;
    button.dataset.qa = "powertoys_ask_claude";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      // Slack's menu closes on Escape pressed inside it.
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
      askClaude({ link, teamId, kind: "message" });
    });
    model.after(wrapper);
  }

  const PAGE_STYLE = ".powertoys-ask-claude button:hover, .powertoys-ask-claude button:focus { background: #1264a3; color: #fff; }";

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
      new MutationObserver((mutations) => {
        for (const mutation of mutations)
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1) continue;
            const menus = node.matches(".p-message_actions_menu") ? [node] : node.querySelectorAll(".p-message_actions_menu");
            for (const menu of menus) addAskClaude(menu);
          }
      }).observe(document.body, { childList: true, subtree: true });
      document.addEventListener("keydown", (event) => event.key === "Escape" && closeMenu(), true);
      log("page module started");
    });
    return store;
  };
});
