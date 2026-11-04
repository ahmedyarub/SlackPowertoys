// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): a brief before (or during) a call, from the "Brief" chip in a huddle window.
//
//   - The daily standup (a huddle in standup.channel, "engineering", on a weekday from 30 minutes before standup.time,
//     "10:00", to two hours after), all since noon of the previous working day: your PRs (gh, dev.repos) opened,
//     merged, closed or reviewed; your tickets whose status changed (Notion's page history, read as you: from what to
//     what, when, by whom); what was released that is yours (Alfred's posts in standup.releaseChannel, the lines
//     "… [ISS-n] by @<standup.githubUser>"; its evening release often comes after midnight); and your tickets now:
//     working on (In progress, Blocked, Code Review Pending), and waiting on a deploy or testing.
//   - Any other call: the conversation with that person or channel lately, your tickets mentioned there (their status
//     now), and the last recording with them; what to raise.
// The standup's is laid out here, a line per ticket (its ID and name, where it is: Production, UAT, Dev, Code review,
// In progress, and its PRs), under Since yesterday, Today, Waiting on deploy or testing, and Blocked.
// Only your tickets. For a call, Claude (the fast model) writes it from those facts only (without Claude, the facts themselves);
// its ticket IDs become links, and a list follows with each ticket's links, made here, not by Claude: the Notion
// ticket, its PRs (gh, your PRs in dev.repos, by the ticket in their title or branch) and the Claude Code sessions
// about it (the linked folders' sessions naming it in their title or transcript; claude://resume opens them).
// ---------------------------------------------------------------------------------------------
(function (module, exports, __webpack_require__) {
  "use strict";

  const fs = __webpack_require__(79896);
  const path = __webpack_require__(16928);
  const { log, warn, readSettings, slackPage, signedInTeams, api } = __webpack_require__("powertoys/main");
  const ai = () => __webpack_require__("powertoys/ai");
  const notion = () => __webpack_require__("powertoys/notion");
  const claude = () => __webpack_require__("powertoys/claude");

  const settings = () => ({ channel: "engineering", time: "10:00", releaseChannel: null, githubUser: null, ...readSettings().standup });
  const normal = (name) => String(name ?? "").replace(/^[#@]\s*/, "").trim().toLowerCase();

  async function teamOf(teamId) {
    const teams = await signedInTeams(slackPage());
    return teams.find((team) => team.id === teamId) ?? teams[0];
  }

  /** Whether a huddle in `where` now is the standup. */
  function isStandup(where, now = new Date()) {
    const { channel, time } = settings();
    if (normal(where) !== normal(channel) || now.getDay() === 0 || now.getDay() === 6) return false;
    const [hours, minutes] = String(time).split(":").map(Number);
    const start = new Date(now);
    start.setHours(hours, minutes || 0, 0, 0);
    // To two hours after: the standup moves an hour when the clocks change (10:00 here before 2 Nov, 11:00 after).
    return now - start >= -30 * 60e3 && now - start <= 120 * 60e3;
  }

  /** The start of the previous working day (Monday: Friday). */
  function previousWorkingDay(now = new Date()) {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    do day.setDate(day.getDate() - 1);
    while (day.getDay() === 0 || day.getDay() === 6);
    return day;
  }

  /**
   * Alfred's release posts since `since` -> [{ env, version, at, items: [{ text, ticket, author, pr }] }]. The posts'
   * text has Slack's formatting: "*release_prod_v1.0.314* published to *PROD*", items "• … [ISS-1999] by @user in
   * <https://github.com/…/pull/1987|…>".
   */
  async function releases(team, since) {
    const { releaseChannel } = settings();
    if (!releaseChannel) throw new Error("standup.releaseChannel isn't set");
    const page = slackPage();
    const history = await api(page, team, "conversations.history", { channel: releaseChannel, oldest: String(since.getTime() / 1000), limit: 200 });
    if (!history.ok) throw new Error(`the release channel couldn't be read (${history.error})`);
    return parseReleases(history.messages ?? []);
  }
  function parseReleases(messages) {
    const found = [];
    for (const message of messages) {
      const text = String(message.text ?? "");
      const published = /(release_(?:prod|uat)_v[\d.]+)\*?\s+published to\s+\*?(PROD|UAT)\b/i.exec(text);
      if (!published) continue;
      const items = [...text.matchAll(/[•]\s*([^\n•]+?)\s*(?:\[([A-Z]+-\d+)\])?\s+by @([\w-]+)(?:\s+in\s+<?(https:\/\/github\.com\/[^\s|>]+))?/g)].map((match) => ({
        text: match[1].trim(),
        ticket: match[2] ?? null,
        author: match[3],
        pr: match[4] ?? null,
      }));
      found.push({ env: published[2].toUpperCase(), version: published[1], at: new Date(Number(message.ts) * 1000), items });
    }
    return found.sort((a, b) => a.at - b.at);
  }
  exports.parseReleases = parseReleases;

  // --- Links for a ticket: its PRs and the Claude Code sessions about it -----------------------------------
  const ticketsIn = (text, prefix) => [...new Set([...String(text).matchAll(new RegExp(`\\b${prefix}-(\\d+)\\b`, "gi"))].map((match) => `${prefix}-${match[1]}`))];

  /** Your PRs (gh, the repositories in dev.repos), by the tickets in their titles and branches -> Map(id -> [pr]). */
  async function prsByTicket(prefix) {
    const byTicket = new Map();
    for (const repo of Object.keys(readSettings().dev?.repos ?? {})) {
      let prs = [];
      try {
        // As an account that can see the repository (powertoys/dev), and "@me" is that account.
        prs = JSON.parse(await __webpack_require__("powertoys/dev").ghAs(repo.split("/")[0], ["pr", "list", "-R", repo, "--author", "@me", "--state", "all", "--limit", "100", "--json", "number,title,url,state,headRefName,updatedAt"]));
      } catch (caught) {
        warn(`brief: ${repo}'s pull requests: ${caught.message}`);
      }
      for (const pr of prs) {
        for (const id of ticketsIn(`${pr.title} ${pr.headRefName}`, prefix)) {
          if (!byTicket.has(id)) byTicket.set(id, []);
          byTicket.get(id).push(pr);
        }
      }
    }
    // Open first, then the newest.
    for (const list of byTicket.values()) list.sort((a, b) => (b.state === "OPEN") - (a.state === "OPEN") || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return byTicket;
  }

  /**
   * The Claude Code sessions about each ticket, in the linked folders (the newest 15 with a title in each): the
   * tickets named in a session's title, or in the start or end of its transcript -> Map(id -> [{ id, title, updated }]).
   */
  function sessionsByTicket(prefix) {
    const byTicket = new Map();
    const huddle = __webpack_require__("powertoys/huddle");
    const projects = path.join(process.env.USERPROFILE ?? "", ".claude", "projects");
    const folders = new Set([...Object.values(readSettings().claude?.folders ?? {}), ...Object.values(readSettings().dev?.repos ?? {})]);
    for (const folder of folders) {
      let sessions = [];
      try {
        sessions = huddle.projectSessions(folder);
      } catch {}
      const project = folder.replace(/[:\\/.]/g, "-");
      const dirs = fs.existsSync(projects) ? fs.readdirSync(projects).filter((dir) => dir === project || dir.startsWith(`${project}--claude-worktrees-`)) : [];
      for (const session of sessions) {
        let text = session.title;
        const file = dirs.map((dir) => path.join(projects, dir, `${session.id}.jsonl`)).find((each) => fs.existsSync(each));
        if (file) {
          const fd = fs.openSync(file, "r");
          try {
            const size = fs.fstatSync(fd).size;
            const part = Buffer.alloc(Math.min(size, 300 * 1024));
            fs.readSync(fd, part, 0, part.length, 0);
            text += part.toString("utf8");
            if (size > part.length) {
              fs.readSync(fd, part, 0, part.length, size - part.length);
              text += part.toString("utf8");
            }
          } finally {
            fs.closeSync(fd);
          }
        }
        const named = new Set(ticketsIn(session.title, prefix));
        for (const id of ticketsIn(text, prefix)) {
          if (!byTicket.has(id)) byTicket.set(id, []);
          byTicket.get(id).push({ id: session.id, title: session.title, updated: session.updated, named: named.has(id) });
        }
      }
    }
    // The sessions named for the ticket first, then the newest; at most two.
    for (const [id, list] of byTicket) byTicket.set(id, list.sort((a, b) => b.named - a.named || b.updated - a.updated).slice(0, 2));
    return byTicket;
  }

  /** Your PRs (gh, the repositories in dev.repos) updated since `since`, with their reviews and checks, newest first. */
  async function prsSince(since) {
    const found = [];
    for (const repo of Object.keys(readSettings().dev?.repos ?? {})) {
      const out = await __webpack_require__("powertoys/dev").ghAs(repo.split("/")[0], [
        "pr", "list", "-R", repo, "--author", "@me", "--state", "all", "--search", `updated:>=${since.toISOString().slice(0, 19)}Z`, "--limit", "40",
        "--json", "number,title,url,state,isDraft,createdAt,mergedAt,closedAt,updatedAt,headRefName,reviewDecision,latestReviews,statusCheckRollup",
      ]);
      found.push(...JSON.parse(out));
    }
    return found.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  /** A ticket's line: its link and title, then where it is, its PRs and its sessions (Markdown). */
  function ticketLine(ticket, { where, prs = [], sessions = [] }) {
    const links = [
      ...prs.slice(0, 3).map((pr) => `PR [#${pr.number}](${pr.url})${pr.state === "OPEN" ? "" : ` (${pr.state.toLowerCase()})`}`),
      ...sessions.map((session) => `session [${session.title.replace(/[[\]]/g, "")}](claude://resume?session=${session.id})`),
    ];
    return `- ${ticket.url ? `[${ticket.id}](${ticket.url})` : ticket.id} ${ticket.title ?? ""}${where ? ` — ${where}` : ""}${links.length ? ` · ${links.join(" · ")}` : ""}`;
  }

  /** Ticket IDs in Claude's text as links to the tickets. */
  const linkTickets = (text, urls) => text.replace(/\b([A-Z]+-\d+)\b(?!\]|\()/g, (id) => (urls.get(id) ? `[${id}](${urls.get(id)})` : id));
  /** A Notion page's id (32 hex digits) in any of its URLs. */
  const pageKey = (url) => /([0-9a-f]{32})/.exec(String(url ?? "").replace(/-/g, ""))?.[1] ?? null;

  async function standupBrief(teamId) {
    const { githubUser } = settings();
    const prefix = notion().ticketPrefix();
    // Since the afternoon of the previous working day (noon).
    const since = previousWorkingDay();
    since.setHours(12);
    const problems = [];
    const team = await teamOf(teamId);
    const [prs, sessions] = await Promise.all([prsByTicket(prefix).catch(() => new Map()), Promise.resolve().then(() => sessionsByTicket(prefix)).catch(() => new Map())]);
    // My PRs since then: opened, merged, closed.
    let recentPrs = [];
    try {
      recentPrs = await prsSince(since);
    } catch (caught) {
      problems.push(`pull requests: ${caught.message}`);
    }
    // My tickets whose status changed since then (Notion's history), or that were created since.
    let moved = [];
    let owned = new Map();
    try {
      const changes = (await notion().ticketChanges(since)).filter((change) => change.after.Status && change.after.Status !== change.before.Status);
      owned = new Map((await notion().myTicketsAmong(changes.map((change) => change.url))).map((t) => [pageKey(t.url), t]));
      moved = changes.filter((change) => owned.has(pageKey(change.url))).map((change) => ({ ...change, ticket: owned.get(pageKey(change.url)) }));
    } catch (caught) {
      problems.push(`ticket changes: ${caught.message}`);
    }
    // Where my tickets were released, the last 7 days (the latest release of each ticket; its evening release often
    // comes after midnight).
    const lastRelease = new Map();
    try {
      if (!githubUser) problems.push("releases: standup.githubUser isn't set");
      for (const release of await releases(team, new Date(Date.now() - 7 * 86400e3)))
        for (const item of release.items) if (item.author === githubUser && item.ticket) lastRelease.set(item.ticket, { ...item, env: release.env, version: release.version, at: release.at });
    } catch (caught) {
      problems.push(`releases: ${caught.message}`);
    }
    let inFlight = [];
    try {
      inFlight = await notion().myTickets();
    } catch (caught) {
      problems.push(`tickets: ${caught.message}`);
    }

    // Each ticket of mine with something since then, once: its PRs since then, its status change, its release.
    const touched = new Map();
    const entry = (id) => (touched.has(id) || touched.set(id, { id, prs: [] }), touched.get(id));
    const loosePrs = [];
    for (const pr of recentPrs) {
      const ids = ticketsIn(`${pr.title} ${pr.headRefName}`, prefix);
      if (!ids.length) loosePrs.push(pr);
      for (const id of ids) entry(id).prs.push(pr);
    }
    for (const change of moved) Object.assign(entry(change.ticket.id), { ticket: change.ticket, change });
    for (const [id, release] of lastRelease) if (release.at >= since) entry(id);
    const known = new Map([...inFlight, ...owned.values()].map((t) => [t.id, t]));
    await Promise.all(
      [...touched.values()].map(async (each) => {
        each.ticket ??= known.get(each.id) ?? (await notion().ticket(each.id).catch(() => null)) ?? {
          id: each.id,
          // Not found in Notion: named by its release line or its PR ("fix(scope): what [ISS-n]" -> "what").
          title: lastRelease.get(each.id)?.text ?? String(each.prs[0]?.title ?? "").replace(/^\w+(\([^)]*\))?!?:\s*/, "").replace(/\s*\[[A-Z]+-\d+\]/g, ""),
          status: null,
          url: null,
        };
      }),
    );

    const name = (t) => `**${t.url ? `[${t.id}](${t.url})` : t.id} ${String(t.title ?? "").replace(/\s+/g, " ").trim()}**`;
    const prText = (pr) => `[#${pr.number}](${pr.url}) ${pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed without merging" : pr.isDraft ? "open, draft" : "open"}`;
    const line = (t, { prs: those = [], was, links = false } = {}) => {
      const where = stage(t, lastRelease.get(t.id));
      const extra = [...those.map(prText), ...(links ? (sessions.get(t.id) ?? []).map((session) => `session [${session.title.replace(/[[\]]/g, "")}](claude://resume?session=${session.id})`) : [])];
      return `- ${name(t)}${where.label ? ` — ${where.label}` : ""}${was && was !== t.status ? ` (was ${was})` : ""}${extra.length ? ` · ${extra.join(" · ")}` : ""}`;
    };
    const since_ = [...touched.values()].sort((a, b) => stage(a.ticket, lastRelease.get(a.id)).rank - stage(b.ticket, lastRelease.get(b.id)).rank || a.id.localeCompare(b.id, undefined, { numeric: true }));
    const working = inFlight.filter((t) => /In progress|Blocked|Code Review/i.test(t.status));
    const waiting = inFlight.filter((t) => !working.includes(t) && !touched.has(t.id));
    const blocked = working.filter((t) => /Blocked/i.test(t.status));
    const openPrs = (t) => (prs.get(t.id) ?? []).filter((pr) => pr.state === "OPEN");
    const sections = [
      "**Since yesterday**",
      ...(since_.length || loosePrs.length
        ? [...since_.map((each) => line(each.ticket, { prs: each.prs, was: each.change?.action === "edited" ? each.change.before.Status : null })), ...loosePrs.map((pr) => `- ${prText(pr)}: ${pr.title}`)]
        : ["- Nothing of mine moved."]),
      "",
      "**Today**",
      ...(working.length ? working.map((t) => line(t, { prs: openPrs(t), links: true })) : ["- No ticket in progress or in code review."]),
      ...(waiting.length ? ["", "**Waiting on deploy or testing**", ...waiting.map((t) => line(t))] : []),
      "",
      `**Blocked:** ${blocked.length ? blocked.map((t) => t.id).join(", ") : "No"}`,
    ];
    log(`brief: Standup (${since_.length} tickets since ${since.toLocaleString()}, ${working.length} today${problems.length ? `, ${problems.length} missing` : ""})`);
    return `**Standup**\n\n${sections.join("\n")}${problems.length ? `\n\n_Not included: ${problems.join("; ")}._` : ""}`;
  }

  /** Where a ticket is: production or UAT once released there, else what its status says -> { label, rank }. */
  function stage(ticket, release) {
    const status = String(ticket?.status ?? "");
    if (release?.env === "PROD") return { label: `**Production** (${release.version.replace(/^release_prod_/, "")})`, rank: 0 };
    if (release?.env === "UAT" || /Deployed\s*\(UAT\)/i.test(status)) return { label: "**UAT**", rank: 1 };
    if (/Acceptance/i.test(status)) return { label: "**Acceptance testing**", rank: 2 };
    if (/Deployed\s*\(Dev\)/i.test(status)) return { label: "**Dev**", rank: 3 };
    if (/Accepted/i.test(status)) return { label: "**Done**, not in a release yet", rank: 4 };
    if (/Code Review/i.test(status)) return { label: "**Code review**", rank: 5 };
    if (/In progress/i.test(status)) return { label: "**In progress**", rank: 6 };
    if (/Blocked/i.test(status)) return { label: "**Blocked**", rank: 7 };
    return { label: status, rank: 8 };
  }

  /** The conversation a huddle is in: a channel by its name, or a DM by the person's name -> its id. */
  const conversations = new Map();
  async function conversationOf(team, where) {
    const key = `${team.id}:${normal(where)}`;
    if (conversations.has(key)) return conversations.get(key);
    const page = slackPage();
    let id = null;
    for (let cursor = "", pages = 0; !id && pages < 5; pages++) {
      const listed = await api(page, team, "conversations.list", { types: "public_channel,private_channel", exclude_archived: true, limit: 1000, ...(cursor && { cursor }) });
      id = (listed.channels ?? []).find((channel) => normal(channel.name) === normal(where))?.id ?? null;
      cursor = listed.response_metadata?.next_cursor;
      if (!cursor) break;
    }
    if (!id) {
      const users = (await api(page, team, "users.list", { limit: 1000 })).members ?? [];
      const wanted = normal(where);
      const person = users.find((user) => !user.deleted && [user.real_name, user.profile?.display_name, user.name].some((name) => normal(name) === wanted || normal(name).startsWith(`${wanted} `)));
      if (person) id = (await api(page, team, "conversations.open", { users: person.id })).channel?.id ?? null;
    }
    if (id) conversations.set(key, id);
    return id;
  }

  /** The last recording of a call in `where` (before this one): its summary, or the end of its transcript. */
  function lastRecording(where) {
    const folder = readSettings().huddle?.recordingsFolder;
    if (!folder || !fs.existsSync(folder)) return null;
    const recordings = fs
      .readdirSync(folder)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        try {
          return { base: path.join(folder, name.slice(0, -5)), ...JSON.parse(fs.readFileSync(path.join(folder, name), "utf8")) };
        } catch {
          return null;
        }
      })
      .filter((recording) => recording && normal(recording.where) === normal(where) && recording.status !== "recording")
      .sort((a, b) => b.since - a.since);
    for (const recording of recordings) {
      for (const [file, label] of [[".summary.md", "summary"], [".captions.txt", "transcript (end)"], [".transcript.txt", "transcript (end)"]]) {
        if (fs.existsSync(`${recording.base}${file}`)) {
          const text = fs.readFileSync(`${recording.base}${file}`, "utf8");
          return `Last recorded call in ${where} (${new Date(recording.since).toLocaleString()}), its ${label}:\n${label === "summary" ? text : text.slice(-4000)}`;
        }
      }
    }
    return null;
  }

  async function callBrief(where, teamId) {
    const team = await teamOf(teamId);
    const facts = [];
    const problems = [];
    let text = "";
    try {
      const channel = await conversationOf(team, where);
      if (!channel) throw new Error(`no conversation named "${where}"`);
      const history = await api(slackPage(), team, "conversations.history", { channel, limit: 40, oldest: String(Date.now() / 1000 - 7 * 86400) });
      const lines = [];
      for (const message of (history.messages ?? []).reverse()) {
        if (!message.text) continue;
        lines.push(`[${new Date(Number(message.ts) * 1000).toLocaleString()}] ${message.user ? await claude().userName(slackPage(), team, message.user) : message.username ?? "bot"}: ${await claude().plainText(slackPage(), team, message.text)}`);
      }
      text = lines.join("\n");
      facts.push(lines.length ? `The conversation in ${where}, last 7 days:\n${text.slice(-12000)}` : `Nothing said in ${where} in the last 7 days.`);
    } catch (caught) {
      problems.push(`conversation: ${caught.message}`);
    }
    // Only my tickets: those mentioned there that I own (any status), with their PRs and sessions.
    let mine = [];
    let prs = new Map();
    let sessions = new Map();
    if (notion().canReadTickets()) {
      const prefix = notion().ticketPrefix();
      try {
        const owned = new Map((await notion().myTickets(ALL_STATUSES)).map((t) => [t.id, t]));
        mine = ticketsIn(text, prefix).filter((id) => owned.has(id)).map((id) => owned.get(id)).slice(-8);
      } catch (caught) {
        problems.push(`tickets: ${caught.message}`);
      }
      if (mine.length) {
        facts.push(`My tickets mentioned there, now:\n${mine.map((t) => `- ${t.id} ${t.title} — ${t.status}`).join("\n")}`);
        [prs, sessions] = await Promise.all([prsByTicket(prefix).catch(() => new Map()), Promise.resolve().then(() => sessionsByTicket(prefix)).catch(() => new Map())]);
      }
    }
    const last = lastRecording(where);
    if (last) facts.push(last);
    const summary = await write(
      `Before (or during) a call in ${where}: from these facts only, a brief in Markdown, at most 8 short bullets: what's open between us, ` +
        "decisions or answers pending, what I should raise. Of tickets, only mine (the ones listed as mine), by ticket ID exactly as given. Nothing invented.",
      facts,
      problems,
      `Brief: ${where}`,
    );
    const urls = new Map(mine.filter((t) => t.url).map((t) => [t.id, t.url]));
    const lines = mine.map((t) => ticketLine(t, { where: t.status, prs: prs.get(t.id), sessions: sessions.get(t.id) }));
    return `${linkTickets(summary, urls)}${lines.length ? `\n\n**My tickets**\n${lines.join("\n")}` : ""}`;
  }
  const ALL_STATUSES = ["Future Work", "In Backlog", "In Planning/Refinement", "In progress", "Blocked", "Code Review Pending", "Deployed (Dev)", "Deployed(UAT)", "Acceptance Testing", "Accepted (Done)", "No Action: Superseded", "No Action: Other", "No Action: Redundant"];

  /** Claude's brief from the facts (the fast model), or the facts themselves when it can't. */
  async function write(instructions, facts, problems, title) {
    const note = problems.length ? `\n\n_Not included: ${problems.join("; ")}._` : "";
    if (!facts.length) return `**${title}**\n\nNothing to go on.${note}`;
    try {
      const text = await ai().ask({ prompt: `${instructions}\n\n${facts.join("\n\n")}`, fast: true, timeoutMs: 90000 });
      log(`brief: ${title} (${facts.length} facts${problems.length ? `, ${problems.length} missing` : ""})`);
      return `**${title}**\n\n${text}${note}`;
    } catch (caught) {
      warn(`brief: Claude couldn't write it (${caught.message}); the facts instead`);
      return `**${title}**\n\n${facts.join("\n\n")}${note}`;
    }
  }

  /** The brief for a huddle in `where`: the standup's, or a call's. */
  exports.forCall = ({ where, teamId }) => (isStandup(where) ? standupBrief(teamId) : callBrief(where, teamId));
  exports.standup = ({ teamId }) => standupBrief(teamId);
  exports.isStandup = isStandup;
  exports.releases = releases;
  exports.previousWorkingDay = previousWorkingDay;
});
