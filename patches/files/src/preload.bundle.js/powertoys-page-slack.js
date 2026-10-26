// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): huddle captions set through Slack's own state, not its menus (started by powertoys/page).
//
// Slack's "huddles_cc_by_default" turns on both caption displays when you join a huddle: side-by-side and the
// closed-caption overlay. Powertoys wants side-by-side only, in the side panel's Captions tab. hookSlack, run from the
// preload, puts a script in the page's world that finds Slack's own modules (through its rspack chunk list, by what
// their code says, not by their short names, which change between releases): the workspaces' stores and the action
// creators "Set enabled state for huddle closed captions view" and "Set selected tab". It watches the stores: when
// side-by-side comes on, the Captions tab is selected; when the overlay comes on with it (within 2 s: Slack's join
// default), it is turned off. The overlay turned on later from the menu stays. Nothing is clicked.
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
      const [stores, captions, tabs, client] = ["stores", "captions", "tabs", "client"].map((key) => load(ids[key]));
      const parts = {
        storeMap: exported(stores, (value) => value.name === "getStoreInstanceMap"),
        closedCaptions: creator(captions, "Set enabled state for huddle closed captions view"),
        selectTab: creator(tabs, "Set selected tab"),
        dispatchForClient: exported(client, (value) => value.name === "dispatchForClientStore"),
      };
      const missing = Object.keys(parts).filter((key) => !parts[key]);
      if (missing.length && !find.warned) say(`captions: Slack's modules found, but not ${missing.join(", ")} in them`);
      find.warned = missing.length > 0;
      return missing.length ? null : parts;
    }

    const watched = new WeakSet();
    function watch() {
      const map = found.storeMap();
      for (const store of map instanceof Map ? map.values() : Object.values(map ?? {})) {
        if (!store?.subscribe || watched.has(store)) continue;
        watched.add(store);
        let last = store.getState()?.huddleEvents ?? {};
        let sideBySideAt = 0;
        store.subscribe(() => {
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
          if (now.isClosedCaptionsEnabled && !before.isClosedCaptionsEnabled && Date.now() - sideBySideAt < 2000) {
            store.dispatch(found.closedCaptions(false));
            say("captions: the overlay Slack turned on with them is off (side-by-side only)");
          }
        });
      }
    }

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
        say("captions: Slack's caption and tab actions found");
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
    electron.webFrame.executeJavaScript(`(${slackHook.toString()})()`).catch((caught) => electron.ipcRenderer.send("powertoys:log", `captions: the page script failed: ${caught.message}`));
  };
});
