// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): push to talk's keyboard shortcut (started by powertoys/huddle while a huddle is on).
//
// The shortcut is held, not pressed, and works whatever window is in front: Electron's global shortcuts only say when
// a key goes down, so a small helper (Windows PowerShell running a few lines of C#) reads the keys' state every 15 ms
// (GetAsyncKeyState) and prints "down" when all of the shortcut's keys are held and "up" when one is let go. The keys
// still reach the window in front (nothing is swallowed), so the default is modifiers only, which type nothing and
// do nothing held alone (Ctrl+Alt+Space, the first default, kept sending Space to the window in front while held):
// "huddle": { "pushToTalk": "Ctrl+Shift" } (keys joined with +: Ctrl, Alt, Shift, Win, LeftCtrl, RightCtrl,
// LeftAlt, RightAlt, LeftShift, RightShift, Space, A-Z, 0-9, F1-F24, CapsLock, ScrollLock, Pause, Insert, Home, End,
// PageUp, PageDown, Backquote, Mouse4, Mouse5, Mouse3, or a virtual-key code as a number); null or "" turns it off.
// The helper exits when Slack does (it checks every second that Slack's process is still there).
// ---------------------------------------------------------------------------------------------
(function (module, exports, __webpack_require__) {
  "use strict";

  const fs = __webpack_require__(79896);
  const path = __webpack_require__(16928);
  const os = __webpack_require__(48161);
  const childProcess = __webpack_require__(35317);
  const { log, warn } = __webpack_require__("powertoys/main");

  const DEFAULT_KEYS = "Ctrl+Shift";

  // Windows' virtual-key codes, by the names the setting uses.
  const KEYS = {
    ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10, win: 0x5b, meta: 0x5b,
    leftctrl: 0xa2, rightctrl: 0xa3, leftalt: 0xa4, rightalt: 0xa5, altgr: 0xa5, leftshift: 0xa0, rightshift: 0xa1,
    space: 0x20, capslock: 0x14, scrolllock: 0x91, pause: 0x13, insert: 0x2d, home: 0x24, end: 0x23,
    pageup: 0x21, pagedown: 0x22, backquote: 0xc0, "`": 0xc0, mouse3: 0x04, mouse4: 0x05, mouse5: 0x06,
  };
  /** "Ctrl+Shift" -> { codes: [0x11, 0x10] }, or { error } when a key isn't known. */
  function keyCodes(shortcut) {
    const codes = [];
    for (const part of String(shortcut).split("+").map((each) => each.trim()).filter(Boolean)) {
      const name = part.toLowerCase();
      if (KEYS[name] !== undefined) codes.push(KEYS[name]);
      else if (/^[a-z0-9]$/.test(name)) codes.push(name.toUpperCase().charCodeAt(0));
      else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(name)) codes.push(0x6f + Number(name.slice(1)));
      else if (/^\d+$/.test(name) && Number(name) > 0 && Number(name) < 256) codes.push(Number(name));
      else return { error: `"${part}" isn't a key push to talk knows` };
    }
    return codes.length ? { codes } : { error: "no keys" };
  }

  const WATCH_SCRIPT = `
param([string]$Keys, [int]$Parent)
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class PowertoysTalk {
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  public static void Watch(int[] keys, int parent) {
    bool held = false;
    int ticks = 0;
    Console.Out.WriteLine("ready");
    Console.Out.Flush();
    while (true) {
      bool now = true;
      foreach (int key in keys) if ((GetAsyncKeyState(key) & 0x8000) == 0) { now = false; break; }
      if (now != held) { held = now; Console.Out.WriteLine(held ? "down" : "up"); Console.Out.Flush(); }
      Thread.Sleep(15);
      if (++ticks % 66 == 0) { try { if (Process.GetProcessById(parent).HasExited) return; } catch (ArgumentException) { return; } }
    }
  }
}
'@
[PowertoysTalk]::Watch([int[]]($Keys -split ','), $Parent)
`;

  let child = null;
  let shortcut = null;

  /**
   * Watches the shortcut (the setting, else Ctrl+Shift) until stop(); onEdge("down" | "up") as it is held and let
   * go -> the shortcut watched, or null (off, or not understood: logged).
   */
  exports.start = function start(setting, onEdge) {
    exports.stop();
    if (setting === null || setting === false || setting === "") return null;
    const wanted = typeof setting === "string" ? setting : DEFAULT_KEYS;
    const parsed = keyCodes(wanted);
    if (parsed.error) return (warn(`push to talk: the shortcut "${wanted}" isn't used: ${parsed.error}`), null);
    const script = path.join(os.tmpdir(), "powertoys-talk.ps1");
    fs.writeFileSync(script, WATCH_SCRIPT);
    const watching = childProcess.spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Keys", parsed.codes.join(","), "-Parent", String(process.pid)],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    child = watching;
    shortcut = wanted;
    let pending = "";
    let errors = "";
    let held = false;
    watching.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines.map((each) => each.trim())) {
        if (line === "ready") log(`push to talk: hold ${wanted} to talk`);
        else if (line === "down" || line === "up") {
          held = line === "down";
          onEdge(line);
        }
      }
    });
    watching.stderr.on("data", (chunk) => (errors = `${errors}${chunk}`.slice(-2000)));
    watching.on("error", (caught) => warn(`push to talk: the key watcher didn't start: ${caught.message}`));
    watching.on("exit", (code) => {
      if (child === watching) child = null;
      // Let go if it stops while the keys were held (the microphone isn't left on).
      if (held) onEdge("up");
      if (!watching.stoppedByUs) warn(`push to talk: the key watcher stopped (${code})${errors.trim() ? `: ${errors.trim().split(/\r?\n/).slice(-3).join(" ")}` : ""}`);
    });
    return wanted;
  };

  exports.stop = function stop() {
    if (!child) return;
    child.stoppedByUs = true;
    child.kill();
    child = null;
    log(`push to talk: ${shortcut} no longer watched`);
  };

  exports.shortcut = () => (child ? shortcut : null);
});
