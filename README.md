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

`patches/patches.json` lists 9 files:

- **3 new files** (`"kind": "add"`), written for Powertoys:
  - `src/main.bundle.cjs/powertoys-main.js`: the main-process half (module id `"powertoys/main"`).
  - `src/preload.bundle.js/powertoys-page.js`: the in-page half (module id `"powertoys/page"`).
  - `mcp/slack-transcripts.mjs`: an MCP server for Claude Desktop (runs on its own with Node, outside Slack).
- **6 edits** (`"kind": "edit"`) to the app's own files: three one-line hooks (start the two halves, add the tray
  menu item), two manifest entries that add the new modules to their bundles, and a small change to Windows
  auto-start.

## What Powertoys adds

- **Mark everything as read**, in every signed-in workspace (a tray menu item) or in one (right-click a workspace
  icon). It marks each channel, DM and group DM with unreads as read at its latest message, the same Web API calls
  Slack's own "Mark all as read" makes; Slack then updates its sidebar itself.
- **Slack clip transcripts for Claude Desktop.** While Slack runs, Powertoys serves clip transcripts (what Slack shows
  under "View transcript") on `127.0.0.1`, with a random port and a bearer token written to
  `%APPDATA%Slackpowertoysridge.json` (removed when Slack quits; `{"bridge": false}` in `settings.json`
  turns it off). `mcp/slack-transcripts.mjs` is a dependency-free MCP server over it, with two tools:
  `get_slack_clip_transcript` (a message link, a file link or a file id) and `list_slack_clips`. Add it to Claude
  Desktop in `%APPDATA%Claudeclaude_desktop_config.json` and restart Claude Desktop:

  ```json
  "mcpServers": {
    "slack-transcripts": { "command": "C:/Program Files/nodejs/node.exe", "args": ["<your-copy>/mcp/slack-transcripts.mjs"] }
  }
  ```
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
| `src/main.bundle.cjs/6440.js` | Windows auto-start: when there is no `slack.exe` one folder up, register the running executable with `--startup` only. |
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
2. **No line of the package repeats a line of the app (40 characters or more)**, except seven generic ones in the
   two new modules: their module wrapper, `(function (module, exports, __webpack_require__) {`, and `require` calls of
   the `electron`, `path`, `http` and `crypto` modules.
3. **Applying it twice is refused**, as is applying it to any other files.
