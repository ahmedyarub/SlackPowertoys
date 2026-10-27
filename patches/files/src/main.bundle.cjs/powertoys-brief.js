// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): a brief before (or during) a call, from the "Brief" chip in a huddle window.
//
//   - The daily standup (a huddle in standup.channel, "engineering", on a weekday from 30 minutes before standup.time,
//     "10:00", to an hour after): what was released since the previous working day that is yours (Alfred's posts in
//     standup.releaseChannel, the lines "… [ISS-n] by @<standup.githubUser>"; its evening release often comes after
//     midnight), and your tickets (Notion, read as you): working on (In progress, Blocked, Code Review Pending), and
//     waiting on a deploy or testing, in a few lines for "What are you working on? Are you blocked? Done when?".
//   - Any other call: the conversation with that person or channel lately, your tickets mentioned there (their status
//     now), and the last recording with them; what to raise.
// Only your tickets. Claude (the fast model) writes it from those facts only (without Claude, the facts themselves);
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
    return now - start >= -30 * 60e3 && now - start <= 60 * 60e3;
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
  const execFile = (command, args) =>
    new Promise((resolve, reject) =>
      __webpack_require__(35317).execFile(command, args, { windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024 }, (caught, stdout, stderr) =>
        caught ? reject(new Error(String(stderr || caught.message).trim().split("\n").pop())) : resolve(String(stdout)),
      ),
    );
  const ticketsIn = (text, prefix) => [...new Set([...String(text).matchAll(new RegExp(`\\b${prefix}-(\\d+)\\b`, "gi"))].map((match) => `${prefix}-${match[1]}`))];

  /** Your PRs (gh, the repositories in dev.repos), by the tickets in their titles and branches -> Map(id -> [pr]). */
  async function prsByTicket(prefix) {
    const byTicket = new Map();
    for (const repo of Object.keys(readSettings().dev?.repos ?? {})) {
      let prs = [];
      try {
        prs = JSON.parse(await execFile("gh", ["pr", "list", "-R", repo, "--author", "@me", "--state", "all", "--limit", "100", "--json", "number,title,url,state,headRefName,updatedAt"]));
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

  async function standupBrief(teamId) {
    const { githubUser } = settings();
    const prefix = notion().ticketPrefix();
    const since = previousWorkingDay();
    const facts = [];
    const problems = [];
    const team = await teamOf(teamId);
    const [prs, sessions] = await Promise.all([prsByTicket(prefix).catch(() => new Map()), Promise.resolve().then(() => sessionsByTicket(prefix)).catch(() => new Map())]);
    // What of mine was released since the previous working day (its evening release often comes after midnight).
    let shipped = [];
    try {
      const mine = (await releases(team, since)).flatMap((release) => release.items.filter((item) => item.author === githubUser).map((item) => ({ ...item, env: release.env, version: release.version, at: release.at })));
      if (!githubUser) problems.push("releases: standup.githubUser isn't set");
      // A ticket released to UAT and then PROD shows once, where it went last.
      const byKey = new Map();
      for (const item of mine) byKey.set(item.ticket ?? item.text, item);
      shipped = [...byKey.values()];
    } catch (caught) {
      problems.push(`releases: ${caught.message}`);
    }
    let inFlight = [];
    try {
      inFlight = await notion().myTickets();
    } catch (caught) {
      problems.push(`tickets: ${caught.message}`);
    }
    const shippedTickets = await Promise.all(
      shipped.map(async (item) => ({ item, ticket: (item.ticket && (await notion().ticket(item.ticket).catch(() => null))) || { id: item.ticket ?? "(no ticket)", title: item.text, url: null } })),
    );
    const urls = new Map([...inFlight, ...shippedTickets.map((each) => each.ticket)].filter((t) => t.url).map((t) => [t.id, t.url]));
    facts.push(
      shippedTickets.length
        ? `Released since ${since.toDateString()} (mine):\n${shippedTickets.map(({ item, ticket }) => `- ${ticket.id} ${ticket.title} (${item.env} ${item.version}, ${item.at.toLocaleString()})`).join("\n")}`
        : `Nothing of mine released since ${since.toDateString()}.`,
    );
    const released = new Set(shippedTickets.map(({ ticket }) => ticket.id));
    const stillInFlight = inFlight.filter((t) => !released.has(t.id) || !/Deployed|Accept/.test(t.status));
    // What I'm working on (it is "Today"), and what only waits on a deploy or on testing.
    const working = stillInFlight.filter((t) => /In progress|Blocked|Code Review/i.test(t.status));
    const waiting = stillInFlight.filter((t) => !working.includes(t));
    const listed = (tickets) => tickets.map((t) => `- ${t.id} ${t.title} — ${t.status}${prs.get(t.id)?.some((pr) => pr.state === "OPEN") ? " (PR open)" : ""}`).join("\n");
    facts.push(working.length ? `My tickets I'm working on:\n${listed(working)}` : "No ticket of mine in progress, blocked or in code review.");
    if (waiting.length) facts.push(`My tickets waiting on a deploy or on testing:\n${listed(waiting)}`);
    const summary = await write(
      "Write my standup update from these facts only, in Markdown, short, only about these tickets of mine: **Yesterday** (what shipped, by ticket ID), " +
        "**Today** (the tickets I'm working on, by ticket ID; not the ones only waiting on a deploy or testing), **Blocked** (only if a fact says so; else \"No\"), **Done by** (only from the facts; else leave it out). " +
        "Ticket IDs exactly as given. Nothing invented.",
      facts,
      problems,
      "Standup",
    );
    const lines = [
      ...(shippedTickets.length ? ["**Shipped**", ...shippedTickets.map(({ item, ticket }) => ticketLine(ticket, { where: `${item.env} ${item.version}`, prs: item.pr ? [{ number: /\/pull\/(\d+)/.exec(item.pr)?.[1] ?? "PR", url: item.pr, state: "MERGED" }] : prs.get(ticket.id) ?? [], sessions: sessions.get(ticket.id) }))] : []),
      ...(working.length ? ["**Working on**", ...working.map((t) => ticketLine(t, { where: t.status, prs: prs.get(t.id), sessions: sessions.get(t.id) }))] : []),
      ...(waiting.length ? ["**Waiting on deploy or testing**", ...waiting.map((t) => ticketLine(t, { where: t.status, prs: prs.get(t.id), sessions: sessions.get(t.id) }))] : []),
    ];
    return `${linkTickets(summary, urls)}${lines.length ? `\n\n${lines.join("\n")}` : ""}`;
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
