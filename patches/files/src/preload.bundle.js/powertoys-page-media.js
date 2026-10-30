// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): videos in Slack can play louder, up to 300% (started by powertoys/page).
//
// A "Louder" slider in the video player's own controls, right after Slack's volume control (in a message's player and
// in the media viewer), from 100% (as Slack plays it) to 300%; it shows and hides with Slack's controls.
// Above 100% the video's sound goes through a gain (Web Audio). A video from files.slack.com is first reloaded with
// credentialed CORS (files.slack.com allows it), where it was, because Chromium silences a cross-origin video's sound
// in Web Audio otherwise. Slack's own volume control still works and is multiplied by this one.
// The level is kept for the video, not just its player: maximizing it (a new player) plays it as loud. A video is known
// by its file address, or, streamed (a blob: address, new for every player), by its length.
// ---------------------------------------------------------------------------------------------
(function (module, exports, __webpack_require__) {
  "use strict";

  let page;
  const MAX = 300;
  const boosts = new WeakMap(); // video -> { gain, percent }
  const levels = new Map(); // a video's key -> its level, for the next player of it
  /** What tells a video apart from one player to the next: its file address, or a stream's length. */
  const keyOf = (video) =>
    video.currentSrc && !/^blob:/.test(video.currentSrc) ? video.currentSrc.split("?")[0] : Number.isFinite(video.duration) ? `length ${video.duration.toFixed(1)}` : null;
  let context = null;

  // In Slack's page (the player's controls are Slack's own nodes), so in the document, not in Powertoys' layer.
  const STYLE = `
    .powertoys-louder { display: flex; align-items: center; gap: 4px; height: 28px; margin: 0 8px; color: #fff;
      font: 700 12px Lato, "Segoe UI", sans-serif; white-space: nowrap; transition: opacity 80ms cubic-bezier(.36,.19,.29,1); }
    .powertoys-louder input { width: 64px; accent-color: #fff; margin: 0; cursor: pointer; }
    .powertoys-louder input:focus-visible { outline: 2px solid #1d9bd1; outline-offset: 2px; }
    .powertoys-louder span { min-width: 34px; font-variant-numeric: tabular-nums; }
    .p-video_controls_overlay--design_polish:not(:hover):not(.p-video_controls_overlay--active) .powertoys-louder { opacity: 0; }`;

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
      const kind = /^blob:/.test(video.currentSrc) ? "stream (blob)" : video.currentSrc.split("?")[0].slice(0, 80);
      page.log(`louder: ${kind}, crossOrigin ${video.crossOrigin}, muted ${video.muted}, volume ${video.volume}, playing ${!video.paused}`);
      if (!video.crossOrigin && /^https:\/\/files\.slack\.com\//.test(video.currentSrc)) await reloadWithCors(video);
      context ??= new AudioContext();
      const gain = context.createGain();
      // The level after the gain, for the log: silence there means the video's sound isn't reaching the gain.
      const meter = context.createAnalyser();
      context.createMediaElementSource(video).connect(gain).connect(context.destination);
      gain.connect(meter);
      state = { gain, meter, percent: 100 };
      boosts.set(video, state);
    }
    if (context.state === "suspended") await context.resume();
    state.gain.gain.value = percent / 100;
    state.percent = percent;
    if (keyOf(video)) levels.set(keyOf(video), percent);
    clearTimeout(state.report);
    state.report = setTimeout(() => {
      const samples = new Float32Array(state.meter.fftSize);
      state.meter.getFloatTimeDomainData(samples);
      const peak = samples.reduce((top, sample) => Math.max(top, Math.abs(sample)), 0);
      page.log(`louder: ${percent}%, audio ${context.state} at ${context.sampleRate} Hz, peak after the gain ${peak.toFixed(3)}, video ${video.paused ? "paused" : "playing"}, volume ${video.volume}, muted ${video.muted}`);
    }, 1500);
  }

  // --- The slider, in the player's controls ----------------------------------------------------------------
  /** The video a player's control belongs to: the nearest one up its ancestors (the player can redraw its video). */
  function videoOf(node) {
    for (let at = node.parentElement; at && at !== document.body; at = at.parentElement) {
      const video = at.querySelector("video");
      if (video) return video;
    }
    return null;
  }

  function show(control, percent) {
    const input = control.querySelector("input");
    input.value = String(percent);
    input.setAttribute("aria-valuetext", `${percent}%`);
    control.querySelector("span").textContent = `${percent}%`;
  }

  function sliderFor(volume) {
    const control = document.createElement("div");
    control.className = "powertoys-louder";
    control.title = "Louder (Powertoys), up to 300%";
    const input = document.createElement("input");
    input.type = "range";
    input.min = "100";
    input.max = String(MAX);
    input.step = "10";
    input.setAttribute("aria-label", "Louder");
    const shown = document.createElement("span");
    shown.setAttribute("aria-hidden", "true");
    control.append(input, shown);
    // The player plays, pauses and seeks on its clicks and keys; the slider's own stay with the slider.
    for (const type of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "keydown", "keyup"]) control.addEventListener(type, (event) => event.stopPropagation());
    input.addEventListener("input", () => {
      const percent = Number(input.value);
      show(control, percent);
      const video = videoOf(control);
      if (!video) return;
      setLouder(video, percent).catch((caught) => {
        show(control, boosts.get(video)?.percent ?? 100);
        page.notice(`Couldn't make it louder: ${caught.message}`);
      });
    });
    control.addEventListener("pointerenter", () => {
      const video = videoOf(control);
      if (video && document.activeElement !== input) show(control, boosts.get(video)?.percent ?? 100);
    });
    show(control, boosts.get(videoOf(volume))?.percent ?? 100);
    return control;
  }

  /** A new player of a video played louder before (maximized, or back from it): the same level, once it knows its video. */
  function keepLevel(video, control) {
    const apply = () => {
      const percent = levels.get(keyOf(video));
      if (!percent || percent <= 100 || boosts.has(video)) return;
      setLouder(video, percent).then(
        () => (show(control, percent), page.log(`louder: kept at ${percent}% in this player of the video`)),
        (caught) => page.log(`louder: couldn't keep ${percent}% in this player (${caught.message})`),
      );
    };
    if (video.readyState >= 1) apply();
    else video.addEventListener("loadedmetadata", apply, { once: true });
  }

  // Players come and go as Slack draws them: each one with a video gets the slider after its volume control.
  let placed = false;
  let pending = false;
  function place() {
    pending = false;
    for (const volume of document.querySelectorAll(".p-media_volume_slider")) {
      if (volume.nextElementSibling?.classList.contains("powertoys-louder") || !videoOf(volume)) continue;
      const control = sliderFor(volume);
      volume.after(control);
      if (!placed) page.log("louder: the slider is in a video player's controls");
      placed = true;
      keepLevel(videoOf(volume), control);
    }
  }

  exports.start = function start(pageModule) {
    page = pageModule;
    const style = document.createElement("style");
    style.dataset.powertoysLouder = "1";
    style.textContent = STYLE;
    document.head.appendChild(style);
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(place);
    }).observe(document.body, { childList: true, subtree: true });
    place();
  };
});
