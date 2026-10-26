// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): developer tools. GitHub through the gh CLI (signed in as you), link titles, opening
// files in your editor, running a command in a terminal (after you confirm), gists, searching a repository.
// Settings (settings.json): "dev": { "editor": "code" | "idea" | "cursor", "shell": "pwsh" | "bash",
//   "repos": { "<owner>/<repo>": "<folder>" } }. A workspace's Claude folder ("claude.folders") counts as a repository
//   folder too.
// ---------------------------------------------------------------------------------------------
(function (module, exports, __webpack_require__) {
  "use strict";

  const electron = __webpack_require__(84157);
  const fs = __webpack_require__(79896);
  const path = __webpack_require__(16928);
  const os = __webpack_require__(48161);
  const childProcess = __webpack_require__(35317);
  const { log, warn, readSettings } = __webpack_require__("powertoys/main");

  const settings = () => ({ editor: "code", shell: "pwsh", repos: {}, ...readSettings().dev });

  function run(command, args, { input = null, cwd = undefined, timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = childProcess.spawn(command, args, { cwd, windowsHide: true, shell: process.platform === "win32" && /\.(cmd|bat)$|^(code|idea|cursor)$/.test(command) });
      let out = "";
      let err = "";
      const timer = setTimeout(() => (child.kill(), reject(new Error(`${command} took too long`))), timeoutMs);
      child.stdout?.on("data", (chunk) => (out += chunk));
      child.stderr?.on("data", (chunk) => (err += chunk));
      child.on("error", (caught) => (clearTimeout(timer), reject(caught)));
      child.on("close", (code) => (clearTimeout(timer), code === 0 ? resolve(out) : reject(new Error(err.trim().split("\n").pop() || `${command} exited with ${code}`))));
      if (input !== null) child.stdin.end(input);
    });
  }

  // --- GitHub ----------------------------------------------------------------------------------------------
  const gh = async (route) => JSON.parse(await run("gh", ["api", route]));

  /** { kind: "pull" | "issue" | "run", owner, repo, number } for a GitHub link, else null. */
  function parseGitHub(url) {
    const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues|actions\/runs)\/(\d+)/.exec(url);
    if (!match) return null;
    return { kind: match[3] === "pull" ? "pull" : match[3] === "issues" ? "issue" : "run", owner: match[1], repo: match[2], number: Number(match[4]) };
  }
  exports.parseGitHub = parseGitHub;

  const cache = new Map();
  function cached(key, ms, load) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ms) return hit.value;
    const value = load().catch((caught) => (cache.delete(key), Promise.reject(caught)));
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  /** What a GitHub card shows, for a pull request, an issue or an Actions run. */
  function githubInfo(url, fresh = false) {
    const ref = parseGitHub(url);
    if (!ref) return Promise.reject(new Error("not a GitHub pull request, issue or run link"));
    const base = `repos/${ref.owner}/${ref.repo}`;
    if (fresh) cache.delete(url);
    return cached(url, 60e3, async () => {
      if (ref.kind === "run") {
        const run2 = await gh(`${base}/actions/runs/${ref.number}`);
        let failing = [];
        if (run2.conclusion === "failure") {
          const { jobs = [] } = await gh(`${base}/actions/runs/${ref.number}/jobs`).catch(() => ({}));
          failing = jobs.filter((job) => job.conclusion === "failure").map((job) => job.name);
        }
        return { ...ref, url, title: run2.display_title || run2.name, workflow: run2.name, branch: run2.head_branch, status: run2.status, conclusion: run2.conclusion, failing, updatedAt: run2.updated_at };
      }
      if (ref.kind === "issue") {
        const issue = await gh(`${base}/issues/${ref.number}`);
        return { ...ref, url, title: issue.title, state: issue.state, author: issue.user?.login, labels: issue.labels.map((l) => l.name), assignees: issue.assignees.map((a) => a.login), comments: issue.comments, isPull: Boolean(issue.pull_request) };
      }
      const pull = await gh(`${base}/pulls/${ref.number}`);
      const [reviews, checks] = await Promise.all([gh(`${base}/pulls/${ref.number}/reviews`).catch(() => []), gh(`${base}/commits/${pull.head.sha}/check-runs?per_page=100`).catch(() => ({ check_runs: [] }))]);
      const latest = new Map();
      for (const review of reviews) if (review.state !== "COMMENTED") latest.set(review.user?.login, review.state);
      const states = [...latest.values()];
      const runs = checks.check_runs ?? [];
      return {
        ...ref,
        url,
        title: pull.title,
        state: pull.merged ? "merged" : pull.state,
        draft: pull.draft,
        author: pull.user?.login,
        branch: pull.head.ref,
        additions: pull.additions,
        deletions: pull.deletions,
        files: pull.changed_files,
        review: states.includes("CHANGES_REQUESTED") ? "changes requested" : states.includes("APPROVED") ? "approved" : "review pending",
        checks: {
          total: runs.length,
          passed: runs.filter((r) => r.conclusion === "success" || r.conclusion === "skipped" || r.conclusion === "neutral").length,
          failed: runs.filter((r) => ["failure", "timed_out", "cancelled", "action_required"].includes(r.conclusion)).map((r) => r.name),
          running: runs.filter((r) => r.status !== "completed").length,
        },
      };
    });
  }
  exports.githubInfo = githubInfo;

  // --- Link titles -----------------------------------------------------------------------------------------
  const decode = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").trim();

  /** A page's title from its HTML (og:title, else <title>), or null; sign-in pages do not count. */
  async function htmlTitle(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await electron.net.fetch(url, { signal: controller.signal, redirect: "follow" });
      if (!response.ok || !/html/.test(response.headers.get("content-type") ?? "")) return null;
      const html = (await response.text()).slice(0, 300000);
      const og = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html) ?? /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i.exec(html);
      const title = decode(og?.[1] ?? /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1] ?? "");
      return title && !/^(sign in|log in|login|just a moment|access denied)\b/i.test(title) ? title.slice(0, 200) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A link's title: Notion (API; "ISS-1995 Title" for a ticket), GitHub (gh), else the page's own title. A Notion link
   * the API can't read gets none: the page's own title is just "Notion".
   */
  function linkTitle(url) {
    return cached(`title:${url}`, 10 * 60e3, async () => {
      const notion = __webpack_require__("powertoys/notion");
      if (notion.isNotionLink(url)) {
        if (!notion.configured()) return null;
        const info = await notion.pageInfo(url);
        return info.ticketId ? `${info.ticketId} ${info.title}` : info.title;
      }
      const ref = parseGitHub(url);
      if (ref && ref.kind !== "run") {
        const info = await githubInfo(url);
        return `${info.title} (${ref.repo}#${ref.number})`;
      }
      if (ref) return `${(await githubInfo(url)).title} (${ref.repo} run)`;
      return htmlTitle(url);
    });
  }
  exports.linkTitle = linkTitle;

  // --- Files and editors -----------------------------------------------------------------------------------
  /** The folders to look for files in: the workspace's Claude folder, then the repositories in settings. */
  function folders(teamId = null) {
    const claudeFolders = readSettings().claude?.folders ?? {};
    return [...new Set([claudeFolders[teamId], ...Object.values(settings().repos), ...Object.values(claudeFolders)].filter((each) => each && fs.existsSync(each)))];
  }
  exports.folders = folders;

  /** The folder of a GitHub repository: settings.dev.repos, else a folder whose git remote is that repository. */
  async function repoFolder(owner, repo) {
    const configured = settings().repos[`${owner}/${repo}`];
    if (configured) return configured;
    for (const folder of folders()) {
      const remote = await run("git", ["-C", folder, "remote", "get-url", "origin"]).catch(() => "");
      if (new RegExp(`[/:]${owner}/${repo}(\\.git)?\\s*$`, "i").test(remote)) return folder;
    }
    return null;
  }
  exports.repoFolder = repoFolder;

  function findByName(root, name, depth = 0) {
    if (depth > 6) return null;
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) if (entry.isFile() && entry.name === name) return path.join(root, entry.name);
    for (const entry of entries) {
      if (!entry.isDirectory() || /^(node_modules|\.git|dist|build|out|target|\.next|vendor)$/.test(entry.name)) continue;
      const found = findByName(path.join(root, entry.name), name, depth + 1);
      if (found) return found;
    }
    return null;
  }

  /** A file a stack trace or message names, in the given folders: as is, relative, then by a shorter tail, then by name. */
  function resolveFile(ref, teamId = null) {
    const clean = String(ref).replace(/^file:\/\/\/?/, "").replace(/^\.\//, "");
    if (path.isAbsolute(clean) && fs.existsSync(clean)) return clean;
    const parts = clean.split(/[\\/]/).filter(Boolean);
    for (const folder of folders(teamId)) {
      for (let i = 0; i < parts.length; i++) {
        const candidate = path.join(folder, ...parts.slice(i));
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      }
    }
    for (const folder of folders(teamId)) {
      const found = findByName(folder, parts[parts.length - 1]);
      if (found) return found;
    }
    return null;
  }
  exports.resolveFile = resolveFile;

  /** Open a file at a line in the editor of settings.dev.editor. */
  async function openInEditor(file, line = 1, column = 1) {
    const { editor } = settings();
    const args = editor === "idea" ? ["--line", String(line), file] : ["-g", `${file}:${line}:${column}`];
    const child = childProcess.spawn(editor, args, { detached: true, stdio: "ignore", shell: process.platform === "win32", windowsHide: true });
    child.unref();
    log(`opened a file in ${editor}`);
  }
  exports.openInEditor = openInEditor;

  /** A snippet in a scratch file (by its language), opened in the editor. */
  async function openSnippet(code, language = "txt") {
    const dir = path.join(os.tmpdir(), "slack-powertoys-snippets");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `snippet-${Date.now()}.${language}`);
    fs.writeFileSync(file, code);
    await openInEditor(file);
    return file;
  }
  exports.openSnippet = openSnippet;

  /** Run a command in a new terminal, after you confirm it (it comes from a message). */
  async function runInTerminal(command, cwd, window) {
    const { response } = await electron.dialog.showMessageBox(window, {
      type: "warning",
      title: "Run this command?",
      message: "Run this command from a Slack message in a new terminal?",
      detail: `${command}\n\nIn: ${cwd ?? os.homedir()}\n\nOnly run commands you trust.`,
      buttons: ["Run", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return false;
    const folder = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    const shell = settings().shell === "bash" ? ["C:\\Program Files\\Git\\bin\\bash.exe", "-c", `${command}; exec bash`] : ["pwsh", "-NoExit", "-Command", command];
    const child = childProcess.spawn("wt", ["-d", folder, ...shell], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    log("ran a command from a message in a terminal");
    return true;
  }
  exports.runInTerminal = runInTerminal;

  /** A secret gist of a snippet (after you confirm) -> its URL. */
  async function createGist(code, language, window) {
    const { response } = await electron.dialog.showMessageBox(window, {
      type: "question",
      title: "Create a gist?",
      message: "Create a secret GitHub gist of this snippet, under your GitHub account?",
      detail: code.length > 600 ? `${code.slice(0, 600)}…` : code,
      buttons: ["Create gist", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return null;
    const url = (await run("gh", ["gist", "create", "--filename", `snippet.${language || "txt"}`, "-"], { input: code })).trim().split("\n").pop();
    electron.clipboard.writeText(url);
    log("created a gist");
    return url;
  }
  exports.createGist = createGist;

  // --- Repository search and history -----------------------------------------------------------------------
  /** git grep in the repository folders -> [{ folder, file, line, text }] (at most 30). */
  async function searchCode(query, teamId = null) {
    const found = [];
    for (const folder of folders(teamId)) {
      const out = await run("git", ["-C", folder, "grep", "-n", "-I", "-i", "--max-count=3", "-F", "-e", query], { timeoutMs: 15000 }).catch(() => "");
      for (const line of out.split("\n").filter(Boolean)) {
        const match = /^(.+?):(\d+):(.*)$/.exec(line);
        if (match) found.push({ folder, file: path.join(folder, match[1]), relative: match[1], line: Number(match[2]), text: match[3].trim().slice(0, 200) });
        if (found.length >= 30) return found;
      }
    }
    return found;
  }
  exports.searchCode = searchCode;

  /** Your commits since yesterday in the workspace's folder (for snippets). */
  async function recentCommits(teamId = null) {
    const [folder] = folders(teamId);
    if (!folder) return "";
    const email = (await run("git", ["-C", folder, "config", "user.email"]).catch(() => "")).trim();
    return (await run("git", ["-C", folder, "log", "--since=yesterday", ...(email ? [`--author=${email}`] : []), "--pretty=format:- %s (%h)"]).catch(() => "")).trim();
  }
  exports.recentCommits = recentCommits;

  // --- Watching an Actions run -----------------------------------------------------------------------------
  const watching = new Map();
  /** Poll a run until it finishes; onChange(info) on each change, then a Slackbot reminder. */
  function watchRun(url, onChange, onDone) {
    if (watching.has(url)) return false;
    let last = null;
    const tick = async () => {
      try {
        const info = await githubInfo(url, true);
        const key = `${info.status}/${info.conclusion}`;
        if (key !== last) {
          last = key;
          onChange(info);
        }
        if (info.status === "completed") {
          clearInterval(watching.get(url));
          watching.delete(url);
          onDone(info);
        }
      } catch (caught) {
        warn(`watch run: ${caught.message}`);
      }
    };
    watching.set(url, setInterval(tick, 30000));
    tick();
    return true;
  }
  exports.watchRun = watchRun;
});
