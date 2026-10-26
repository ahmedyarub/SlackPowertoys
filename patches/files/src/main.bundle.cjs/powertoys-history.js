// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): copies of edited and deleted messages.
//
// The page (powertoys/page-history) sees each edit and deletion as it arrives on Slack's live connection, with the
// message as it was, and hands it here. Each copy is appended to powertoys\history\messages.jsonl (one JSON object a
// line; the file is only ever appended to, and synced to disk) before the page marks the message:
//   { kind: "edited" | "deleted", at, teamId, channel, where, ts, threadTs, user, who, text (as it was),
//     after (an edit's new text), editedTs, files, link, was (the message as Slack sent it), now (an edit's new message) }
// IPC: powertoys:history-add (a copy from the page), powertoys:history-list (the copies, newest first).
// ---------------------------------------------------------------------------------------------
(function (module, exports, __webpack_require__) {
  "use strict";

  const electron = __webpack_require__(84157);
  const fs = __webpack_require__(79896);
  const path = __webpack_require__(16928);
  const { log, warn, slackPage, signedInTeams, api, powertoysDir } = __webpack_require__("powertoys/main");

  const historyFile = () => path.join(powertoysDir(), "history", "messages.jsonl");
  const keyOf = (record) => `${record.kind}:${record.channel}:${record.ts}:${record.editedTs ?? ""}`;

  /** What the page needs of a copy (the stored one also keeps Slack's message objects). */
  const slim = ({ kind, at, channel, where, ts, threadTs, who, text, after, editedTs, link }) => ({ kind, at, channel, where, ts, threadTs, who, text, after, editedTs, link });

  function readAll() {
    let lines;
    try {
      lines = fs.readFileSync(historyFile(), "utf8").split("\n");
    } catch (caught) {
      if (caught.code === "ENOENT") return [];
      throw caught;
    }
    const records = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        warn(`history: an unreadable line in ${historyFile()}`);
      }
    }
    return records;
  }

  let keys = null;
  function append(record) {
    fs.mkdirSync(path.dirname(historyFile()), { recursive: true });
    const fd = fs.openSync(historyFile(), "a");
    try {
      fs.writeSync(fd, `${JSON.stringify(record)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  // The workspace whose token can read the channel (the message's own team first); remembered per channel.
  const teams = new Map();
  async function teamFor(page, teamHint, channel) {
    if (!teams.has(channel)) {
      teams.set(
        channel,
        (async () => {
          const signedIn = await signedInTeams(page);
          for (const team of [...signedIn.filter((t) => t.id === teamHint), ...signedIn.filter((t) => t.id !== teamHint)]) {
            if ((await api(page, team, "conversations.info", { channel }).catch(() => null))?.ok) return team;
          }
          return null;
        })().catch((caught) => (teams.delete(channel), Promise.reject(caught))),
      );
    }
    return teams.get(channel);
  }

  /** Names, plain text and a link for a copy; whatever is known within 4 seconds (the copy is saved either way). */
  async function describe(copy, was, now) {
    const claude = __webpack_require__("powertoys/claude");
    const page = slackPage();
    if (!page) return {};
    const work = (async () => {
      const team = await teamFor(page, was.team ?? now?.team, copy.channel);
      if (!team) return {};
      const [where, who, text, after] = await Promise.all([
        claude.conversationName(page, team, copy.channel),
        was.user ? claude.userName(page, team, was.user) : null,
        claude.plainText(page, team, was.text ?? ""),
        now ? claude.plainText(page, team, now.text ?? "") : undefined,
      ]);
      return { teamId: team.id, where, who, text, after, link: claude.permalink(team, copy.channel, copy.ts, was.thread_ts) };
    })();
    const late = new Promise((resolve) => setTimeout(() => resolve({ late: true }), 4000));
    const found = await Promise.race([work, late]).catch((caught) => ({ failed: caught.message }));
    if (found.late || found.failed) warn(`history: names for ${copy.channel}/${copy.ts}: ${found.failed ?? "no answer within 4 s"}`);
    return found.late || found.failed ? {} : found;
  }

  /** Saves a copy the page saw: { kind, channel, ts, message (as it was; for an edit, the new one), previous }. */
  async function add({ kind, channel, ts, message, previous }) {
    if (!["edited", "deleted"].includes(kind) || !channel || !ts || !message || (kind === "edited" && !previous)) throw new Error("not a copy of a message");
    const was = kind === "edited" ? previous : message;
    const now = kind === "edited" ? message : null;
    keys ??= new Set(readAll().map(keyOf));
    const draft = { kind, channel, ts, editedTs: now?.edited?.ts ?? null };
    if (keys.has(keyOf(draft))) return { ...slim(readAll().find((each) => keyOf(each) === keyOf(draft)) ?? draft), duplicate: true };
    keys.add(keyOf(draft));
    const described = await describe(draft, was, now);
    const record = {
      ...draft,
      at: new Date().toISOString(),
      teamId: described.teamId ?? was.team ?? null,
      where: described.where ?? channel,
      threadTs: was.thread_ts ?? null,
      user: was.user ?? null,
      who: described.who ?? was.user_profile?.real_name ?? was.username ?? was.user ?? was.bot_id ?? null,
      text: described.text ?? was.text ?? "",
      after: now ? (described.after ?? now.text ?? "") : undefined,
      files: (was.files ?? []).map((file) => file.name ?? file.title ?? file.id),
      link: described.link ?? null,
      was,
      now: now ?? undefined,
    };
    try {
      append(record);
    } catch (caught) {
      keys.delete(keyOf(draft));
      throw caught;
    }
    log(`history: kept a copy of ${kind === "edited" ? "an edited" : "a deleted"} message in ${record.where}`);
    return slim(record);
  }

  /** The copies, newest first: all of them, or the latest `limit`. */
  function list({ limit } = {}) {
    const records = readAll().reverse().map(slim);
    return limit ? records.slice(0, limit) : records;
  }

  exports.start = function start() {
    electron.ipcMain.handle("powertoys:history-add", (event, copy) => add(copy ?? {}));
    electron.ipcMain.handle("powertoys:history-list", (event, request) => list(request ?? {}));
  };
});
