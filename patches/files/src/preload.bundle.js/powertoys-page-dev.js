// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): developer features in Slack's page (started by powertoys/page). It only adds its own
// elements after a message's text (cards, chips, a code toolbar); Slack's own nodes are left alone.
//
//   - Message menu: Draft a reply with Claude, Save to Notion, Create an issue with Claude, Make this a Claude Code task,
//     Draft a postmortem in Notion (in incident channels), Watch this run (GitHub Actions links).
//   - Notion links: a preview card (title, path, status, assignees, last edit, first lines).
//   - GitHub pull request, issue and Actions run links: a live card (state, checks, review, diff); "Ask Claude to review",
//     "Watch".
//   - Code blocks: Copy, Open in editor, Run in terminal (asks first), Gist (asks first), Send to Claude Code.
//   - Files named in a message (src/app.ts:42, stack traces): chips that open them in your editor.
//   - Select text in a message: "Explain" (Claude, with the workspace's folder as context).
// ---------------------------------------------------------------------------------------------
(function (module, exports, __webpack_require__) {
  "use strict";

  const STYLE = `
    .powertoys-card { margin: 6px 0 2px; padding: 8px 12px; max-width: 560px; border-left: 4px solid #4a154b; border-radius: 4px;
      background: rgba(127,127,127,.08); font-size: 13px; line-height: 1.45; }
    .powertoys-card .pt-title { font-weight: 700; }
    .powertoys-card .pt-meta { opacity: .75; }
    .powertoys-card .pt-excerpt { margin-top: 4px; white-space: pre-wrap; opacity: .9; }
    .powertoys-card .pt-actions, .powertoys-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
    .powertoys-card button, .powertoys-chips button, .powertoys-code-bar button { font: inherit; font-size: 12px; cursor: pointer;
      border: 1px solid rgba(127,127,127,.4); border-radius: 4px; background: transparent; color: inherit; padding: 1px 8px; }
    .powertoys-card button:hover, .powertoys-chips button:hover, .powertoys-code-bar button:hover { background: rgba(29,155,209,.2); }
    .pt-ok { color: #2eb67d; } .pt-bad { color: #e01e5a; } .pt-wait { color: #ecb22e; }
    .powertoys-code-bar { display: none; gap: 6px; margin: 2px 0 6px; }
    .powertoys-code-host:hover > .powertoys-code-bar, .powertoys-code-bar:hover { display: flex; }
    .powertoys-explain { position: fixed; z-index: 2147483646; font: 12px Lato, sans-serif; background: #1264a3; color: #fff;
      border: 0; border-radius: 4px; padding: 3px 9px; cursor: pointer; box-shadow: 0 2px 6px rgba(0,0,0,.3); }`;

  const FILE_REF = /(?:[A-Za-z]:)?(?:[\w@.-]+[\\/])*[\w@.-]+\.(?:js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|cpp|cc|c|h|hpp|swift|scala|ex|exs|vue|svelte|sql|sh|yml|yaml|json)(?::(\d+))(?::(\d+))?/g;
  const NOTION = /^https:\/\/([\w-]+\.)?notion\.(so|site|com)\//;
  const GITHUB = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(pull|issues|actions\/runs)\/\d+/;

  let page;
  const cards = new Map(); // url -> [element]

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(label, run) {
    const node = el("button", "", label);
    node.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      run(node);
    });
    return node;
  }
  async function busy(node, label, work) {
    const before = node.textContent;
    node.textContent = label;
    node.disabled = true;
    try {
      return await work();
    } catch (caught) {
      page.notice(page.reason(caught));
    } finally {
      node.textContent = before;
      node.disabled = false;
    }
  }

  // --- Message menu ----------------------------------------------------------------------------------------
  let incidentPattern = /^(inc|incident)[-_]/i;
  const channelName = () => /^#?([^ ]+) \(Channel\)/.exec(document.title)?.[1] ?? "";

  function menuItems() {
    page.addMessageMenuItem({
      label: "Draft a reply with Claude",
      run: async ({ link }) => {
        page.notice("Claude is drafting a reply in your style…");
        try {
          const draft = await page.invoke("draft-reply", { link });
          page.notice(`Draft ready ${draft.where} (thread). It has not been sent.`);
        } catch (caught) {
          page.notice(`Couldn't draft a reply: ${page.reason(caught)}`);
        }
      },
    });
    page.addMessageMenuItem({
      label: "Save to Notion",
      run: async ({ link }) => {
        page.notice("Summarizing for Notion…");
        try {
          const created = await page.invoke("thread-to-notion", { link });
          page.notice(`Saved to Notion, under ${created.place}.`, { label: "Open", run: () => window.open(created.url) });
        } catch (caught) {
          page.notice(`Couldn't save to Notion: ${page.reason(caught)}`);
        }
      },
    });
    // A message with a video or audio clip: its transcript attached, the video only by its link.
    page.addMessageMenuItem({
      label: "Share video with Claude",
      inFileMenu: true,
      show: ({ element }) => !!element.querySelector('video, audio, [data-qa*="video"], [data-qa*="audio"], [data-qa*="clip"], [data-qa*="media_player"]'),
      run: async ({ link, teamId }) => {
        try {
          const sessionId = await page.chooseSession({ teamId });
          if (sessionId === undefined) return;
          page.shared(await page.invoke("share-clip", { link, teamId, sessionId }));
        } catch (caught) {
          page.notice(`Couldn't share it with Claude: ${page.reason(caught)}`);
        }
      },
    });
    page.addMessageMenuItem({
      label: "Create an issue with Claude",
      run: async ({ link, teamId }) => {
        try {
          const { folder } = await page.invoke("issue-from-thread", { link, teamId });
          page.notice(`Opening Claude Code in ${folder} to write the ticket…`);
        } catch (caught) {
          page.notice(`Couldn't start the issue: ${page.reason(caught)}`);
        }
      },
    });
    page.addMessageMenuItem({
      label: "Make this a Claude Code task",
      run: async ({ link, teamId }) => {
        try {
          const { folder } = await page.invoke("task-from-thread", { link, teamId });
          page.notice(folder ? `Opening a Claude Code session in ${folder}…` : "Opening Claude (no folder linked to this workspace)…");
        } catch (caught) {
          page.notice(`Couldn't open Claude Code: ${page.reason(caught)}`);
        }
      },
    });
    page.addMessageMenuItem({
      label: "Draft a postmortem in Notion",
      show: () => incidentPattern.test(channelName()),
      run: async ({ link }) => {
        page.notice("Drafting a postmortem from this channel…");
        try {
          const channelLink = link.replace(/\/p\d+.*$/, "");
          const created = await page.invoke("postmortem", { link: channelLink });
          page.notice(`Postmortem drafted in Notion, under ${created.place}.`, { label: "Open", run: () => window.open(created.url) });
        } catch (caught) {
          page.notice(`Couldn't draft the postmortem: ${page.reason(caught)}`);
        }
      },
    });
    page.addMessageMenuItem({
      label: "Watch this run",
      show: (message) => [...message.element.querySelectorAll("a[href]")].some((a) => /\/actions\/runs\/\d+/.test(a.href)),
      run: async (message) => {
        const url = [...message.element.querySelectorAll("a[href]")].map((a) => a.href).find((href) => /\/actions\/runs\/\d+/.test(href));
        await page.invoke("watch-run", { url: url.replace(/(\/runs\/\d+).*/, "$1") });
        page.notice("Watching the run: you get a Slackbot reminder when it finishes.");
      },
    });
  }

  // --- Cards -----------------------------------------------------------------------------------------------
  function timeAgo(iso) {
    const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (minutes < 60) return `${minutes} min ago`;
    if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
    return `${Math.round(minutes / 1440)} days ago`;
  }

  async function notionCard(url) {
    const info = await page.invoke("notion-preview", url).catch(() => null);
    if (!info || info.setup || !info.title) return null;
    const card = el("div", "powertoys-card");
    card.append(el("div", "pt-title", `${info.icon && !/^http/.test(info.icon) ? `${info.icon} ` : ""}${info.ticketId ? `${info.ticketId} ` : ""}${info.title}`));
    const meta = [info.path.join(" / "), info.status && `Status: ${info.status}`, info.assignees.length && `Assignees: ${info.assignees.join(", ")}`, info.editedAt && `Edited ${timeAgo(info.editedAt)}${info.editedBy ? ` by ${info.editedBy}` : ""}`].filter(Boolean);
    if (meta.length) card.append(el("div", "pt-meta", meta.join(" · ")));
    if (info.excerpt) card.append(el("div", "pt-excerpt", info.excerpt));
    return card;
  }

  function githubBody(card, info) {
    card.replaceChildren();
    const title = el("div", "pt-title", `${info.title} `);
    const meta = el("div", "pt-meta");
    if (info.kind === "run") {
      const state = info.status !== "completed" ? ["pt-wait", info.status] : info.conclusion === "success" ? ["pt-ok", "passed"] : ["pt-bad", info.conclusion];
      meta.append(el("span", state[0], `● ${state[1]}`), ` · ${info.workflow} · ${info.branch}${info.failing?.length ? ` · failing: ${info.failing.join(", ")}` : ""}`);
    } else if (info.kind === "pull") {
      const checks = info.checks.failed.length ? ["pt-bad", `✕ ${info.checks.failed.length} failing`] : info.checks.running ? ["pt-wait", `● ${info.checks.running} running`] : ["pt-ok", `✓ ${info.checks.passed}/${info.checks.total} checks`];
      meta.append(`${info.draft ? "draft · " : ""}${info.state} · ${info.review} · `, el("span", checks[0], checks[1]), ` · +${info.additions} −${info.deletions} in ${info.files} files · ${info.author}`);
    } else {
      meta.append(`${info.state} · ${info.comments} comments${info.labels.length ? ` · ${info.labels.join(", ")}` : ""}${info.assignees.length ? ` · ${info.assignees.join(", ")}` : ""}`);
    }
    card.append(title, meta);
    const actions = el("div", "pt-actions");
    if (info.kind === "pull") {
      actions.append(button("Ask Claude to review", (node) => busy(node, "Opening…", () => page.invoke("review-pull", { url: info.url, teamId: page.currentTeamId() }))));
    }
    if (info.kind === "run" && info.status !== "completed") {
      actions.append(button("Watch", (node) => busy(node, "…", async () => (await page.invoke("watch-run", { url: info.url }), page.notice("Watching: you get a reminder when it finishes.")))));
    }
    if (actions.childNodes.length) card.append(actions);
  }

  async function githubCard(url) {
    const info = await page.invoke("github-info", url).catch(() => null);
    if (!info) return null;
    const card = el("div", "powertoys-card");
    githubBody(card, info);
    return card;
  }

  // --- Code blocks and files -------------------------------------------------------------------------------
  function codeBar(pre, link) {
    const code = () => pre.innerText.replace(/\n$/, "");
    const bar = el("div", "powertoys-code-bar");
    const teamId = page.currentTeamId();
    bar.append(
      button("Copy", async (node) => {
        await navigator.clipboard.writeText(code());
        node.textContent = "Copied";
        setTimeout(() => (node.textContent = "Copy"), 1200);
      }),
      button("Open in editor", (node) => busy(node, "Opening…", () => page.invoke("open-snippet", { code: code() }))),
      button("Run in terminal", (node) => busy(node, "…", () => page.invoke("run-command", { code: code(), teamId }))),
      button("Gist", (node) =>
        busy(node, "…", async () => {
          const url = await page.invoke("gist", { code: code() });
          if (url) page.notice(`Gist created (link copied): ${url}`);
        }),
      ),
      button("Send to Claude Code", (node) => busy(node, "Opening…", () => page.invoke("send-to-code", { code: code(), link, teamId }))),
    );
    pre.parentElement.classList.add("powertoys-code-host");
    pre.after(bar);
  }

  function fileChips(text) {
    const seen = new Set();
    const chips = el("div", "powertoys-chips");
    for (const match of text.matchAll(FILE_REF)) {
      const [whole, line, column] = match;
      const ref = whole.replace(/:\d+(:\d+)?$/, "");
      if (seen.has(whole) || /^https?:/.test(ref) || seen.size >= 6) continue;
      seen.add(whole);
      chips.append(
        button(`↗ ${ref.split(/[\\/]/).slice(-2).join("/")}:${line}`, (node) =>
          busy(node, "Opening…", () => page.invoke("open-file", { ref, line: Number(line), column: Number(column) || 1, teamId: page.currentTeamId() })),
        ),
      );
    }
    return seen.size ? chips : null;
  }

  // --- Decorating messages ---------------------------------------------------------------------------------
  async function decorate(item) {
    if (item.dataset.powertoysDone) return;
    item.dataset.powertoysDone = "1";
    const textBox = item.querySelector('[data-qa="message-text"]');
    if (!textBox) return;
    const link = [...item.querySelectorAll('a[href*="/archives/"]')].find((a) => a.pathname.includes("/p"))?.href;
    const extras = el("div", "powertoys-extras");
    for (const pre of textBox.querySelectorAll("pre")) codeBar(pre, link);
    const chips = fileChips(textBox.innerText);
    if (chips) extras.append(chips);
    const urls = [...new Set([...textBox.querySelectorAll("a[href]")].map((a) => a.href))];
    for (const url of urls.slice(0, 3)) {
      let card = null;
      if (NOTION.test(url)) card = await notionCard(url);
      else if (GITHUB.test(url)) card = await githubCard(url.match(GITHUB)[0]);
      if (!card) continue;
      card.dataset.url = url;
      if (!cards.has(url)) cards.set(url, []);
      cards.get(url).push(card);
      extras.append(card);
    }
    if (extras.childNodes.length) textBox.after(extras);
  }

  let scanQueued = false;
  function scan() {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => {
      scanQueued = false;
      for (const item of document.querySelectorAll('[data-qa="virtual-list-item"]:not([data-powertoys-done])')) {
        if (/^\d{10}\.\d{6}$/.test(item.dataset.itemKey ?? "")) decorate(item).catch((caught) => page.log(`decorate: ${caught.message}`));
      }
    }, 800);
  }

  // --- Explain a selection ---------------------------------------------------------------------------------
  let explainButton = null;
  function offerExplain() {
    explainButton?.remove();
    const selection = getSelection();
    const text = selection?.toString().trim() ?? "";
    if (text.length < 4 || !selection.anchorNode?.parentElement?.closest('[data-qa="message-text"]')) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    explainButton = el("button", "powertoys-explain", "✦ Explain");
    explainButton.style.left = `${rect.right + 6}px`;
    explainButton.style.top = `${rect.top - 4}px`;
    explainButton.addEventListener("mousedown", (event) => event.preventDefault());
    explainButton.addEventListener("click", async () => {
      explainButton.remove();
      const shown = page.popover({ title: "Claude explains", text: "Thinking…" });
      try {
        shown.setMarkdown(await page.invoke("explain", { text, teamId: page.currentTeamId() }));
      } catch (caught) {
        shown.setText(`Couldn't explain: ${page.reason(caught)}`);
      }
    });
    document.body.appendChild(explainButton);
  }

  exports.start = function start(core) {
    page = core;
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);
    menuItems();
    page.invoke("settings").then((s) => s.incidentPattern && (incidentPattern = new RegExp(s.incidentPattern, "i"))).catch(() => {});
    page.on("powertoys:run-status", (info) => {
      for (const [url, list] of cards) if (url.startsWith(info.url)) for (const card of list) githubBody(card, info);
    });
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
    document.addEventListener("mouseup", () => setTimeout(offerExplain, 10));
    document.addEventListener("mousedown", (event) => event.target !== explainButton && explainButton?.remove());
    scan();
    page.log("dev features started");
  };
});
