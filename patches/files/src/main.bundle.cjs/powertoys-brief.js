// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): a brief before (or during) a call, from the "Brief" chip in a huddle window.
//
//   - The daily standup (a huddle in standup.channel, "engineering", on a weekday from 30 minutes before standup.time,
//     "10:00", to an hour after): what was released since the previous working day that is yours (Alfred's posts in
//     standup.releaseChannel, the lines "… [ISS-n] by @<standup.githubUser>"), and your tickets in progress (Notion,
//     read as you), in a few lines for "What are you working on? Are you blocked? When do you expect to be done?".
//   - Any other call: the conversation with that person or channel lately, the tickets mentioned there (their status
//     now), and the last recording with them; what to raise.
// Claude (the fast model) writes it from those facts only; without Claude, the facts themselves.
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

  /** Alfred's release posts since `since` -> [{ env, version, at, items: [{ text, ticket, author }] }]. */
  async function releases(team, since) {
    const { releaseChannel } = settings();
    if (!releaseChannel) throw new Error("standup.releaseChannel isn't set");
    const page = slackPage();
    const history = await api(page, team, "conversations.history", { channel: releaseChannel, oldest: String(since.getTime() / 1000), limit: 200 });
    if (!history.ok) throw new Error(`the release channel couldn't be read (${history.error})`);
    const found = [];
    for (const message of history.messages ?? []) {
      const text = String(message.text ?? "");
      const published = /(release_(prod|uat)_v[\d.]+) published to (PROD|UAT)/i.exec(text);
      if (!published) continue;
      const items = [...text.matchAll(/[•*]\s*([^\n•]+?)\s*(?:\[([A-Z]+-\d+)\])?\s+by @([\w-]+)/g)].map((match) => ({ text: match[1].trim(), ticket: match[2] ?? null, author: match[3] }));
      found.push({ env: published[3].toUpperCase(), version: published[1], at: new Date(Number(message.ts) * 1000), items });
    }
    return found.sort((a, b) => a.at - b.at);
  }

  async function standupBrief(teamId) {
    const { githubUser } = settings();
    const since = previousWorkingDay();
    const facts = [];
    const problems = [];
    const team = await teamOf(teamId);
    try {
      const mine = (await releases(team, since)).map((release) => ({ ...release, items: release.items.filter((item) => !githubUser || item.author === githubUser) })).filter((release) => release.items.length);
      facts.push(
        mine.length
          ? `Released since ${since.toDateString()} (mine):\n${mine.map((release) => `- ${release.env} ${release.version} (${release.at.toLocaleString()}): ${release.items.map((item) => `${item.ticket ? `${item.ticket} ` : ""}${item.text}`).join("; ")}`).join("\n")}`
          : `Nothing of mine released since ${since.toDateString()}.`,
      );
    } catch (caught) {
      problems.push(`releases: ${caught.message}`);
    }
    try {
      const tickets = await notion().myTickets();
      facts.push(tickets.length ? `My tickets in flight:\n${tickets.map((t) => `- ${t.id} ${t.title} — ${t.status}`).join("\n")}` : "No tickets of mine in flight.");
    } catch (caught) {
      problems.push(`tickets: ${caught.message}`);
    }
    return write(
      "Write my standup update from these facts only, in Markdown, short: **Yesterday** (what shipped, by ticket), **Today** (what I'm working on), " +
        "**Blocked** (only if a fact says so; else \"No\"), **Done by** (only from the facts; else leave it out). Ticket IDs as they are. Nothing invented.",
      facts,
      problems,
      "Standup",
    );
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
    if (notion().canReadTickets()) {
      const prefix = notion().ticketPrefix();
      const ids = [...new Set([...text.matchAll(new RegExp(`\\b${prefix}-\\d+\\b`, "g"))].map((match) => match[0]))].slice(-8);
      const tickets = (await Promise.all(ids.map((id) => notion().ticket(id).catch(() => null)))).filter(Boolean);
      if (tickets.length) facts.push(`Tickets mentioned there, now:\n${tickets.map((t) => `- ${t.id} ${t.title} — ${t.status}`).join("\n")}`);
    }
    const last = lastRecording(where);
    if (last) facts.push(last);
    return write(
      `Before (or during) a call in ${where}: from these facts only, a brief in Markdown, at most 8 short bullets: what's open between us, ` +
        "decisions or answers pending, the tickets involved and their status, what I should raise. Ticket IDs as they are. Nothing invented.",
      facts,
      problems,
      `Brief: ${where}`,
    );
  }

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
