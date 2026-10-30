// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): huddle captions set through Slack's own state, not its menus (started by powertoys/page).
//
// Slack's "huddles_cc_by_default" turns on both caption displays when you join a huddle: side-by-side and the
// closed-caption overlay. Powertoys wants side-by-side only, in the side panel's Captions tab. hookSlack, run from the
// preload, puts a script in the page's world that finds Slack's own modules (through its rspack chunk list, by what
// their code says, not by their short names, which change between releases): the workspaces' stores and the action
// creators "Set enabled state for huddle closed captions view" and "Set selected tab". It watches the stores: when
// side-by-side comes on, the Captions tab is selected; when the overlay comes on within 30 s of that or of the huddle's
// start (Slack's join default), it is turned off. The overlay turned on later from the menu stays. Nothing is clicked.
// Slack 4.53 no longer turns side-by-side on at once when you join (in one huddle, only when it ended), so when a huddle
// window shows (powertoys/huddle tells the page) side-by-side is turned on with Slack's own "Set enabled state for huddle
// captions side-by-side view" in every store that doesn't have it yet, the Captions tab is selected, and the overlay is
// turned off, then and when Slack turns it on in the huddle's first 30 s (a store can keep side-by-side on from the
// last huddle, and then nothing flips for the watcher to act on). During a call the huddle's state is in Slack's client
// store (it reaches the workspace's store only when the call ends), so that store is watched and set too.
// Slack's "Heads up — AI notes are on" notice, shown to who joins a huddle with AI notes on, is closed as its "Got It"
// does: taken out of Slack's open modals (its modal store), and the store told. The notice the one who starts AI notes
// gets ("Everyone ready to start AI notes?", Start or Cancel) stays.
// ---------------------------------------------------------------------------------------------
(function (module, exports, __webpack_require__) {
  "use strict";

  const electron = __webpack_require__(261);

  // In the page's own world.
  function slackHook() {
    if (window.__powertoysSlack) return;
    window.__powertoysSlack = true;
    const say = (text) => document.dispatchEvent(new CustomEvent("powertoys:slack-log", { detail: String(text) }));
    let load = null;
    (globalThis.rspackChunkGantryV2 ||= []).push([[Symbol("powertoys")], {}, (require) => (load = require)]);

    // Slack's modules whose code has all these texts; each module's code is read once, as modules arrive.
    const WANTED = {
      stores: ["function dispatchForTeamId", "function getStoreInstanceMap"],
      captions: ['"Set enabled state for huddle closed captions view"'],
      tabs: ['"Set selected tab"', '"Upsert huddle object"'],
      client: ["function dispatchForClientStore"],
      modals: ['"Sets a flag that will prevent the video recorder modal from being closed"', "modalsByTeamAndWindow"],
    };
    const ids = {};
    const scanned = new Set();
    const scan = () => {
      for (const id of Object.keys(load?.m ?? {})) {
        if (scanned.has(id)) continue;
        scanned.add(id);
        const source = String(load.m[id]);
        for (const [key, texts] of Object.entries(WANTED)) if (!ids[key] && texts.every((text) => source.includes(text))) ids[key] = id;
      }
    };
    const exported = (module, test) => Object.values(module ?? {}).find((value) => typeof value === "function" && test(value));
    const creator = (module, description) => exported(module, (value) => typeof value.getType === "function" && String(value.getType()).endsWith(`] ${description}`));

    let found = null;
    function find() {
      scan();
      if (Object.keys(WANTED).some((key) => !ids[key])) return null;
      // Loaded the way Slack loads them (already loaded: their exports as they are).
      const [stores, captions, tabs, client, modals] = ["stores", "captions", "tabs", "client", "modals"].map((key) => load(ids[key]));
      const parts = {
        storeMap: exported(stores, (value) => value.name === "getStoreInstanceMap"),
        closedCaptions: creator(captions, "Set enabled state for huddle closed captions view"),
        sideBySide: creator(captions, "Set enabled state for huddle captions side-by-side view"),
        selectTab: creator(tabs, "Set selected tab"),
        dispatchForClient: exported(client, (value) => value.name === "dispatchForClientStore"),
        // The client store: during a call (4.53) the huddle's state is there, and reaches the workspace's store only
        // when the call ends.
        clientStore: exported(client, (value) => value.name === "tryGetClientStoreInstance"),
        // The open modals, by workspace and window, and the action that tells the store they changed.
        openModals: Object.values(modals ?? {}).find((value) => value?.constructor === Object),
        modalsChanged: creator(modals, "Open a modal"),
      };
      const missing = Object.keys(parts).filter((key) => !parts[key]);
      if (missing.length && !find.warned) say(`captions: Slack's modules found, but not ${missing.join(", ")} in them`);
      find.warned = missing.length > 0;
      return missing.length ? null : parts;
    }

    // The workspaces' stores (by team id) and the client store: [label, store].
    const labelledStores = () => {
      const map = found.storeMap();
      return [...(map instanceof Map ? map.entries() : Object.entries(map ?? {})), ["client", found.clientStore()]].filter(([, store]) => store);
    };
    const allStores = () => labelledStores().map(([, store]) => store);
    const watched = new WeakSet();
    let huddleStartedAt = 0; // when the last huddle window showed
    function watch() {
      for (const store of allStores()) {
        if (!store?.subscribe || watched.has(store)) continue;
        watched.add(store);
        let last = store.getState()?.huddleEvents ?? {};
        let sideBySideAt = 0;
        let modalsAt = store.getState()?.modal?.lastUpdated;
        store.subscribe(() => {
          if (store.getState()?.modal?.lastUpdated !== modalsAt) {
            modalsAt = store.getState()?.modal?.lastUpdated;
            closeAiNotesNotice(store);
          }
          const now = store.getState()?.huddleEvents;
          if (!now || now === last) return;
          const before = last;
          last = now;
          if (now.isSideBySideEnabled && !before.isSideBySideEnabled) {
            sideBySideAt = Date.now();
            const tab = found.selectTab({ selectedTab: "captions" });
            store.dispatch(tab);
            found.dispatchForClient(tab);
            say("captions: side-by-side on; the side panel shows Captions");
          }
          // Slack's join default (huddles_cc_by_default): on with side-by-side, or once the huddle's transcription has
          // started, some seconds in (4.53); within 30 s of either it is Slack's, later it was you.
          if (now.isClosedCaptionsEnabled && !before.isClosedCaptionsEnabled) {
            const since = Math.round((Date.now() - Math.max(sideBySideAt, huddleStartedAt)) / 1000);
            if (since < 30) {
              store.dispatch(found.closedCaptions(false));
              say(`captions: the overlay Slack turned on ${since} s in is off (side-by-side only)`);
            } else say(`captions: the overlay came on ${since} s in; left on (yours)`);
          }
        });
      }
    }

    // "Got It" closes the notice and nothing else; so does this, wherever it is open.
    function closeAiNotesNotice(store) {
      for (const [key, modals] of Object.entries(found.openModals)) {
        const kept = modals.filter((modal) => !(modal?.name === "SlackAIHuddleRecordingLegalModal" && !modal.element?.props?.isInitiator));
        if (kept.length === modals.length) continue;
        found.openModals[key] = kept;
        store.dispatch(found.modalsChanged());
        say('huddle: the "AI notes are on" notice is closed, as its Got It would');
      }
    }

    // A huddle window showed: side-by-side captions on where they aren't, the overlay off where it is, and the
    // Captions tab, whatever side-by-side was already (a store keeps it from the last huddle, and then nothing flips).
    document.addEventListener("powertoys:slack-command", (event) => {
      if (event.detail !== "captions-on" || !found) return;
      huddleStartedAt = Date.now();
      let turned = 0;
      let overlays = 0;
      const tab = found.selectTab({ selectedTab: "captions" });
      for (const store of allStores()) {
        const events = store?.getState?.()?.huddleEvents;
        if (!events) continue;
        if (!events.isSideBySideEnabled) (store.dispatch(found.sideBySide(true)), turned++);
        if (events.isClosedCaptionsEnabled) (store.dispatch(found.closedCaptions(false)), overlays++);
        store.dispatch(tab);
      }
      say(`captions: a huddle started; the side panel shows Captions (side-by-side turned on in ${turned}, overlay turned off in ${overlays} of the stores)`);
      // Slack turns the overlay on once the call's audio is connected; whatever store it lands in, it goes off within
      // these checks, and the log says where each store stood.
      for (const seconds of [3, 8, 15, 30]) {
        setTimeout(() => {
          const states = [];
          for (const [label, store] of labelledStores()) {
            const events = store.getState?.()?.huddleEvents;
            if (!events) continue;
            states.push(`${label}: side-by-side ${events.isSideBySideEnabled ? "on" : "off"}, overlay ${events.isClosedCaptionsEnabled ? "on" : "off"}`);
            if (events.isClosedCaptionsEnabled) store.dispatch(found.closedCaptions(false));
          }
          say(`captions: ${seconds} s in: ${states.join("; ") || "no store has the huddle's captions"}${states.some((each) => each.endsWith("overlay on")) ? " (overlays turned off)" : ""}`);
        }, seconds * 1000);
      }
    });

    // Slack's modules arrive as its code loads: looked for every 2 s for 3 minutes; the stores, then every 10 s.
    let tries = 0;
    const look = setInterval(() => {
      try {
        found ??= load ? find() : null;
      } catch (caught) {
        say(`captions: looking for Slack's modules failed: ${caught.message}`);
      }
      if (found) {
        clearInterval(look);
        say("captions: Slack's caption, tab and modal actions found");
        watch();
        setInterval(watch, 10000);
      } else if (++tries > 90) {
        clearInterval(look);
        say("captions: Slack's caption actions weren't found; captions are left as Slack sets them");
      }
    }, 2000);
  }

  exports.hookSlack = function hookSlack() {
    document.addEventListener("powertoys:slack-log", (event) => electron.ipcRenderer.send("powertoys:log", String(event.detail)));
    electron.ipcRenderer.on("powertoys:huddle-started", () => document.dispatchEvent(new CustomEvent("powertoys:slack-command", { detail: "captions-on" })));
    electron.webFrame.executeJavaScript(`(${slackHook.toString()})()`).catch((caught) => electron.ipcRenderer.send("powertoys:log", `captions: the page script failed: ${caught.message}`));
  };
});
