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
  const { log, warn, readSettings } = __webpack_require__("powertoys/main");

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
  exports.pageInfo = pageInfo;

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

  /** Signs in through Notion in the browser (you pick the pages to share there) -> { token, refreshToken, workspace }. */
  async function signIn({ clientId, clientSecret }) {
    const state = crypto.randomBytes(16).toString("hex");
    const servers = [];
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Notion: no answer from the browser within 5 minutes")), 5 * 60e3);
      const handle = (request, response) => {
        const url = new URL(request.url, exports.redirectUri);
        if (url.pathname !== "/notion/callback") return response.writeHead(404).end();
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
      const authorize = new URL("https://api.notion.com/v1/oauth/authorize");
      for (const [key, value] of Object.entries({ client_id: clientId, response_type: "code", owner: "user", redirect_uri: exports.redirectUri, state })) authorize.searchParams.set(key, value);
      electron.shell.openExternal(authorize.toString());
    }).finally(() => servers.forEach((server) => server.close()));
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
