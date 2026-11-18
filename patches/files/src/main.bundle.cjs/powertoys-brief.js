// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): the brief from the "Brief" chip in a huddle window, in any huddle, at any time.
//
// Only your tickets with something in the past 24 hours, a line each: its ID and name, where it is (Production with
// its release, UAT, Acceptance testing, Dev, Done, Code review, In progress, Blocked), what it was before if its status
// changed, and its PRs (merged, open, closed). From your PRs (gh, dev.repos) updated in the past 24 hours, your
// tickets' status changes in that time (Notion's page history) and Alfred's release posts (standup.releaseChannel,
// the lines "… [ISS-n] by @<standup.githubUser>"; a ticket's latest release in the last 7 days says where it is).
// Nothing else: no conversations, no recordings, no Claude-written text. It used to fall back to a "call brief" of the
// channel's conversation whenever the huddle wasn't recognised as the standup (e.g. 12 Nov, started at 12:01, a minute
// past the window), which is gone for good.
// ---------------------------------------------------------------------------------------------
(function (module, exports, __webpack_require__) {
  "use strict";

  const { log, warn, readSettings, slackPage, signedInTeams, api } = __webpack_require__("powertoys/main");
  const notion = () => __webpack_require__("powertoys/notion");

  const settings = () => ({ releaseChannel: null, githubUser: null, ...readSettings().standup });
  const HOURS = 24;

  async function teamOf(teamId) {
    const teams = await signedInTeams(slackPage());
    return teams.find((team) => team.id === teamId) ?? teams[0];
  }

  /**
   * Alfred's release posts since `since` -> [{ env, version, at, items: [{ text, ticket, author, pr }] }]. The posts'
   * text has Slack's formatting: "*release_prod_v1.0.314* published to *PROD*", items "• … [ISS-1999] by @user in
   * <https://github.com/…/pull/1987|…>".
   */
  async function releases(team, since) {
    const { releaseChannel } = settings();
    if (!releaseChannel) throw new Error("standup.releaseChannel isn't set");
    const page = slackPage();
    const history = await api(page, team, "conversations.history", { channel: releaseChannel, oldest: String(since.getTime() / 1000), limit: 200 });
    if (!history.ok) throw new Error(`the release channel couldn't be read (${history.error})`);
    return parseReleases(history.messages ?? []);
  }
  function parseReleases(messages) {
    const found = [];
    for (const message of messages) {
      const text = String(message.text ?? "");
      const published = /(release_(?:prod|uat)_v[\d.]+)\*?\s+published to\s+\*?(PROD|UAT)\b/i.exec(text);
      if (!published) continue;
      const items = [...text.matchAll(/[•]\s*([^\n•]+?)\s*(?:\[([A-Z]+-\d+)\])?\s+by @([\w-]+)(?:\s+in\s+<?(https:\/\/github\.com\/[^\s|>]+))?/g)].map((match) => ({
        text: match[1].trim(),
        ticket: match[2] ?? null,
        author: match[3],
        pr: match[4] ?? null,
      }));
      found.push({ env: published[2].toUpperCase(), version: published[1], at: new Date(Number(message.ts) * 1000), items });
    }
    return found.sort((a, b) => a.at - b.at);
  }
  exports.parseReleases = parseReleases;

  const ticketsIn = (text, prefix) => [...new Set([...String(text).matchAll(new RegExp(`\\b${prefix}-(\\d+)\\b`, "gi"))].map((match) => `${prefix}-${match[1]}`))];

  /** Your PRs (gh, the repositories in dev.repos) updated since `since`, with their reviews and checks, newest first. */
  async function prsSince(since) {
    const found = [];
    for (const repo of Object.keys(readSettings().dev?.repos ?? {})) {
      const out = await __webpack_require__("powertoys/dev").ghAs(repo.split("/")[0], [
        "pr", "list", "-R", repo, "--author", "@me", "--state", "all", "--search", `updated:>=${since.toISOString().slice(0, 19)}Z`, "--limit", "40",
        "--json", "number,title,url,state,isDraft,createdAt,mergedAt,closedAt,updatedAt,headRefName,reviewDecision,latestReviews,statusCheckRollup",
      ]);
      found.push(...JSON.parse(out));
    }
    return found.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  /** A Notion page's id (32 hex digits) in any of its URLs. */
  const pageKey = (url) => /([0-9a-f]{32})/.exec(String(url ?? "").replace(/-/g, ""))?.[1] ?? null;

  /** My tickets with a merge, a status change or a release in the past 24 hours, a line each (Markdown). */
  async function brief(teamId) {
    const { githubUser } = settings();
    const prefix = notion().ticketPrefix();
    const since = new Date(Date.now() - HOURS * 3600e3);
    const problems = [];
    const team = await teamOf(teamId);
    // My PRs updated since then: opened, merged, closed.
    let recentPrs = [];
    try {
      recentPrs = await prsSince(since);
    } catch (caught) {
      problems.push(`pull requests: ${caught.message}`);
    }
    // My tickets whose status changed since then (Notion's history).
    let moved = [];
    let owned = new Map();
    try {
      const changes = (await notion().ticketChanges(since)).filter((change) => change.after.Status && change.after.Status !== change.before.Status);
      owned = new Map((await notion().myTicketsAmong(changes.map((change) => change.url))).map((t) => [pageKey(t.url), t]));
      moved = changes.filter((change) => owned.has(pageKey(change.url))).map((change) => ({ ...change, ticket: owned.get(pageKey(change.url)) }));
    } catch (caught) {
      problems.push(`ticket changes: ${caught.message}`);
    }
    // Where my tickets were released, the last 7 days (the latest release of each ticket).
    const lastRelease = new Map();
    try {
      if (!githubUser) problems.push("releases: standup.githubUser isn't set");
      for (const release of await releases(team, new Date(Date.now() - 7 * 86400e3)))
        for (const item of release.items) if (item.author === githubUser && item.ticket) lastRelease.set(item.ticket, { ...item, env: release.env, version: release.version, at: release.at });
    } catch (caught) {
      problems.push(`releases: ${caught.message}`);
    }
    // My tickets now, for the status of those touched only by a PR or a release.
    let current = [];
    try {
      current = await notion().myTickets();
    } catch (caught) {
      warn(`brief: my tickets: ${caught.message}`);
    }

    // Each ticket of mine with something since then, once: its PRs, its status change, its release.
    const touched = new Map();
    const entry = (id) => (touched.has(id) || touched.set(id, { id, prs: [] }), touched.get(id));
    const loosePrs = [];
    for (const pr of recentPrs) {
      const ids = ticketsIn(`${pr.title} ${pr.headRefName}`, prefix);
      if (!ids.length) loosePrs.push(pr);
      for (const id of ids) entry(id).prs.push(pr);
    }
    for (const change of moved) Object.assign(entry(change.ticket.id), { ticket: change.ticket, change });
    for (const [id, release] of lastRelease) if (release.at >= since) entry(id);
    const known = new Map([...current, ...owned.values()].map((t) => [t.id, t]));
    await Promise.all(
      [...touched.values()].map(async (each) => {
        each.ticket ??= known.get(each.id) ?? (await notion().ticket(each.id).catch(() => null)) ?? {
          id: each.id,
          // Not found in Notion: named by its release line or its PR ("fix(scope): what [ISS-n]" -> "what").
          title: lastRelease.get(each.id)?.text ?? String(each.prs[0]?.title ?? "").replace(/^\w+(\([^)]*\))?!?:\s*/, "").replace(/\s*\[[A-Z]+-\d+\]/g, ""),
          status: null,
          url: null,
        };
      }),
    );

    // Under a heading per status (Production, UAT, …, Code review, In progress): "ISS-1 (linked) **Title** — v1.0.335 ·
    // was … · #12 merged".
    const name = (t) => `${t.url ? `[${t.id}](${t.url})` : t.id} **${String(t.title ?? "").replace(/\s+/g, " ").trim()}**`;
    const prText = (pr) => `[#${pr.number}](${pr.url}) ${pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed without merging" : pr.isDraft ? "open, draft" : "open"}`;
    const line = (t, where, { prs = [], was } = {}) =>
      `- ${name(t)}${where.detail ? ` — ${where.detail}` : ""}${was && was !== t.status ? ` · was ${was}` : ""}${prs.length ? ` · ${prs.map(prText).join(" · ")}` : ""}`;
    const tickets = [...touched.values()]
      .map((each) => ({ ...each, where: stage(each.ticket, lastRelease.get(each.id)) }))
      .sort((a, b) => a.where.rank - b.where.rank || a.id.localeCompare(b.id, undefined, { numeric: true }));
    const groups = new Map();
    for (const each of tickets) {
      if (!groups.has(each.where.group)) groups.set(each.where.group, []);
      groups.get(each.where.group).push(line(each.ticket, each.where, { prs: each.prs, was: each.change?.action === "edited" ? each.change.before.Status : null }));
    }
    if (loosePrs.length) groups.set("PRs without a ticket", loosePrs.map((pr) => `- ${prText(pr)}: ${pr.title}`));
    const lines = [...groups].flatMap(([group, items], index) => [...(index ? [""] : []), `### ${group}`, ...items]);
    log(`brief: ${tickets.length} tickets, ${loosePrs.length} PRs without a ticket, since ${since.toLocaleString()}${problems.length ? `, ${problems.length} missing` : ""}`);
    const note = problems.length ? `\n\nNot included: ${problems.join("; ")}.` : "";
    return `**My tickets, past ${HOURS} hours**\n\n${lines.length ? lines.join("\n") : "- Nothing of mine merged, moved or released."}${note}`;
  }

  /** Where a ticket is: production or UAT once released there, else what its status says -> { group, detail, rank }. */
  function stage(ticket, release) {
    const status = String(ticket?.status ?? "");
    if (release?.env === "PROD") return { group: "Production", detail: release.version.replace(/^release_prod_/, ""), rank: 0 };
    if (release?.env === "UAT" || /Deployed\s*\(UAT\)/i.test(status)) return { group: "UAT", rank: 1 };
    if (/Acceptance/i.test(status)) return { group: "Acceptance testing", rank: 2 };
    if (/Deployed\s*\(Dev\)/i.test(status)) return { group: "Dev", rank: 3 };
    if (/Accepted/i.test(status)) return { group: "Done, not in a release yet", rank: 4 };
    if (/Code Review/i.test(status)) return { group: "Code review", rank: 5 };
    if (/In progress/i.test(status)) return { group: "In progress", rank: 6 };
    if (/Blocked/i.test(status)) return { group: "Blocked", rank: 7 };
    return { group: status || "No status", rank: 8 };
  }

  /** The Brief chip's brief, in any huddle: always my tickets' past 24 hours. */
  exports.forCall = ({ teamId }) => brief(teamId);
  exports.standup = ({ teamId }) => brief(teamId);
  exports.releases = releases;
});
