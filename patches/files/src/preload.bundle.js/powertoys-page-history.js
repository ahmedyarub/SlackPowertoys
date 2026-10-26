// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): edited and deleted messages keep a copy and are marked (started by powertoys/page).
//
//   - hookSocket, run from the preload before Slack's own scripts, puts a script in the page's world that watches
//     Slack's live connection (wss-*.slack.com): an edit's earlier message and a deleted message are handed to
//     powertoys/history (main process), which saves the copy (powertoys\history\messages.jsonl).
//   - A deleted message stays where it is: Slack's page is not told of the deletion, so it keeps it until it reloads
//     the conversation. Once the copy is saved it is dimmed and marked "Deleted". Copies stay in the Powertoys
//     panel's History tab.
//   - An edited message: "earlier versions" next to Slack's "(edited)" shows what it said before each edit.
// ---------------------------------------------------------------------------------------------
(function (module, exports, __webpack_require__) {
  "use strict";

  const electron = __webpack_require__(261);
  const log = (message) => electron.ipcRenderer.send("powertoys:log", `history: ${message}`);
  let page = null;

  // In the page's own world: Slack's listeners on its live connection get every event but a deletion (a copy of it is
  // handed out instead, as is an edit's earlier message), through a "powertoys:history" event on the document.
  function socketHook() {
    if (window.__powertoysHistory) return;
    window.__powertoysHistory = true;
    const SLACK = /^wss:\/\/wss-[\w-]+\.slack\.com\//;
    const report = (copy) => document.dispatchEvent(new CustomEvent("powertoys:history", { detail: JSON.stringify(copy) }));
    // One verdict per event (a socket can have several listeners): true keeps it from Slack.
    const verdicts = new WeakMap();
    function withheld(event) {
      if (verdicts.has(event)) return verdicts.get(event);
      let verdict = false;
      const data = event.data;
      if (typeof data === "string" && data.includes('"message_') && SLACK.test(event.currentTarget?.url ?? event.target?.url ?? "")) {
        let message = null;
        try {
          message = JSON.parse(data);
        } catch {}
        if (message?.type === "message" && message.subtype === "message_deleted" && message.previous_message) {
          report({ kind: "deleted", channel: message.channel, ts: message.deleted_ts ?? message.previous_message.ts, message: message.previous_message });
          verdict = true;
        } else if (message?.type === "message" && message.subtype === "message_changed" && message.message?.edited && message.previous_message && message.previous_message.text !== message.message.text) {
          report({ kind: "edited", channel: message.channel, ts: message.message.ts, message: message.message, previous: message.previous_message });
        }
      }
      verdicts.set(event, verdict);
      return verdict;
    }
    const wrapped = new WeakMap();
    const wrap = (listener) => {
      if (typeof listener !== "function" && typeof listener?.handleEvent !== "function") return listener;
      if (!wrapped.has(listener)) {
        wrapped.set(listener, function (event) {
          if (withheld(event)) return undefined;
          return typeof listener === "function" ? listener.call(this, event) : listener.handleEvent(event);
        });
      }
      return wrapped.get(listener);
    };
    const proto = WebSocket.prototype;
    const add = proto.addEventListener;
    const remove = proto.removeEventListener;
    proto.addEventListener = function (type, listener, options) {
      return add.call(this, type, type === "message" ? wrap(listener) : listener, options);
    };
    proto.removeEventListener = function (type, listener, options) {
      return remove.call(this, type, type === "message" && wrapped.has(listener) ? wrapped.get(listener) : listener, options);
    };
    const onmessage = Object.getOwnPropertyDescriptor(proto, "onmessage");
    const handlers = new WeakMap();
    Object.defineProperty(proto, "onmessage", {
      configurable: true,
      enumerable: onmessage.enumerable,
      get() {
        return handlers.has(this) ? handlers.get(this) : onmessage.get.call(this);
      },
      set(handler) {
        handlers.set(this, handler);
        onmessage.set.call(this, typeof handler === "function" ? wrap(handler) : handler);
      },
    });
  }

  // "channel:ts" -> the copies of that message, oldest first.
  const copies = new Map();
  const keyOf = (channel, ts) => `${channel}:${ts}`;
  function remember(copy) {
    const key = keyOf(copy.channel, copy.ts);
    const known = copies.get(key) ?? [];
    if (known.some((each) => each.kind === copy.kind && each.editedTs === copy.editedTs)) return;
    copies.set(key, [...known, copy].sort((a, b) => String(a.at).localeCompare(String(b.at))));
    scheduleMarks();
  }

  async function keep(copy) {
    try {
      remember(await electron.ipcRenderer.invoke("powertoys:history-add", copy));
    } catch (caught) {
      const why = caught.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
      log(`couldn't keep a copy of a message (${copy.kind}) in ${copy.channel}: ${why}`);
      page?.notice(`Couldn't keep a copy of ${copy.kind === "deleted" ? "a deleted" : "an edited"} message: ${why}`);
    }
  }

  exports.hookSocket = function hookSocket() {
    document.addEventListener("powertoys:history", (event) => {
      try {
        keep(JSON.parse(event.detail));
      } catch (caught) {
        log(`an unreadable copy: ${caught.message}`);
      }
    });
    electron.webFrame.executeJavaScript(`(${socketHook.toString()})()`).catch((caught) => log(`the page script failed: ${caught.message}`));
  };

  // --- Marks -----------------------------------------------------------------------------------------------
  const STYLE = `
    .powertoys-deleted { opacity: .55; }
    .powertoys-history-tag { font-size: 12px; color: #e01e5a; margin-top: 2px; }
    .powertoys-history-earlier { font-size: 12px; color: #1d9bd1; cursor: pointer; margin-left: 2px; }
    .powertoys-history-earlier:hover { text-decoration: underline; }`;

  const time = (iso) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

  function earlierVersions(event, edits) {
    event.preventDefault();
    event.stopPropagation();
    const text = edits.map((edit) => `Before the edit seen ${time(edit.at)}:\n${edit.text}`).join("\n\n");
    page.popover({ title: edits.length > 1 ? "Earlier versions" : "Earlier version", text, x: event.clientX, y: event.clientY });
  }

  function markMessage(container, known) {
    const deleted = known.find((each) => each.kind === "deleted");
    const edits = known.filter((each) => each.kind === "edited");
    const textBox = container.querySelector('[data-qa="message-text"]');
    if (deleted && !container.querySelector(".powertoys-history-tag")) {
      container.classList.add("powertoys-deleted");
      const tag = document.createElement("div");
      tag.className = "powertoys-history-tag";
      tag.textContent = `Deleted · seen ${time(deleted.at)} · copy kept`;
      tag.title = "Powertoys kept this message after it was deleted (Powertoys panel, History tab)";
      (textBox ?? container.lastElementChild ?? container).after(tag);
    }
    const label = container.querySelector(".c-message__edited_label");
    if (edits.length && label && !container.querySelector(".powertoys-history-earlier")) {
      const link = document.createElement("span");
      link.className = "powertoys-history-earlier";
      link.textContent = edits.length > 1 ? `${edits.length} earlier versions` : "earlier version";
      link.setAttribute("role", "button");
      link.tabIndex = 0;
      link.addEventListener("click", (event) => earlierVersions(event, edits));
      link.addEventListener("keydown", (event) => (event.key === "Enter" || event.key === " ") && earlierVersions(event, edits));
      label.after(link);
    }
  }

  let scheduled = false;
  function scheduleMarks() {
    if (scheduled || !page || !copies.size) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      for (const container of document.querySelectorAll('[data-qa="message_container"][data-msg-ts][data-msg-channel-id]')) {
        const known = copies.get(keyOf(container.dataset.msgChannelId, container.dataset.msgTs));
        if (known) markMessage(container, known);
      }
    });
  }

  exports.start = async function start(pageModule) {
    page = pageModule;
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);
    new MutationObserver(scheduleMarks).observe(document.body, { childList: true, subtree: true });
    try {
      for (const copy of await page.invoke("history-list")) remember(copy);
    } catch (caught) {
      log(`couldn't read the copies: ${page.reason(caught)}`);
    }
  };
});
