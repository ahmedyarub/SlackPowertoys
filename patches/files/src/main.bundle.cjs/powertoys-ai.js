// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): Claude for Powertoys' features, through the Claude Code CLI (`claude -p`), signed in as
// you (no API key). A lean call: Powertoys' own system prompt, no tools unless a feature asks for read-only ones, no
// MCP servers, no settings or CLAUDE.md files, nothing saved. Or a prompt added to one of your Claude Code sessions.
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

  /** Runs `claude <args>` with the prompt on stdin, in cwd -> its JSON result. */
  function run(args, prompt, cwd, timeoutMs) {
    return new Promise((resolve, reject) => {
      // Without ANTHROPIC_API_KEY, so Claude Code uses the claude.ai sign-in (the Max plan), not an API key.
      const { ANTHROPIC_API_KEY, ...env } = process.env;
      const child = childProcess.spawn(claudePath(), args, { cwd: cwd && fs.existsSync(cwd) ? cwd : os.tmpdir(), windowsHide: true, env });
      let out = "";
      let err = "";
      const timer = setTimeout(() => (child.kill(), reject(new Error("Claude took too long"))), timeoutMs);
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      child.on("error", (caught) => (clearTimeout(timer), reject(new Error(`could not start Claude: ${caught.message}`))));
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 && !out) return reject(new Error(err.trim().split("\n").pop() || `Claude exited with ${code}`));
        let result;
        try {
          result = JSON.parse(out);
        } catch {
          return reject(new Error(`Claude's answer could not be read: ${out.slice(0, 200)}`));
        }
        if (result.is_error) reject(new Error(result.result || "Claude failed"));
        else resolve(result);
      });
      child.stdin.end(prompt);
    });
  }

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
      const result = await run(args, prompt, cwd, timeoutMs);
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

  /**
   * Adds a prompt to one of your Claude Code sessions (`claude -p --resume`), with its own settings and tools (and its
   * model, unless `model` says otherwise), as if you had typed it there; the question and answer stay in the session.
   * -> the answer text.
   */
  const sessionCosts = new Map(); // session id -> its running total, as last reported
  async function askSession({ sessionId, cwd, prompt, model = null, timeoutMs = 180000 }) {
    await slot();
    try {
      const started = Date.now();
      const result = await run(["-p", "--output-format", "json", "--resume", sessionId, ...(model ? ["--model", model] : [])], prompt, cwd, timeoutMs);
      // A resumed session reports its running total; the difference is what this prompt cost.
      const total = result.total_cost_usd ?? 0;
      const cost = sessionCosts.has(sessionId) ? total - sessionCosts.get(sessionId) : null;
      sessionCosts.set(sessionId, total);
      log(`ai: session ${sessionId}${model ? ` (${model})` : ""}, ${Math.round((Date.now() - started) / 1000)}s, ${cost === null ? `session total $${total.toFixed(4)}` : `$${cost.toFixed(4)}`}`);
      return String(result.result ?? "").trim();
    } catch (caught) {
      warn(`ai: session ${sessionId}: ${caught.message}`);
      throw caught;
    } finally {
      release();
    }
  }

  /** Starts a Claude Code session in cwd with a prompt (saved like any session, with your settings) -> { text, sessionId }. */
  async function askNew({ cwd, prompt, model = null, timeoutMs = 180000 }) {
    await slot();
    try {
      const started = Date.now();
      const result = await run(["-p", "--output-format", "json", ...(model ? ["--model", model] : [])], prompt, cwd, timeoutMs);
      log(`ai: new session ${result.session_id}${model ? ` (${model})` : ""}, ${Math.round((Date.now() - started) / 1000)}s, $${(result.total_cost_usd ?? 0).toFixed(4)}`);
      return { text: String(result.result ?? "").trim(), sessionId: result.session_id };
    } catch (caught) {
      warn(`ai: new session: ${caught.message}`);
      throw caught;
    } finally {
      release();
    }
  }

  exports.ask = ask;
  exports.askNew = askNew;
  exports.askSession = askSession;
  exports.claudePath = claudePath;
  exports.fastModel = () => settings().fastModel;
});
