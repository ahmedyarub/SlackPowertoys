// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): the developer features, in the main process. The page half (powertoys-page-*.js) asks
// for them over IPC ("powertoys:*"); Claude Code's hook reaches the agents part through the bridge.
//
//   Notion       link previews and titles; a thread, huddle or clip as a Notion page; incident postmortems
//   Claude       catch-up digest; explain a selection; draft a reply in your style; check a message before sending
//   Code         snippets (editor, terminal, gist, Claude Code); files from stack traces; GitHub cards; watching runs
//   Agents       Claude Code sessions (panel); approving a session's permission request from Slack; a thread as a task
//   Focus        do not disturb, with Claude letting urgent mentions through, and a summary afterwards
//   Search       Slack, Notion and your repositories at once
//   Snippets     message templates with placeholders ({{commits}}, {{date}}, {{ai: ...}})
//
// Settings (settings.json): "digest": { "time": "09:00" | null, "to": "dm" | "notion" },
//   "focus": { "minutes": 60 }, "agents": { "remoteApprove": false, "approveWaitSeconds": 120 },
//   "incidents": { "channelPattern": "^(inc|incident)[-_]" }, "snippets": { "teamFile": null }
// ---------------------------------------------------------------------------------------------
(function (module, exports, __webpack_require__) {
  "use strict";

  const electron = __webpack_require__(84157);
  const fs = __webpack_require__(79896);
  const path = __webpack_require__(16928);
  const { log, warn, readSettings, updateSettings, powertoysDir, api, slackPage, signedInTeams } = __webpack_require__("powertoys/main");
  const claude = __webpack_require__("powertoys/claude");
  const ai = __webpack_require__("powertoys/ai");
  const notion = __webpack_require__("powertoys/notion");
  const dev = __webpack_require__("powertoys/dev");

  const settingsOf = (key, defaults) => ({ ...defaults, ...readSettings()[key] });
  const page = () => claude.requirePage();
  const send = (channel, payload) => slackPage()?.send(channel, payload);

  async function teamOf(teamId) {
    const teams = await signedInTeams(page());
    return teams.find((team) => team.id === teamId) ?? teams.find((team) => !team.enterprise_id && !/\.enterprise\./.test(team.url)) ?? teams[0];
  }

  /** A message in your own DM (your space in Slack): { channel, ts }. */
  async function postToSelf(team, text, threadTs = undefined) {
    const me = await claude.self(page(), team);
    const opened = await api(page(), team, "conversations.open", { users: me.userId });
    const posted = await api(page(), team, "chat.postMessage", { channel: opened.channel.id, text, ...(threadTs && { thread_ts: threadTs }) });
    if (!posted.ok) throw new Error(`chat.postMessage: ${posted.error}`);
    return { channel: opened.channel.id, ts: posted.ts };
  }

  const threadAsText = (thread) =>
    `${thread.conversation} (${thread.workspace})\n\n` +
    thread.messages.map((m) => `[${m.time.slice(0, 16).replace("T", " ")}] ${m.author}: ${m.text}${m.files?.length ? ` [files: ${m.files.map((f) => f.name).join(", ")}]` : ""}`).join("\n");

  /** The folder Claude Code works in for a workspace (claude.folders), if any. */
  const folderOf = (teamId) => readSettings().claude?.folders?.[teamId] ?? null;

  function openClaude(prompt, folder) {
    const url = folder ? `claude://code/new?folder=${encodeURIComponent(folder)}&q=${encodeURIComponent(prompt)}` : `claude://claude.ai/new?q=${encodeURIComponent(prompt)}`;
    return electron.shell.openExternal(url);
  }

  // --- Opening a Slack link in the app ---------------------------------------------------------------------
  // Slack's own deep links (slack://channel?team=&id=&message=), handed to its store as the app does with the ones it
  // is opened with (HANDLE_DEEP_LINK): the web app goes there without reloading.
  let appStore = null;
  async function openInSlack({ link }) {
    const ref = claude.parseRef(link);
    if (!ref.channel) throw new Error('not a link to a Slack conversation');
    const teams = await signedInTeams(page());
    const team = teams.find((each) => new URL(each.url).hostname === ref.host) ?? teams[0];
    const url = `slack://channel?team=${team.id}&id=${ref.channel}${ref.ts ? `&message=${ref.ts}` : ''}${ref.threadTs ? `&thread_ts=${ref.threadTs}` : ''}`;
    appStore.dispatch({ type: 'HANDLE_DEEP_LINK', payload: { url } });
    return { url };
  }

  // --- Notion ----------------------------------------------------------------------------------------------
  async function notionPreview(url) {
    if (!notion.canRead() || notion.settings().previews === false) return { setup: !notion.canRead() };
    return notion.pageInfo(url);
  }

  /** A summary of a conversation as { title, summary, decisions, actions: [{ task, owner }] } (Claude). */
  function summarize(kind, text) {
    return ai.ask({
      json: true,
      prompt:
        `Summarize this Slack ${kind} for a Notion page. Answer as JSON: {"title": short title, "summary": 2-5 sentences, ` +
        `"decisions": [strings], "actions": [{"task": string, "owner": name or null}]}. Use the people's names as written.\n\n${text.slice(0, 150000)}`,
    });
  }

  const needNotion = () => {
    if (!notion.configured()) throw new Error("Notion is not set up: Powertoys panel (Ctrl+Alt+P), Settings");
  };

  /** Claude picks where in Notion a new page belongs, among the pages and databases shared with the connection. */
  async function choosePlace({ kind, title, about }) {
    const places = await notion.places();
    if (!places.length) throw new Error("Notion: the connection can't see any pages; share the pages it may use with it");
    if (places.length === 1) return places[0];
    const list = places.map((place, i) => `${i}. [${place.type}] ${place.path}`).join("\n");
    const answer = await ai.ask({
      fast: true,
      json: true,
      prompt:
        `A new Notion page is being created: a ${kind} titled "${title}". About it: ${about.slice(0, 1500)}\n\n` +
        "Where in this Notion workspace does it belong? Prefer a database or page meant for this kind of page (a Postmortems or " +
        "Incidents database for a postmortem, Meeting notes for a huddle, the project's page for a project discussion) over a " +
        'generic one. Answer as JSON: {"index": number, "why": string}.\n\n' + list.slice(0, 60000),
    });
    const place = places[answer.index];
    if (!place) throw new Error(`Claude didn't pick a place in Notion (${JSON.stringify(answer).slice(0, 200)})`);
    log(`notion: a ${kind} goes under "${place.path}" (${answer.why ?? ""})`);
    return place;
  }

  /** A new page wherever Claude says it belongs -> { url, place: the parent's path }. */
  async function newNotionPage({ kind, title, about, children }) {
    const place = await choosePlace({ kind, title, about });
    const created = await notion.createPage({ parentId: place.id, title, children });
    return { ...created, place: place.path };
  }

  async function threadToNotion({ link }) {
    needNotion();
    const thread = await claude.readThread({ link, limit: 200 });
    let kind = "thread";
    let text = threadAsText(thread);
    const root = thread.messages[0];
    if (root?.huddle) {
      const huddle = await claude.huddleTranscript({ huddle: root.huddle });
      kind = "huddle";
      text = `Huddle in ${huddle.conversation}, ${huddle.minutes} min, with ${huddle.participants.join(", ")}\n\n${huddle.notes ?? ""}\n\n${huddle.lines.map((l) => `${l.speaker}: ${l.text}`).join("\n")}`;
    } else if (thread.messages.some((m) => m.files?.some((f) => f.type === "clip"))) {
      const { clips } = await claude.clipTranscripts({ clip: link });
      kind = "thread with clips";
      text += `\n\n${clips.map((c) => `Clip "${c.title}" transcript:\n${c.lines.map((l) => l.text).join(" ")}`).join("\n\n")}`;
    }
    const summary = await summarize(kind, text);
    const b = notion.blocks;
    const children = [
      b.link(`From Slack: ${thread.conversation}`, link),
      b.heading("Summary"),
      b.paragraph(summary.summary ?? ""),
      ...(summary.decisions?.length ? [b.heading("Decisions"), ...summary.decisions.map((d) => b.bullet(d))] : []),
      ...(summary.actions?.length ? [b.heading("Action items"), ...summary.actions.map((a) => b.todo(a.owner ? `${a.task} (${a.owner})` : a.task))] : []),
      b.divider(),
      b.toggle("Conversation", text.split("\n").filter(Boolean).slice(0, 95).map((line) => b.paragraph(line))),
    ];
    const created = await newNotionPage({ kind: `Slack ${kind} summary`, title: summary.title || `Slack: ${thread.conversation}`, about: `From #${thread.conversation}. ${summary.summary ?? ""}`, children });
    log(`saved a ${kind} to Notion`);
    return created;
  }

  async function postmortem({ link }) {
    needNotion();
    const thread = await claude.readThread({ link, limit: 200 });
    const report = await ai.ask({
      json: true,
      prompt:
        "This is an incident channel's conversation (bot messages are alerts and deploys). Draft a blameless postmortem as JSON: " +
        '{"title": string, "summary": string, "impact": string, "timeline": [{"time": "HH:MM UTC", "event": string}], "rootCause": string, ' +
        '"resolution": string, "actions": [{"task": string, "owner": name or null}]}. Mark guesses as such.\n\n' +
        threadAsText(thread).slice(0, 150000),
    });
    const b = notion.blocks;
    const created = await newNotionPage({
      kind: "incident postmortem",
      title: report.title || `Postmortem: ${thread.conversation}`,
      about: `Incident channel #${thread.conversation}. ${report.summary ?? ""}`,
      children: [
        b.link(`Incident channel: ${thread.conversation}`, link),
        b.heading("Summary"),
        b.paragraph(report.summary ?? ""),
        b.heading("Impact"),
        b.paragraph(report.impact ?? ""),
        b.heading("Timeline"),
        ...(report.timeline ?? []).map((t) => b.bullet(`${t.time} ${t.event}`)),
        b.heading("Root cause"),
        b.paragraph(report.rootCause ?? ""),
        b.heading("Resolution"),
        b.paragraph(report.resolution ?? ""),
        b.heading("Action items"),
        ...(report.actions ?? []).map((a) => b.todo(a.owner ? `${a.task} (${a.owner})` : a.task)),
      ],
    });
    log("drafted a postmortem in Notion");
    return created;
  }

  // --- Claude in Slack -------------------------------------------------------------------------------------
  async function digest({ deliver = false } = {}) {
    const { workspaces } = await claude.unreads({ conversations: 20, perConversation: 10 });
    const text = workspaces
      .map((w) => `# ${w.workspace}\n${w.conversations.map((c) => `## ${c.conversation}${c.mentions ? ` (${c.mentions} mentions)` : ""} ${c.link}\n${c.messages.map((m) => `${m.author}: ${m.text}`).join("\n")}`).join("\n\n")}`)
      .join("\n\n");
    if (!text.trim()) return { text: "Nothing unread." };
    const answer = await ai.ask({
      prompt:
        "Summarize what is unread in my Slack, grouped by urgency (Needs you now / Worth reading / FYI). For each item: one line " +
        "with who, what, and the conversation's link. Mentions of me and direct messages first.\n\n" + text.slice(0, 150000),
    });
    if (deliver) {
      const { to } = settingsOf("digest", { to: "dm" });
      if (to === "notion" && notion.configured()) {
        const created = await newNotionPage({ kind: "daily Slack digest", title: `Slack digest ${new Date().toISOString().slice(0, 10)}`, about: answer, children: answer.split("\n").filter(Boolean).map((line) => notion.blocks.paragraph(line)) });
        return { text: answer, url: created.url };
      }
      await postToSelf(await teamOf(null), `*Catch-up digest*\n${answer}`);
    }
    return { text: answer };
  }

  function scheduleDigest() {
    let lastDay = null;
    setInterval(() => {
      const { time } = settingsOf("digest", { time: null });
      if (!time) return;
      const now = new Date();
      const today = now.toDateString();
      if (lastDay === today || `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}` < time) return;
      lastDay = today;
      digest({ deliver: true }).catch((caught) => warn(`digest: ${caught.message}`));
    }, 60 * 1000);
  }

  function explain({ text, teamId }) {
    const folder = folderOf(teamId) ?? dev.folders(teamId)[0] ?? null;
    return ai.ask({
      cwd: folder,
      prompt:
        `Explain this, from a Slack message, to a developer${folder ? " (the repository in this folder is the code it is about; read files if that helps)" : ""}: ` +
        `what it is, what it means, and what to do about it if it is an error.\n\n${text.slice(0, 20000)}`,
    });
  }

  async function draftReply({ link }) {
    const [thread, mine] = await Promise.all([claude.readThread({ link, limit: 100 }), claude.myMessages({ count: 25 })]);
    const samples = mine.results.map((r) => r.text).filter(Boolean).slice(0, 25).join("\n---\n");
    const reply = await ai.ask({
      prompt:
        "Write my reply to the last message of this Slack thread, in my style (my recent messages show my tone, length and " +
        "language). Answer with the reply text only.\n\nMy recent messages:\n" + samples + "\n\nThe thread:\n" + threadAsText(thread),
    });
    return claude.createDraft({ target: link, text: reply, inThread: true });
  }

  function checkMessage({ text }) {
    return ai.ask({
      fast: true,
      json: true,
      prompt:
        'Check this Slack message before it is sent. Answer as JSON: {"ok": boolean, "issues": [short strings: unclear asks, ' +
        'missing context such as a link or steps to reproduce, a harsh tone], "rewrite": a better version or null}. Keep my ' +
        `voice; do not add formality.\n\n${text.slice(0, 8000)}`,
    });
  }

  // --- Code ------------------------------------------------------------------------------------------------
  const languageOf = (code) =>
    /^\s*(\$ |npm |pnpm |yarn |git |cd |ls |curl |docker |kubectl |pip |python |node )/m.test(code) ? "sh" : /^\s*(import|export|const|let|function)\b/m.test(code) ? "js" : /^\s*(def |class |import )/m.test(code) ? "py" : "txt";

  async function openFile({ ref, line, column, teamId }) {
    const file = dev.resolveFile(ref, teamId);
    if (!file) throw new Error(`${ref} is not in the workspace's folder or the repositories in settings`);
    await dev.openInEditor(file, line || 1, column || 1);
    return { file };
  }

  // "Ask Claude to review": the prompt is "dev": { "reviewPrompt" } ({pr}: the pull request's link), set in the panel's
  // Settings tab.
  const REVIEW_PROMPT = "Review the PR {pr} focusing only on major business logic issues. No nit-picking";
  const reviewPrompt = () => settingsOf("dev", {}).reviewPrompt?.trim() || REVIEW_PROMPT;
  function reviewPull({ url, teamId }) {
    const ref = dev.parseGitHub(url);
    return dev.repoFolder(ref.owner, ref.repo).then((folder) => {
      openClaude(reviewPrompt().replaceAll("{pr}", url), folder ?? folderOf(teamId));
      return { folder };
    });
  }

  function watchRun({ url }) {
    return {
      started: dev.watchRun(
        url,
        (info) => send("powertoys:run-status", info),
        async (info) => {
          const team = await teamOf(null);
          await claude.remind(page(), team, `GitHub run ${info.workflow} (${info.branch}) finished: ${info.conclusion}${info.failing?.length ? ` (failing: ${info.failing.join(", ")})` : ""} ${url}`);
        },
      ),
    };
  }

  // --- Agents: Claude Code sessions ------------------------------------------------------------------------
  const sessions = new Map(); // session id -> { id, cwd, state, message, updated, started }
  function trackSession({ event, sessionId, cwd, message, summary }) {
    if (!sessionId) return;
    const previous = sessions.get(sessionId) ?? { id: sessionId, cwd, started: Date.now() };
    const state = { start: "working", prompt: "working", stop: "idle", notification: "needs you", permission: "needs you" }[event] ?? previous.state;
    sessions.set(sessionId, { ...previous, cwd: cwd ?? previous.cwd, state, message: message ?? summary ?? previous.message, updated: Date.now() });
    send("powertoys:agents", agents());
  }
  const agents = () => [...sessions.values()].sort((a, b) => b.updated - a.updated).slice(0, 20);

  function resumeSession({ id }) {
    const session = sessions.get(id);
    if (!session) throw new Error("no such session");
    const child = __webpack_require__(35317).spawn("wt", ["-d", session.cwd, "claude", "--resume", id], { detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true };
  }

  // A session's permission request, answered from Slack: the hook waits (agents.approveWaitSeconds) for Approve or
  // Deny in Slack's page, or for "y" / "n" in the thread of a message in your DM (so it works from your phone).
  const approvals = new Map(); // id -> { resolve, timer }
  let approvalCount = 0;
  async function permission({ sessionId, cwd, tool, input }) {
    const { remoteApprove, approveWaitSeconds } = settingsOf("agents", { remoteApprove: false, approveWaitSeconds: 120 });
    trackSession({ event: "permission", sessionId, cwd, message: `wants to use ${tool}` });
    if (!remoteApprove) return { decision: null };
    const id = `a${++approvalCount}`;
    const where = cwd ? path.basename(cwd) : "a session";
    const detail = typeof input === "object" ? (input.command ?? input.file_path ?? input.url ?? JSON.stringify(input)).toString().slice(0, 300) : "";
    const team = await teamOf(null);
    const posted = await postToSelf(team, `:robot_face: Claude Code in *${where}* wants to use *${tool}*${detail ? `: \`${detail}\`` : ""}\nReply \`y\` to allow or \`n\` to deny in this thread (or use the buttons in Slack on your computer).`);
    await claude.remind(page(), team, `Claude Code in ${where} is waiting for your permission (${tool})`).catch(() => {});
    send("powertoys:approval", { id, where, tool, detail });
    const decision = await new Promise((resolve) => {
      const done = (value) => {
        clearInterval(poll);
        clearTimeout(timer);
        approvals.delete(id);
        resolve(value);
      };
      const timer = setTimeout(() => done(null), approveWaitSeconds * 1000);
      const poll = setInterval(async () => {
        const replies = await api(page(), team, "conversations.replies", { channel: posted.channel, ts: posted.ts, limit: 10 }).catch(() => ({}));
        const answer = (replies.messages ?? []).slice(1).map((m) => (m.text ?? "").trim().toLowerCase()).find((t) => /^(y|yes|n|no)$/.test(t));
        if (answer) done(answer.startsWith("y") ? "allow" : "deny");
      }, 3000);
      approvals.set(id, { done });
    });
    send("powertoys:approval-done", { id, decision });
    await postToSelf(team, decision ? `${decision === "allow" ? "Allowed" : "Denied"}.` : "No answer in time: the session asks in its own window.", posted.ts).catch(() => {});
    log(`permission request ${decision ?? "unanswered"}`);
    return { decision };
  }

  function answerApproval({ id, decision }) {
    approvals.get(id)?.done(decision === "allow" ? "allow" : "deny");
    return { ok: true };
  }

  function taskFromThread({ link, teamId }) {
    const folder = folderOf(teamId);
    openClaude(
      `Read this Slack thread with the slack-powertoys tools and do the work it asks for here: ${link}\n` +
        "When it is done (a branch or pull request), put a reply in that thread as a draft with create_slack_draft, with the link and two lines on what changed.",
      folder,
    );
    return { folder };
  }

  // A thread as an issue ticket, by a Claude Code session in the workspace's folder (which knows how its tickets are
  // made). The session reads the thread itself, through the slack-powertoys tools; this only says what to use.
  function issueFromThread({ link, teamId }) {
    const folder = folderOf(teamId);
    if (!folder) throw new Error("this workspace has no folder linked (Claude Code needs one to know where its tickets go)");
    openClaude(
      `Create a ticket in Notion's Issues database (Issues & Sprints → Core DBs → Issues), the way tickets are made there, from this Slack thread: ${link}\n\n` +
        "- Read it with the slack-powertoys tools: read_slack_thread (limit 200).\n" +
        "- Its videos: get_slack_clip_transcript gives Slack's transcript. When Slack has none yet, request_slack_transcript " +
        "and read it again a minute later.\n" +
        "- Write the ticket from the messages and the transcripts. Look at a video only when they don't make the issue clear " +
        "(when what is on screen matters: a UI problem, an error shown, a number on a chart): take frames at those moments " +
        "(save_slack_file for the video, then ffmpeg -ss <seconds> -i <video> -frames:v 1 frame-<seconds>.png), look at them, and attach to the ticket only the ones " +
        "that show the problem. Images attached in the thread: save_slack_file, and the same rule.\n" +
        "- Then give me the ticket's link, and put it in a reply in the thread as a draft (create_slack_draft).",
      folder,
    );
    log(`issue from a thread: Claude Code in ${folder}`);
    return { folder };
  }

  // --- Search ----------------------------------------------------------------------------------------------
  async function searchAll({ query, teamId }) {
    const [slack, notionResults, code] = await Promise.all([
      claude.search({ query, count: 8 }).then((r) => r.results).catch((caught) => [{ error: caught.message }]),
      notion.configured() ? notion.search(query, 8).catch((caught) => [{ error: caught.message }]) : Promise.resolve(null),
      dev.searchCode(query, teamId).catch(() => []),
    ]);
    return { slack, notion: notionResults, code };
  }

  // --- Focus mode ------------------------------------------------------------------------------------------
  let focus = null; // { until, since, seen: Set, collected: [] , timer }
  async function setFocus({ on, minutes }) {
    const teams = (await signedInTeams(page())).filter((team) => !/\.enterprise\./.test(team.url));
    if (!on) {
      if (!focus) return { on: false };
      clearInterval(focus.timer);
      for (const team of teams) await api(page(), team, "dnd.endSnooze").catch(() => {});
      const collected = focus.collected;
      focus = null;
      send("powertoys:focus", { on: false });
      if (!collected.length) return { on: false, summary: "Nothing happened while you were focused." };
      const summary = await ai.ask({ prompt: `Summarize what I missed in Slack while focused, most important first, one line each with the link:\n\n${collected.map((m) => `${m.author} in ${m.conversation}: ${m.text} ${m.link}`).join("\n")}` });
      return { on: false, summary };
    }
    const length = minutes ?? settingsOf("focus", { minutes: 60 }).minutes;
    for (const team of teams) await api(page(), team, "dnd.setSnooze", { num_minutes: length }).catch(() => {});
    focus = { until: Date.now() + length * 60000, since: Date.now() / 1000, seen: new Set(), collected: [], timer: null };
    focus.timer = setInterval(() => triage().catch((caught) => warn(`focus: ${caught.message}`)), 2 * 60 * 1000);
    send("powertoys:focus", { on: true, until: focus.until });
    log(`focus mode for ${length} min`);
    return { on: true, until: focus.until };
  }

  async function triage() {
    if (!focus) return;
    if (Date.now() > focus.until) return setFocus({ on: false });
    const { workspaces } = await claude.unreads({ conversations: 15, perConversation: 8 });
    const fresh = [];
    for (const w of workspaces) {
      for (const c of w.conversations) {
        for (const m of c.messages) {
          if (Date.parse(m.time) / 1000 < focus.since || focus.seen.has(m.link)) continue;
          focus.seen.add(m.link);
          const entry = { ...m, conversation: c.conversation, workspace: w.workspace, direct: c.conversation.startsWith("@"), mentions: c.mentions };
          focus.collected.push(entry);
          if (entry.direct || c.mentions) fresh.push(entry);
        }
      }
    }
    if (!fresh.length) return;
    const verdicts = await ai.ask({
      fast: true,
      json: true,
      prompt: `I am focusing. Which of these Slack messages need me now (production down, a blocker for others, a deadline today, my manager asking)? Answer as JSON: [{"i": index, "urgent": boolean, "why": short}].\n\n${fresh.map((m, i) => `${i}. ${m.author} in ${m.conversation}: ${m.text}`).join("\n")}`,
    });
    for (const verdict of verdicts ?? []) {
      const m = fresh[verdict.i];
      if (!verdict.urgent || !m) continue;
      const shown = new electron.Notification({ title: `Urgent: ${m.author} in ${m.conversation}`, body: `${verdict.why ? `${verdict.why}: ` : ""}${m.text.slice(0, 180)}` });
      shown.on("click", () => send("powertoys:open-link", { link: m.link }));
      shown.show();
    }
  }

  // --- Snippets --------------------------------------------------------------------------------------------
  function snippets() {
    const own = path.join(powertoysDir(), "snippets.json");
    const read = (file) => {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return [];
      }
    };
    if (!fs.existsSync(own)) {
      fs.mkdirSync(powertoysDir(), { recursive: true });
      fs.writeFileSync(
        own,
        JSON.stringify(
          [
            { name: "standup", text: "*Yesterday*\n{{commits}}\n*Today*\n- \n*Blockers*\n- none" },
            { name: "bug report", text: "*What happened*\n\n*Expected*\n\n*Steps to reproduce*\n1. \n\n*Environment*\n" },
            { name: "release note", text: "{{ai: a short release note from my commits since yesterday}}\n\n{{commits}}" },
          ],
          null,
          2,
        ),
      );
    }
    const team = settingsOf("snippets", { teamFile: null }).teamFile;
    return [...read(own), ...(team ? read(team).map((s) => ({ ...s, team: true })) : [])];
  }

  async function fillSnippet({ text, teamId }) {
    let out = text.replace(/\{\{date\}\}/g, new Date().toISOString().slice(0, 10));
    if (/\{\{commits\}\}|\{\{ai:/.test(out)) {
      const commits = (await dev.recentCommits(teamId)) || "- (no commits since yesterday)";
      out = out.replace(/\{\{commits\}\}/g, commits);
      for (const [whole, request] of [...out.matchAll(/\{\{ai:\s*([^}]+)\}\}/g)]) {
        const answer = await ai.ask({ fast: true, prompt: `${request}\n\nMy commits since yesterday:\n${commits}\n\nAnswer with the text only.` });
        out = out.replace(whole, answer);
      }
    }
    return { text: out };
  }

  // --- Tray ------------------------------------------------------------------------------------------------
  exports.addTrayItems = function addTrayItems(menu) {
    menu.append(new electron.MenuItem({ label: "Catch-up digest (to your DM)", click: () => digest({ deliver: true }).catch((caught) => warn(`digest: ${caught.message}`)) }));
    menu.append(new electron.MenuItem({ label: focus ? "End focus mode" : "Focus mode", click: () => setFocus({ on: !focus }).then((r) => r.summary && send("powertoys:focus-summary", r)).catch((caught) => warn(`focus: ${caught.message}`)) }));
    menu.append(new electron.MenuItem({ label: "Powertoys panel", click: () => send("powertoys:panel", {}) }));
    menu.append(new electron.MenuItem({ label: "Edit snippets", click: () => (snippets(), electron.shell.openPath(path.join(powertoysDir(), "snippets.json"))) }));
  };

  exports.trackSession = (body) => trackSession({ ...body, sessionId: body.sessionId ?? body.session_id });
  exports.permission = permission;

  const HANDLERS = {
    "notion-preview": notionPreview,
    "link-title": (url) => dev.linkTitle(url),
    "thread-to-notion": threadToNotion,
    postmortem,
    digest: () => digest({ deliver: false }),
    explain,
    "draft-reply": draftReply,
    "check-message": checkMessage,
    "open-file": openFile,
    "open-snippet": ({ code }) => dev.openSnippet(code, languageOf(code)),
    "run-command": ({ code, teamId }, event) => dev.runInTerminal(code.replace(/^\$ /gm, ""), folderOf(teamId) ?? dev.folders(teamId)[0], electron.BrowserWindow.fromWebContents(event.sender)),
    gist: ({ code }, event) => dev.createGist(code, languageOf(code), electron.BrowserWindow.fromWebContents(event.sender)),
    "send-to-code": ({ code, link, teamId }) => openClaude(`Here is a snippet from Slack${link ? ` (${link})` : ""}:\n\n\`\`\`\n${code}\n\`\`\`\n\n`, folderOf(teamId)).then(() => ({ ok: true })),
    "github-info": (url) => dev.githubInfo(url),
    "open-in-slack": openInSlack,
    "review-pull": reviewPull,
    "watch-run": watchRun,
    agents: () => agents(),
    "resume-session": resumeSession,
    "answer-approval": answerApproval,
    "task-from-thread": taskFromThread,
    "issue-from-thread": issueFromThread,
    search: searchAll,
    focus: setFocus,
    snippets: () => snippets(),
    "fill-snippet": fillSnippet,
    "notion-setup": notionSetup,
    "notion-sign-in": notionSignIn,
    "notion-sign-in-as-you": () => notion.signInAsYou(),
    "review-prompt": ({ prompt }) => {
      const value = String(prompt ?? "").trim();
      updateSettings((current) => ({ ...current, dev: { ...current.dev, reviewPrompt: value && value !== REVIEW_PROMPT ? value : undefined } }));
      log(`review prompt ${value && value !== REVIEW_PROMPT ? "set" : "back to the default"}`);
      return { prompt: reviewPrompt() };
    },
    "transcript-language": ({ language }) => {
      if (!(language in claude.TRANSCRIPT_LANGUAGES)) throw new Error(`not a language Slack transcribes in: ${language}`);
      updateSettings((current) => ({ ...current, transcripts: { ...current.transcripts, language } }));
      log(`transcripts in ${language}`);
      return { language };
    },
    settings: () => ({
      notion: notion.configured(),
      notionAsYou: notion.mcpSignedIn(),
      notionClientId: notion.settings().clientId || null,
      notionRedirectUri: notion.redirectUri,
      transcriptLanguage: claude.transcriptLanguage(),
      reviewPrompt: reviewPrompt(),
      reviewPromptDefault: REVIEW_PROMPT,
      transcriptLanguages: claude.TRANSCRIPT_LANGUAGES,
      incidentPattern: settingsOf("incidents", { channelPattern: "^(inc|incident)[-_]" }).channelPattern,
      focus: focus ? { on: true, until: focus.until } : { on: false },
    }),
  };

  /** Saves Notion's token, only once Notion has accepted it. A blank token keeps the saved one. */
  async function notionSetup({ token }) {
    token = token?.trim() || notion.settings().token;
    if (!token) throw new Error("Paste the integration's secret first");
    const checked = await notion.check({ token });
    updateSettings((current) => ({ ...current, notion: { ...current.notion, token } }));
    log(`Notion set up (workspace ${checked.workspace ?? "?"}, ${checked.shared} pages shared)`);
    return checked;
  }

  /** Signs in with a public (OAuth) connection; saves the token only once it checks out. A blank secret keeps the saved one. */
  async function notionSignIn({ clientId, clientSecret }) {
    clientId = clientId?.trim() || notion.settings().clientId;
    clientSecret = clientSecret?.trim() || notion.settings().clientSecret;
    if (!clientId || !clientSecret) throw new Error("Paste the connection's client ID and client secret first");
    const { token, refreshToken, workspace } = await notion.signIn({ clientId, clientSecret });
    const checked = await notion.check({ token });
    updateSettings((current) => ({ ...current, notion: { ...current.notion, token, refreshToken, clientId, clientSecret } }));
    log(`Notion signed in (workspace ${workspace ?? "?"}, ${checked.shared} pages shared)`);
    return { ...checked, workspace: workspace ?? checked.workspace };
  }

  exports.start = function start(store) {
    appStore = store;
    for (const [name, handler] of Object.entries(HANDLERS)) {
      electron.ipcMain.handle(`powertoys:${name}`, (event, request) => handler(request ?? {}, event));
    }
    scheduleDigest();
    log("assist started");
  };
});
