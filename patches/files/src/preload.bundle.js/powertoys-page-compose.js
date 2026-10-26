// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): features of Slack's message box (started by powertoys/page).
//
//   - Pasting a link (Notion, GitHub, any page with a title): the link goes in at once, and its title replaces its
//     text, linked, once known (if it is still in the message box).
//   - Secret guard: before a message goes, it is checked here (nothing leaves the computer) for things like API keys,
//     tokens, private keys and .env lines; you can redact them, send anyway, or cancel.
//   - Snippets: type ;; in the message box to pick one (powertoys\snippets.json; {{commits}}, {{date}}, {{ai: ...}}).
//   - Ctrl+Shift+K: Claude checks the message (unclear asks, missing context, tone) and offers a rewrite.
// ---------------------------------------------------------------------------------------------
(function (module, exports, __webpack_require__) {
  "use strict";

  let page;
  const editorOf = (node) => node?.closest?.('[data-qa="message_input"] .ql-editor');

  // --- Pasting links as titles -----------------------------------------------------------------------------
  const SINGLE_URL = /^https?:\/\/\S+$/;
  let ownPaste = false;
  // The link goes in at once, as Slack pastes it, so a message sent right away has it; once the page's title is known
  // it replaces the link's text, if that is still in the message box (not sent, not edited away) and the box still
  // has the focus.
  async function onPaste(event) {
    const editor = editorOf(event.target);
    if (!editor || ownPaste) return;
    const text = event.clipboardData?.getData("text/plain")?.trim() ?? "";
    if (!SINGLE_URL.test(text) || event.clipboardData.getData("text/html")) return;
    let title = null;
    try {
      title = await Promise.race([page.invoke("link-title", text), new Promise((resolve) => setTimeout(() => resolve(null), 4000))]);
    } catch (caught) {
      // Most often a page the Notion connection wasn't given: say so rather than leave the link unexplained.
      if (/^Notion\b/.test(page.reason(caught))) page.notice(`No title for this link. ${page.reason(caught)}`);
    }
    if (title) titleLink(editor, text, title);
  }

  function titleLink(editor, url, title) {
    if (!editor.isConnected || document.activeElement !== editor) return;
    // Slack turns a pasted address into a link chip (<ts-slug data-url>, showing it without "https://"); else it is text.
    const slug = [...editor.querySelectorAll("ts-slug[data-url]")].find((each) => each.dataset.url === url);
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let node = slug ? null : walker.nextNode();
    while (node && !node.textContent.includes(url)) node = walker.nextNode();
    if (!slug && !node) return;
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
    document.addEventListener(
      "keydown",
      (event) => {
        const editor = editorOf(event.target);
        if (!editor) return;
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !event.ctrlKey && !event.altKey) {
          guard(event, editor);
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
        const send = event.target.closest?.('[data-qa="texty_send_button"]');
        if (!send) return;
        const editor = send.closest('[data-qa="message_input"]')?.querySelector(".ql-editor") ?? document.querySelector('[data-qa="message_input"] .ql-editor');
        if (editor) guard(event, editor);
      },
      true,
    );
    document.addEventListener(
      "input",
      (event) => {
        const editor = editorOf(event.target);
        if (!editor || event.data !== ";") return;
        const selection = getSelection();
        const node = selection?.anchorNode;
        if (node?.nodeType === 3 && node.textContent.slice(0, selection.anchorOffset).endsWith(";;")) offerSnippets(editor);
      },
      true,
    );
    page.log("message box features started");
  };
});
