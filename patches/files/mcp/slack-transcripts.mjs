#!/usr/bin/env node
// Slack clip transcripts for Claude Desktop: an MCP server (stdio, no dependencies, Node 18+).
//
// It asks Slack Powertoys' bridge, which runs inside Slack: Slack must be running. The bridge's port and token are in
// %APPDATA%\Slack\powertoys\bridge.json while it runs.
//
// Claude Desktop (%APPDATA%\Claude\claude_desktop_config.json):
//   "mcpServers": { "slack-transcripts": { "command": "node", "args": ["<this folder>\\slack-transcripts.mjs"] } }
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const BRIDGE_FILE = path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Slack", "powertoys", "bridge.json");

const TOOLS = [
  {
    name: "get_slack_clip_transcript",
    description:
      "The transcript of a Slack video or audio clip (what Slack shows under \"View transcript\"), with timestamps. " +
      "Takes a link to the clip's message (Copy link), a file link, or a file id (F...).",
    inputSchema: {
      type: "object",
      properties: {
        clip: { type: "string", description: "A Slack message link, file link or file id" },
        timestamps: { type: "boolean", description: "Start each line with its time (default true)" },
      },
      required: ["clip"],
    },
  },
  {
    name: "list_slack_clips",
    description: "The newest video and audio clips in the signed-in Slack workspaces, with their links and whether they have a transcript.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Only this workspace (part of its name, or its id)" },
        limit: { type: "number", description: "How many clips (default 20, at most 100)" },
      },
    },
  },
];

async function bridge(route, params) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(BRIDGE_FILE, "utf8"));
  } catch {
    throw new Error("Slack is not running (or Slack Powertoys' bridge is off), so its clips can't be read. Start Slack and try again.");
  }
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value != null && value !== ""));
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${config.port}/${route}?${query}`, { headers: { authorization: `Bearer ${config.token}` } });
  } catch {
    throw new Error("Slack's bridge did not answer. Is Slack running?");
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

const clock = (ms) => {
  const seconds = Math.floor(ms / 1000);
  const [h, m, s] = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
  return `${h ? `${h}:` : ""}${String(m).padStart(h ? 2 : 1, "0")}:${String(s).padStart(2, "0")}`;
};

function header(clip) {
  const facts = [clip.kind, clip.author && `by ${clip.author}`, clip.created.slice(0, 16).replace("T", " ") + " UTC", clip.durationSeconds != null && clock(clip.durationSeconds * 1000), clip.workspace];
  return `# ${clip.title}\n${facts.filter(Boolean).join(" · ")}\n${clip.permalink}`;
}

async function getTranscript({ clip, timestamps = true }) {
  const { clips } = await bridge("transcript", { clip });
  return clips
    .map((each) => {
      if (!each.lines.length) return `${header(each)}\n\nNo transcript (Slack's transcript status: ${each.transcript ?? "none"}).`;
      const lines = each.lines.map((line) => (timestamps ? `[${clock(line.start)}] ${line.text}` : line.text));
      return `${header(each)}\nLanguage: ${each.locale ?? "unknown"}\n\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

async function listClips({ workspace, limit }) {
  const { clips } = await bridge("clips", { workspace, limit });
  if (!clips.length) return "No clips found.";
  return clips
    .map((clip) => `- ${clip.title} (${clip.kind}, ${clip.created.slice(0, 10)}, ${clip.durationSeconds != null ? clock(clip.durationSeconds * 1000) : "?"}, by ${clip.author ?? "?"}, ${clip.workspace}; transcript: ${clip.transcript ?? "none"})\n  ${clip.permalink}`)
    .join("\n");
}

const HANDLERS = { get_slack_clip_transcript: getTranscript, list_slack_clips: listClips };

async function handle(message) {
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "slack-transcripts", version: "1.0.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const handler = HANDLERS[message.params?.name];
      if (!handler) throw Object.assign(new Error(`unknown tool ${message.params?.name}`), { code: -32602 });
      try {
        return { content: [{ type: "text", text: await handler(message.params.arguments ?? {}) }] };
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
