// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): features of Slack's message box (started by powertoys/page).
//
//   - Pasting a link (Notion, GitHub, any page with a title), alone or in text: the link goes in at once, and its
//     title replaces its text, linked, once known (if it is still in the message box). A message (or an edit) with a GitHub link, or a
//     pasted one, whose title isn't in yet is held when you send it, up to 10 s, titled, then sent by Slack's own
//     send (or Save).
//   - Ticket IDs ("ISS-1780"), typed or pasted, become links to their Notion pages; their text stays the ID.
//   - Secret guard: before a message goes, it is checked here (nothing leaves the computer) for things like API keys,
//     tokens, private keys and .env lines; you can redact them, send anyway, or cancel.
//   - Snippets: type ;; in the message box to pick one (powertoys\snippets.json; {{commits}}, {{date}}, {{ai: ...}}).
//   - Ctrl+Shift+K: Claude checks the message (unclear asks, missing context, tone) and offers a rewrite.
// ---------------------------------------------------------------------------------------------
(function (module, exports, __webpack_require__) {
  "use strict";

  let page;
  // The message box, and the box a message is edited in.
  const editorOf = (node) => node?.closest?.('[data-qa="message_input"] .ql-editor, [data-qa="message_editor"] .ql-editor');

  // --- Pasting links as titles -----------------------------------------------------------------------------
  let ownPaste = false;
  // The link goes in at once, as Slack pastes it; once the page's title is known it replaces the link's text, if that
  // is still in the message box (not sent, not edited away) and the box still has the focus. Sending holds for it.
  const titles = new Map(); // link -> its title (null: none), asked once; a failed ask is asked again next time
  const titleOf = (url) => {
    if (!titles.has(url))
      titles.set(
        url,
        page.invoke("link-title", url).catch((caught) => {
          titles.delete(url);
          // Most often a page the Notion connection wasn't given: say so rather than leave the link unexplained.
          if (/^Notion\b/.test(page.reason(caught))) page.notice(`No title for this link. ${page.reason(caught)}`);
          else page.log(`link title: ${url}: ${page.reason(caught)}`);
          return null;
        }),
      );
    return titles.get(url);
  };

  async function onPaste(event) {
    const editor = editorOf(event.target);
    if (!editor || ownPaste) return;
    // Every address in what was pasted (a link alone, or with words around it: "@someone please review <link>"), each
    // titled where it still shows as its address (a link pasted with its own text is left as it is).
    const text = event.clipboardData?.getData("text/plain") ?? "";
    const urls = [...new Set([...text.matchAll(/https?:\/\/[^\s<>]+/g)].map(([url]) => url.replace(/[.,;:!?)\]]+$/, "")))];
    await Promise.all(
      urls.map(async (url) => {
        const title = await titleOf(url);
        if (title) titleLink(editor, url, title);
      }),
    );
  }

  // Links in the box still showing their address: Slack's link chips, links whose text is their address (with or
  // without https://), and addresses in plain text.
  const bare = (anchor, url) => [url, url.replace(/^https?:\/\//, "")].includes(anchor.textContent.trim());
  function bareLinks(editor) {
    const urls = new Set();
    for (const slug of editor.querySelectorAll("ts-slug[data-url]")) urls.add(slug.dataset.url);
    for (const anchor of editor.querySelectorAll("a[href]")) if (bare(anchor, anchor.getAttribute("href"))) urls.add(anchor.getAttribute("href"));
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest("a, ts-slug")) continue;
      for (const [url] of node.textContent.matchAll(/https?:\/\/[^\s<>]+/g)) urls.add(url.replace(/[.,;:!?)\]]+$/, ""));
    }
    return [...urls];
  }
  function titleLink(editor, url, title) {
    if (!editor.isConnected || document.activeElement !== editor) return;
    // Slack turns a pasted address into a link chip (<ts-slug data-url>, showing it without "https://"); else it is text.
    const slug = [...editor.querySelectorAll("ts-slug[data-url]")].find((each) => each.dataset.url === url);
    const link = slug ? null : [...editor.querySelectorAll("a[href]")].find((each) => each.getAttribute("href") === url && bare(each, url));
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let node = slug || link ? null : walker.nextNode();
    while (node && !node.textContent.includes(url)) node = walker.nextNode();
    if (!slug && !link && !node) return;
    const selection = getSelection();
    const caret = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    const atEnd = (() => {
      if (!caret) return true;
      const rest = document.createRange();
      rest.setStart(caret.endContainer, caret.endOffset);
      rest.setEnd(editor, editor.childNodes.length);
      return !rest.toString().trim();
    })();
    const range = document.createRange();
    const anchor = node?.parentElement?.closest("a");
    if (slug) range.selectNode(slug);
    else if (link) range.selectNode(link);
    else if (anchor && editor.contains(anchor) && anchor.textContent.trim() === url) range.selectNode(anchor);
    else {
      const at = node.textContent.indexOf(url);
      range.setStart(node, at);
      range.setEnd(node, at + url.length);
    }
    selection.removeAllRanges();
    selection.addRange(range);
    // Slack's editor takes inserted HTML (a made-up paste event it ignores): a link is kept as a link.
    const escape = (value) => value.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);
    ownPaste = true;
    try {
      document.execCommand("insertHTML", false, `<a href="${escape(url)}">${escape(title)}</a>`);
    } finally {
      ownPaste = false;
    }
    // The caret back where it was: at the end if it was there, else in its place if that is still in the box.
    const back = document.createRange();
    if (atEnd || !caret.startContainer.isConnected) {
      back.selectNodeContents(editor);
      back.collapse(false);
    } else {
      back.setStart(caret.startContainer, Math.min(caret.startOffset, caret.startContainer.length ?? caret.startContainer.childNodes.length));
      back.collapse(true);
    }
    selection.removeAllRanges();
    selection.addRange(back);
  }

  // --- Ticket IDs as Notion links ---------------------------------------------------------------------------
  // "ISS-1780" in the message box becomes a link to its Notion page (its text stays the ID): typed, once the
  // character after it is typed; pasted, at once. An ID Notion doesn't know is left as it is.
  let ticketPattern = null;
  const tickets = new Map(); // ID -> its ticket (Notion), asked once
  const ticketOf = (id) => {
    if (!tickets.has(id)) tickets.set(id, page.invoke("ticket-info", { id }).catch((caught) => (tickets.delete(id), page.log(`tickets: ${id}: ${page.reason(caught)}`), null)));
    return tickets.get(id);
  };

  /** The IDs in the box not linked yet: [{ node, at, id }]; one the caret is right after (still being typed) only if asked. */
  function unlinkedTickets(editor, withCaret) {
    const selection = getSelection();
    const found = [];
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement.closest("a, ts-slug, code, pre")) continue;
      for (const match of node.textContent.matchAll(ticketPattern)) {
        const typing = selection.anchorNode === node && selection.anchorOffset === match.index + match[0].length;
        if (withCaret || !typing) found.push({ node, at: match.index, id: match[0] });
      }
    }
    return found;
  }

  // Where the caret is, as text before it, so it goes back to the same place (a link keeps the ID's text).
  function caretOffset(editor) {
    const selection = getSelection();
    if (!selection.rangeCount || !editor.contains(selection.anchorNode)) return null;
    const before = document.createRange();
    before.setStart(editor, 0);
    before.setEnd(selection.anchorNode, selection.anchorOffset);
    return before.toString().length;
  }
  function putCaret(editor, offset) {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let left = offset;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (left <= node.textContent.length) {
        const range = document.createRange();
        range.setStart(node, left);
        range.collapse(true);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        return;
      }
      left -= node.textContent.length;
    }
  }

  async function linkTickets(editor, withCaret = false) {
    if (!ticketPattern) return;
    const ids = [...new Set(unlinkedTickets(editor, withCaret).map((each) => each.id))];
    if (!ids.length) return;
    const found = new Map((await Promise.all(ids.map(async (id) => [id, await ticketOf(id)]))).filter(([, ticket]) => ticket?.url));
    // Slack's editor takes inserted HTML in the box that has the focus; the IDs are found again, as the box is now.
    if (!found.size || !editor.isConnected || document.activeElement !== editor) return;
    const caret = caretOffset(editor);
    const escape = (value) => value.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);
    let linked = 0;
    // From the last, so the places of the ones before stay right.
    for (const { node, at, id } of unlinkedTickets(editor, withCaret).reverse()) {
      const ticket = found.get(id);
      if (!ticket) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + id.length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      ownPaste = true;
      try {
        document.execCommand("insertHTML", false, `<a href="${escape(ticket.url)}">${escape(id)}</a>`);
      } finally {
        ownPaste = false;
      }
      linked++;
    }
    if (caret !== null) putCaret(editor, caret);
    if (linked) page.log(`tickets: ${linked} ID${linked > 1 ? "s" : ""} in the message box linked to Notion`);
  }

  // --- Secret guard ----------------------------------------------------------------------------------------
  const SECRETS = [
    ["AWS access key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g],
    ["GitHub token", /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/g],
    ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g],
    ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
    ["OpenAI key", /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/g],
    ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
    ["Stripe key", /\b(sk|rk)_live_[0-9a-zA-Z]{20,}\b/g],
    ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g],
    ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
    ["password or secret in a .env line", /^\s*[A-Z][A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*\S{8,}/gm],
    ["connection string with a password", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{4,}@[^\s]+/gi],
  ];
  function findSecrets(text) {
    const found = [];
    for (const [kind, pattern] of SECRETS) for (const match of text.matchAll(pattern)) found.push({ kind, value: match[0] });
    return found;
  }

  // "Send anyway" approves the message as it is: your next Enter (or Send) sends it; nothing is pressed for you.
  let approved = null;
  function guard(event, editor) {
    const text = editor.innerText;
    if (approved !== null && text === approved) {
      approved = null;
      return false;
    }
    const found = findSecrets(text);
    if (!found.length) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    page.popover({
      title: "This message may contain a secret",
      text: `${[...new Set(found.map((f) => f.kind))].join(", ")}:\n\n${found.map((f) => `• ${f.value.length > 60 ? `${f.value.slice(0, 24)}…${f.value.slice(-8)}` : f.value}`).join("\n")}\n\nNothing has been sent.`,
      actions: [
        {
          label: "Redact",
          run: () => {
            replaceAll(editor, found.map((f) => f.value), (value) => `${value.slice(0, 4)}[redacted]`);
            page.notice("Redacted. Check the message, then send it.");
          },
        },
        {
          label: "Send anyway",
          run: () => {
            approved = text;
            editor.focus();
            page.notice("Approved as it is: press Enter (or Send) to send it.");
          },
        },
      ],
    });
    return true;
  }

  // --- Sending holds for links' titles --------------------------------------------------------------------
  // Enter (or Send, or an edit's Save) on a box with a GitHub link, or a pasted link, still showing its address: the
  // send is held (up to 10 s) until their titles are in, they are put in, the secret check runs, and the message is
  // sent by Slack's own send (or Save; powertoys/page-slack, in the page). If that can't be found, your next Enter
  // sends it as it is.
  const GITHUB_LINK = /^https:\/\/github\.com\/[^/]+\/[^/]+\/(pull|issues|actions\/runs)\/\d+/;
  const HOLD_MS = 10000;
  let holding = false;
  let released = null; // the text your next send lets go as it is
  function holdForTitles(event, editor) {
    if (released !== null && editor.innerText === released) {
      released = null;
      return false;
    }
    const urls = bareLinks(editor).filter((url) => GITHUB_LINK.test(url) || titles.has(url));
    if (!urls.length) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!holding) titleThenSend(editor, urls).catch((caught) => page.log(`link titles: ${caught.message}`)).finally(() => (holding = false));
    holding = true;
    return true;
  }

  async function titleThenSend(editor, urls) {
    const slow = setTimeout(() => page.notice("Getting the link's title; the message goes once it's in (up to 10 s)."), 800);
    const deadline = new Promise((resolve) => setTimeout(() => resolve(null), HOLD_MS));
    const found = await Promise.all(urls.map(async (url) => [url, await Promise.race([titleOf(url), deadline])]));
    clearTimeout(slow);
    if (!editor.isConnected) return;
    editor.focus();
    for (const [url, title] of found) if (title) titleLink(editor, url, title);
    const missing = found.filter(([, title]) => !title).map(([url]) => url);
    if (missing.length) page.log(`link titles: none in ${HOLD_MS / 1000} s for ${missing.join(", ")}; sent with the address`);
    await new Promise((resolve) => setTimeout(resolve, 150)); // Slack's editor takes the change in
    if (guard(NO_EVENT, editor)) return;
    const how = await slackSend(editor);
    if (how) page.log(`link titles: ${found.length - missing.length} of ${found.length} titled; ${how} by Slack`);
    else {
      released = editor.innerText;
      page.notice("Titled. Press Enter to send it.");
    }
  }
  const NO_EVENT = { preventDefault() {}, stopImmediatePropagation() {} };

  /** Slack's own send (or an edit's Save) for this box, run in the page -> "sent", "saved", or "" (not found). */
  function slackSend(editor) {
    return new Promise((resolve) => {
      const answered = (event) => (clearTimeout(timer), document.removeEventListener("powertoys:slack-sent", answered), resolve(String(event.detail ?? "")));
      const timer = setTimeout(() => answered({ detail: "" }), 1000);
      document.addEventListener("powertoys:slack-sent", answered);
      editor.setAttribute("data-powertoys-send", "");
      document.dispatchEvent(new CustomEvent("powertoys:slack-command", { detail: "send" }));
    });
  }

  /** Replace text in the message box through the editor (selection + insertText), so Slack's editor keeps track. */
  function replaceAll(editor, values, replacement) {
    editor.focus();
    for (const value of values) {
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent.indexOf(value);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + value.length);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand("insertText", false, replacement(value));
        break;
      }
    }
  }

  /** Text with line breaks, inserted line by line: Slack's editor makes a paragraph of each, and mangles "\n" in text. */
  function insertLines(text) {
    text.split("\n").forEach((line, i) => {
      if (i) document.execCommand("insertParagraph", false);
      if (line) document.execCommand("insertText", false, line);
    });
  }

  function replaceMessage(editor, text) {
    editor.focus();
    document.execCommand("selectAll", false);
    document.execCommand("delete", false);
    insertLines(text);
  }

  // --- Snippets --------------------------------------------------------------------------------------------
  async function offerSnippets(editor) {
    let list;
    try {
      list = await page.invoke("snippets");
    } catch (caught) {
      return page.notice(`Couldn't read snippets: ${page.reason(caught)}`);
    }
    const rect = editor.getBoundingClientRect();
    const shown = page.popover({
      title: "Snippets (powertoys\\snippets.json)",
      text: list.length ? "Pick one:" : "No snippets yet: Powertoys' tray menu, Edit snippets.",
      x: rect.left,
      y: rect.top - 260,
      actions: list.slice(0, 8).map((snippet) => ({
        label: snippet.name,
        run: async () => {
          editor.focus();
          document.execCommand("delete", false);
          document.execCommand("delete", false);
          let text = snippet.text;
          if (/\{\{(commits|ai:)/.test(text)) {
            page.notice("Filling in the snippet…");
            text = (await page.invoke("fill-snippet", { text, teamId: page.currentTeamId() })).text;
          } else {
            text = text.replace(/\{\{date\}\}/g, new Date().toISOString().slice(0, 10));
          }
          editor.focus();
          insertLines(text);
        },
      })),
    });
    return shown;
  }

  // --- Checking a message ----------------------------------------------------------------------------------
  async function checkMessage(editor) {
    const text = editor.innerText.trim();
    if (!text) return;
    const shown = page.popover({ title: "Claude checks your message", text: "Checking…" });
    try {
      const result = await page.invoke("check-message", { text });
      const lines = result.ok && !result.issues?.length ? ["Looks good."] : (result.issues ?? []).map((issue) => `• ${issue}`);
      shown.box.remove();
      page.popover({
        title: "Claude checks your message",
        text: `${lines.join("\n")}${result.rewrite ? `\n\nSuggested:\n${result.rewrite}` : ""}`,
        actions: result.rewrite ? [{ label: "Use the suggestion", run: () => replaceMessage(editor, result.rewrite) }] : [],
      });
    } catch (caught) {
      shown.setText(`Couldn't check: ${page.reason(caught)}`);
    }
  }

  exports.start = function start(core) {
    page = core;
    document.addEventListener("paste", (event) => onPaste(event).catch((caught) => page.log(`paste: ${caught.message}`)), true);
    // After Slack has put the pasted text in.
    document.addEventListener("paste", (event) => {
      const editor = editorOf(event.target);
      if (editor && !ownPaste) setTimeout(() => linkTickets(editor, true).catch((caught) => page.log(`tickets: ${caught.message}`)), 50);
    });
    document.addEventListener(
      "keydown",
      (event) => {
        const editor = editorOf(event.target);
        if (!editor) return;
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !event.ctrlKey && !event.altKey) {
          if (!holdForTitles(event, editor)) guard(event, editor);
        } else if (event.key === "K" && event.ctrlKey && event.shiftKey) {
          event.preventDefault();
          event.stopImmediatePropagation();
          checkMessage(editor);
        }
      },
      true,
    );
    document.addEventListener(
      "click",
      (event) => {
        // Send, or an edit's Save.
        const send = event.target.closest?.('[data-qa="texty_send_button"]');
        const save = send ? null : event.target.closest?.('[data-qa="message_editor"] button');
        if (!send && !(save && /^save\b/i.test(save.getAttribute("aria-label") || save.textContent.trim()))) return;
        const editor = send
          ? (send.closest('[data-qa="message_input"]')?.querySelector(".ql-editor") ?? document.querySelector('[data-qa="message_input"] .ql-editor'))
          : save.closest('[data-qa="message_editor"]').querySelector(".ql-editor");
        if (editor && !holdForTitles(event, editor)) guard(event, editor);
      },
      true,
    );
    document.addEventListener(
      "input",
      (event) => {
        const editor = editorOf(event.target);
        if (!editor) return;
        // A character that ends an ID (not a digit), or a new line.
        if (!ownPaste && ((event.inputType === "insertText" && !/^\d+$/.test(event.data ?? "")) || /^insert(Paragraph|LineBreak)$/.test(event.inputType))) {
          linkTickets(editor).catch((caught) => page.log(`tickets: ${caught.message}`));
        }
        if (event.data !== ";") return;
        const selection = getSelection();
        const node = selection?.anchorNode;
        if (node?.nodeType === 3 && node.textContent.slice(0, selection.anchorOffset).endsWith(";;")) offerSnippets(editor);
      },
      true,
    );
    page.invoke("settings")
      .then((s) => s.ticketPrefix && (ticketPattern = new RegExp(`\\b${s.ticketPrefix.replace(/\W/g, "")}-\\d+\\b`, "g")))
      .catch(() => {});
    page.log("message box features started");
  };
});
