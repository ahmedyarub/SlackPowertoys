// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): the Powertoys panel in Slack's page (started by powertoys/page). Ctrl+Alt+P, or the tray
// menu's "Powertoys panel".
//
//   Agents   your Claude Code sessions (state, folder, last message); Resume opens one in a terminal
//   Search   Slack, Notion and your repositories at once
//   Focus    do not disturb for a while; Claude lets urgent mentions through; a summary when it ends
//   Digest   what is unread, summarized by Claude
//   Recordings  the huddles recorded: open, transcribe (Slack), summarize (Claude), delete
//   History  copies of edited and deleted messages (powertoys/page-history), newest first
//   Settings the transcription language; Notion: sign in (OAuth connection) or an internal integration's secret
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
    .panel-head { display: flex; align-items: flex-start; gap: 4px; padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,.1); }
    .panel-head .tabs { display: flex; flex-wrap: wrap; gap: 2px 4px; flex: 1; min-width: 0; }
    .panel-head .tab { background: none; border: 0; color: #d1d2d3; padding: 4px 8px; border-radius: 4px; cursor: pointer; font: inherit; }
    .panel-head .tab.on { background: #1264a3; color: #fff; }
    .panel-head .close { flex: none; margin-left: auto; background: none; border: 0; color: #d1d2d3; font-size: 18px; cursor: pointer; }
    .panel-body { padding: 10px; overflow: auto; }
    .panel-body .row { padding: 6px 4px; border-bottom: 1px solid rgba(255,255,255,.06); }
    .panel-body .row .sub { opacity: .7; font-size: 12px; }
    .panel-body .group { margin: 8px 0 4px; font-weight: 700; }
    .panel-body input, .panel-body select, .panel-body textarea { font: inherit; width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 4px;
      border: 1px solid rgba(255,255,255,.2); background: #222529; color: #fff; }
    .panel-body button.act { font: inherit; font-weight: 700; color: #fff; background: #007a5a; border: 0; border-radius: 4px; padding: 4px 10px; cursor: pointer; margin-top: 6px; }
    .panel-body .link { color: #1d9bd1; cursor: pointer; }
    .state-working { color: #ecb22e; } .state-idle { color: #2eb67d; } .state-needs { color: #e01e5a; }
    .panel-body pre { white-space: pre-wrap; font: inherit; margin: 0; }
    .panel-body label { display: block; margin: 4px 0; font-weight: 700; }
    .panel-body .md-heading { font-weight: 700; margin: 10px 0 4px; }
    .panel-body p { margin: 0 0 6px; }
    .panel-body ul, .panel-body ol { margin: 0 0 8px; padding-left: 20px; }
    .panel-body select:focus-visible, .panel-body input:focus-visible, .panel-body button:focus-visible { outline: 2px solid #1d9bd1; outline-offset: 1px; }`;

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
    // The tabs wrap onto a second line when they don't fit (a larger zoom, or more tabs).
    const tabs = el("div", "tabs");
    for (const [name, label] of [["agents", "Agents"], ["search", "Search"], ["focus", "Focus"], ["digest", "Digest"], ["recordings", "Recordings"], ["history", "History"], ["settings", "Settings"]]) {
      const button = el("button", `tab${tab === name ? " on" : ""}`, label);
      button.addEventListener("click", () => ((tab = name), toggle(true)));
      tabs.append(button);
    }
    const close = el("button", "close", "×");
    close.setAttribute("aria-label", "Close the Powertoys panel");
    close.addEventListener("click", () => toggle(false));
    head.append(tabs, close);
    const body = el("div", "panel-body");
    panel.append(head, body);
    root.appendChild(panel);
    ({ agents: renderAgents, search: renderSearch, focus: renderFocus, digest: renderDigest, recordings: renderRecordings, history: renderHistory, settings: renderSettings })[tab](body);
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
        body.replaceChildren(page.renderMarkdown(result.summary ?? "Focus mode ended."));
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
    // Your tickets (Notion, as you): status changes since the last day seen, and the ones in flight; the standup summary.
    const tickets = el("div");
    const standup = el("button", "act", "Standup summary");
    standup.style.marginRight = "6px";
    standup.addEventListener("click", async () => {
      standup.disabled = true;
      const shown = page.popover({ title: "Standup", text: "Reading the releases and your tickets…" });
      try {
        shown.setMarkdown(await page.invoke("standup", { teamId: page.currentTeamId() }));
      } catch (caught) {
        shown.setText(`Couldn't make it: ${page.reason(caught)}`);
      } finally {
        standup.disabled = false;
      }
    });
    page
      .invoke("ticket-changes")
      .then((found) => {
        if (found.setup) return tickets.append(el("div", "sub", "Your Notion tickets show here once Notion is signed in as you (Settings)."));
        tickets.append(el("div", "group", found.since ? `Your tickets since ${found.since}` : "Your tickets"));
        if (found.since && !found.changes.length) tickets.append(el("div", "sub", "No status changes."));
        if (!found.since) tickets.append(el("div", "sub", "Changes show from tomorrow (today is the first day seen)."));
        for (const change of found.changes) {
          const row = el("div", "row");
          const open = el("span", "link", `${change.id} ${change.title}`);
          open.addEventListener("click", () => openLink(change.url));
          row.append(open, el("div", "sub", `${change.from} → ${change.status}`));
          tickets.append(row);
        }
        tickets.append(el("div", "group", `In flight (${found.inFlight.length})`));
        for (const ticket of found.inFlight) {
          const row = el("div", "row");
          const open = el("span", "link", `${ticket.id} ${ticket.title}`);
          open.addEventListener("click", () => openLink(ticket.url));
          row.append(open, el("div", "sub", ticket.status));
          tickets.append(row);
        }
      })
      .catch((caught) => tickets.append(el("div", "sub", `Couldn't read your tickets: ${page.reason(caught)}`)));
    body.append(standup);
    const go = el("button", "act", "Summarize what is unread");
    const out = el("div");
    go.addEventListener("click", async () => {
      go.disabled = true;
      out.textContent = "Reading and summarizing…";
      try {
        out.replaceChildren(page.renderMarkdown((await page.invoke("digest")).text));
      } catch (caught) {
        out.textContent = `Couldn't make the digest: ${page.reason(caught)}`;
      } finally {
        go.disabled = false;
      }
    });
    body.append(go, out, tickets);
  }

  /** The recorded huddles, newest first, each with what can be done with it. */
  async function renderHistory(body) {
    let list;
    try {
      list = await page.invoke("history-list", { limit: 200 });
    } catch (caught) {
      return body.append(el("div", "sub", `Couldn't read the copies: ${page.reason(caught)}`));
    }
    if (!list.length) return body.append(el("div", "sub", "No edited or deleted messages yet. Each one seen from now on keeps a copy here."));
    for (const copy of list) {
      const row = el("div", "row");
      row.append(
        el("div", "", `${copy.kind === "deleted" ? "Deleted" : "Edited"} · ${copy.where ?? copy.channel}${copy.who ? ` · ${copy.who}` : ""}`),
        el("div", "sub", new Date(copy.at).toLocaleString()),
      );
      if (copy.kind === "edited") row.append(el("div", "sub", "Before:"), el("pre", "", copy.text), el("div", "sub", "After:"), el("pre", "", copy.after ?? ""));
      else row.append(el("pre", "", copy.text));
      if (copy.kind === "edited" && copy.link) {
        const open = el("span", "link", "Open in Slack");
        open.addEventListener("click", () => openLink(copy.link));
        row.append(open);
      }
      body.append(row);
    }
  }

  async function renderRecordings(body) {
    let list;
    try {
      list = await page.invoke("recordings");
    } catch (caught) {
      return body.append(el("div", "sub", `Couldn't list the recordings: ${page.reason(caught)}`));
    }
    if (!list.length) return body.append(el("div", "sub", "No recordings yet. Each huddle is recorded; you choose what to keep when it ends."));
    for (const recording of list) {
      const row = el("div", "row");
      row.append(
        el("div", "", `${recording.where ?? "Huddle"}`),
        el("div", "sub", `${new Date(recording.since).toLocaleString()} · ${recording.megabytes} MB${recording.parts.length > 1 ? ` · ${recording.parts.length} parts` : ""}`),
      );
      const buttons = el("div");
      const button = (label, run) => {
        const node = el("button", "act", label);
        node.style.marginRight = "6px";
        node.addEventListener("click", run);
        buttons.append(node);
      };
      const open = (file) => page.invoke("recording-open", { base: recording.base, file }).catch((caught) => page.notice(page.reason(caught)));
      button("Play", () => open(recording.parts[0]));
      if (recording.transcript) button("Transcript", () => open(`${recording.base}.transcript.txt`));
      if (recording.summary) button("Summary", () => open(`${recording.base}.summary.md`));
      for (const action of page.recordingActions(recording.base).filter((each) => each.label !== "Save")) {
        if ((action.label === "Transcribe" && recording.transcript) || (action.label === "Summarize" && recording.summary)) continue;
        button(action.label, () => Promise.resolve(action.run()).finally(() => setTimeout(() => tab === "recordings" && toggle(true), 500)));
      }
      row.append(buttons);
      body.append(row);
    }
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

    // As you, through Notion's MCP server: reads what you can read (teamspace pages too), for link titles and previews.
    const asYouStatus = Object.assign(el("div", "sub", current.notionAsYou ? "Signed in as you." : ""), { role: "status" });
    asYouStatus.setAttribute("aria-live", "polite");
    const asYou = el("button", "act", current.notionAsYou ? "Sign in as you again" : "Sign in as you");
    asYou.addEventListener("click", async () => {
      asYou.disabled = true;
      asYouStatus.textContent = "Finish signing in in your browser…";
      try {
        const me = await page.invoke("notion-sign-in-as-you");
        asYouStatus.textContent = `Signed in${me.name ? ` as ${me.name}` : ""}. Link titles and previews read Notion as you.`;
      } catch (caught) {
        asYouStatus.textContent = `Not signed in: ${page.reason(caught)}`;
      } finally {
        asYou.disabled = false;
      }
    });

    const token = input(current.notion && !current.notionClientId ? saved : "Internal integration secret (ntn_…)", "", true);
    const save = el("button", "act", "Check and save");
    save.addEventListener("click", () => run(save, "notion-setup", () => ({ token: token.value }), [token]));

    // Transcription language: a native select with its label, a description and a spoken confirmation.
    const heading = (text) => Object.assign(el("div", "group", text), { role: "heading" }, { ariaLevel: "3" });
    const languageLabel = Object.assign(el("label", "", "Transcription language"), { htmlFor: "powertoys-transcript-language" });
    const language = Object.assign(el("select"), { id: "powertoys-transcript-language" });
    language.setAttribute("aria-describedby", "powertoys-transcript-language-help");
    for (const [code, name] of Object.entries(current.transcriptLanguages ?? { "en-US": "English (US)" })) {
      language.append(Object.assign(el("option", "", name), { value: code, lang: code, selected: code === (current.transcriptLanguage ?? "en-US") }));
    }
    const languageHelp = Object.assign(el("div", "sub", "The language Slack transcribes videos, recordings and audio clips in, when Powertoys or Claude asks it to."), {
      id: "powertoys-transcript-language-help",
    });
    const languageStatus = Object.assign(el("div", "sub"), { role: "status" });
    languageStatus.setAttribute("aria-live", "polite");
    language.addEventListener("change", async () => {
      try {
        await page.invoke("transcript-language", { language: language.value });
        languageStatus.textContent = `Saved: transcripts in ${language.selectedOptions[0].textContent}.`;
      } catch (caught) {
        languageStatus.textContent = `Not saved: ${page.reason(caught)}`;
      }
    });

    // The prompt "Ask Claude to review" sends ({pr}: the pull request's link); empty is the default.
    const reviewLabel = Object.assign(el("label", "", "Prompt for “Ask Claude to review”"), { htmlFor: "powertoys-review-prompt" });
    const review = Object.assign(el("textarea"), { id: "powertoys-review-prompt", rows: 3, value: current.reviewPrompt ?? "", placeholder: current.reviewPromptDefault ?? "" });
    review.setAttribute("aria-describedby", "powertoys-review-prompt-help");
    const reviewHelp = Object.assign(el("div", "sub", "{pr} is replaced by the pull request's link. Empty: the default."), { id: "powertoys-review-prompt-help" });
    const reviewSave = el("button", "act", "Save prompt");
    const reviewStatus = Object.assign(el("div", "sub"), { role: "status" });
    reviewStatus.setAttribute("aria-live", "polite");
    reviewSave.addEventListener("click", async () => {
      try {
        review.value = (await page.invoke("review-prompt", { prompt: review.value })).prompt;
        reviewStatus.textContent = "Saved.";
      } catch (caught) {
        reviewStatus.textContent = `Not saved: ${page.reason(caught)}`;
      }
    });

    body.append(
      heading("Code review"),
      reviewLabel,
      review,
      reviewHelp,
      reviewSave,
      reviewStatus,
      heading("Transcription"),
      languageLabel,
      language,
      languageHelp,
      languageStatus,
      el("div", "group", "Notion: as you"),
      steps("Link titles (with a ticket's ID) and previews read Notion as you, through Notion's own MCP server: everything you can open, teamspaces included, with no connection to share pages with."),
      asYou,
      asYouStatus,
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
    page.on("powertoys:focus-summary", ({ summary }) => summary && page.popover({ title: "While you were focused", text: summary, markdown: true }));
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
    // A press outside the panel closes it; a press on Powertoys' own layer (the panel, or a picker or notice it opened)
    // doesn't. The press goes on to Slack as usual.
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (panel && !event.composedPath().includes(page.ui())) toggle(false);
      },
      true,
    );
    page.log("panel started");
  };
});
