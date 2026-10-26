# SlackPowertoys

Patches that add **Powertoys** to the Slack desktop app for Windows, and the patcher that applies them. This repository
holds **only the patches and the patcher**. It contains no code from Slack.

> Not affiliated with or endorsed by Slack or Salesforce. "Slack" is theirs. The patches are modifications for your
> own copy of the app; using a modified app is at your own risk and subject to Slack's terms.

## What is in this repository

```
patcher/apply-patches.mjs   the patcher: Node 18+, no dependencies
patches/patches.json        the patch manifest: every file, its hashes and its edits
patches/files/...           files that are entirely new (written for Powertoys), copied in as they are
```

`patches/patches.json` lists 18 files:

- **13 new files** (`"kind": "add"`), written for Powertoys:
  - main process: `powertoys-main.js` (`"powertoys/main"`), `powertoys-claude.js` (Slack for Claude, the bridge),
    `powertoys-ai.js` (Claude through the Claude Code CLI), `powertoys-notion.js` (Notion API),
    `powertoys-dev.js` (GitHub through `gh`, editors, terminals, gists, repository search),
    `powertoys-assist.js` (the developer features), `powertoys-huddle.js` (huddles: captions, questions to Claude,
    headphones), all in `src/main.bundle.cjs/`;
  - Slack's page: `powertoys-page.js`, `powertoys-page-dev.js`, `powertoys-page-compose.js`,
    `powertoys-page-panel.js`, in `src/preload.bundle.js/`;
  - `mcp/slack-powertoys.mjs` (an MCP server for Claude Desktop) and `mcp/claude-code-hook.mjs` (a Claude Code hook),
    which run on their own with Node.
- **6 edits** (`"kind": "edit"`) to the app's own files: three one-line hooks (start the two halves, add the tray
  menu items), two manifest entries that add the new modules to their bundles, and a small change to Windows
  auto-start.

## What Powertoys adds

- **Mark everything as read**, in every signed-in workspace (a tray menu item) or in one (right-click a workspace
  icon). It marks each channel, DM and group DM with unreads as read at its latest message, the same Web API calls
  Slack's own "Mark all as read" makes; Slack then updates its sidebar itself.
