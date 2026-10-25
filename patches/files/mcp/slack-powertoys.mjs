#!/usr/bin/env node
// Slack for Claude: an MCP server (stdio, no dependencies, Node 18+) over Slack Powertoys' bridge.
//
// The bridge runs inside Slack, so Slack must be running; its port and token are in
// %APPDATA%\Slack\powertoys\bridge.json while it runs. It reads with your own Slack session (what you can see in Slack)
// and writes nothing but drafts: create_slack_draft puts a message in a message box for you to review and send.
//
// Claude Desktop (%APPDATA%\Claude\claude_desktop_config.json):
//   "mcpServers": { "slack-powertoys": { "command": "node", "args": ["<this folder>\\slack-powertoys.mjs"] } }
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const BRIDGE_FILE = path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Slack", "powertoys", "bridge.json");

const workspace = { type: "string", description: "Only this workspace (part of its name, or its id); all signed-in workspaces when left out" };
const link = (what) => ({ type: "string", description: what });

const TOOLS = [
  {
    name: "read_slack_thread",
    description: "A Slack message with its whole thread (or, for a channel link, the channel's latest messages): authors, times, text, files and links.",
    inputSchema: { type: "object", properties: { link: link("A Slack message link (Copy link) or channel link"), limit: { type: "number", description: "For a channel link: how many messages (default 50)" } }, required: ["link"] },
    run: async ({ link, limit }) => formatThread(await bridge("GET", "thread", { link, limit })),
  },
  {
    name: "get_slack_unreads",
    description: "What is unread in Slack: the conversations with unread messages (those with mentions first) and their unread messages. Use it to catch up or summarize.",
    inputSchema: {
      type: "object",
      properties: {
        workspace,
        conversations: { type: "number", description: "At most this many conversations per workspace (default 25)" },
        perConversation: { type: "number", description: "At most this many unread messages per conversation (default 15)" },
      },
    },
    run: async (args) => formatUnreads(await bridge("GET", "unreads", args)),
  },
  {
    name: "search_slack",
    description: "Search Slack messages with Slack's search syntax (words, \"phrases\", from:@name, in:#channel, before:/after:YYYY-MM-DD, has:link ...).",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, workspace, count: { type: "number", description: "How many results (default 20)" }, sort: { type: "string", enum: ["score", "timestamp"] } },
      required: ["query"],
    },
    run: async (args) => formatResults(await bridge("GET", "search", args)),
  },
  {
    name: "get_my_slack_messages",
    description: "Your own latest Slack messages: samples of how you write (tone, length, language), to draft replies in your style.",
    inputSchema: { type: "object", properties: { workspace, count: { type: "number", description: "How many (default 30)" }, query: { type: "string", description: "Only messages matching this search" } } },
    run: async (args) => formatResults(await bridge("GET", "my-messages", args)),
  },
  {
    name: "list_slack_saved",
    description: "Your saved Slack items (\"Later\"), with the saved messages' text and links.",
    inputSchema: { type: "object", properties: { workspace } },
    run: async (args) => formatSaved(await bridge("GET", "saved", args)),
  },
  {
    name: "list_slack_drafts",
    description: "Your unsent Slack drafts and scheduled messages, with where each goes.",
    inputSchema: { type: "object", properties: { workspace } },
    run: async (args) => formatDrafts(await bridge("GET", "drafts", args)),
  },
  {
    name: "create_slack_draft",
    description:
      "Put a draft in a Slack message box for the user to review and send. It never sends. With a message link the draft is a reply in that " +
      "message's thread (in_thread false: in the channel instead); with a channel link or id, a message in the channel. Plain text.",
    inputSchema: {
      type: "object",
      properties: {
        target: link("A Slack message link, channel link or channel id"),
        text: { type: "string" },
        in_thread: { type: "boolean", description: "For a message link: reply in its thread (default true)" },
        workspace,
      },
      required: ["target", "text"],
    },
    run: async ({ target, text, in_thread, workspace }) => {
      const draft = await bridge("POST", "draft", { target, text, inThread: in_thread ?? true, workspace });
      return `Draft created ${draft.where} of ${draft.conversation}${draft.inThread ? " (in the thread)" : ""}. It has not been sent.\n${draft.link}`;
    },
  },
  {
    name: "get_slack_clip_transcript",
    description:
      "The transcript of a Slack video or audio clip (what Slack shows under \"View transcript\"), with timestamps. " +
      "Takes a link to the clip's message (Copy link), a file link, or a file id (F...). No transcript yet: request_slack_transcript.",
    inputSchema: {
      type: "object",
      properties: { clip: link("A Slack message link, file link or file id"), timestamps: { type: "boolean", description: "Start each line with its time (default true)" } },
      required: ["clip"],
    },
    run: async ({ clip, timestamps = true }) => formatClips(await bridge("GET", "transcript", { clip }), timestamps),
  },
  {
    name: "request_slack_transcript",
    description:
      "Asks Slack to transcribe a video or audio file it has no transcript of (Slack's own \"Generate transcript\"; uploaded " +
      "screen recordings often have none). It takes a minute or so: then read it with get_slack_clip_transcript. Takes a file link or a file id (F...).",
    inputSchema: {
      type: "object",
      properties: {
        clip: link("A Slack file link or file id"),
        language: {
          type: "string",
          enum: ["en-US", "en-GB", "de-DE", "es-ES", "es-LA", "fr-FR", "it-IT", "pt-BR", "ja-JP", "ko-KR", "zh-CN", "zh-TW"],
          description: "The language spoken in it (default: the one chosen in Slack Powertoys' settings, English unless changed)",
        },
      },
      required: ["clip"],
    },
    run: async ({ clip, language }) => {
      const { file, language: used } = await bridge("POST", "transcript", { clip, language });
      return `Slack is transcribing ${file} (${used}). Read it with get_slack_clip_transcript in a minute or so.`;
    },
  },
  {
    name: "save_slack_file",
    description:
      "Downloads a file shared in Slack (a video clip, a screen recording, an image) and gives its path, to look at or process " +
      "(frames from a video with ffmpeg). Takes a file link or a file id (F..., as read_slack_thread lists them).",
    inputSchema: {
      type: "object",
      properties: { file: link("A Slack file link or file id"), folder: { type: "string", description: "The folder to save it in (default: Powertoys' files folder)" } },
      required: ["file"],
    },
    run: async ({ file, folder }) => `Saved: ${(await bridge("GET", "file", { file, folder })).path}`,
  },
  {
    name: "list_slack_clips",
    description: "The newest video and audio clips in Slack, with their links and whether they have a transcript.",
    inputSchema: { type: "object", properties: { workspace, limit: { type: "number", description: "How many clips (default 20, at most 100)" } } },
    run: async (args) => formatClipList(await bridge("GET", "clips", args)),
  },
  {
    name: "list_slack_huddles",
    description: "Recent Slack huddles: where, when, how long, who was there, whether there is a transcript, and the huddle's thread link.",
    inputSchema: { type: "object", properties: { workspace, limit: { type: "number", description: "How many (default 20)" } } },
    run: async (args) => formatHuddleList(await bridge("GET", "huddles", args)),
  },
  {
    name: "get_slack_huddle_transcript",
    description: "A Slack huddle's transcript (who said what, with times) and Slack's AI notes when there are any. Takes the huddle's thread link or its id (R...).",
    inputSchema: {
      type: "object",
      properties: { huddle: link("The huddle's thread link or id"), timestamps: { type: "boolean", description: "Start each line with its time (default true)" } },
      required: ["huddle"],
    },
    run: async ({ huddle, timestamps = true }) => formatHuddle(await bridge("GET", "huddle", { huddle }), timestamps),
  },
];

