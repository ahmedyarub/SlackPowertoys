// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): Notion tickets and Claude Code sessions next to Slack messages.
//
//   ticket-info        a ticket ID in a message ("ISS-1780") -> its title, status and link (Notion, read as you)
//   thread-tickets     the tickets a thread is about: the IDs it mentions, else the one of yours Claude picks from it,
//                      with a one-line comment to add; link-ticket adds it to the ticket you chose (only then)
//   thread-sessions    the Claude Code sessions threads started (Make this a Claude Code task, Create an issue,
//                      Share video with Claude): each thread's session, its title and whether it is working now
//   ticket-changes     your tickets whose status changed since the last day seen (a snapshot a day, in
//                      powertoys\tickets-snapshot.json), and the ones in flight, for the panel's Digest tab
// ---------------------------------------------------------------------------------------------
(function (module, exports, __webpack_require__) {
  "use strict";

  const electron = __webpack_require__(84157);
  const fs = __webpack_require__(79896);
  const path = __webpack_require__(16928);
  const { log, warn, powertoysDir } = __webpack_require__("powertoys/main");
  const notion = () => __webpack_require__("powertoys/notion");
  const claude = () => __webpack_require__("powertoys/claude");
  const ai = () => __webpack_require__("powertoys/ai");

  const readJson = (file, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return fallback;
    }
  };
  const writeJson = (file, value) => {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  };
  /** A message link's identity (channel and timestamp digits), whatever its host or query. */
  const messageKey = (link) => /\/archives\/([A-Z0-9]+)\/p(\d+)/.exec(String(link))?.slice(1).join(":") ?? null;

  // --- Ticket IDs in messages ------------------------------------------------------------------------------
  async function ticketInfo({ id }) {
    if (!notion().canReadTickets()) return null;
    return notion().ticket(id);
  }

  // --- Thread -> ticket ------------------------------------------------------------------------------------
  /** The tickets a thread is about, and the comment that would be added -> { tickets, comment, conversation }. */
  async function threadTickets({ link }) {
    const thread = await claude().readThread({ link, limit: 100 });
    const text = thread.messages.map((m) => `${m.author}: ${m.text}`).join("\n");
    const prefix = notion().ticketPrefix();
    const mentioned = [...new Set([...text.matchAll(new RegExp(`\\b${prefix}-\\d+\\b`, "g"))].map((match) => match[0]))];
    let tickets = (await Promise.all(mentioned.map((id) => notion().ticket(id).catch(() => null)))).filter(Boolean);
    let summary = "";
    const mine = tickets.length ? [] : await notion().myTickets().catch(() => []);
    const answer = await ai()
      .ask({
        fast: true,
        json: true,
        prompt:
          `A Slack thread in ${thread.conversation}:\n${text.slice(0, 20000)}\n\n` +
          (tickets.length
            ? ""
            : `Which of these tickets is it about? Answer null if none clearly is.\n${mine.map((t) => `${t.id} ${t.title} (${t.status})`).join("\n")}\n\n`) +
          'Answer as JSON: {"ticket": "ISS-…" or null, "summary": one line (under 200 characters) on what the thread says, for a comment on the ticket}',
      })
      .catch((caught) => (warn(`thread tickets: ${caught.message}`), {}));
    summary = String(answer.summary ?? "").slice(0, 300);
    if (!tickets.length && answer.ticket) tickets = mine.filter((t) => t.id === answer.ticket);
    return { tickets, conversation: thread.conversation, comment: `Slack thread in ${thread.conversation}: ${link}${summary ? ` — ${summary}` : ""}` };
  }

  async function linkTicket({ url, comment }) {
    if (!url || !comment) throw new Error("no ticket or comment");
    await notion().comment(url, comment);
    log(`thread linked to a ticket: ${url}`);
    return { ok: true };
  }

  // --- Threads' Claude Code sessions ------------------------------------------------------------------------
  const threadsFile = () => path.join(powertoysDir(), "thread-sessions.json");
  /** A thread started a Claude Code session in `folder` (its prompt has the link): remembered for its chip. */
  exports.rememberThreadSession = ({ link, folder, kind }) => {
    if (!folder || !messageKey(link)) return;
    const all = readJson(threadsFile(), []).filter((each) => Date.now() - each.at < 14 * 86400e3);
    all.push({ link, key: messageKey(link), folder, kind, at: Date.now() });
    writeJson(threadsFile(), all);
  };

  /** The session a thread started: the folder's session made just after, whose first prompt has the thread's link. */
  function sessionOf(record) {
    const sessions = __webpack_require__("powertoys/huddle").projectSessions(record.folder);
    const project = record.folder.replace(/[:\\/.]/g, "-");
    for (const session of sessions) {
      const file = path.join(process.env.USERPROFILE ?? "", ".claude", "projects", project, `${session.id}.jsonl`);
      if (!fs.existsSync(file) || fs.statSync(file).birthtimeMs < record.at - 10000) continue;
      const fd = fs.openSync(file, "r");
      try {
        const head = Buffer.alloc(64 * 1024);
        const read = fs.readSync(fd, head, 0, head.length, 0);
        const [channel, digits] = record.key.split(":");
        const text = head.toString("utf8", 0, read);
        if (text.includes(`${channel}/p${digits}`)) return { ...session, working: Date.now() - fs.statSync(file).mtimeMs < 20000 };
      } finally {
        fs.closeSync(fd);
      }
    }
    return null;
  }

  /** The threads with a session -> { "<channel>:<digits>": { title, working, kind } }. */
  function threadSessions() {
    const found = {};
    for (const record of readJson(threadsFile(), [])) {
      try {
        const session = sessionOf(record);
        if (session) found[record.key] = { title: session.title, working: session.working, kind: record.kind };
      } catch (caught) {
        warn(`thread sessions: ${caught.message}`);
      }
    }
    return found;
  }

  // --- Your tickets' changes -----------------------------------------------------------------------------
  const ALL = ["Future Work", "In Backlog", "In Planning/Refinement", "In progress", "Blocked", "No Action: Superseded", "No Action: Other", "No Action: Redundant", "Code Review Pending", "Deployed (Dev)", "Deployed(UAT)", "Acceptance Testing", "Accepted (Done)"];
  async function ticketChanges() {
    if (!notion().canReadTickets()) return { setup: true };
    const tickets = await notion().myTickets(ALL);
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(powertoysDir(), "tickets-snapshot.json");
    let snapshot = readJson(file, null);
    const current = Object.fromEntries(tickets.map((t) => [t.id, t.status]));
    if (!snapshot || snapshot.date !== today) {
      snapshot = { date: today, statuses: current, previous: snapshot ? { date: snapshot.date, statuses: snapshot.statuses } : null };
      writeJson(file, snapshot);
    }
    const before = snapshot.previous?.statuses ?? {};
    const changes = snapshot.previous ? tickets.filter((t) => before[t.id] !== t.status).map((t) => ({ ...t, from: before[t.id] ?? "(new)" })) : [];
    const active = new Set(notion().activeStatuses?.() ?? ["In progress", "Blocked", "Code Review Pending", "Deployed (Dev)", "Deployed(UAT)", "Acceptance Testing"]);
    return { since: snapshot.previous?.date ?? null, changes, inFlight: tickets.filter((t) => active.has(t.status)) };
  }

  exports.start = function start() {
    const handlers = {
      "ticket-info": ticketInfo,
      "thread-tickets": threadTickets,
      "link-ticket": linkTicket,
      "thread-sessions": () => threadSessions(),
      "ticket-changes": () => ticketChanges(),
      standup: ({ teamId }) => __webpack_require__("powertoys/brief").standup({ teamId }),
    };
    for (const [name, handler] of Object.entries(handlers)) electron.ipcMain.handle(`powertoys:${name}`, (event, request) => handler(request ?? {}));
  };
});