- **Slack for Claude Desktop.** While Slack runs, Powertoys answers on `127.0.0.1`, with a random port and a bearer
  token written to `%APPDATA%\Slack\powertoys\bridge.json` (removed when Slack quits; `{"bridge": false}` in
  `settings.json` turns it off). It uses your own Slack session, so it sees what you see in Slack.
  `mcp/slack-powertoys.mjs` is a dependency-free MCP server over it, with these tools:

  | Tool | What it does |
  |---|---|
  | `read_slack_thread` | a message with its whole thread (or a channel's latest messages), from a link |
  | `get_slack_unreads` | the conversations with unread messages, mentions first, and those messages |
  | `search_slack` | Slack's message search (`from:`, `in:`, `before:`, ...) |
  | `get_my_slack_messages` | your own latest messages, so replies can be drafted in your style |
  | `list_slack_saved`, `list_slack_drafts` | your saved items ("Later") and unsent drafts |
  | `create_slack_draft` | puts a draft in a message box (or a thread's) for you to review and send; it never sends |
  | `get_slack_clip_transcript`, `list_slack_clips` | video and audio clips' transcripts ("View transcript") |
  | `request_slack_transcript` | asks Slack to transcribe a video it has no transcript of ("Generate transcript") |
  | `save_slack_file` | downloads a file shared in Slack (a video, an image) for Claude to look at |
  | `list_slack_huddles`, `get_slack_huddle_transcript` | huddles, and a huddle's transcript (who said what) with Slack's AI notes |

  Add it to Claude Desktop in `%APPDATA%\Claude\claude_desktop_config.json` and restart Claude Desktop:

  ```json
  "mcpServers": {
    "slack-powertoys": { "command": "C:/Program Files/nodejs/node.exe", "args": ["<your-copy>/mcp/slack-powertoys.mjs"] }
  }
  ```
- **Ask Claude about this**, in Slack's message menu (right-click a message, or its "More actions"): opens Claude
  Desktop with the message's link and a prompt to read it (with its thread and any clip transcripts) through the tools
  above. If the workspace is linked to a folder, it starts a Claude Code session in that folder; otherwise a chat.
- **A folder per workspace:** right-click a workspace icon, "Link a folder for Claude…" (kept in `settings.json`
  under `claude.folders`). Claude Code sessions started from that workspace open in that folder.
- **Huddle summaries:** when a huddle you were in ends with a transcript, a notice offers "Summarize with Claude"
  (`"claude": {"huddleSummaries": false}` turns it off).
- **A transcript for every video:** each video or audio file posted gets Slack's own transcript requested right away
  (what "Generate transcript" does), so it is there when you need it (`"claude": {"autoTranscripts": false}` turns
  it off).
- **Huddles:** the huddle window opens maximized with captions side by side instead of the huddle's thread (side by
  side only: the closed-caption overlay is turned off). A
  "Claude session" dropdown in the captions panel picks one of your Claude Code sessions in the workspace's folder,
  or a new one (the default). Double-click a caption, select several and press **Ask Claude**, or right-click: the
  question is asked in that session (it stays there) by a fast model, and the answer shows in a pop-up you can drag
  and type follow-up questions in. From the moment a huddle rings or its start screen opens, Bluetooth goes on and
  Windows connects your paired
  headphones (found by their Bluetooth class, whatever their name; `"huddle": {"headphones": "<name>"}` picks a
  device, `null` turns it off). If Bluetooth was off, it goes off again when the huddle ends, or at Cancel/Decline.
- **Recording every huddle:** the huddle window, the call's sound and your microphone, encoded by your graphics card,
  to `.mkv` in `"huddle": {"recordingsFolder"}`. The call's sound is taken inside Slack, from the huddle's incoming
  audio as it arrives (you keep hearing it as usual), so it is recorded whichever speaker or headphones play it; the
  computer's sound output is kept too, as a backup track. Written and flushed to disk every half second, kept in
  memory too, restarted in a new part if the recorder fails, finished before Slack quits and recovered after a
  crash. If the call's sound stops reaching the recording, the Rec chip in the huddle window turns yellow, a notice
  says so, and it restarts. The file has the tracks "Call and microphone" (the default), "Call", "Microphone" and
  "Computer sound (backup)". When the huddle ends, Slack says whether the call's sound was recorded, and offers **Transcribe** (Slack's own transcription, via a private upload,
  saved beside the video and added to it as a subtitle track),
  **Summarize** (Claude), **Share with Claude** (the Claude Code session you pick, whose answer shows in a pop-up, or a new one, gets the transcript attached and only the
  video's path, and looks at the video only when the transcript isn't enough) and **Keep** as checkboxes, or delete
  it (Recycle Bin, after a Yes/No); also in the panel's
  Recordings tab.
  `"huddle": {"autoRecord": false}` turns it off. You are responsible for telling the people on the call.
- **Transcription language:** a dropdown in the panel's Settings tab (English by default) for every transcript.
- **Claude Code tells you in Slack** when a long session finishes or a session needs you: add
  `mcp/claude-code-hook.mjs` to Claude Code's hooks (`UserPromptSubmit`, `Stop` and `Notification`, in
  `~/.claude/settings.json`; the file's header shows how). You get a Slackbot reminder (it notifies, unlike a
  message to yourself) in the workspace linked to the session's folder. Settings under `claude.codeNotify`:
  `minMinutes` (default 5), `"claude": {"reminders": false}` turns the reminders off, `status` (default false: also show "Claude Code: working on <folder>" as your Slack
  status while a session works), `workspace` (a workspace id for folders that are not linked).
