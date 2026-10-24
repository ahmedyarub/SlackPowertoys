// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): Claude for Powertoys' features, through the Claude Code CLI (`claude -p`), signed in as
// you (no API key). A lean call: Powertoys' own system prompt, no tools unless a feature asks for read-only ones, no
// MCP servers, no settings or CLAUDE.md files, nothing saved.
// Settings (settings.json): "ai": { "model": "sonnet", "fastModel": "haiku", "claudePath": null }
// ---------------------------------------------------------------------------------------------
(function (module, exports, __webpack_require__) {
  "use strict";

  const fs = __webpack_require__(79896);
  const path = __webpack_require__(16928);
  const os = __webpack_require__(48161);
  const childProcess = __webpack_require__(35317);
  const { log, warn, readSettings } = __webpack_require__("powertoys/main");

  const DEFAULTS = { model: "sonnet", fastModel: "haiku", claudePath: null };
  const settings = () => ({ ...DEFAULTS, ...readSettings().ai });

  /** The claude CLI: the setting, then PATH (~/.local/bin), then the newest one Claude Desktop installed. */
  function claudePath() {
    const configured = settings().claudePath;
    if (configured) return configured;
    const local = path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
    if (fs.existsSync(local)) return local;
    const desktop = path.join(process.env.APPDATA ?? "", "Claude", "claude-code");
    const found = [];
    for (const version of fs.existsSync(desktop) ? fs.readdirSync(desktop) : []) {
      for (const hash of fs.readdirSync(path.join(desktop, version))) {
        const exe = path.join(desktop, version, hash, "claude.exe");
        if (fs.existsSync(exe)) found.push({ exe, time: fs.statSync(exe).mtimeMs });
      }
    }
    return found.sort((a, b) => b.time - a.time)[0]?.exe ?? "claude";
  }

  const SYSTEM =
    "You help a software developer inside Slack. Be concise and concrete. Write plain text with simple markdown " +
    "(short paragraphs, '-' lists, `code`); no preamble, no closing remarks.";

  let running = 0;
  const waiting = [];
  const slot = () => (running < 3 ? (running++, Promise.resolve()) : new Promise((resolve) => waiting.push(resolve)));
  const release = () => (waiting.length ? waiting.shift()() : running--);

  /**
   * Ask Claude. { prompt, system?, fast?: true for the fast model, cwd?: a folder it may read (then the tools are
   * Read, Grep and Glob), json?: parse the answer as JSON, timeoutMs? } -> the answer text (or parsed JSON).
   */
  async function ask({ prompt, system = SYSTEM, fast = false, cwd = null, json = false, timeoutMs = 180000 }) {
    await slot();
    try {
      const { model, fastModel } = settings();
      const tools = cwd ? ["Read", "Grep", "Glob"] : [];
      const args = [
        "-p",
        "--output-format", "json",
        "--model", fast ? fastModel : model,
        "--tools", tools.join(",") || "",
        ...(tools.length ? ["--allowed-tools", ...tools] : []),
        "--strict-mcp-config",
        "--setting-sources", "",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--system-prompt", json ? `${system}\nAnswer with JSON only, no code fence.` : system,
      ];
      const started = Date.now();
      const output = await new Promise((resolve, reject) => {
        const child = childProcess.spawn(claudePath(), args, { cwd: cwd && fs.existsSync(cwd) ? cwd : os.tmpdir(), windowsHide: true });
        let out = "";
        let err = "";
        const timer = setTimeout(() => (child.kill(), reject(new Error("Claude took too long"))), timeoutMs);
        child.stdout.on("data", (chunk) => (out += chunk));
        child.stderr.on("data", (chunk) => (err += chunk));
        child.on("error", (caught) => (clearTimeout(timer), reject(new Error(`could not start Claude: ${caught.message}`))));
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0 && !out) reject(new Error(err.trim().split("\n").pop() || `Claude exited with ${code}`));
          else resolve(out);
        });
        child.stdin.end(prompt);
      });
      const result = JSON.parse(output);
      if (result.is_error) throw new Error(result.result || "Claude failed");
      log(`ai: ${fast ? "fast" : "main"} model, ${Math.round((Date.now() - started) / 1000)}s, $${(result.total_cost_usd ?? 0).toFixed(4)}`);
      const text = String(result.result ?? "").trim();
      if (!json) return text;
      return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } catch (caught) {
      warn(`ai: ${caught.message}`);
      throw caught;
    } finally {
      release();
    }
  }

  exports.ask = ask;
  exports.claudePath = claudePath;
});
