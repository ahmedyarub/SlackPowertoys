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

`patches/patches.json` lists 6 files:

- **2 new files** (`"kind": "add"`), written for Powertoys:
  - `src/main.bundle.cjs/powertoys-main.js`: the main-process half (module id `"powertoys/main"`).
  - `src/preload.bundle.js/powertoys-page.js`: the in-page half (module id `"powertoys/page"`).
- **4 edits** (`"kind": "edit"`) to the app's own files: two one-line hooks that start the two halves, and two
  manifest entries that add the new modules to their bundles.

## What Powertoys adds

This first release is the foundation the features build on:

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
2. **No line of the package repeats a line of the app (40 characters or more)**, except three generic ones in the
   new main-process module: its module wrapper, `(function (module, exports, __webpack_require__) {`, and two
   `require` calls of Electron's `path` and `electron` modules.
3. **Applying it twice is refused**, as is applying it to any other files.