async function bridge(method, route, params = {}) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(BRIDGE_FILE, "utf8"));
  } catch {
    throw new Error("Slack is not running (or Slack Powertoys' bridge is off), so Slack can't be read. Start Slack and try again.");
  }
  const defined = Object.entries(params).filter(([, value]) => value != null && value !== "");
  const query = method === "GET" ? `?${new URLSearchParams(defined)}` : "";
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${config.port}/${route}${query}`, {
      method,
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify(Object.fromEntries(defined)) : undefined,
    });
  } catch {
    throw new Error("Slack's bridge did not answer. Is Slack running?");
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

// --- Formatting ----------------------------------------------------------------------------------------------
const clock = (ms) => {
  const seconds = Math.floor(ms / 1000);
  const [h, m, s] = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
  return `${h ? `${h}:` : ""}${String(m).padStart(h ? 2 : 1, "0")}:${String(s).padStart(2, "0")}`;
};
const when = (iso) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
const indent = (text, prefix = "  ") => text.split("\n").map((line) => prefix + line).join("\n");

function formatMessage(message) {
  const files = message.files?.length ? `\n  [files: ${message.files.map((file) => `${file.name} (${file.type}, ${file.id})`).join("; ")}]` : "";
  const extra = [message.replies && `${message.replies} replies`, message.huddle && `huddle ${message.huddle}`].filter(Boolean).join(", ");
  return `[${when(message.time)}] ${message.author}${extra ? ` (${extra})` : ""}:\n${indent(message.text || "(no text)")}${files}`;
}

function formatThread({ workspace, conversation, messages }) {
  return `${conversation} · ${workspace}\n${messages[0]?.link ?? ""}\n\n${messages.map(formatMessage).join("\n\n")}`;
}

function formatUnreads({ workspaces }) {
  if (!workspaces.length) return "Nothing to report (no workspace answered).";
  return workspaces
    .map((each) => {
      const threads = each.unreadThreads ? `Threads: unread replies${each.threadMentions ? `, ${each.threadMentions} mention(s)` : ""}.\n` : "";
      const conversations = each.conversations.length
        ? each.conversations
            .map((c) => `## ${c.conversation}${c.mentions ? ` (${c.mentions} mention(s))` : ""}${c.more ? " (more unread than shown)" : ""}\n${c.link}\n\n${c.messages.map(formatMessage).join("\n\n")}`)
            .join("\n\n")
        : "No unread conversations.";
      return `# ${each.workspace}\n${threads}\n${conversations}`;
    })
    .join("\n\n");
}

