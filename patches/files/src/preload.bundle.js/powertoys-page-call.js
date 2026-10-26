// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): the call's sound, recorded where Slack's page receives it (for powertoys/huddle).
//
// Slack's huddles run in its main page over WebRTC (Amazon Chime's client): the other people's sound arrives as audio
// tracks on an RTCPeerConnection and is played by an <audio> element. hookCall, run from the preload before Slack's
// own scripts, puts a script in the page's world that notes every incoming audio track (the peer connections' "track"
// events, and, each second, whatever Slack's audio and video elements play), and, while a huddle is recorded, mixes
// them into a MediaRecorder. Recording a track leaves it playing. Nothing depends on which speaker Slack plays to.
//
// The main process drives it ("powertoys:call-command": start / stop / probe, with the recording's id) and gets
// "powertoys:call-event" back: started (when the first moment was recorded), chunk (half a second of Opus in WebM,
// numbered), level (each second: the loudest sample, how many tracks are recorded and how many are live), error,
// stopped, probe.
// ---------------------------------------------------------------------------------------------
(function (module, exports, __webpack_require__) {
  "use strict";

  const electron = __webpack_require__(261);
  const log = (message) => electron.ipcRenderer.send("powertoys:log", `call: ${message}`);

  // In the page's own world.
  function callTap() {
    if (window.__powertoysCall) return;
    window.__powertoysCall = true;
    const say = (message) => document.dispatchEvent(new CustomEvent("powertoys:call", { detail: JSON.stringify(message) }));
    const known = new Set(); // incoming audio tracks
    let session = null;

    function connect(track) {
      if (!session || session.nodes.has(track) || track.readyState !== "live") return;
      const node = session.context.createMediaStreamSource(new MediaStream([track]));
      node.connect(session.destination);
      node.connect(session.analyser);
      session.nodes.set(track, node);
    }
    function tap(track) {
      if (track?.kind !== "audio" || known.has(track)) return;
      known.add(track);
      track.addEventListener("ended", () => {
        known.delete(track);
        session?.nodes.get(track)?.disconnect();
        session?.nodes.delete(track);
      });
      connect(track);
    }

    // Every peer connection Slack uses: its incoming tracks.
    const watched = new WeakSet();
    const watch = (peer) => {
      if (watched.has(peer)) return;
      watched.add(peer);
      add.call(peer, "track", (event) => tap(event.track));
      for (const receiver of peer.getReceivers()) tap(receiver.track);
    };
    const proto = RTCPeerConnection.prototype;
    const add = proto.addEventListener;
    const setRemote = proto.setRemoteDescription;
    proto.addEventListener = function (...args) {
      watch(this);
      return add.apply(this, args);
    };
    proto.setRemoteDescription = function (...args) {
      watch(this);
      return setRemote.apply(this, args);
    };
    // And whatever the page plays: a track the peer connections didn't show is still recorded.
    setInterval(() => {
      for (const element of document.querySelectorAll("audio, video")) {
        if (element.srcObject instanceof MediaStream) for (const track of element.srcObject.getAudioTracks()) tap(track);
      }
    }, 1000);

    const base64 = (blob) =>
      new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(",") + 1));
        reader.readAsDataURL(blob);
      });

    async function start(id) {
      if (session) stop(session.id);
      const context = new AudioContext({ sampleRate: 48000 });
      await context.resume();
      const destination = context.createMediaStreamDestination();
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      const mine = { id, context, destination, analyser, nodes: new Map(), queue: Promise.resolve(), sequence: 0 };
      session = mine;
      for (const track of known) connect(track);
      const recorder = new MediaRecorder(destination.stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 128000 });
      mine.recorder = recorder;
      // In order: each piece is converted and sent only after the one before it.
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        const sequence = mine.sequence++;
        mine.queue = mine.queue.then(async () => say({ type: "chunk", id, sequence, data: await base64(event.data) }));
      };
      recorder.onerror = (event) => say({ type: "error", id, error: event.error?.message ?? "MediaRecorder failed" });
      recorder.onstop = () => mine.queue.then(() => say({ type: "stopped", id }));
      const samples = new Float32Array(analyser.fftSize);
      mine.timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let level = 0;
        for (const sample of samples) level = Math.max(level, Math.abs(sample));
        const live = [...known].filter((track) => track.readyState === "live").length;
        say({ type: "level", id, level, tracks: mine.nodes.size, live });
      }, 1000);
      const startedAt = Date.now();
      recorder.start(500);
      say({ type: "started", id, startedAt, tracks: mine.nodes.size });
    }

    function stop(id) {
      const mine = session;
      if (!mine || mine.id !== id) return say({ type: "stopped", id });
      session = null;
      clearInterval(mine.timer);
      if (mine.recorder.state !== "inactive") mine.recorder.stop();
      else mine.queue.then(() => say({ type: "stopped", id }));
      mine.queue.then(() => mine.context.close());
    }

    document.addEventListener("powertoys:call-command", (event) => {
      const { action, id } = JSON.parse(event.detail);
      if (action === "start") start(id).catch((caught) => say({ type: "error", id, error: caught.message }));
      else if (action === "stop") stop(id);
      else if (action === "probe") say({ type: "probe", id, recorder: MediaRecorder.isTypeSupported("audio/webm;codecs=opus"), tracks: known.size });
    });
  }

  exports.hookCall = function hookCall() {
    document.addEventListener("powertoys:call", (event) => electron.ipcRenderer.send("powertoys:call-event", event.detail));
    electron.ipcRenderer.on("powertoys:call-command", (event, command) =>
      document.dispatchEvent(new CustomEvent("powertoys:call-command", { detail: JSON.stringify(command) })),
    );
    electron.webFrame.executeJavaScript(`(${callTap.toString()})()`).catch((caught) => log(`the page script failed: ${caught.message}`));
  };
});