- **Developer features** (they use Claude through the Claude Code CLI, signed in as you, with a lean prompt; Notion
  through the Powertoys panel's Settings tab (Ctrl+Alt+P): **Sign in as you** (Notion's own MCP server, the one
  Claude's Notion connector uses: link titles and previews then read everything you can open, teamspaces included),
  and for saving pages, sign in with an OAuth connection whose redirect URI is
  `http://localhost:47821/notion/callback`, or paste an internal integration's secret; GitHub through the `gh` CLI):
  - **Notion:** link previews (title, path, status, assignees, last edit, first lines; notion.so, notion.site and
    app.notion.com links); a pasted link goes in at once, and its title, linked, replaces it once known (a Notion
    ticket as "ISS-1995 Title", with its database's ID; a GitHub title; or any page's title). A Notion page not shared
    with your connection keeps its link and a notice says why. **Save to Notion** in the message menu (a thread, huddle or
    clip, summarized with decisions and action items); **Draft a postmortem in Notion** in incident channels. Claude
    picks where each new page goes (an Incidents database for a postmortem, say) among the pages you shared.
  - **Share video with Claude** in the menu of a message with a video or audio clip, and in the clip's own ⋮ menu:
    just like sharing a recording. The clip is saved to your recordings folder (`From Slack`) with its Slack
    transcript beside it, and the Claude Code session you pick, or a new one, gets the transcript attached and the
    video's path, to look at only when the transcript isn't enough.
  - **Claude in Slack:** a catch-up digest (tray, panel, or daily); **Explain** for selected text; **Draft a reply with
    Claude** (in your style, as a draft, never sent); **Ctrl+Shift+K** checks a message for unclear asks, missing
    context and tone.
  - **Code:** code blocks get Copy, Open in editor, Run in terminal (asks first), Gist (asks first) and Send to
    Claude Code; files named in a message (stack traces) open in your editor; GitHub pull request, issue and Actions
    run cards update live, with Ask Claude to review (its prompt set in the panel's Settings tab; by default "Review
    the PR {pr} focusing only on major business logic issues. No nit-picking") and Watch (a reminder when the run ends).
  - **Agents:** a panel (Ctrl+Alt+P) with your Claude Code sessions; a session's permission request can be allowed or
    denied from Slack (or with `y`/`n` in a thread of your DM, from your phone); **Make this a Claude Code task**
    starts a session in the workspace's folder that drafts its result into the thread; **Create an issue with Claude**
    has that session write a ticket from the thread, its videos' transcripts and, only when needed, frames from them.
  - **Focus mode** (do not disturb, with Claude letting urgent mentions through and a summary afterwards), **search**
    across Slack, Notion and your repositories, a **secret guard** before sending (API keys, tokens, private keys,
    `.env` lines; checked on your computer), and **snippets** (type `;;`, with `{{commits}}`, `{{date}}`,
    `{{ai: ...}}`).
- **Edited and deleted messages keep a copy:** a deleted message stays where it was, dimmed and marked "Deleted" (until
  Slack reloads that conversation); an edited message gets "earlier version" next to Slack's "(edited)". Every copy is
  saved to `%APPDATA%\Slack\powertoys\history\messages.jsonl` before the message is marked, and listed in the panel's
  History tab. Only what your Slack sees while it runs is kept.
- **Louder videos:** pointing at a video shows a "Louder" slider, 100% to 300%, on top of Slack's own volume.
- **More from each recording:** a transcript with who spoke (from Slack's live captions, also as a subtitle track);
  **★ Mark** (or Ctrl+Shift+M) in the huddle window to mark a moment, which becomes a chapter; stills of the screen
  whenever it changes a lot (a new slide, another shared screen). Share with Claude hands all three over before the
  video. **Propose tickets** asks the session you pick for comments and new tickets in your Notion Issues database,
  creating nothing until you approve each one.
- **Brief:** a faint "Brief" chip in the huddle window. In the daily standup it summarizes what of yours was released
  since the previous working day (your team's release-bot posts) and your tickets in flight, for "What are you working
  on? Blocked? Done by?" (`"standup": {"channel", "time", "releaseChannel", "githubUser"}`). In other calls: what's
  open with that person or channel lately, the tickets mentioned and their status, and the last recorded call.
- **Tickets next to messages** (Notion read as you; `"notion": {"issues", "people", "ticketPrefix"}`): pointing at a
  ticket ID like "ISS-1780" in a message shows its title and status, and clicking it opens it; **Link to a ticket**
  in the message menu adds the thread's link to the ticket it's about, after you confirm the comment; a thread that
  started a Claude Code session shows that session's title and whether it's working; the Digest tab lists your
  tickets' status changes since yesterday and the ones in flight, with a **Standup summary** button.
- **Auto-start for a copy run from its own folder:** with no Squirrel launcher (`slack.exe`) one folder up, "Launch
  on login" registers the running executable itself.
- **Mods:** CSS and JavaScript files in `%APPDATA%\Slack\powertoys\mods\` are inserted into, and run in, Slack's
  pages each time they load. `*.css` restyles Slack; `*.js` can add behaviour. Mods are read fresh on every load, so
  a change takes effect when Slack reloads.
- **Settings:** `%APPDATA%\Slack\powertoys\settings.json` (`{"mods": false}` turns mods off).
- **Logging:** Powertoys writes to Slack's own log (`%APPDATA%\Slack\logs\default\browser.log`) with a
  `[powertoys]` prefix.
- **An in-page module** started with the page's store, where page features go.

## How the patches avoid containing Slack's code

New files are Powertoys code and are stored as they are. An edit to one of the app's own files is stored so that
nothing of that file is in the patch. The patcher reconstructs the edited file from **your** copy:

- each hunk gives the 0-based line where it goes, how many of your lines it replaces, and their SHA-256 (never their
  text);
- each new line is a list of parts: text written for Powertoys, or a `[line, start, end]` range copied from your copy;
- the whole file's SHA-256 before and after, so a different base is refused and the result is checked.

## Every change to the app's own files

| File | What it does |
|---|---|
| `src/main.bundle.cjs/33229-main/0050.js` | One line after the app's start-up returns its store: `__webpack_require__("powertoys/main").start(appStore)`. |
| `src/main.bundle.cjs/33229-main/0037.js` | One line in the tray menu's builder, before Preferences: `__webpack_require__("powertoys/main").addTrayItems(menu)`. |
| `src/main.bundle.cjs/6440-windows-startup-login-items.js` | Windows auto-start: when there is no `slack.exe` one folder up, register the running executable with `--startup` only. |
| `src/preload.bundle.js/_runtime.js` | One line after the preload creates its store: `webpackRequire("powertoys/page").start(store)`. |
| `src/main.bundle.cjs/_bundle.json`, `src/preload.bundle.js/_bundle.json` | Add the new modules to their bundles. |

## What the patches apply to

The patches are for **Slack 4.52.182 for Windows**, laid out as the paths in `patches.json` show. Every edited file is
checked by SHA-256, so the patches apply only to byte-identical files and refuse anything else.

## Applying them

```
node patcher/apply-patches.mjs patches <your-copy> --check   # report only
node patcher/apply-patches.mjs patches <your-copy>           # apply
```

- **Checked before anything is written.** Each edited file must match its base hash, and each hunk's lines theirs.
  A new file must not collide with a different file already there. If anything fails, **nothing** is written.
- **Checked after.** Each patched file must match its result hash.
- **Applying twice is refused.**

## How the package was checked

1. **Applied to unmodified files, it reproduces the Powertoys build byte for byte.**
2. **No line of the package repeats a line of the app (40 characters or more)**, except generic ones in the new
   modules: their module wrapper, `(function (module, exports, __webpack_require__) {`, `require` calls of the
   `electron`, `path`, `http` and `crypto` modules, and `return new Promise((resolve, reject) => {`.
3. **Applying it twice is refused**, as is applying it to any other files.