function formatResults({ results }) {
  if (!results.length) return "No messages found.";
  return results.map((r) => `[${when(r.time)}] ${r.author} in ${r.conversation} (${r.workspace}):\n${indent(r.text)}\n  ${r.link}`).join("\n\n");
}

function formatSaved({ items }) {
  if (!items.length) return "No saved items.";
  return items
    .map((item) => {
      const head = `- ${item.type} saved ${when(item.saved)}${item.due ? `, due ${when(item.due)}` : ""} (${item.state}, ${item.workspace})`;
      if (item.message) return `${head} in ${item.conversation}:\n${indent(item.message.text ? formatMessage(item.message) : item.message.link, "    ")}\n    ${item.message.link}`;
      return `${head}: ${item.description ?? item.id}`;
    })
    .join("\n");
}

function formatDrafts({ drafts }) {
  if (!drafts.length) return "No drafts.";
  return drafts
    .map((d) => `- To ${d.conversation ?? "?"}${d.inThread ? " (thread)" : ""}, ${d.scheduled ? `scheduled for ${when(d.scheduled)}` : `edited ${when(d.updated)}`} (${d.workspace}):\n${indent(d.text, "    ")}${d.link ? `\n    ${d.link}` : ""}`)
    .join("\n");
}

function clipHeader(clip) {
  const facts = [clip.kind, clip.author && `by ${clip.author}`, when(clip.created), clip.durationSeconds != null && clock(clip.durationSeconds * 1000), clip.workspace];
  return `# ${clip.title}\n${facts.filter(Boolean).join(" · ")}\n${clip.permalink}`;
}

function formatClips({ clips }, timestamps) {
  return clips
    .map((clip) => {
      if (!clip.lines.length) return `${clipHeader(clip)}\n\nNo transcript (Slack's transcript status: ${clip.transcript ?? "none"}).`;
      const lines = clip.lines.map((line) => (timestamps ? `[${clock(line.start)}] ${line.text}` : line.text));
      return `${clipHeader(clip)}\nLanguage: ${clip.locale ?? "unknown"}\n\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

function formatClipList({ clips }) {
  if (!clips.length) return "No clips found.";
  return clips
    .map((clip) => `- ${clip.title} (${clip.kind}, ${clip.created.slice(0, 10)}, ${clip.durationSeconds != null ? clock(clip.durationSeconds * 1000) : "?"}, by ${clip.author ?? "?"}, ${clip.workspace}; transcript: ${clip.transcript ?? "none"})\n  ${clip.permalink}`)
    .join("\n");
}

function formatHuddleList({ huddles }) {
  if (!huddles.length) return "No huddles found.";
  return huddles
    .map((h) => `- ${when(h.start)}, ${h.minutes ?? "?"} min, in ${h.conversation ?? "?"} (${h.workspace}); ${h.participants.join(", ")}; transcript: ${h.transcript ? "yes" : "no"}\n  ${h.link ?? h.id}`)
    .join("\n");
}

function formatHuddle(huddle, timestamps) {
  const head = `# Huddle in ${huddle.conversation ?? "?"} · ${when(huddle.start)} · ${huddle.minutes ?? "?"} min · ${huddle.workspace}\nParticipants: ${huddle.participants.join(", ")}\n${huddle.link ?? huddle.id}`;
  const notes = huddle.notes ? `\n\n## Slack's AI notes\n${huddle.notes}` : "";
  if (!huddle.lines.length) return `${head}${notes}\n\nNo transcript.`;
  const lines = huddle.lines.map((line) => `${timestamps ? `[${clock(line.start)}] ` : ""}${line.speaker}: ${line.text}`);
  return `${head}${notes}\n\n## Transcript\n${lines.join("\n")}`;
}

// --- MCP over stdio --------------------------------------------------------------------------------------------
async function handle(message) {
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "slack-powertoys", version: "1.2.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS.map(({ run, ...tool }) => tool) };
    case "tools/call": {
      const tool = TOOLS.find((each) => each.name === message.params?.name);
      if (!tool) throw Object.assign(new Error(`unknown tool ${message.params?.name}`), { code: -32602 });
      try {
        return { content: [{ type: "text", text: await tool.run(message.params.arguments ?? {}) }] };
      } catch (caught) {
        return { content: [{ type: "text", text: caught.message }], isError: true };
      }
    }
    default:
      throw Object.assign(new Error(`method not found: ${message.method}`), { code: -32601 });
  }
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: "parse error" } });
  }
  if (message.id === undefined) return; // a notification
  try {
    send({ id: message.id, result: await handle(message) });
  } catch (caught) {
    send({ id: message.id, error: { code: caught.code ?? -32603, message: caught.message } });
  }
});
