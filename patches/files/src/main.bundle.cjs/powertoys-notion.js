// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): Notion, through its API with your integration's token.
// Settings (settings.json): "notion": { "token": "<an internal integration's secret>", "previews": true }, set in the
// Powertoys panel's Settings tab; or a public (OAuth) connection's "clientId", "clientSecret" and the token its sign-in
// gives ("refreshToken" too). Powertoys sees only the pages shared with the connection; where a new page goes is chosen
// among them (powertoys/assist asks Claude).
// ---------------------------------------------------------------------------------------------
(function (module, exports, __webpack_require__) {
  "use strict";

  const electron = __webpack_require__(84157);
  const http = __webpack_require__(58611);
  const crypto = __webpack_require__(76982);
  const { log, warn, readSettings, updateSettings } = __webpack_require__("powertoys/main");

  const API = "https://api.notion.com/v1";
  const settings = () => ({ token: "", previews: true, ...readSettings().notion });
  exports.settings = settings;
  exports.configured = () => Boolean(settings().token);

  async function call(method, route, body, token = settings().token) {
    if (!token) throw new Error("Notion is not set up: Powertoys panel (Ctrl+Alt+P), Settings");
    const response = await fetch(`${API}${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "notion-version": "2022-06-28", "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await response.json();
    if (!response.ok) throw Object.assign(new Error(`Notion: ${json.message ?? response.status}`), { status: response.status, code: json.code });
    return json;
  }

  /** The id in a Notion link (or an id with or without dashes), dashed; null if there is none. */
  function notionId(ref) {
    const match = /([0-9a-f]{32})(?:[?#]|$)/i.exec(String(ref).replace(/-/g, "")) ?? /([0-9a-f]{32})/i.exec(String(ref).replace(/-/g, ""));
    if (!match) return null;
    const hex = match[1].toLowerCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  exports.notionId = notionId;
  // notion.so, notion.site (published pages) and notion.com (app.notion.com: Notion's current links).
  exports.isNotionLink = (url) => /^https:\/\/([\w-]+\.)?notion\.(so|site|com)\//.test(url);

  const plain = (richText = []) => richText.map((part) => part.plain_text ?? "").join("");
  const titleOf = (object) => {
    if (object.object === "database") return plain(object.title);
    const property = Object.values(object.properties ?? {}).find((each) => each.type === "title");
    return plain(property?.title) || "Untitled";
  };
  const iconOf = (object) => object.icon?.emoji ?? object.icon?.external?.url ?? object.icon?.file?.url ?? null;

  const cache = new Map();
  function cached(key, ms, load) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ms) return hit.value;
    const value = load().catch((caught) => (cache.delete(key), Promise.reject(caught)));
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  async function object(id, token) {
    try {
      return await call("GET", `/pages/${id}`, undefined, token);
    } catch (caught) {
      if (caught.status === 404 || caught.code === "validation_error") return call("GET", `/databases/${id}`, undefined, token);
      throw caught;
    }
  }

  const userName = (id) => cached(`user:${id}`, 36e5, async () => (await call("GET", `/users/${id}`).catch(() => ({}))).name ?? null);

  async function parentTitle(parent) {
    if (parent?.type === "page_id") return titleOf(await object(parent.page_id).catch(() => ({ properties: {} })));
    if (parent?.type === "database_id") return titleOf(await call("GET", `/databases/${parent.database_id}`).catch(() => ({ object: "database", title: [] })));
    return null;
  }

  /** The text of a page's first blocks (up to about 400 characters). */
  async function firstLines(id) {
    const { results = [] } = await call("GET", `/blocks/${id}/children?page_size=15`).catch(() => ({}));
    const lines = [];
    for (const block of results) {
      const text = plain(block[block.type]?.rich_text);
      if (text) lines.push(block.type === "to_do" ? `${block.to_do.checked ? "[x]" : "[ ]"} ${text}` : block.type.startsWith("bulleted") ? `- ${text}` : text);
      if (lines.join("\n").length > 400) break;
    }
    return lines.join("\n").slice(0, 420);
  }

  /**
   * What a link preview shows: { id, url, title, ticketId (a database's own ID, like ISS-1995, or null), icon, path: [parent titles], editedAt, editedBy, status, assignees,
   * excerpt, kind: "page" | "database" | "row" }.
   */
  function pageInfo(ref) {
    const id = notionId(ref);
    if (!id) return Promise.reject(new Error("not a Notion link"));
    if (!mcpSignedIn()) return pageInfoViaConnection(id);
    // As you first (it sees teamspace pages); the connection when that fails and is set up.
    return cached(`page-as-you:${id}`, 5 * 60e3, () =>
      pageInfoAsYou(id).catch((caught) => {
        if (!exports.configured()) throw caught;
        warn(`notion: ${caught.message}; trying the connection`);
        return pageInfoViaConnection(id);
      }),
    );
  }
  exports.pageInfo = pageInfo;

  function pageInfoViaConnection(id) {
    return cached(`page:${id}`, 5 * 60e3, async () => {
      const found = await object(id);
      const pathTitles = [];
      let parent = found.parent;
      for (let depth = 0; depth < 3 && parent && parent.type !== "workspace"; depth++) {
        const title = await parentTitle(parent).catch(() => null);
        if (!title) break;
        pathTitles.unshift(title);
        const next = parent.type === "page_id" ? await object(parent.page_id).catch(() => null) : parent.type === "database_id" ? await call("GET", `/databases/${parent.database_id}`).catch(() => null) : null;
        parent = next?.parent;
      }
      const properties = Object.entries(found.properties ?? {});
      const status = properties.find(([, p]) => p.type === "status")?.[1]?.status?.name ?? properties.find(([name, p]) => p.type === "select" && /status|state|stage/i.test(name))?.[1]?.select?.name ?? null;
      const unique = properties.find(([, p]) => p.type === "unique_id")?.[1]?.unique_id;
      const people = properties.find(([name, p]) => p.type === "people" && /assign|owner|lead|dri/i.test(name)) ?? properties.find(([, p]) => p.type === "people");
      return {
        id,
        url: found.url,
        title: titleOf(found),
        ticketId: unique?.number != null ? `${unique.prefix ? `${unique.prefix}-` : ""}${unique.number}` : null,
        icon: iconOf(found),
        path: pathTitles,
        editedAt: found.last_edited_time ?? null,
        editedBy: found.last_edited_by?.id ? await userName(found.last_edited_by.id) : null,
        status,
        assignees: (people?.[1]?.people ?? []).map((person) => person.name).filter(Boolean),
        excerpt: found.object === "page" ? await firstLines(id) : "",
        kind: found.object === "database" ? "database" : found.parent?.type === "database_id" ? "row" : "page",
      };
    });
  }

  // --- Writing pages ---------------------------------------------------------------------------------------
  const text = (content) => {
    const parts = [];
    for (let i = 0; i < String(content).length; i += 1900) parts.push({ type: "text", text: { content: String(content).slice(i, i + 1900) } });
    return parts.length ? parts : [{ type: "text", text: { content: "" } }];
  };
  const linkText = (content, url) => [{ type: "text", text: { content, link: { url } } }];
  exports.blocks = {
    heading: (content) => ({ object: "block", type: "heading_2", heading_2: { rich_text: text(content) } }),
    paragraph: (content) => ({ object: "block", type: "paragraph", paragraph: { rich_text: text(content) } }),
    link: (content, url) => ({ object: "block", type: "paragraph", paragraph: { rich_text: linkText(content, url) } }),
    bullet: (content) => ({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: text(content) } }),
    todo: (content) => ({ object: "block", type: "to_do", to_do: { rich_text: text(content), checked: false } }),
    toggle: (content, children) => ({ object: "block", type: "toggle", toggle: { rich_text: text(content), children: children.slice(0, 100) } }),
    divider: () => ({ object: "block", type: "divider", divider: {} }),
  };

  /** The pages and databases a new page can go under -> [{ id, type, title, path }], path being "A / B / title". */
  async function places(token = settings().token) {
    const found = [];
    let cursor;
    do {
      const result = await call("POST", "/search", { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }, token);
      found.push(...result.results.filter((each) => !each.archived && !each.in_trash));
      cursor = result.has_more && found.length < 500 ? result.next_cursor : null;
    } while (cursor);
    const byId = new Map(found.map((each) => [each.id, each]));
    const parentOf = (each) => byId.get(each.parent?.page_id ?? each.parent?.database_id);
    const pathOf = (each, depth = 0) => {
      const parent = depth < 6 && parentOf(each);
      return parent ? `${pathOf(parent, depth + 1)} / ${titleOf(each)}` : titleOf(each);
    };
    return found.map((each) => ({ id: each.id, type: each.object, title: titleOf(each), path: pathOf(each) }));
  }
  exports.places = places;

  /** A new page under parentId (a page, or a database: then a row) -> { id, url }. */
  async function createPage({ parentId, title, children = [] }) {
    const parentObject = await object(parentId);
    let parent;
    let properties;
    if (parentObject.object === "database") {
      const titleName = Object.entries(parentObject.properties).find(([, p]) => p.type === "title")?.[0] ?? "Name";
      parent = { database_id: parentId };
      properties = { [titleName]: { title: text(title) } };
    } else {
      parent = { page_id: parentId };
      properties = { title: { title: text(title) } };
    }
    const page = await call("POST", "/pages", { parent, properties, children: children.slice(0, 100) });
    for (let i = 100; i < children.length; i += 100) await call("PATCH", `/blocks/${page.id}/children`, { children: children.slice(i, i + 100) });
    return { id: page.id, url: page.url };
  }
  exports.createPage = createPage;

  /** Checks a token before it is saved -> { workspace, shared: the number of pages and databases it can see }. */
  async function check({ token }) {
    const bot = await call("GET", "/users/me", undefined, token);
    const shared = (await places(token)).length;
    if (!shared) throw new Error("Notion: the connection can't see any pages yet; share the pages it may use with it");
    return { workspace: bot.bot?.workspace_name ?? null, shared };
  }
  exports.check = check;

  // Notion's connection settings list this redirect URI; a server listens on it only while a sign-in waits.
  const OAUTH_PORT = 47821;
  exports.redirectUri = `http://localhost:${OAUTH_PORT}/notion/callback`;

  /** Opens Notion's sign-in in the browser and waits for its answer on localhost:<OAUTH_PORT><path> -> the code. */
  async function browserCode(path, authorize, state) {
    const servers = [];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Notion: no answer from the browser within 5 minutes")), 5 * 60e3);
      const handle = (request, response) => {
        const url = new URL(request.url, exports.redirectUri);
        if (url.pathname !== path) return response.writeHead(404).end();
        const ok = url.searchParams.get("state") === state && url.searchParams.get("code");
        response.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
        response.end(ok ? "<p>Notion is connected to Slack Powertoys. You can close this tab.</p>" : `<p>Not connected: ${url.searchParams.get("error") ?? "unexpected answer"}.</p>`);
        if (url.searchParams.get("state") !== state) return;
        clearTimeout(timer);
        if (ok) resolve(url.searchParams.get("code"));
        else reject(new Error(`Notion: ${url.searchParams.get("error") ?? "sign-in failed"}`));
      };
      // "localhost" can be 127.0.0.1 or ::1 to the browser, so both.
      for (const host of ["127.0.0.1", "::1"]) {
        const server = http.createServer(handle);
        server.on("error", (caught) => (host === "127.0.0.1" ? reject(new Error(`Notion: can't listen on port ${OAUTH_PORT}: ${caught.message}`)) : warn(`notion sign-in on ::1: ${caught.message}`)));
        server.listen(OAUTH_PORT, host);
        servers.push(server);
      }
      electron.shell.openExternal(authorize.toString());
    }).finally(() => servers.forEach((server) => server.close()));
  }

  /** Signs in through Notion in the browser (you pick the pages to share there) -> { token, refreshToken, workspace }. */
  async function signIn({ clientId, clientSecret }) {
    const state = crypto.randomBytes(16).toString("hex");
    const authorize = new URL("https://api.notion.com/v1/oauth/authorize");
    for (const [key, value] of Object.entries({ client_id: clientId, response_type: "code", owner: "user", redirect_uri: exports.redirectUri, state })) authorize.searchParams.set(key, value);
    const code = await browserCode("/notion/callback", authorize, state);
    const response = await fetch(`${API}/oauth/token`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: exports.redirectUri }),
    });
    const json = await response.json();
    if (!response.ok) throw new Error(`Notion: ${json.error_description ?? json.message ?? json.error ?? response.status}`);
    log(`notion sign-in: token for workspace ${json.workspace_name ?? "?"}${json.refresh_token ? ", with a refresh token" : ""}${json.expires_in ? `, expires in ${json.expires_in}s` : ""}`);
    return { token: json.access_token, refreshToken: json.refresh_token ?? null, workspace: json.workspace_name ?? null };
  }
  exports.signIn = signIn;

  // --- Notion's MCP server, signed in as you ---------------------------------------------------------------
  // Notion's own MCP server (the one Claude's Notion connector uses) acts as you: it reads what you can read, teamspace
  // pages included, where a connection sees only the pages someone connected it to. Link titles and previews use it
  // when you have signed in ("Sign in as you" in the panel's Settings tab). Settings: notion.mcp { clientId, token,
  // refreshToken, expiresAt }; the client is registered with Notion at sign-in (OAuth dynamic registration, PKCE).
  const MCP = "https://mcp.notion.com";
  const MCP_PATH = "/notion/mcp-callback";
  const mcpRedirect = `http://localhost:${OAUTH_PORT}${MCP_PATH}`;
  const mcpSettings = () => settings().mcp ?? {};
  const mcpSignedIn = () => Boolean(mcpSettings().refreshToken || mcpSettings().token);
  exports.mcpSignedIn = mcpSignedIn;
  /** Whether link titles and previews can be read: as you (MCP) or through the connection. */
  exports.canRead = () => mcpSignedIn() || exports.configured();

  const base64url = (buffer) => buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  async function mcpToken(form) {
    const response = await fetch(`${MCP}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Notion (as you): ${json.error_description ?? json.error ?? response.status}`);
    return json;
  }

  function saveMcp(clientId, json, previous = {}) {
    const mcp = {
      clientId,
      token: json.access_token,
      refreshToken: json.refresh_token ?? previous.refreshToken ?? null,
      expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : null,
    };
    updateSettings((current) => ({ ...current, notion: { ...current.notion, mcp } }));
    return mcp;
  }

  /** Signs in to Notion's MCP server as you, in the browser -> { name } (who Notion says you are). */
  async function signInAsYou() {
    const registered = await fetch(`${MCP}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Slack Powertoys", redirect_uris: [mcpRedirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    }).then((response) => response.json());
    if (!registered.client_id) throw new Error(`Notion (as you): couldn't register (${registered.error_description ?? registered.error ?? "no client id"})`);
    const verifier = base64url(crypto.randomBytes(32));
    const state = crypto.randomBytes(16).toString("hex");
    const authorize = new URL(`${MCP}/authorize`);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: registered.client_id,
      redirect_uri: mcpRedirect,
      code_challenge: base64url(crypto.createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      state,
      resource: `${MCP}/mcp`,
    }))
      authorize.searchParams.set(key, value);
    const code = await browserCode(MCP_PATH, authorize, state);
    const json = await mcpToken({ grant_type: "authorization_code", code, redirect_uri: mcpRedirect, client_id: registered.client_id, code_verifier: verifier, resource: `${MCP}/mcp` });
    saveMcp(registered.client_id, json);
    mcpSession = null;
    const me = await mcpTool("notion-get-self", {}).catch(() => null);
    log(`notion: signed in as you through Notion's MCP server${json.expires_in ? ` (token for ${json.expires_in}s, refreshed as needed)` : ""}`);
    return { name: me?.name ?? me?.user?.name ?? null };
  }
  exports.signInAsYou = signInAsYou;

  // One refresh at a time; a token is refreshed a minute before it expires.
  let refreshing = null;
  async function mcpAccessToken(force = false) {
    const mcp = mcpSettings();
    if (!force && mcp.token && (!mcp.expiresAt || mcp.expiresAt - Date.now() > 60e3)) return mcp.token;
    if (!mcp.refreshToken) throw new Error("Notion (as you): signed out; sign in again in the panel's Settings tab");
    refreshing ??= mcpToken({ grant_type: "refresh_token", refresh_token: mcp.refreshToken, client_id: mcp.clientId, resource: `${MCP}/mcp` })
      .then((json) => saveMcp(mcp.clientId, json, mcp).token)
      .finally(() => (refreshing = null));
    return refreshing;
  }

  /** A JSON-RPC message to the MCP server; its answer from JSON or from a server-sent event stream. */
  async function mcpPost(message, sessionId, token) {
    const response = await fetch(`${MCP}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" } : {}),
      },
      body: JSON.stringify(message),
    });
    if (!response.ok) throw Object.assign(new Error(`Notion (as you): ${response.status} ${(await response.text()).slice(0, 200)}`), { status: response.status });
    const text = await response.text();
    if (message.id === undefined) return { response };
    const answers = (response.headers.get("content-type") ?? "").includes("text/event-stream")
      ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)))
      : [JSON.parse(text)];
    const answer = answers.find((each) => each.id === message.id);
    if (!answer) throw new Error("Notion (as you): no answer");
    if (answer.error) throw new Error(`Notion (as you): ${answer.error.message}`);
    return { response, result: answer.result };
  }

  let mcpSession = null;
  let rpcId = 0;
  async function mcpTool(name, args) {
    const attempt = async (token) => {
      mcpSession ??= (async () => {
        const { response } = await mcpPost({ jsonrpc: "2.0", id: ++rpcId, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "slack-powertoys", version: "1" } } }, null, token);
        const sessionId = response.headers.get("mcp-session-id");
        await mcpPost({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId, token);
        return sessionId;
      })().catch((caught) => ((mcpSession = null), Promise.reject(caught)));
      const { result } = await mcpPost({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }, await mcpSession, token);
      const text = (result.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
      if (result.isError) throw new Error(`Notion (as you): ${text.slice(0, 300)}`);
      try {
        return JSON.parse(text);
      } catch {
        return { text };
      }
    };
    try {
      return await attempt(await mcpAccessToken());
    } catch (caught) {
      // The MCP spec: 404 means the session ended (start a new one); 401, the token was refused (refresh it).
      if (caught.status !== 404 && caught.status !== 401) throw caught;
      mcpSession = null;
      return attempt(await mcpAccessToken(caught.status === 401));
    }
  }

  /** pageInfo's answer, from notion-fetch: its properties (JSON) and content (Notion's Markdown) are in its text. */
  async function pageInfoAsYou(id) {
    const fetched = await mcpTool("notion-fetch", { id });
    const text = fetched.text ?? "";
    let properties = {};
    try {
      properties = JSON.parse(/<properties>\s*([\s\S]*?)\s*<\/properties>/.exec(text)?.[1] ?? "{}");
    } catch {}
    const ticketId = [properties["userDefined:ID"], properties.ID].find((value) => typeof value === "string" && /^[A-Za-z][\w]*-\d+$/.test(value)) ?? null;
    const statusKey = Object.keys(properties).find((key) => /^(status|state|stage)$/i.test(key));
    const content = /<content>([\s\S]*?)<\/content>/.exec(text)?.[1] ?? "";
    return {
      id,
      url: fetched.url ?? null,
      title: fetched.title || "Untitled",
      ticketId,
      icon: typeof fetched.icon === "string" && !/^http/.test(fetched.icon) ? fetched.icon : null,
      path: fetched.path ? String(fetched.path).split(" / ").filter(Boolean) : [],
      editedAt: fetched.page_last_edited_at ?? null,
      editedBy: null,
      status: typeof properties[statusKey] === "string" ? properties[statusKey] : null,
      assignees: [],
      excerpt: content.replace(/<[^>]+>/g, "").split("\n").map((line) => line.trim()).filter(Boolean).join("\n").slice(0, 420),
      kind: fetched.metadata?.type === "database" ? "database" : /<parent-data-source\b/.test(text) ? "row" : "page",
    };
  }

  // --- Tickets, as you (link titles, briefs, the standup, the digest, thread → ticket) --------------------------
  // Settings: notion.issues (the Issues data source, "collection://…"), notion.people (the one its Owner column points
  // to), notion.ticketPrefix (the IDs' prefix, "ISS"), notion.activeStatuses (what "working on" means). Read with SQL
  // through Notion's MCP server, signed in as you.
  const ACTIVE = ["In progress", "Blocked", "Code Review Pending", "Deployed (Dev)", "Deployed(UAT)", "Acceptance Testing"];
  const ticketSettings = () => ({ ticketPrefix: "ISS", activeStatuses: ACTIVE, ...settings() });
  exports.ticketPrefix = () => ticketSettings().ticketPrefix;
  exports.activeStatuses = () => ticketSettings().activeStatuses;
  function needTickets() {
    const current = ticketSettings();
    if (!mcpSignedIn()) throw new Error("Notion: sign in as you first (Powertoys panel, Settings)");
    if (!current.issues) throw new Error("Notion: notion.issues (the Issues data source) isn't set");
    return current;
  }
  exports.canReadTickets = () => mcpSignedIn() && Boolean(ticketSettings().issues);

  async function sql(source, query, params = []) {
    const result = await mcpTool("notion-query-data-sources", { data: { data_source_urls: [source], query, params } });
    if (!Array.isArray(result.results)) throw new Error(`Notion (as you): ${String(result.text ?? JSON.stringify(result)).slice(0, 200)}`);
    return result.results;
  }
  const ticketOf = (row, prefix) => ({ id: `${prefix}-${row["userDefined:ID"]}`, title: row.Name, status: row.Status ?? null, url: row.url });

  /** A ticket by its ID ("ISS-1780") -> { id, title, status, url }, or null. */
  function ticket(ref) {
    const current = needTickets();
    const number = Number(/(\d+)\s*$/.exec(String(ref))?.[1]);
    if (!number) return Promise.resolve(null);
    return cached(`ticket:${number}`, 10 * 60e3, async () => {
      const rows = await sql(current.issues, `SELECT url, Name, Status, "userDefined:ID" FROM "${current.issues}" WHERE "userDefined:ID" = ?`, [number]);
      return rows[0] ? ticketOf(rows[0], current.ticketPrefix) : null;
    });
  }
  exports.ticket = ticket;

  /** Your page among the people the Owner column points to (by your Notion name) -> its id, no dashes. */
  function myOwnerId() {
    const current = needTickets();
    if (!current.people) return Promise.reject(new Error("Notion: notion.people (the Owner column's data source) isn't set"));
    return cached("owner:me", 60 * 60e3, async () => {
      const me = await mcpTool("notion-get-self", {});
      const name = me.user?.name;
      const rows = name ? await sql(current.people, `SELECT url FROM "${current.people}" WHERE Name = ?`, [name]) : [];
      const id = /([0-9a-f]{32})/.exec(String(rows[0]?.url ?? "").replace(/-/g, ""))?.[1];
      if (!id) throw new Error(`Notion: no one named "${name ?? "?"}" among the tickets' owners`);
      return id;
    });
  }

  /** Your tickets (you among their owners) in some statuses (default: the active ones) -> [{ id, title, status, url }]. */
  async function myTickets(statuses = ticketSettings().activeStatuses) {
    const current = needTickets();
    const owner = await myOwnerId();
    const rows = await sql(
      current.issues,
      `SELECT url, Name, Status, "userDefined:ID" FROM "${current.issues}" WHERE Owner LIKE ? AND Status IN (${statuses.map(() => "?").join(", ")}) ORDER BY "userDefined:ID" DESC LIMIT 60`,
      [`%${owner}%`, ...statuses],
    );
    return rows.map((row) => ticketOf(row, current.ticketPrefix));
  }
  exports.myTickets = myTickets;

  /** A comment on a ticket's page, as you. */
  exports.comment = (pageUrl, markdown) => mcpTool("notion-create-comment", { page_id: pageUrl, markdown });

  /** Pages and databases whose title matches -> [{ title, url, icon, editedAt }]. */
  async function search(query, limit = 10) {
    const { results = [] } = await call("POST", "/search", { query, page_size: limit });
    return results.map((each) => ({ title: titleOf(each), url: each.url, icon: iconOf(each), editedAt: each.last_edited_time }));
  }
  exports.search = search;

  exports.warnOnce = (() => {
    let warned = false;
    return (message) => warned || ((warned = true), warn(message));
  })();
});
