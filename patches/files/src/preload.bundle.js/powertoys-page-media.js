// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): videos in Slack can play louder, up to 300% (started by powertoys/page).
//
// Pointing at a video shows a small "Louder" slider at its top-left corner, from 100% (as Slack plays it) to 300%.
// Above 100% the video's sound goes through a gain (Web Audio). A video from files.slack.com is first reloaded with
// credentialed CORS (files.slack.com allows it), where it was, because Chromium silences a cross-origin video's sound
// in Web Audio otherwise. Slack's own volume control still works and is multiplied by this one.
// ---------------------------------------------------------------------------------------------
(function (module, exports, __webpack_require__) {
  "use strict";

  let page;
  const MAX = 300;
  const boosts = new WeakMap(); // video -> { gain, percent }
  let context = null;

  const STYLE = `
    .louder { position: fixed; z-index: 2147483646; display: flex; align-items: center; gap: 6px; padding: 4px 8px;
      border-radius: 6px; background: rgba(26,29,33,.85); color: #fff; font: 12px Lato, "Segoe UI", sans-serif; }
    .louder input { width: 110px; accent-color: #1d9bd1; margin: 0; }
    .louder input:focus-visible { outline: 2px solid #1d9bd1; outline-offset: 2px; }
    .louder[hidden] { display: none; }`;

  /** Reloads a files.slack.com video with credentialed CORS, back where it was (playing if it was). */
  function reloadWithCors(video) {
    const at = video.currentTime;
    const playing = !video.paused;
    return new Promise((resolve, reject) => {
      const settle = (ok) => {
        video.removeEventListener("loadedmetadata", loaded);
        video.removeEventListener("error", failed);
        video.currentTime = at;
        if (playing) video.play().catch(() => {});
        ok ? resolve() : reject(new Error("the video didn't load again for a louder volume"));
      };
      const loaded = () => settle(true);
      const failed = () => {
        video.removeAttribute("crossorigin");
        video.load();
        settle(false);
      };
      video.addEventListener("loadedmetadata", loaded);
      video.addEventListener("error", failed);
      video.crossOrigin = "use-credentials";
      video.load();
    });
  }

  async function setLouder(video, percent) {
    let state = boosts.get(video);
    if (!state) {
      if (percent <= 100) return;
      if (!video.crossOrigin && /^https:\/\/files\.slack\.com\//.test(video.currentSrc)) await reloadWithCors(video);
      context ??= new AudioContext();
      const gain = context.createGain();
      context.createMediaElementSource(video).connect(gain).connect(context.destination);
      state = { gain, percent: 100 };
      boosts.set(video, state);
    }
    if (context.state === "suspended") await context.resume();
    state.gain.gain.value = percent / 100;
    state.percent = percent;
  }

  // --- The slider ------------------------------------------------------------------------------------------
  let control = null;
  let current = null; // the video the slider is for
  let hideTimer = null;

  function slider() {
    if (control?.isConnected) return control;
    const root = page.ui();
    if (!root.querySelector("style[data-louder]")) {
      const style = document.createElement("style");
      style.dataset.louder = "1";
      style.textContent = STYLE;
      root.appendChild(style);
    }
    control = document.createElement("div");
    control.className = "louder";
    control.hidden = true;
    const label = document.createElement("label");
    label.textContent = "Louder";
    const input = document.createElement("input");
    input.type = "range";
    input.min = "100";
    input.max = String(MAX);
    input.step = "10";
    input.id = "powertoys-louder";
    label.htmlFor = input.id;
    const shown = document.createElement("span");
    shown.setAttribute("aria-hidden", "true");
    input.addEventListener("input", () => {
      const percent = Number(input.value);
      shown.textContent = `${percent}%`;
      input.setAttribute("aria-valuetext", `${percent}%`);
      const video = current;
      if (!video) return;
      setLouder(video, percent).catch((caught) => {
        input.value = String(boosts.get(video)?.percent ?? 100);
        shown.textContent = `${input.value}%`;
        page.notice(`Couldn't make it louder: ${caught.message}`);
      });
    });
    control.append(label, input, shown);
    control.addEventListener("pointerenter", () => clearTimeout(hideTimer));
    control.addEventListener("pointerleave", hideSoon);
    root.appendChild(control);
    return control;
  }

  function showFor(video) {
    clearTimeout(hideTimer);
    const box = slider();
    const rect = video.getBoundingClientRect();
    box.style.left = `${Math.max(0, rect.left + 8)}px`;
    box.style.top = `${Math.max(0, rect.top + 8)}px`;
    if (current !== video) {
      current = video;
      const percent = boosts.get(video)?.percent ?? 100;
      const input = box.querySelector("input");
      input.value = String(percent);
      input.setAttribute("aria-valuetext", `${percent}%`);
      box.querySelector("span").textContent = `${percent}%`;
    }
    box.hidden = false;
  }

  function hideSoon() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => control && !control.contains(control.getRootNode().activeElement) && (control.hidden = true), 1500);
  }

  // Slack lays its own controls over a video, so the pointer is matched by position, not by the element under it.
  let pending = false;
  function onPointerMove(event) {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const video = [...document.querySelectorAll("video")].find((each) => {
        const rect = each.getBoundingClientRect();
        return rect.width > 80 && rect.height > 60 && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      });
      if (video) showFor(video);
      else if (control && !control.hidden) hideSoon();
    });
  }

  exports.start = function start(pageModule) {
    page = pageModule;
    document.addEventListener("pointermove", onPointerMove, { passive: true, capture: true });
  };
});
