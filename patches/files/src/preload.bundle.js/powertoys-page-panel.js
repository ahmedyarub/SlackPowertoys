// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): the Powertoys panel in Slack's page (started by powertoys/page). Ctrl+Alt+P, or the tray
// menu's "Powertoys panel".
//
//   Agents   your Claude Code sessions (state, folder, last message); Resume opens one in a terminal
//   Search   Slack, Notion and your repositories at once
//   Focus    do not disturb for a while; Claude lets urgent mentions through; a summary when it ends
//   Digest   what is unread, summarized by Claude
//   Settings Notion: sign in (OAuth connection) or an internal integration's secret
// Also: a Claude Code session's permission request (with "agents.remoteApprove" on) shows as Allow / Deny here.
// ---------------------------------------------------------------------------------------------
(function (module, exports, __webpack_require__) {
  "use strict";

  let page;
  let panel = null;
  let tab = "agents";
  let agents = [];

  const STYLE = `
    .panel { position: fixed; z-index: 2147483645; right: 16px; top: 64px; width: 420px; max-height: 70vh; display: flex; flex-direction: column;
      border-radius: 10px; background: #1a1d21; color: #d1d2d3; font: 13px/1.45 Lato, "Segoe UI", sans-serif;
      box-shadow: 0 0 0 1px rgba(255,255,255,.13), 0 10px 30px rgba(0,0,0,.5); }
    .panel-head { display: flex; align-items: center; gap: 4px; padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,.1); }
    .panel-head .tab { background: none; border: 0; color: #d1d2d3; padding: 4px 8px; border-radius: 4px; cursor: pointer; font: inherit; }
    .panel-head .tab.on { background: #1264a3; color: #fff; }
    .panel-head .close { margin-left: auto; background: none; border: 0; color: #d1d2d3; font-size: 18px; cursor: pointer; }
    .panel-body { padding: 10px; overflow: auto; }
    .panel-body .row { padding: 6px 4px; border-bottom: 1px solid rgba(255,255,255,.06); }
    .panel-body .row .sub { opacity: .7; font-size: 12px; }
    .panel-body .group { margin: 8px 0 4px; font-weight: 700; }
    .panel-body input, .panel-body select { font: inherit; width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 4px;
      border: 1px solid rgba(255,255,255,.2); background: #222529; color: #fff; }
    .panel-body button.act { font: inherit; font-weight: 700; color: #fff; background: #007a5a; border: 0; border-radius: 4px; padding: 4px 10px; cursor: pointer; margin-top: 6px; }
    .panel-body .link { color: #1d9bd1; cursor: pointer; }
    .state-working { color: #ecb22e; } .state-idle { color: #2eb67d; } .state-needs { color: #e01e5a; }
    .panel-body pre { white-space: pre-wrap; font: inherit; margin: 0; }`;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** A Slack link opens in the app (powertoys:open-in-slack); others in the browser. */
  function openLink(link) {
    if (/^https:\/\/[\w.-]+\.slack\.com\/archives\//.test(link)) page.invoke("open-in-slack", { link }).catch((caught) => page.notice(page.reason(caught)));
    else window.open(link);
  }

  function toggle(show = !panel) {
    panel?.remove();
    panel = null;
    if (!show) return;
    const root = page.ui();
    panel = el("div", "panel");
    const head = el("div", "panel-head");
    for (const [name, label] of [["agents", "Agents"], ["search", "Search"], ["focus", "Focus"], ["digest", "Digest"], ["settings", "Settings"]]) {
      const button = el("button", `tab${tab === name ? " on" : ""}`, label);
      button.addEventListener("click", () => ((tab = name), toggle(true)));
      head.append(button);
    }
    const close = el("button", "close", "×");
    close.addEventListener("click", () => toggle(false));
    head.append(close);
    const body = el("div", "panel-body");
    panel.append(head, body);
    root.appendChild(panel);
    ({ agents: renderAgents, search: renderSearch, focus: renderFocus, digest: renderDigest, settings: renderSettings })[tab](body);
  }

  function renderAgents(body) {
    if (!agents.length) {
      body.append(el("div", "sub", "No Claude Code sessions yet. Sessions show here once Claude Code's hook (mcp/claude-code-hook.mjs) is installed."));
      return;
    }
    for (const session of agents) {
      const row = el("div", "row");
      const state = session.state === "needs you" ? "state-needs" : session.state === "working" ? "state-working" : "state-idle";
      row.append(el("div", "", ""), el("div", "sub", ""));
      row.firstChild.append(el("span", state, `● ${session.state} `), `${(session.cwd ?? "").split(/[\\/]/).pop() || "session"}`);
      row.lastChild.textContent = `${session.message ? `${session.message.slice(0, 140)} · ` : ""}${new Date(session.updated).toLocaleTimeString()}`;
      const resume = el("button", "act", "Resume in a terminal");
      resume.addEventListener("click", () => page.invoke("resume-session", { id: session.id }).catch((caught) => page.notice(page.reason(caught))));
      row.append(resume);
      body.append(row);
    }
  }

  function renderSearch(body) {
    const input = el("input");
    input.placeholder = "Search Slack, Notion and your repositories…";
    const results = el("div");
    input.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter" || !input.value.trim()) return;
      results.replaceChildren(el("div", "sub", "Searching…"));
      try {
        const found = await page.invoke("search", { query: input.value.trim(), teamId: page.currentTeamId() });
        results.replaceChildren();
        const group = (title, list, render) => {
          results.append(el("div", "group", title));
          if (!list?.length) return results.append(el("div", "sub", list === null ? "Not set up." : "Nothing found."));
          for (const each of list) results.append(render(each));
        };
        group("Slack", found.slack, (r) => {
          const row = el("div", "row");
          const title = el("div", "link", `${r.author ?? ""} in ${r.conversation ?? ""}`);
          title.addEventListener("click", () => openLink(r.link));
          row.append(title, el("div", "sub", (r.text ?? r.error ?? "").slice(0, 160)));
          return row;
        });
        group("Notion", found.notion, (r) => {
          const row = el("div", "row");
          const title = el("div", "link", `${r.icon && !/^http/.test(r.icon) ? `${r.icon} ` : ""}${r.title ?? r.error}`);
          title.addEventListener("click", () => r.url && window.open(r.url));
          row.append(title);
          return row;
        });
        group("Code", found.code, (r) => {
          const row = el("div", "row");
          const title = el("div", "link", `${r.relative}:${r.line}`);
          title.addEventListener("click", () => page.invoke("open-file", { ref: r.file, line: r.line, teamId: page.currentTeamId() }));
          row.append(title, el("div", "sub", r.text));
          return row;
        });
      } catch (caught) {
        results.replaceChildren(el("div", "sub", `Couldn't search: ${page.reason(caught)}`));
      }
    });
    body.append(input, results);
    setTimeout(() => input.focus(), 0);
  }

  async function renderFocus(body) {
    const state = (await page.invoke("settings").catch(() => ({}))).focus ?? { on: false };
    if (state.on) {
      body.append(el("div", "", `Focus mode until ${new Date(state.until).toLocaleTimeString()}. Urgent mentions still reach you.`));
      const end = el("button", "act", "End focus mode");
      end.addEventListener("click", async () => {
        end.textContent = "Summarizing…";
        const result = await page.invoke("focus", { on: false }).catch((caught) => ({ summary: page.reason(caught) }));
        body.replaceChildren(el("pre", "", result.summary ?? "Focus mode ended."));
      });
      body.append(end);
      return;
    }
    const minutes = el("select");
    for (const value of [25, 50, 90, 120]) minutes.append(Object.assign(el("option", "", `${value} minutes`), { value }));
    const start = el("button", "act", "Start focus mode");
    start.addEventListener("click", async () => {
      await page.invoke("focus", { on: true, minutes: Number(minutes.value) }).catch((caught) => page.notice(page.reason(caught)));
      toggle(true);
    });
    body.append(el("div", "sub", "Do not disturb in your workspaces; Claude checks new mentions and DMs every 2 minutes and lets urgent ones through."), minutes, start);
  }

  function renderDigest(body) {
    const go = el("button", "act", "Summarize what is unread");
    const out = el("pre");
    go.addEventListener("click", async () => {
      go.disabled = true;
      out.textContent = "Reading and summarizing…";
      try {
        out.textContent = (await page.invoke("digest")).text;
      } catch (caught) {
        out.textContent = `Couldn't make the digest: ${page.reason(caught)}`;
      } finally {
        go.disabled = false;
      }
    });
    body.append(go, out);
  }

  /** Notion: sign in with a public (OAuth) connection, or an internal integration's secret; saved only once Notion accepts it. */
  async function renderSettings(body) {
    const current = await page.invoke("settings").catch(() => ({}));
    const input = (placeholder, value = "", secret = false) => {
      const node = el("input");
      node.placeholder = placeholder;
      node.value = value;
      if (secret) Object.assign(node, { type: "password", autocomplete: "off" });
      return node;
    };
    const steps = (text) => Object.assign(el("div", "sub", text), { style: "white-space: pre-line" });
    const status = el("div", "sub", current.notion ? "Notion is set up." : "");
    const saved = "Saved (paste a new one to replace it)";
    const run = async (button, channel, request, clear) => {
      button.disabled = true;
      status.textContent = channel === "notion-sign-in" ? "Finish signing in in your browser…" : "Checking with Notion…";
      try {
        const checked = await page.invoke(channel, request());
        for (const node of clear) Object.assign(node, { value: "", placeholder: saved });
        status.textContent = `Saved: ${checked.workspace ? `workspace ${checked.workspace}, ` : ""}${checked.shared} pages and databases shared. Claude picks where each new page goes.`;
      } catch (caught) {
        status.textContent = `Not saved: ${page.reason(caught)}`;
      } finally {
        button.disabled = false;
      }
    };

    const clientId = input("OAuth client ID", current.notionClientId ?? "");
    const clientSecret = input(current.notionClientId ? saved : "OAuth client secret", "", true);
    const signIn = el("button", "act", "Sign in with Notion");
    signIn.addEventListener("click", () => run(signIn, "notion-sign-in", () => ({ clientId: clientId.value, clientSecret: clientSecret.value }), [clientSecret]));

    const token = input(current.notion && !current.notionClientId ? saved : "Internal integration secret (ntn_…)", "", true);
    const save = el("button", "act", "Check and save");
    save.addEventListener("click", () => run(save, "notion-setup", () => ({ token: token.value }), [token]));

    body.append(
      el("div", "group", "Notion: sign in (OAuth connection)"),
      steps(`notion.so/profile/integrations → New connection → OAuth, redirect URI ${current.notionRedirectUri ?? ""} → copy its client ID and secret. When Notion asks, pick the pages Powertoys may use; Claude puts each new page where it fits among them.`),
      clientId,
      clientSecret,
      signIn,
      el("div", "group", "Or an internal integration"),
      steps("If you may create internal connections: copy its secret, and on each page it may use, ••• → Connections → add it."),
      token,
      save,
      status,
    );
  }

  exports.start = function start(core) {
    page = core;
    page.ui().querySelector("style").textContent += STYLE;
    page.on("powertoys:panel", () => toggle(true));
    page.on("powertoys:agents", (list) => {
      agents = list;
      if (panel && tab === "agents") toggle(true);
    });
    page.on("powertoys:approval", ({ id, where, tool, detail }) => {
      page.popover({
        title: `Claude Code in ${where} wants to use ${tool}`,
        text: detail || "(no details)",
        actions: [
          { label: "Allow", run: () => page.invoke("answer-approval", { id, decision: "allow" }) },
          { label: "Deny", run: () => page.invoke("answer-approval", { id, decision: "deny" }) },
        ],
      });
    });
    page.on("powertoys:focus-summary", ({ summary }) => summary && page.popover({ title: "While you were focused", text: summary }));
    page.on("powertoys:open-link", ({ link }) => openLink(link));
    page.invoke("agents").then((list) => (agents = list)).catch(() => {});
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.ctrlKey && event.altKey && (event.key === "p" || event.key === "P")) {
          event.preventDefault();
          toggle();
        }
      },
      true,
    );
    page.log("panel started");
  };
});
