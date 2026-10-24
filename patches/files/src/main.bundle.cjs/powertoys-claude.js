// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): Slack and Claude.
//
// Started by powertoys/main's start(). It
//   - serves Slack to Claude: a bridge on 127.0.0.1 (a random port and a bearer token, both in
//     %APPDATA%\Slack\powertoys\bridge.json while Slack runs) for mcp/slack-powertoys.mjs, the MCP server Claude
//     Desktop runs. It reads clip and huddle transcripts, threads, unreads, search results, saved items, drafts and your
//     own messages; it writes only drafts (never sends) and, for Claude Code's hooks, Slackbot reminders to you and your
//     status;
//   - opens Claude from Slack: "Ask Claude" starts a chat, or a Claude Code session in the folder linked to the
//     workspace (claude://code/new?folder=&q=, claude://claude.ai/new?q=);
//   - offers a summary when a huddle you were in ends with a transcript;
//   - asks Slack to transcribe each video or audio file posted (what "Generate transcript" does), so it is there.
// Settings (settings.json): "bridge" (default true) and "claude":
//   { "folders": { "<team id>": "<folder>" }, "huddleSummaries": true, "autoTranscripts": true,
//     "codeNotify": { "minMinutes": 5, "status": false, "workspace": null } }
// ---------------------------------------------------------------------------------------------
(function (module, exports, __webpack_require__) {
  "use strict";

  const electron = __webpack_require__(84157);
  const fs = __webpack_require__(79896);
  const path = __webpack_require__(16928);
  const http = __webpack_require__(58611);
  const crypto = __webpack_require__(76982);
  const { log, warn, api, slackPage, signedInTeams, readSettings, updateSettings, powertoysDir } = __webpack_require__("powertoys/main");

  const DEFAULTS = { folders: {}, huddleSummaries: true, autoTranscripts: true, codeNotify: { minMinutes: 5, status: false, workspace: null } };
  function settings() {
    const claude = readSettings().claude ?? {};
    return { ...DEFAULTS, ...claude, codeNotify: { ...DEFAULTS.codeNotify, ...claude.codeNotify } };
  }

  function requirePage() {
    const page = slackPage();
    if (!page) throw new Error("Slack's page is not open");
    return page;
  }

  async function inOrder(items, each) {
    const results = [];
    for (const item of items) results.push(await each(item));
    return results;
  }

  const isOrg = (team) => /\.enterprise\.slack\.com/.test(team.url);

  /** The signed-in workspaces matching a name or id (all of them when none is given). */
  async function teamsMatching(page, workspace) {
    const teams = await signedInTeams(page);
    if (!workspace) return teams;
    const wanted = workspace.toLowerCase();
    const matching = teams.filter((team) => team.id.toLowerCase() === wanted || team.name.toLowerCase().includes(wanted));
    if (!matching.length) throw new Error(`no signed-in workspace matches "${workspace}"`);
    return matching;
  }

  /** The workspaces to ask for a link, best first: those at the link's address, then the rest. */
  function teamsInOrder(teams, host) {
    if (!host) return teams;
    const matches = (team) => new URL(team.url).hostname === host;
    return [...teams.filter(matches), ...teams.filter((team) => !matches(team))];
  }

  /** A Slack reference: a file id (F...), a huddle id (R...), a channel id, or a link to a file, a message or a channel. */
  function parseRef(ref) {
    ref = String(ref ?? "").trim();
    if (/^F[A-Z0-9]{6,}$/.test(ref)) return { file: ref };
    if (/^R[A-Z0-9]{6,}$/.test(ref)) return { huddle: ref };
    if (/^[CDG][A-Z0-9]{6,}$/.test(ref)) return { channel: ref };
    let url;
    try {
      url = new URL(ref);
    } catch {
      throw new Error("expected a Slack link or id");
    }
    const file = /\/files\/[^/]+\/(F[A-Z0-9]+)/.exec(url.pathname)?.[1];
    if (file) return { file, host: url.hostname };
    const message = /\/archives\/([A-Z0-9]+)(?:\/p(\d{10})(\d{6}))?/.exec(url.pathname);
    if (message) {
      const ts = message[2] && `${message[2]}.${message[3]}`;
      return { host: url.hostname, channel: message[1], ts, threadTs: url.searchParams.get("thread_ts") ?? undefined };
    }
    throw new Error("that is not a link to a Slack message, channel or file");
  }

  const permalink = (team, channel, ts, threadTs) =>
    `${team.url}archives/${channel}${ts ? `/p${ts.replace(".", "")}` : ""}${threadTs && threadTs !== ts ? `?thread_ts=${threadTs}&cid=${channel}` : ""}`;
  const isoTime = (seconds) => new Date(Number(seconds) * 1000).toISOString();
  const isClip = (file) => /^(video|audio)\//.test(file.mimetype ?? "");

  // --- Names (cached for the session) ----------------------------------------------------------------------
  const cache = new Map();
  function cached(key, load) {
    if (!cache.has(key)) cache.set(key, load().catch((caught) => (cache.delete(key), Promise.reject(caught))));
    return cache.get(key);
  }

  function userName(page, team, userId) {
    if (!userId) return Promise.resolve(null);
    return cached(`user:${team.id}:${userId}`, async () => {
      const result = await api(page, team, "users.info", { user: userId });
      return result.user?.real_name || result.user?.profile?.display_name || result.user?.name || userId;
    });
  }

  function conversationName(page, team, channelId) {
    return cached(`conversation:${team.id}:${channelId}`, async () => {
      const { channel } = await api(page, team, "conversations.info", { channel: channelId });
      if (!channel) return channelId;
      if (channel.is_im) return `@${await userName(page, team, channel.user)}`;
      return channel.is_mpim ? channel.purpose?.value || channel.name : `#${channel.name}`;
    });
  }

  function self(page, team) {
    return cached(`self:${team.id}`, async () => {
      const result = await api(page, team, "auth.test");
      if (!result.ok) throw new Error(`auth.test: ${result.error}`);
      return { userId: result.user_id };
    });
  }

  /** Slack's message markup as plain text: names for mentions, "label (url)" for links. */
  async function plainText(page, team, text = "") {
    const names = new Map();
    for (const [, id] of text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) names.set(id, await userName(page, team, id));
    return text
      .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => `@${names.get(id)}`)
      .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, "#$1")
      .replace(/<!subteam\^[A-Z0-9]+\|?([^>]*)>/g, "$1")
      .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
      .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
      .replace(/<(https?:[^>]+)>/g, "$1")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }

  /** The text of rich-text blocks (drafts keep their text only in blocks). */
  function blocksText(blocks = []) {
    const walk = (element) => {
      if (!element || typeof element !== "object") return "";
      switch (element.type) {
        case "text":
          return element.text ?? "";
        case "link":
          return element.text ? `${element.text} (${element.url})` : element.url;
        case "emoji":
          return `:${element.name}:`;
        case "user":
          return `<@${element.user_id}>`;
        case "channel":
          return `<#${element.channel_id}>`;
        case "rich_text_list":
          return (element.elements ?? []).map((item) => `- ${walk(item)}`).join("\n") + "\n";
        default:
          return (element.elements ?? []).map(walk).join(element.type === "rich_text" ? "\n" : "");
      }
    };
    return blocks.map(walk).join("\n").trim();
  }

  async function describeMessage(page, team, channel, message) {
    return {
      time: isoTime(message.ts),
      author: (await userName(page, team, message.user)) ?? message.username ?? message.bot_profile?.name ?? "unknown",
      text: await plainText(page, team, message.text || blocksText(message.blocks)),
      files: (message.files ?? []).map((file) => ({
        id: file.id,
        name: file.title || file.name,
        type: isClip(file) ? "clip" : file.pretty_type || file.filetype,
        mimetype: file.mimetype,
      })),
      replies: message.reply_count || undefined,
      huddle: message.subtype === "huddle_thread" ? message.room?.id : undefined,
      link: permalink(team, channel, message.ts, message.thread_ts),
    };
  }

  // --- Reading ---------------------------------------------------------------------------------------------
  /** A message with its whole thread, or a channel's latest messages. */
  async function readThread({ link, limit = 50 }) {
    const page = requirePage();
    const ref = parseRef(link);
    if (!ref.channel) throw new Error("expected a link to a Slack message or channel");
    let lastError = "channel_not_found";
    for (const team of teamsInOrder(await signedInTeams(page), ref.host)) {
      const result = ref.ts
        ? await api(page, team, "conversations.replies", { channel: ref.channel, ts: ref.threadTs ?? ref.ts, limit: 1000 })
        : await api(page, team, "conversations.history", { channel: ref.channel, limit });
      if (!result.ok) {
        lastError = result.error;
        continue;
      }
      const messages = ref.ts ? result.messages : result.messages.reverse();
      return {
        workspace: team.name,
        conversation: await conversationName(page, team, ref.channel),
        messages: await inOrder(messages, (message) => describeMessage(page, team, ref.channel, message)),
      };
    }
    throw new Error(`the conversation could not be read (${lastError})`);
  }

  /** What is unread: conversations with unread messages (mentions first) and their unread messages. */
  async function unreads({ workspace, conversations = 25, perConversation = 15 }) {
    const page = requirePage();
    const workspaces = [];
    for (const team of await teamsMatching(page, workspace)) {
      const counts = await api(page, team, "client.counts");
      if (!counts.ok) {
        if (counts.error !== "team_is_restricted") warn(`unreads: ${team.id}: ${counts.error}`);
        continue;
      }
      const unread = [...(counts.channels ?? []), ...(counts.ims ?? []), ...(counts.mpims ?? [])]
        .filter((each) => each.has_unreads)
        .sort((x, y) => y.mention_count - x.mention_count || Number(y.latest) - Number(x.latest))
        .slice(0, conversations);
      workspaces.push({
        workspace: team.name,
        unreadThreads: counts.threads?.has_unreads ?? false,
        threadMentions: counts.threads?.mention_count ?? 0,
        conversations: await inOrder(unread, async (each) => {
          // The newest messages, those after the last read one (with oldest set, Slack returns the oldest ones first).
          const history = await api(page, team, "conversations.history", { channel: each.id, limit: perConversation });
          const latest = history.messages ?? [];
          const unreadMessages = latest.filter((message) => Number(message.ts) > Number(each.last_read));
          return {
            conversation: await conversationName(page, team, each.id),
            mentions: each.mention_count,
            more: unreadMessages.length === latest.length && Boolean(history.has_more),
            link: permalink(team, each.id),
            messages: await inOrder(unreadMessages.reverse(), (message) => describeMessage(page, team, each.id, message)),
          };
        }),
      });
    }
    return { workspaces };
  }

  /** search.messages in each workspace (Slack's search syntax: from:, in:, before:, ...). */
  async function search({ query, workspace, count = 20, sort = "score" }) {
    if (!query) throw new Error("a search query is needed");
    const page = requirePage();
    const seen = new Map();
    for (const team of await teamsMatching(page, workspace)) {
      const result = await api(page, team, "search.messages", { query, count, sort, sort_dir: "desc" });
      if (!result.ok) {
        if (result.error !== "team_is_restricted") warn(`search: ${team.id}: ${result.error}`);
        continue;
      }
      for (const match of result.messages?.matches ?? []) {
        if (seen.has(match.permalink)) continue;
        const channel = match.channel ?? {};
        seen.set(match.permalink, {
          workspace: team.name,
          conversation: channel.is_im ? `@${await userName(page, team, channel.user ?? channel.name)}` : `#${channel.name}`,
          time: isoTime(match.ts),
          author: (await userName(page, team, match.user)) ?? match.username ?? "unknown",
          text: await plainText(page, team, match.text || blocksText(match.blocks)),
          link: match.permalink,
        });
      }
    }
    return { results: [...seen.values()].sort((x, y) => (sort === "timestamp" ? y.time.localeCompare(x.time) : 0)).slice(0, count) };
  }

  /** Your own latest messages (samples of how you write). */
  function myMessages({ workspace, count = 30, query = "" }) {
    return search({ query: `from:me ${query}`.trim(), workspace, count, sort: "timestamp" });
  }

  /** Saved items ("Later"): messages with their text, other kinds as Slack lists them. */
  async function savedItems({ workspace }) {
    const page = requirePage();
    const items = [];
    for (const team of await teamsMatching(page, workspace)) {
      const result = await api(page, team, "saved.list", { limit: 100 });
      if (!result.ok) {
        if (result.error !== "team_is_restricted") warn(`saved: ${team.id}: ${result.error}`);
        continue;
      }
      for (const item of result.saved_items ?? []) {
        const entry = { workspace: team.name, type: item.item_type, state: item.state, saved: isoTime(item.date_created), due: item.date_due ? isoTime(item.date_due) : null };
        if (item.item_type === "message") {
          const history = await api(page, team, "conversations.history", { channel: item.item_id, latest: item.ts, inclusive: true, limit: 1 });
          const message = history.messages?.find((each) => each.ts === item.ts);
          entry.conversation = await conversationName(page, team, item.item_id);
          entry.message = message ? await describeMessage(page, team, item.item_id, message) : { link: permalink(team, item.item_id, item.ts) };
        } else {
          entry.id = item.item_id;
          // A reminder's description is rich-text blocks.
          entry.description = Array.isArray(item.description) ? blocksText(item.description) : item.description;
        }
        items.push(entry);
      }
    }
    return { items };
  }

  /** Unsent drafts (and scheduled messages), with where they go. */
  async function drafts({ workspace }) {
    const page = requirePage();
    const items = [];
    for (const team of await teamsMatching(page, workspace)) {
      const result = await api(page, team, "drafts.list", { limit: 100, is_active: true });
      if (!result.ok) {
        if (result.error !== "team_is_restricted") warn(`drafts: ${team.id}: ${result.error}`);
        continue;
      }
      for (const draft of result.drafts ?? []) {
        if (draft.is_sent || draft.is_deleted) continue;
        const destination = draft.destinations?.[0] ?? {};
        items.push({
          workspace: team.name,
          conversation: destination.channel_id ? await conversationName(page, team, destination.channel_id) : null,
          inThread: Boolean(destination.thread_ts),
          updated: isoTime(draft.last_updated_ts),
          scheduled: draft.date_scheduled ? isoTime(draft.date_scheduled) : null,
          text: await plainText(page, team, blocksText(draft.blocks)),
          link: destination.channel_id ? permalink(team, destination.channel_id, destination.thread_ts) : null,
        });
      }
    }
    return { drafts: items };
  }

  // --- Clips and huddles -----------------------------------------------------------------------------------
  // A clip's transcript: files.info with include_transcription has transcription.status and transcription.lines.
  // A huddle's: huddles.get (or the huddle's thread) names its notes canvas (transcript_file_id); the canvas names the
  // transcript file (huddle_transcript_file_id), whose huddle_transcription.lines have a speaker each.

  async function describeClip(page, team, file) {
    return {
      id: file.id,
      title: file.title || file.name,
      kind: file.mimetype?.startsWith("audio/") ? "audio" : "video",
      created: isoTime(file.created),
      durationSeconds: file.duration_ms ? Math.round(file.duration_ms / 1000) : null,
      author: await userName(page, team, file.user),
      workspace: team.name,
      permalink: file.permalink,
      transcript: file.transcription?.status ?? null,
    };
  }

  async function clipTranscript(page, teams, fileId) {
    let lastError = "file_not_found";
    for (const team of teams) {
      const result = await api(page, team, "files.info", { file: fileId, include_transcription: true });
      if (!result.ok) {
        lastError = result.error;
        continue;
      }
      const transcription = result.file.transcription ?? {};
      return {
        ...(await describeClip(page, team, result.file)),
        locale: transcription.locale ?? null,
        lines: (transcription.lines ?? []).map((line) => ({ start: line.start_time_ms, end: line.end_time_ms, text: line.contents })),
      };
    }
    throw new Error(`clip ${fileId} could not be read (${lastError})`);
  }

  /** The clips a message link points to: the message's video and audio files. */
  async function clipsOfMessage(page, teams, { channel, ts, threadTs }) {
    let lastError = "message_not_found";
    for (const team of teams) {
      let result = await api(page, team, "conversations.history", { channel, latest: ts, inclusive: true, limit: 1 });
      let message = result.messages?.find((each) => each.ts === ts);
      if (!message && (result.ok || threadTs)) {
        // A reply in a thread is not in the channel's history.
        result = await api(page, team, "conversations.replies", { channel, ts: threadTs ?? ts, latest: ts, inclusive: true, limit: 1 });
        message = result.messages?.find((each) => each.ts === ts);
      }
      if (message) return (message.files ?? []).filter(isClip).map((file) => file.id);
      if (!result.ok) lastError = result.error;
    }
    throw new Error(`the message could not be read (${lastError})`);
  }

  async function clipTranscripts({ clip }) {
    const page = requirePage();
    const ref = parseRef(clip);
    if (!ref.file && !ref.ts) throw new Error("expected a link to a clip's message, a file link or a file id (F...)");
    const teams = teamsInOrder(await signedInTeams(page), ref.host);
    const files = ref.file ? [ref.file] : await clipsOfMessage(page, teams, ref);
    if (!files.length) throw new Error("that message has no video or audio clip");
    return { clips: await inOrder(files, (file) => clipTranscript(page, teams, file)) };
  }

  /** Asks Slack to transcribe a video or audio file (what its "Generate transcript" does) -> Slack's answer. */
  async function requestTranscript({ clip }) {
    const page = requirePage();
    const ref = parseRef(clip);
    if (!ref.file) throw new Error("expected a file link or a file id (F...)");
    let lastError = "file_not_found";
    for (const team of teamsInOrder(await signedInTeams(page), ref.host)) {
      const result = await api(page, team, "files.retranscribe", { file_id: ref.file, reason: "generate-transcript" });
      if (result.ok) return { file: ref.file, status: "requested" };
      lastError = result.error;
      if (result.error !== "file_not_found") break;
    }
    throw new Error(`Slack didn't start a transcript for ${ref.file} (${lastError})`);
  }

  /** A message's file (a clip's video, an image) saved as <to>.<its extension> -> the path. */
  async function saveFile({ file: fileId, host, to }) {
    const page = requirePage();
    let lastError = "file_not_found";
    for (const team of teamsInOrder(await signedInTeams(page), host)) {
      const result = await api(page, team, "files.info", { file: fileId });
      if (!result.ok) {
        lastError = result.error;
        continue;
      }
      const response = await page.session.fetch(result.file.url_private_download ?? result.file.url_private);
      if (!response.ok) throw new Error(`file ${fileId} could not be downloaded (HTTP ${response.status})`);
      const file = `${to}.${result.file.filetype || "bin"}`;
      fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
      return file;
    }
    throw new Error(`file ${fileId} could not be read (${lastError})`);
  }

  /** The newest clips (video and audio), newest first. */
  async function listClips({ workspace, limit = 20 }) {
    const page = requirePage();
    const seen = new Map();
    for (const team of await teamsMatching(page, workspace)) {
      const result = await api(page, team, "files.list", { count: 200 });
      if (!result.ok) {
        if (result.error !== "team_is_restricted") warn(`clips: ${team.id}: ${result.error}`);
        continue;
      }
      for (const file of result.files ?? []) if (isClip(file) && !seen.has(file.id)) seen.set(file.id, { team, file });
    }
    const newest = [...seen.values()].sort((x, y) => y.file.created - x.file.created).slice(0, limit);
    return { clips: await inOrder(newest, ({ team, file }) => describeClip(page, team, file)) };
  }

  async function describeHuddle(page, team, huddle) {
    const channel = huddle.channels?.[0];
    return {
      id: huddle.id,
      workspace: team.name,
      conversation: channel ? await conversationName(page, team, channel) : null,
      start: isoTime(huddle.date_start),
      end: huddle.date_end ? isoTime(huddle.date_end) : null,
      minutes: huddle.date_end ? Math.round((huddle.date_end - huddle.date_start) / 60) : null,
      participants: await inOrder((huddle.participant_history ?? []).slice(0, 15), (user) => userName(page, team, user)),
      transcript: Boolean(huddle.recording?.transcript),
      link: channel && huddle.thread_root_ts ? permalink(team, channel, huddle.thread_root_ts) : null,
    };
  }

  async function listHuddles({ workspace, limit = 20 }) {
    const page = requirePage();
    const found = [];
    for (const team of await teamsMatching(page, workspace)) {
      const result = await api(page, team, "huddles.history", { limit: Math.min(limit, 100) });
      if (!result.ok) {
        if (result.error !== "team_is_restricted") warn(`huddles: ${team.id}: ${result.error}`);
        continue;
      }
      for (const huddle of result.huddles ?? []) if (huddle.has_ended) found.push({ team, huddle });
    }
    const newest = found.sort((x, y) => y.huddle.date_start - x.huddle.date_start).slice(0, limit);
    return { huddles: await inOrder(newest, ({ team, huddle }) => describeHuddle(page, team, huddle)) };
  }

  /** A canvas's text (the huddle's AI notes), from its HTML. */
  async function canvasText(page, file) {
    const response = await page.session.fetch(file.url_private_download ?? file.url_private);
    const html = await response.text();
    return html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<\/(p|div|h[1-6]|li|tr)>|<br\s*\/?>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/\n\s*\n+/g, "\n\n")
      .trim();
  }

  /** The notes canvas names people and channels by id (@U..., #C...). */
  async function namesInNotes(page, team, text) {
    const names = new Map();
    for (const [mention, kind, id] of text.matchAll(/([@#])([UWC][A-Z0-9]{8,})\b/g)) {
      if (!names.has(mention)) names.set(mention, kind === "@" ? `@${await userName(page, team, id)}` : await conversationName(page, team, id));
    }
    return text.replace(/[@#][UWC][A-Z0-9]{8,}\b/g, (mention) => names.get(mention) ?? mention);
  }

  async function huddleTranscript({ huddle: ref }) {
    const page = requirePage();
    const target = parseRef(ref);
    if (!target.huddle && !target.ts) throw new Error("expected a huddle's thread link or a huddle id (R...)");
    let lastError = "huddle_not_found";
    for (const team of teamsInOrder(await signedInTeams(page), target.host)) {
      let huddle;
      if (target.huddle) {
        const result = await api(page, team, "huddles.get", { huddle_id: target.huddle });
        huddle = result.huddle;
        if (!result.ok) lastError = result.error;
      } else {
        const result = await api(page, team, "conversations.replies", { channel: target.channel, ts: target.threadTs ?? target.ts, limit: 1 });
        huddle = result.messages?.[0]?.room;
        if (!result.ok) lastError = result.error;
        else if (!huddle) throw new Error("that message is not a huddle's thread");
      }
      if (!huddle) continue;
      const described = await describeHuddle(page, team, huddle);
      if (!huddle.transcript_file_id) return { ...described, notes: null, lines: [] };
      const notes = (await api(page, team, "files.info", { file: huddle.transcript_file_id })).file;
      const transcriptId = notes?.huddle_transcript_file_id;
      const transcript = transcriptId ? (await api(page, team, "files.info", { file: transcriptId, include_transcription: true })).file : null;
      const lines = transcript?.huddle_transcription?.lines ?? [];
      const notesText = notes ? await canvasText(page, notes).catch((caught) => (warn(`huddle notes: ${caught.message}`), null)) : null;
      return {
        ...described,
        notes: notesText && (await namesInNotes(page, team, notesText)),
        lines: await inOrder(lines, async (line) => ({ start: line.start_time_ms, speaker: await userName(page, team, line.user_id), text: line.contents })),
      };
    }
    throw new Error(`the huddle could not be read (${lastError})`);
  }

  // --- Writing: drafts only --------------------------------------------------------------------------------
  /** A draft in a conversation's message box (or in a thread's), for you to review and send. Never sends. */
  async function createDraft({ target, text, workspace, inThread = true }) {
    if (!text) throw new Error("the draft has no text");
    const page = requirePage();
    const ref = parseRef(target);
    if (!ref.channel) throw new Error("expected a link to a Slack message or channel, or a channel id");
    const threadTs = ref.threadTs ?? (inThread ? ref.ts : undefined);
    const teams = ref.host ? teamsInOrder(await signedInTeams(page), ref.host) : await teamsMatching(page, workspace);
    let lastError = "channel_not_found";
    for (const team of teams) {
      const create = (fromComposer) =>
        api(page, team, "drafts.create", {
          blocks: JSON.stringify([{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }] }]),
          client_msg_id: crypto.randomUUID(),
          destinations: JSON.stringify([{ channel_id: ref.channel, ...(threadTs && { thread_ts: threadTs, broadcast: false }) }]),
          file_ids: "[]",
          is_from_composer: fromComposer,
        });
      let result = await create(true);
      // The message box already has a draft (Slack's own client recovers from this error the same way).
      const inComposer = result.error !== "attached_draft_exists";
      if (!inComposer) result = await create(false);
      if (!result.ok) {
        lastError = result.error;
        continue;
      }
      log(`draft created in ${team.id}/${ref.channel}${threadTs ? " (thread)" : ""}`);
      return {
        id: result.draft.id,
        conversation: await conversationName(page, team, ref.channel),
        inThread: Boolean(threadTs),
        where: inComposer ? "in the message box" : "in Drafts & sent (the message box already had a draft)",
        link: permalink(team, ref.channel, threadTs),
      };
    }
    throw new Error(`the draft could not be created (${lastError})`);
  }

  // --- Claude Code: tell you when a session finishes or needs you ------------------------------------------
  /** The workspace for a folder: the one linked to it (or to a folder containing it), the setting, or the first. */
  async function teamForFolder(page, folder) {
    const teams = await signedInTeams(page);
    const { folders, codeNotify } = settings();
    const inside = (parent) => folder && path.relative(parent, folder).split(path.sep)[0] !== ".." && !path.isAbsolute(path.relative(parent, folder));
    const linked = Object.entries(folders).find(([, linkedFolder]) => inside(linkedFolder))?.[0];
    const standalone = teams.find((team) => !team.enterprise_id && !isOrg(team));
    return teams.find((team) => team.id === linked) ?? teams.find((team) => team.id === codeNotify.workspace) ?? standalone ?? teams[0];
  }

  /** A Slackbot reminder to you, due now: unlike a message to yourself, it notifies. */
  async function remind(page, team, text) {
    const result = await api(page, team, "reminders.add", { text, time: Math.floor(Date.now() / 1000) + 2 });
    if (!result.ok) throw new Error(`reminders.add: ${result.error}`);
    log(`reminded you in ${team.id} (Claude Code)`);
  }

  const STATUS_PREFIX = "Claude Code: ";
  async function claudeCodeEvent(body) {
    const { event, cwd, message, seconds, summary } = body;
    // The agents panel keeps track of sessions (powertoys-assist.js).
    __webpack_require__("powertoys/assist").trackSession(body);
    const page = requirePage();
    const team = await teamForFolder(page, cwd);
    const { minMinutes, status } = settings().codeNotify;
    const where = cwd ? path.basename(cwd) : "a session";
    if (event === "prompt") return { done: true };
    if (event === "start") {
      if (status) {
        const profile = { status_text: `${STATUS_PREFIX}working on ${where}`, status_emoji: ":robot_face:", status_expiration: Math.floor(Date.now() / 1000) + 2 * 3600 };
        await api(page, team, "users.profile.set", { profile: JSON.stringify(profile) });
      }
      return { done: true };
    }
    if (event === "stop") {
      if (status) {
        const { profile } = await api(page, team, "users.profile.get");
        if (profile?.status_text?.startsWith(STATUS_PREFIX)) {
          await api(page, team, "users.profile.set", { profile: JSON.stringify({ status_text: "", status_emoji: "", status_expiration: 0 }) });
        }
      }
      if (!(seconds >= minMinutes * 60)) return { notified: false };
      const minutes = Math.round(seconds / 60);
      await remind(page, team, `Claude Code finished in ${where} after ${minutes} min${summary ? `: ${summary}` : ""}`);
      return { notified: true };
    }
    if (event === "notification") {
      await remind(page, team, `Claude Code needs you in ${where}${message ? `: ${message}` : ""}`);
      return { notified: true };
    }
    throw new Error(`unknown event ${event}`);
  }

  // --- Opening Claude from Slack ---------------------------------------------------------------------------
  const PROMPTS = {
    message: (link) => `Read this Slack message, its thread and any clip transcripts with the slack-powertoys tools, then help me with it:\n${link}`,
    huddle: (link) => `Read this Slack huddle's transcript with the slack-powertoys tools and summarize it: the key points, decisions and action items (with owners):\n${link}`,
  };

  async function askClaude({ link, teamId, kind = "message" }) {
    const prompt = (PROMPTS[kind] ?? PROMPTS.message)(link);
    const folder = settings().folders[teamId] ?? null;
    const url = folder
      ? `claude://code/new?folder=${encodeURIComponent(folder)}&q=${encodeURIComponent(prompt)}`
      : `claude://claude.ai/new?q=${encodeURIComponent(prompt)}`;
    await electron.shell.openExternal(url);
    log(`asked Claude about a ${kind} (${folder ? "Code session in the linked folder" : "chat"})`);
    return { folder };
  }

  async function linkFolder(event, teamId) {
    const window = electron.BrowserWindow.fromWebContents(event.sender);
    const current = settings().folders[teamId];
    const chosen = await electron.dialog.showOpenDialog(window, {
      title: "Folder for Claude Code sessions started from this workspace",
      defaultPath: current,
      properties: ["openDirectory"],
    });
    if (chosen.canceled || !chosen.filePaths[0]) return current ?? null;
    updateSettings((all) => ({ ...all, claude: { ...all.claude, folders: { ...all.claude?.folders, [teamId]: chosen.filePaths[0] } } }));
    log(`workspace ${teamId} linked to a folder`);
    return chosen.filePaths[0];
  }

  function unlinkFolder(teamId) {
    updateSettings((all) => {
      const { [teamId]: removed, ...folders } = all.claude?.folders ?? {};
      return { ...all, claude: { ...all.claude, folders } };
    });
    log(`workspace ${teamId} unlinked from its folder`);
    return null;
  }

  // --- When a huddle you were in ends with a transcript, offer a summary -----------------------------------
  function watchHuddles() {
    const startedAt = Date.now() / 1000;
    const offered = new Set();
    const check = async () => {
      const page = slackPage();
      if (!page || !settings().huddleSummaries) return;
      for (const team of await signedInTeams(page)) {
        const result = await api(page, team, "huddles.history", { limit: 10 });
        if (!result.ok) continue;
        const me = await self(page, team);
        for (const listed of result.huddles ?? []) {
          if (!listed.has_ended || listed.date_end < startedAt || offered.has(listed.id)) continue;
          if (!listed.recording?.transcript || !listed.participant_history?.includes(me.userId)) continue;
          // The notes and transcript exist once huddles.get names them; until then, ask again next time.
          const { huddle } = await api(page, team, "huddles.get", { huddle_id: listed.id });
          if (!huddle?.transcript_file_id) continue;
          offered.add(listed.id);
          const described = await describeHuddle(page, team, huddle);
          page.send("powertoys:huddle-ended", { teamId: team.id, link: described.link, where: described.conversation });
          log(`offered a summary of huddle ${listed.id}`);
        }
      }
    };
    setInterval(() => check().catch((caught) => warn(`huddle watch: ${caught.message}`)), 3 * 60 * 1000);
  }

  // --- A transcript for each video or audio file posted ----------------------------------------------------
  // Every 30 seconds, each workspace's files since the last look (files.list); those Slack has no transcript of get
  // one requested, once each.
  function watchNewMedia() {
    const since = new Map(); // team id -> unix seconds
    const requested = new Set();
    const firstLook = Math.floor(Date.now() / 1000) - 3600;
    const check = async () => {
      const page = slackPage();
      if (!page || !settings().autoTranscripts) return;
      for (const team of await signedInTeams(page)) {
        const now = Math.floor(Date.now() / 1000);
        const result = await api(page, team, "files.list", { ts_from: since.get(team.id) ?? firstLook, count: 100 });
        if (!result.ok) continue;
        since.set(team.id, now - 60);
        for (const file of result.files ?? []) {
          if (!isClip(file) || file.transcription?.status !== "none" || requested.has(file.id)) continue;
          requested.add(file.id);
          const answer = await api(page, team, "files.retranscribe", { file_id: file.id, reason: "generate-transcript" });
          log(`transcript of ${file.id} (${file.title || file.name}) ${answer.ok ? "requested" : `not requested: ${answer.error}`}`);
        }
      }
    };
    setInterval(() => check().catch((caught) => warn(`transcript watch: ${caught.message}`)), 30 * 1000);
  }

  // --- The bridge ------------------------------------------------------------------------------------------
  const number = (value) => (value == null || value === "" ? undefined : Number(value));
  const ROUTES = {
    "GET /clips": (q) => listClips({ workspace: q.workspace, limit: Math.min(number(q.limit) ?? 20, 100) }),
    "GET /transcript": (q) => clipTranscripts({ clip: q.clip }),
    "POST /transcript": (q, body) => requestTranscript({ clip: body.clip }),
    "GET /file": async (q) => {
      const ref = parseRef(q.file);
      if (!ref.file) throw new Error("expected a file link or a file id (F...)");
      const folder = q.folder || path.join(powertoysDir(), "files");
      fs.mkdirSync(folder, { recursive: true });
      return { path: await saveFile({ file: ref.file, host: ref.host, to: path.join(folder, ref.file) }) };
    },
    "GET /thread": (q) => readThread({ link: q.link, limit: Math.min(number(q.limit) ?? 50, 200) }),
    "GET /unreads": (q) => unreads({ workspace: q.workspace, conversations: number(q.conversations), perConversation: number(q.perConversation) }),
    "GET /search": (q) => search({ query: q.query, workspace: q.workspace, count: Math.min(number(q.count) ?? 20, 100), sort: q.sort || "score" }),
    "GET /my-messages": (q) => myMessages({ workspace: q.workspace, count: Math.min(number(q.count) ?? 30, 100), query: q.query }),
    "GET /saved": (q) => savedItems({ workspace: q.workspace }),
    "GET /drafts": (q) => drafts({ workspace: q.workspace }),
    "GET /huddles": (q) => listHuddles({ workspace: q.workspace, limit: Math.min(number(q.limit) ?? 20, 100) }),
    "GET /huddle": (q) => huddleTranscript({ huddle: q.huddle }),
    "POST /draft": (q, body) => createDraft(body),
    "POST /claude-code": (q, body) => claudeCodeEvent(body),
    "POST /claude-code/permission": (q, body) => __webpack_require__("powertoys/assist").permission(body),
  };

  function readBody(request) {
    return new Promise((resolve, reject) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1e6) request.destroy(new Error("body too large"));
      });
      request.on("end", () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          reject(new Error("the body is not JSON"));
        }
      });
      request.on("error", reject);
    });
  }

  function startBridge() {
    const token = crypto.randomBytes(24).toString("hex");
    const file = path.join(powertoysDir(), "bridge.json");
    const server = http.createServer(async (request, response) => {
      const send = (status, body) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.headers.authorization !== `Bearer ${token}`) return send(401, { error: "unauthorized" });
      const url = new URL(request.url, "http://127.0.0.1");
      const route = ROUTES[`${request.method} ${url.pathname}`];
      if (!route) return send(404, { error: "not found" });
      try {
        const body = request.method === "POST" ? await readBody(request) : null;
        send(200, await route(Object.fromEntries(url.searchParams), body));
      } catch (caught) {
        warn(`bridge ${url.pathname}: ${caught.message}`);
        send(500, { error: caught.message });
      }
    });
    server.listen(0, "127.0.0.1", () => {
      fs.writeFileSync(file, JSON.stringify({ port: server.address().port, token, pid: process.pid }), { mode: 0o600 });
      log(`bridge listening on 127.0.0.1:${server.address().port}`);
    });
    electron.app.on("will-quit", () => fs.rmSync(file, { force: true }));
  }

  // For powertoys/assist.
  Object.assign(exports, { settings, requirePage, readThread, unreads, search, myMessages, createDraft, huddleTranscript, clipTranscripts, saveFile, teamForFolder, remind, self, conversationName, userName, parseRef, permalink });

  exports.start = function start() {
    if (readSettings().bridge) startBridge();
    electron.ipcMain.handle("powertoys:ask-claude", (event, request) => askClaude(request));
    electron.ipcMain.handle("powertoys:claude-folder", (event, teamId) => settings().folders[teamId] ?? null);
    electron.ipcMain.handle("powertoys:link-folder", (event, teamId) => linkFolder(event, teamId));
    electron.ipcMain.handle("powertoys:unlink-folder", (event, teamId) => unlinkFolder(teamId));
    watchHuddles();
    watchNewMedia();
  };
});
