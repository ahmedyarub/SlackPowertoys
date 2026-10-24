#!/usr/bin/env node
// Claude Code hook: tells you in Slack when a long session finishes or a session needs you (no dependencies, Node 18+).
//
// Slack Powertoys does the telling: a Slackbot reminder to you, due at once (it notifies, unlike a message to yourself),
// in the workspace linked to the session's folder; and, when "claude.codeNotify.status" is on in Powertoys' settings,
// your Slack status while a session works. Sessions shorter than "claude.codeNotify.minMinutes" (default 5) stay quiet.
// It does nothing when Slack is not running.
//
// ~/.claude/settings.json:
//   "hooks": {
//     "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node <this folder>/claude-code-hook.mjs" }] }],
//     "Stop":             [{ "hooks": [{ "type": "command", "command": "node <this folder>/claude-code-hook.mjs" }] }],
//     "Notification":     [{ "hooks": [{ "type": "command", "command": "node <this folder>/claude-code-hook.mjs" }] }]
//   }
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BRIDGE_FILE = path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Slack", "powertoys", "bridge.json");
const STATE_DIR = path.join(os.tmpdir(), "slack-powertoys-claude-code");

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const stateFile = path.join(STATE_DIR, `${String(input.session_id ?? "unknown").replace(/[^\w-]/g, "")}.json`);

/** The last thing Claude said in the session (its transcript is JSON lines), shortened. */
function lastReply(transcriptPath) {
  try {
    const lines = fs.readFileSync(transcriptPath, "utf8").trim().split("\n").reverse();
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.type !== "assistant") continue;
      const text = (entry.message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join(" ").trim();
      if (text) return text.replace(/\s+/g, " ").slice(0, 300);
    }
  } catch {}
  return null;
}

async function tell(body) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(BRIDGE_FILE, "utf8"));
  } catch {
    return; // Slack is not running
  }
  await fetch(`http://127.0.0.1:${config.port}/claude-code`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

const cwd = input.cwd ?? process.cwd();
switch (input.hook_event_name) {
  case "UserPromptSubmit": {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // A session's turn starts with the first prompt since it last stopped.
    if (!fs.existsSync(stateFile)) {
      fs.writeFileSync(stateFile, JSON.stringify({ started: Date.now() }));
      await tell({ event: "start", cwd });
    }
    break;
  }
  case "Stop": {
    let started = null;
    try {
      started = JSON.parse(fs.readFileSync(stateFile, "utf8")).started;
      fs.rmSync(stateFile, { force: true });
    } catch {}
    const seconds = started ? Math.round((Date.now() - started) / 1000) : 0;
    await tell({ event: "stop", cwd, seconds, summary: lastReply(input.transcript_path) });
    break;
  }
  case "Notification":
    await tell({ event: "notification", cwd, message: input.message });
    break;
}
