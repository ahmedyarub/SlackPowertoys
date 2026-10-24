// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): the preload half, in Slack's page (app.slack.com).
//
// Started by one line in preload.bundle.js/_runtime.js, right after the preload's store exists:
//   webpackRequire("powertoys/page").start(store);
// It runs in the preload's isolated world: it reads and changes the page through the DOM, shares the page's storage
// (same origin), and talks to the main process over IPC ("powertoys:*" channels, see powertoys-main.js).
//
// Right-clicking a workspace icon (the switcher button in the left rail, or a workspace in the switcher) shows a
// small menu: mark everything read in that workspace, or in every workspace. The main process does the marking with
// Slack's API; Slack's servers then update the sidebar.
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
      .notice { position: fixed; z-index: 2147483647; left: 50%; bottom: 72px; transform: translateX(-50%); padding: 8px 16px;
        border-radius: 8px; background: #222529; color: #d1d2d3; font: 14px/1.4 Lato, "Segoe UI", sans-serif;
        box-shadow: 0 0 0 1px rgba(255,255,255,.13), 0 4px 12px rgba(0,0,0,.4); }
    </style>`;
    document.body.appendChild(host);
    return host.shadowRoot;
  }

  function closeMenu() {
    host?.shadowRoot.querySelector(".menu")?.remove();
  }

  function notice(text) {
    const root = ui();
    root.querySelector(".notice")?.remove();
    const node = document.createElement("div");
    node.className = "notice";
    node.textContent = text;
    root.appendChild(node);
    setTimeout(() => node.remove(), 4000);
  }

  async function markAllRead(teamId, where) {
    notice(`Marking everything as read ${where}…`);
    try {
      const { marked, failed } = await electron.ipcRenderer.invoke("powertoys:mark-all-read", teamId);
      notice(`${marked ? `Marked ${marked} conversation${marked === 1 ? "" : "s"} as read` : "Nothing was unread"} ${where}${failed ? ` (${failed} failed)` : ""}`);
    } catch (caught) {
      notice(`Couldn't mark everything as read: ${caught.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}`);
    }
  }

  function showMenu(x, y, workspace) {
    closeMenu();
    const menu = document.createElement("div");
    menu.className = "menu";
    for (const [label, teamId, where] of [
      [`Mark all as read in ${workspace.name}`, workspace.teamId, `in ${workspace.name}`],
      ["Mark all as read in all workspaces", null, "in all workspaces"],
    ]) {
      if (teamId === undefined) continue;
      const item = document.createElement("div");
      item.className = "item";
      item.textContent = label;
      item.addEventListener("click", () => {
        closeMenu();
        markAllRead(teamId, where);
      });
      menu.appendChild(item);
    }
    ui().appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, innerWidth - rect.width - 8)}px`;
    menu.style.top = `${Math.min(y, innerHeight - rect.height - 8)}px`;
  }

  exports.start = function start(store) {
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
      document.addEventListener("keydown", (event) => event.key === "Escape" && closeMenu(), true);
      log("page module started");
    });
    return store;
  };
});
