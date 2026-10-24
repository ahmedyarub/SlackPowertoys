#!/usr/bin/env node
// Claude Code hook for Slack Powertoys (no dependencies, Node 18+). It does nothing when Slack is not running.
//
//   - Tells you in Slack when a long session finishes or a session needs you: a Slackbot reminder (it notifies, unlike
//     a message to yourself) in the workspace linked to the session's folder; with "claude.codeNotify.status" on in
//     Powertoys' settings, your Slack status while a session works. Sessions shorter than
//     "claude.codeNotify.minMinutes" (default 5) stay quiet.
//   - Keeps Powertoys' agents panel up to date (each session's state).
//   - With "agents.remoteApprove" on, a permission request can be answered from Slack (buttons in Slack on your
//     computer, or "y" / "n" in a thread of your DM, from your phone); unanswered after "agents.approveWaitSeconds"
//     (default 120), the session asks in its own window as usual.
//
// ~/.claude/settings.json (the PermissionRequest hook needs a timeout longer than the wait):
//   "hooks": {
//     "UserPromptSubmit":  [{ "hooks": [{ "type": "command", "command": "node <this folder>/claude-code-hook.mjs" }] }],
//     "Stop":              [{ "hooks": [{ "type": "command", "command": "node <this folder>/claude-code-hook.mjs" }] }],
//     "Notification":      [{ "hooks": [{ "type": "command", "command": "node <this folder>/claude-code-hook.mjs" }] }],
//     "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "node <this folder>/claude-code-hook.mjs", "timeout": 150 }] }]
//   }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BRIDGE_FILE = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Slack', 'powertoys', 'bridge.json');
const STATE_DIR = path.join(os.tmpdir(), 'slack-powertoys-claude-code');

const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
const sessionId = String(input.session_id ?? 'unknown');
const stateFile = path.join(STATE_DIR, `${sessionId.replace(/[^\w-]/g, '')}.json`);

/** The last thing Claude said in the session (its transcript is JSON lines), shortened. */
function lastReply(transcriptPath) {
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n').reverse();
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.type !== 'assistant') continue;
      const text = (entry.message?.content ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(' ')
        .trim();
      if (text) return text.replace(/\s+/g, ' ').slice(0, 300);
    }
  } catch {}
  return null;
}

async function tell(route, body) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8'));
  } catch {
    return null; // Slack is not running
  }
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/${route}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, ...body }),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

const cwd = input.cwd ?? process.cwd();
switch (input.hook_event_name) {
  case 'UserPromptSubmit': {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // A session's turn starts with the first prompt since it last stopped.
    if (!fs.existsSync(stateFile)) {
      fs.writeFileSync(stateFile, JSON.stringify({ started: Date.now() }));
      await tell('claude-code', { event: 'start', cwd });
    } else {
      await tell('claude-code', { event: 'prompt', cwd });
    }
    break;
  }
  case 'Stop': {
    let started = null;
    try {
      started = JSON.parse(fs.readFileSync(stateFile, 'utf8')).started;
      fs.rmSync(stateFile, { force: true });
    } catch {}
    const seconds = started ? Math.round((Date.now() - started) / 1000) : 0;
    await tell('claude-code', { event: 'stop', cwd, seconds, summary: lastReply(input.transcript_path) });
    break;
  }
  case 'Notification':
    await tell('claude-code', { event: 'notification', cwd, message: input.message });
    break;
  case 'PermissionRequest': {
    const answer = await tell('claude-code/permission', { cwd, tool: input.tool_name, input: input.tool_input });
    if (answer?.decision === 'allow' || answer?.decision === 'deny') {
      const decision = answer.decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied from Slack.' };
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }));
    }
    break;
  }
}
