// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): the preload half, in Slack's page (app.slack.com).
//
// Started by one line in preload.bundle.js/_runtime.js, right after the preload's store exists:
//   webpackRequire("powertoys/page").start(store);
// It runs in the preload's isolated world: it can read and change the page through the DOM, and talk to the main
// process through Slack's IPC. Features that need the page go here.
// ---------------------------------------------------------------------------------------------
(function (module, exports) {
  "use strict";

  exports.start = function start(store) {
    // A marker the page (and a smoke test) can see: Powertoys' preload half is running.
    globalThis.addEventListener?.("DOMContentLoaded", () => {
      document.documentElement.dataset.powertoys = "1";
    });
    return store;
  };
});
