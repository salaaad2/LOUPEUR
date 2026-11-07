"use strict";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRACK_COUNT = 4;
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.1;      // seconds
const SEAM_SECONDS = 0.008;
const RAMP_SECONDS = 0.01;
const REVERB_RAMP = 0.02;
const MIN_LOOP_SECONDS = 0.5;
const MAX_TAKE_SECONDS = 8 * 60;
const FREE_TOLERANCE = 0.05;     // seconds
const CLEAR_HOLD_MS = 600;
const EXPORT_TAIL = 1;           // seconds of reverb tail

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  mode: "tempo",         // "free" | "tempo"
  bpm: 100,
  bars: 4,
  clickOn: true,
  reverbOn: false,
  master: 0.85,
  micId: "",             // "" = system default input
  selected: 0,
  transport: "stopped",  // "stopped" | "running"
  loopLength: 0,         // samples, 0 = undefined
  t0: 0,                 // AudioContext time of loop sample 0
  channels: [],
};

let ctx = null;
let masterGain = null;
let dryGain = null;
let wetGain = null;
let convolver = null;
let clickGain = null;
let micStream = null;
let captureNode = null;
let captureReady = false;
let schedulerTimer = null;
let armTimer = null;         // promotes an armed take at its loop boundary
let nextBoundaryIndex = 0;   // next loop index to schedule
let pendingRecord = null;    // { channel, startFrame, endFrame } while capturing
let liveEnv = null;          // envelope of the take in progress, for the waveform
let countInOscs = [];        // clicks of a count-in that has not finished yet

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const el = {
  banner: document.getElementById("banner"),
  tracks: document.getElementById("tracks"),
  bpm: document.getElementById("bpm"),
  bpmOut: document.getElementById("bpmOut"),
  bars: document.getElementById("bars"),
  mode: document.getElementById("mode"),
  click: document.getElementById("click"),
  mic: document.getElementById("mic"),
  reverb: document.getElementById("reverb"),
  master: document.getElementById("master"),
  masterOut: document.getElementById("masterOut"),
  exportBtn: document.getElementById("export"),
  modeHelp: document.getElementById("modeHelp"),
};

// ---------------------------------------------------------------------------
// Audio graph
// ---------------------------------------------------------------------------

async function initAudio() {
  if (ctx) {
    if (ctx.state === "suspended") await ctx.resume();
    return;
  }

  ctx = new (window.AudioContext || window.webkitAudioContext)();

  masterGain = ctx.createGain();
  masterGain.gain.value = state.master;

  dryGain = ctx.createGain();
  dryGain.gain.value = 1;

  wetGain = ctx.createGain();
  wetGain.gain.value = 0;

  convolver = ctx.createConvolver();
  convolver.buffer = makeImpulse(1.8, 2.5);

  clickGain = ctx.createGain();
  clickGain.gain.value = 1;
  clickGain.connect(masterGain);

  dryGain.connect(masterGain);
  convolver.connect(wetGain);
  wetGain.connect(masterGain);
  masterGain.connect(ctx.destination);

  for (let i = 0; i < TRACK_COUNT; i++) {
    const gain = ctx.createGain();
    gain.gain.value = 1;
    gain.connect(dryGain);
    gain.connect(convolver);
    state.channels.push({
      index: i,
      state: "empty",
      buffer: null,
      gain,
      source: null,
      muted: false,
      layers: 0,
      env: null,        // cached waveform envelope
      envBuffer: null,  // buffer the envelope was computed from
      anchorTime: null, // loop time the buffer starts at, null = loop top
    });
  }

  if (ctx.state === "suspended") await ctx.resume();
}

function makeImpulse(seconds, decay) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Mic capture
// ---------------------------------------------------------------------------

async function ensureMic() {
  if (captureReady) return true;

  // getUserMedia only exists in a secure context: https://, or http:// on
  // localhost. Any other http:// origin (LAN IP, hostname) has no
  // navigator.mediaDevices at all, and the browser greys out the permission.
  if (!window.isSecureContext) {
    showBanner(
      "Microphone needs a secure origin. Open http://localhost:8000 (not a LAN IP or hostname), or serve over https://."
    );
    return false;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showBanner("This browser does not support microphone capture.");
    return false;
  }
  if (!ctx.audioWorklet) {
    showBanner("This browser does not support AudioWorklet. Recording is disabled.");
    return false;
  }
  if (location.protocol === "file:") {
    showBanner("Open this page over http://localhost (not file://) so the audio worklet can load.");
    return false;
  }

  // Everything below is inside the try: a failure after the permission grant
  // must not leave captureReady false, or the next click re-prompts.
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: micConstraints(),
    });

    await ctx.audioWorklet.addModule("capture-worklet.js");
    const source = ctx.createMediaStreamSource(micStream);
    captureNode = new AudioWorkletNode(ctx, "capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });
    captureNode.port.onmessage = onCaptureFrame;
    source.connect(captureNode);
    captureReady = true;
    // Labels are only readable once a stream has been granted, so the picker
    // is filled here rather than at boot.
    refreshMicList();
    return true;
  } catch (err) {
    releaseMic();
    if (err && err.name === "NotAllowedError") {
      showBanner("Microphone access was denied. Allow it in your browser settings and try again.");
    } else if (err && err.name === "NotFoundError") {
      showBanner("No microphone found. Connect one and try again.");
    } else if (err && err.name === "OverconstrainedError") {
      // The chosen device was unplugged between selection and capture. Drop
      // it from the picker and fall back to the default input.
      state.micId = "";
      refreshMicList();
      showBanner("That microphone is no longer available. Using the default input.");
    } else {
      showBanner("Could not start the microphone: " + (err && err.message ? err.message : err));
    }
    return false;
  }
}

// Processing is off so the take is the raw signal. deviceId is only pinned
// when the user picked a specific input; "" lets the browser follow the
// system default, which is what a headset swap should do.
function micConstraints() {
  const audio = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  };
  if (state.micId) audio.deviceId = { exact: state.micId };
  return audio;
}

// Fills the picker from enumerateDevices. Labels are empty until the page
// holds a mic permission, so unnamed inputs fall back to "Microphone N".
async function refreshMicList() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  let devices;
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (_) {
    return;
  }
  const inputs = devices.filter((d) => d.kind === "audioinput");
  const options = ['<option value="">Default input</option>'];
  inputs.forEach((d, i) => {
    const label = d.label || `Microphone ${i + 1}`;
    options.push(`<option value="${d.deviceId}">${escapeHtml(label)}</option>`);
  });
  el.mic.innerHTML = options.join("");
  // A device that disappeared falls back to the default instead of leaving
  // the select showing a value that no longer exists.
  const known = inputs.some((d) => d.deviceId === state.micId);
  if (!known) state.micId = "";
  el.mic.value = state.micId;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// Rebuilds the capture path on the newly chosen input. A take in progress is
// cancelled: its samples came from the old device, so splicing two inputs
// into one buffer would be wrong.
async function switchMic(deviceId) {
  if (deviceId === state.micId) return;
  state.micId = deviceId;

  if (pendingRecord) {
    const ch = pendingRecord.channel;
    pendingRecord = null;
    liveEnv = null;
    stopArmTimer();
    ch.state = "empty";
    showBanner("Recording cancelled: the microphone changed.");
  }

  if (!captureReady) {
    // Nothing has been opened yet; the choice is applied on the first record.
    render();
    return;
  }

  releaseMic();
  const ok = await ensureMic();
  if (!ok) {
    // ensureMic reported the failure and, for a vanished device, already
    // reset micId and rebuilt the list. Re-sync the picker either way so it
    // never shows a device that is not actually open.
    el.mic.value = state.micId;
  }
  render();
}

function releaseMic() {
  if (micStream) {
    for (const track of micStream.getTracks()) track.stop();
    micStream = null;
  }
  if (captureNode) {
    captureNode.port.onmessage = null;
    captureNode.disconnect();
    captureNode = null;
  }
  captureReady = false;
}

function onCaptureFrame(e) {
  if (!pendingRecord) return;
  const { frame, data } = e.data;
  const rec = pendingRecord;

  // The take starts at the first block that overlaps the capture window. For
  // an armed take the window opens at a loop boundary, so blocks that arrive
  // before it are dropped and the take is anchored to the boundary itself.
  if (rec.startFrame === null) {
    if (frame + data.length <= rec.startFramePredicted) return;
    rec.startFrame = Math.max(frame, rec.startFramePredicted);
    if (rec.endFrame !== Infinity) rec.endFrame = rec.startFrame + rec.lengthSamples;
  }

  const start = rec.startFrame;
  const end = rec.endFrame;
  const from = Math.max(frame, start);
  const to = Math.min(frame + data.length, end);
  if (to <= from) return;

  const offset = from - frame;
  const count = to - from;
  const target = rec.scratch;
  const writeAt = from - start;
  if (writeAt < 0 || writeAt + count > target.length) return;
  target.set(data.subarray(offset, offset + count), writeAt);
  rec.lastFrame = to - 1;

  // Fold the new samples into the live envelope so the waveform fills in as
  // the take arrives. Buckets are fixed, so the envelope is rescaled to the
  // captured length on every block: one pass over 200 floats, not the take.
  const buckets = liveEnv.length;
  const total = writeAt + count;
  const prev = liveEnv.slice();
  const prevTotal = rec.envTotal || 0;
  liveEnv.fill(0);
  for (let b = 0; b < buckets; b++) {
    const from2 = Math.floor((b * total) / buckets);
    const to2 = Math.min(total, Math.floor(((b + 1) * total) / buckets));
    let peak = 0;
    // Carry over the peak of the old bucket that overlaps this one.
    if (prevTotal > 0) {
      const pFrom = Math.floor((b * prevTotal) / buckets);
      const pTo = Math.min(prevTotal, Math.floor(((b + 1) * prevTotal) / buckets));
      for (let i = pFrom; i < pTo; i++) {
        const v = prev[Math.min(buckets - 1, Math.floor((i * buckets) / prevTotal))];
        if (v > peak) peak = v;
      }
    }
    for (let i = from2; i < to2; i++) {
      const v = target[i] < 0 ? -target[i] : target[i];
      if (v > peak) peak = v;
    }
    liveEnv[b] = peak;
  }
  rec.envTotal = total;

  if (to >= end) finishCapture();
}
// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function loopSamples() {
  if (state.mode === "tempo") {
    // The grid is the musical length, unshortened. Capture runs seamSamples(L)
    // longer than this and foldSeam crossfades that extra tail into the head,
    // so the buffer is exactly L samples and no audio is lost. Subtracting the
    // seam here would make the loop 8 ms short of the bar grid and cut the
    // tail of the last beat.
    return Math.round(state.bars * 4 * (60 / state.bpm) * ctx.sampleRate);
  }
  return state.loopLength;
}

function seamSamples(length) {
  return Math.min(Math.round(SEAM_SECONDS * ctx.sampleRate), Math.floor(length / 2));
}

// First loop boundary at or after `after`. Used for mute ramps, later-track
// record starts, overdub starts, and resume. Not used to start a take that has
// already been recorded: its anchor may be in the past, and the next boundary
// would then be a whole loop away. See schedulePending.
function nextBoundaryTime(after) {
  const L = loopSamples() / ctx.sampleRate;
  if (!L) return after;
  const elapsed = after - state.t0;
  const n = Math.ceil(elapsed / L);
  return state.t0 + n * L;
}

function startTransport(atTime) {
  state.transport = "running";
  state.t0 = atTime;
  // t0 may be in the past (Free Mode back-dating), so begin at the first
  // boundary that has not already gone by.
  const Lsec = loopSamples() / ctx.sampleRate;
  nextBoundaryIndex = Lsec ? Math.max(0, Math.ceil((ctx.currentTime - atTime) / Lsec)) : 0;
  startScheduler();
  // Tracks that are already playing have no source after a stop; start them
  // now rather than waiting for the scheduler to reach a boundary.
  schedulePending();
}

// Starts every playing/overdubbing track that has no source yet. Called when
// the transport starts or a take is committed, so a freshly recorded track is
// heard immediately instead of after a full loop of silence.
//
// Every take is entered at the loop position the transport has already
// reached, computed from its anchor. A take whose anchor is still ahead (a
// later track armed at the loop top, committed before that boundary arrives)
// waits for the boundary; one whose anchor has already gone by — the first
// Free Mode take, or a later take that finished at the end of its window — is
// entered right away. Waiting for the *next* boundary in that case would skip
// a whole loop, which is the "full run before any sound" symptom.
function schedulePending() {
  if (state.transport !== "running" || !ctx) return;
  const L = loopSamples();
  if (!L) return;
  const now = ctx.currentTime;
  for (const ch of state.channels) {
    if (!ch.buffer || ch.source) continue;
    if (ch.state !== "playing" && ch.state !== "overdubbing") continue;
    const anchor = ch.anchorTime || state.t0;
    const when = anchor > now ? anchor : now;
    scheduleChannel(ch, when, loopOffset(ch, when));
  }
}

// Loop position, in samples, that a channel's buffer starts at when its
// source is started at `when`, measured from the channel's anchor (its own
// anchorTime, or the loop top).
function loopOffset(ch, when) {
  const anchor = ch.anchorTime || state.t0;
  const L = loopSamples();
  const elapsed = Math.round((when - anchor) * ctx.sampleRate);
  return ((elapsed % L) + L) % L;
}

function stopTransport() {
  state.transport = "stopped";
  stopScheduler();
  for (const ch of state.channels) {
    if (ch.source) {
      try { ch.source.stop(); } catch (_) {}
      ch.source = null;
    }
  }
}

function rampMaster(target) {
  if (!masterGain) return;
  const now = ctx.currentTime;
  const g = masterGain.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(target, now + RAMP_SECONDS);
}

function startScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(scheduleAhead, LOOKAHEAD_MS);
  scheduleAhead();
}

function stopScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

function scheduleAhead() {
  if (state.transport !== "running" || !ctx) return;
  const L = loopSamples();
  if (!L) return;

  const horizon = ctx.currentTime + SCHEDULE_AHEAD;
  const Lsec = L / ctx.sampleRate;
  if (!(Lsec > 0)) return;

  let guard = 0;
  while (state.t0 + nextBoundaryIndex * Lsec < horizon && guard++ < 64) {
    const when = state.t0 + nextBoundaryIndex * Lsec;
    if (when >= ctx.currentTime - 0.01) {
      for (const ch of state.channels) {
        if (ch.state !== "playing" && ch.state !== "overdubbing") continue;
        // A source already running loops on its own; restarting it at every
        // boundary would cut the take and re-enter it at the wrong offset.
        if (ch.source) continue;
        scheduleChannel(ch, when, loopOffset(ch, when));
      }
    }
    nextBoundaryIndex++;
  }
}

// An armed track becomes RECORDING once the loop top it was waiting for has
// arrived. Driven by the transport clock, not by the first captured block:
// the worklet delivers blocks asynchronously, so keying off audio would flip
// the label a few milliseconds late and make the state invisible.
//
// This runs on its own timer rather than from scheduleAhead, because an armed
// take must still promote if the transport is stopped underneath it.
function promoteArmed() {
  const rec = pendingRecord;
  if (!rec || rec.channel.state !== "armed") return;
  if (ctx.currentTime < rec.startTime) return;
  rec.channel.state = "recording";
  render();
}

function startArmTimer() {
  if (armTimer) return;
  armTimer = setInterval(promoteArmed, LOOKAHEAD_MS);
}

// Beats left before an armed take punches in, for the button label. Counted in
// beats rather than bars because a bar is 2.4 s at 100 BPM: a per-bar number
// sits still long enough to look frozen. Free Mode has no beat grid, so the
// count is in whole loops there. Returns 0 when nothing is armed.
function armCountdown(ch) {
  const rec = pendingRecord;
  if (!rec || rec.channel !== ch || !ctx) return 0;
  const remaining = rec.startTime - ctx.currentTime;
  if (remaining <= 0) return 0;
  const unit = state.mode === "tempo" ? 60 / state.bpm : loopSamples() / ctx.sampleRate;
  if (!(unit > 0)) return 0;
  return Math.max(1, Math.ceil(remaining / unit));
}

function stopArmTimer() {
  if (armTimer) {
    clearInterval(armTimer);
    armTimer = null;
  }
}

function scheduleChannel(ch, when, offset) {
  if (!ch.buffer) return;
  // Retire the previous source so they do not accumulate.
  if (ch.source) {
    try { ch.source.stop(when); } catch (_) {}
  }
  const src = ctx.createBufferSource();
  src.buffer = ch.buffer;
  src.connect(ch.gain);
  // A source entered mid-loop plays the remainder of the buffer and then
  // loops from its head, so the track stays aligned with the transport.
  src.loop = true;
  src.start(when, offset || 0);
  // Drop the reference once the source ends, so a track that stopped on its
  // own is treated as pending again instead of holding a dead source.
  src.onended = () => {
    if (ch.source === src) ch.source = null;
  };
  ch.source = src;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

async function beginRecord(ch) {
  const ok = await ensureMic();
  if (!ok) return;

  // A loop already exists: punch in at the loop top, in both modes. The take
  // is armed now and capture opens at the next loop boundary, which is also
  // loop sample 0, so what the user hears while recording is what plays back.
  // The branch is loopLength, not mode: in Tempo Lock loopLength is what marks
  // "a loop exists", and the grid is derived from BPM and bars.
  if (state.loopLength) {
    const L = state.loopLength;
    const raw = L + seamSamples(L);
    // If the transport is stopped, t0 is stale and there is no boundary to
    // wait for: restart the loop from the top and record from there.
    if (state.transport !== "running") {
      startTransport(ctx.currentTime + 0.05);
    }
    const startAt = nextBoundaryTime(ctx.currentTime + 0.05);
    armCapture(ch, startAt, startAt + raw / ctx.sampleRate, raw);
    ch.state = "armed";
    startArmTimer();
  } else if (state.mode === "tempo") {
    // First Tempo Lock take: count in, then start the transport on beat 5.
    const L = loopSamples();
    const raw = L + seamSamples(L);
    const beat = 60 / state.bpm;
    const countInStart = ctx.currentTime + 0.1;
    playCountIn(countInStart, beat);
    const armAt = countInStart + 4 * beat;
    startTransport(armAt);
    state.loopLength = L;
    // Capture L + seam samples; foldSeam crossfades the extra tail into the
    // head and returns exactly L, so the last beat is not cut.
    armCapture(ch, armAt, armAt + raw / ctx.sampleRate, raw);
    // Armed through the count-in, promoted to RECORDING at beat 5, so the
    // press can be cancelled before any audio is captured.
    ch.state = "armed";
    startArmTimer();
  } else {
    // First Free Mode take: free-running, length fixed at punch-out.
    const startAt = ctx.currentTime + 0.05;
    armCapture(ch, startAt, Infinity, 0);
    ch.state = "recording";
  }
  render();
}

function armCapture(ch, startTime, endTime, lengthSamples) {
  const cap = lengthSamples || Math.ceil(ctx.sampleRate * MAX_TAKE_SECONDS);
  pendingRecord = {
    channel: ch,
    // Resolved from the first captured block; see onCaptureFrame.
    startFrame: null,
    // Frame the capture window opens at. Blocks before it are discarded, so
    // an armed take begins exactly at the loop boundary.
    startFramePredicted: Math.round(startTime * ctx.sampleRate),
    lastFrame: null,
    endFrame: endTime === Infinity ? Infinity : Math.round(endTime * ctx.sampleRate),
    lengthSamples: lengthSamples || 0,
    scratch: new Float32Array(cap),
    freeMode: state.mode === "free" && !state.loopLength,
    overdub: false,
    // AudioContext time the capture window opens. An armed take waits for
    // this before it counts as recording.
    startTime,
    // When the arm began, so the waveform can show the wait as a progress bar.
    armedAt: ctx.currentTime,
    envTotal: 0,      // samples the live envelope currently spans
  };
  liveEnv = new Float32Array(WAVE_BUCKETS);
}

function finishCapture() {
  const rec = pendingRecord;
  if (!rec) return;
  pendingRecord = null;
  liveEnv = null;
  stopArmTimer();

  const ch = rec.channel;
  const rate = ctx.sampleRate;

  let length;
  if (rec.freeMode) {
    // The take ends where the user punched out, not where the buffer ends.
    const start = rec.startFrame === null ? Math.round(ctx.currentTime * rate) : rec.startFrame;
    const recorded = rec.endFrame === Infinity
      ? Math.round(ctx.currentTime * rate) - start
      : rec.endFrame - start;
    length = Math.max(1, Math.min(recorded, rec.scratch.length));
    if (length / rate < MIN_LOOP_SECONDS) {
      ch.state = "empty";
      showBanner("Take too short. Record at least half a second.");
      render();
      return;
    }
    state.loopLength = length;
    state.t0 = start / rate;
  } else {
    length = state.loopLength;

    // A later Free Mode take must match the existing loop. The capture window
    // is already L + n samples, so a take that ended early means the user
    // punched out before the loop finished. An armed take that never reached
    // its boundary has no startFrame at all.
    if (state.mode === "free" && rec.endFrame !== Infinity) {
      if (rec.startFrame === null) {
        ch.state = "empty";
        showBanner("That take did not match the loop length. Try again.");
        render();
        return;
      }
      const got = rec.endFrame - rec.startFrame;
      const want = length + seamSamples(length);
      if (Math.abs(got - want) > FREE_TOLERANCE * rate) {
        ch.state = "empty";
        showBanner("That take did not match the loop length. Try again.");
        render();
        return;
      }
    }
  }

  if (rec.overdub) {
    commitOverdub(ch, rec.scratch);
    ch.state = "playing";
    // The running source still plays the pre-overdub buffer; retire it so the
    // new one, with the added layer, is entered at the current loop position.
    if (ch.source) {
      try { ch.source.stop(); } catch (_) {}
      ch.source = null;
    }
    schedulePending();
    render();
    return;
  }

  // In Tempo Lock the capture holds L + seam samples, so fold all of it back
  // to L. In Free Mode the take is exactly what was recorded, and the fold
  // trims its own tail.
  const captured = rec.freeMode ? length : Math.min(rec.scratch.length, length + seamSamples(length));
  const raw = rec.scratch.subarray(0, captured);
  const folded = foldSeam(raw);
  const buf = ctx.createBuffer(1, folded.length, rate);
  buf.getChannelData(0).set(folded);

  // The first Free Mode take defines the loop from its folded length.
  if (rec.freeMode) {
    state.loopLength = folded.length;
    startTransport(state.t0);
  }
  ch.buffer = buf;
  ch.layers = 1;
  ch.state = "playing";
  // Loop position the buffer starts at. A take recorded from the loop top is
  // anchored to t0; the first Free Mode take is anchored to the frame capture
  // actually began at, which is mid-loop, so playback enters it at the
  // position the transport has already reached.
  ch.anchorTime = rec.freeMode ? state.t0 : null;
  // Enter the take at the loop position the transport has reached, instead of
  // waiting for the next boundary, which is a whole loop away.
  schedulePending();
  render();
}

function punchOut(ch) {
  if (ch.state === "armed") {
    // Nothing has been captured yet: cancel the take and return to EMPTY.
    if (pendingRecord && pendingRecord.channel === ch) {
      pendingRecord = null;
      liveEnv = null;
      stopArmTimer();
    }
    // A first Tempo Lock take is armed through its count-in, so cancelling it
    // must also silence the clicks still queued and stop the transport that
    // was started for it. A later take is armed against a loop that is already
    // running: the master track keeps playing and only the take is dropped.
    if (state.mode === "tempo") {
      stopCountIn();
      if (!state.channels.some((c) => c.buffer)) {
        state.loopLength = 0;
        stopTransport();
      }
    }
    ch.state = "empty";
    render();
    return;
  }
  if (ch.state === "recording") {
    if (state.mode === "tempo") {
      // Auto-stop is handled by the capture window; nothing to do.
      return;
    }
    if (!pendingRecord) return;
    if (pendingRecord.freeMode) {
      // First take: the length is whatever was captured up to now. The worklet
      // delivers blocks asynchronously, so the take ends at the last frame we
      // actually received, not at the wall clock.
      const rec = pendingRecord;
      if (rec.startFrame === null) {
        finishCapture();
        return;
      }
      rec.endFrame = rec.lastFrame === null ? rec.startFrame : rec.lastFrame + 1;
      finishCapture();
    } else {
      // Later Free Mode track: the loop length is already fixed by the first
      // take, so this take runs to the end of the loop on its own. Punching
      // out early would leave a short take that cannot be looped, so the
      // press is ignored.
      showBanner("This track records for the full loop length. It stops on its own.");
    }
  } else if (ch.state === "overdubbing") {
    if (!pendingRecord) return;
    // Overdub always runs a full loop; punch-out just stops the badge early.
    ch.state = "playing";
    render();
  }
}

// Crossfades the last n samples of the take into its first n samples and
// returns a buffer shortened by n. The loop point then lands where the tail
// hands over to the head, so the seam is continuous in value.
function foldSeam(data) {
  const n = seamSamples(data.length);
  if (n < 2) return data;

  const out = data.slice(0, data.length - n);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const headW = Math.sin((t * Math.PI) / 2); // head fades in
    const tailW = Math.cos((t * Math.PI) / 2); // tail fades out
    out[i] = data[i] * headW + data[data.length - n + i] * tailW;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Overdub
// ---------------------------------------------------------------------------

function beginOverdub(ch) {
  if (!ch.buffer) return;
  const L = ch.buffer.length;
  const startAt = nextBoundaryTime(ctx.currentTime + 0.05);
  armCapture(ch, startAt, startAt + L / ctx.sampleRate, L);
  pendingRecord.overdub = true;
  pendingRecord.freeMode = false;
  ch.state = "overdubbing";
  render();
}

function commitOverdub(ch, scratch) {
  const old = ch.buffer;
  const buf = ctx.createBuffer(1, old.length, old.sampleRate);
  const data = buf.getChannelData(0);
  data.set(old.getChannelData(0));
  const add = scratch.subarray(0, old.length);
  for (let i = 0; i < add.length; i++) data[i] += add[i];
  ch.buffer = buf;
  ch.layers++;
}

// ---------------------------------------------------------------------------
// Mute / clear
// ---------------------------------------------------------------------------

function toggleMute(ch) {
  ch.muted = !ch.muted;
  const target = ch.muted ? 0 : 1;
  const now = ctx.currentTime;
  const when = state.transport === "running" ? nextBoundaryTime(now) : now;
  const g = ch.gain.gain;
  // Hold the current value until the boundary, then ramp. Reading .value here
  // is correct because nothing else is scheduled on this param.
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.setValueAtTime(g.value, when);
  g.linearRampToValueAtTime(target, when + RAMP_SECONDS);
  render();
}

function clearChannel(ch) {
  if (ch.source) {
    try { ch.source.stop(); } catch (_) {}
    ch.source = null;
  }
  ch.buffer = null;
  ch.layers = 0;
  ch.state = "empty";
  ch.muted = false;
  ch.envBuffer = null;
  ch.env = null;
  ch.anchorTime = null;
  const g = ch.gain.gain;
  g.cancelScheduledValues(ctx.currentTime);
  g.setValueAtTime(1, ctx.currentTime);

  if (state.mode === "free") {
    const remaining = state.channels.filter((c) => c.buffer);
    if (remaining.length === 0) {
      state.loopLength = 0;
      stopTransport();
    } else {
      state.loopLength = remaining[0].buffer.length;
    }
  } else if (!state.channels.some((c) => c.buffer)) {
    // Tempo Lock: the grid is derived from BPM and bars, but loopLength is
    // what marks "a loop exists". Clearing the last track must drop it, or the
    // next record press would arm against a loop with nothing in it.
    state.loopLength = 0;
    stopTransport();
  }
  render();
}

// ---------------------------------------------------------------------------
// Click
// ---------------------------------------------------------------------------

function playCountIn(startTime, beat) {
  if (!state.clickOn) return;
  for (let i = 0; i < 4; i++) {
    playClick(startTime + i * beat, i === 0);
  }
}

// Cancels the clicks of a count-in that has not finished yet. Called when an
// armed Tempo Lock take is cancelled, so the user is not left listening to a
// count-in for a take that no longer exists.
function stopCountIn() {
  if (!countInOscs.length) return;
  const now = ctx.currentTime;
  for (const osc of countInOscs) {
    try { osc.stop(now); } catch (_) {}
  }
  countInOscs.length = 0;
}

function playClick(when, accent) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.frequency.value = accent ? 1600 : 1000;
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(accent ? 0.5 : 0.25, when + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);
  osc.connect(g);
  g.connect(clickGain);
  osc.start(when);
  osc.stop(when + 0.08);
  // Track the click so a cancelled count-in can silence the ones still ahead.
  countInOscs.push(osc);
  osc.onended = () => {
    const i = countInOscs.indexOf(osc);
    if (i !== -1) countInOscs.splice(i, 1);
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

async function exportMix() {
  const active = state.channels.filter((c) => c.buffer && !c.muted);
  if (!active.length) {
    showBanner("Nothing to export. Record a loop first.");
    return;
  }

  const L = active[0].buffer.length;
  const rate = ctx.sampleRate;
  const tail = Math.round(EXPORT_TAIL * rate);
  const offline = new OfflineAudioContext(2, L + tail, rate);

  const master = offline.createGain();
  master.gain.value = state.master;
  master.connect(offline.destination);

  const dry = offline.createGain();
  dry.gain.value = 1;
  dry.connect(master);

  const conv = offline.createConvolver();
  conv.buffer = makeImpulse(1.8, 2.5);
  const wet = offline.createGain();
  wet.gain.value = state.reverbOn ? 0.35 : 0;
  conv.connect(wet);
  wet.connect(master);

  for (const ch of active) {
    const src = offline.createBufferSource();
    src.buffer = ch.buffer;
    src.connect(dry);
    src.connect(conv);
    src.start(0);
  }

  const rendered = await offline.startRendering();
  const wav = encodeWav(rendered, L);
  download(wav, "loop-mix.wav");
}

function encodeWav(buffer, frames) {
  const channels = buffer.numberOfChannels;
  const rate = buffer.sampleRate;
  const data = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));

  const bytes = frames * channels * 2;
  const out = new ArrayBuffer(44 + bytes);
  const view = new DataView(out);

  const str = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  str(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, bytes, true);

  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([out], { type: "audio/wav" });
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Waveform display
// ---------------------------------------------------------------------------

const WAVE_BUCKETS = 200;

// Reduces a Float32Array to per-bucket peak amplitudes in 0..1. Computed once
// per buffer change, not per frame.
function computeEnvelope(samples, buckets) {
  const out = new Float32Array(buckets);
  if (!samples || !samples.length) return out;
  const per = samples.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * per);
    const to = Math.min(samples.length, Math.floor((b + 1) * per));
    let peak = 0;
    for (let i = from; i < to; i++) {
      const v = samples[i] < 0 ? -samples[i] : samples[i];
      if (v > peak) peak = v;
    }
    out[b] = peak;
  }
  return out;
}

// Cached envelope per channel, keyed by buffer identity so it is recomputed
// only when the buffer is replaced.
function envelopeFor(ch) {
  if (!ch.buffer) return null;
  if (ch.envBuffer === ch.buffer) return ch.env;
  ch.envBuffer = ch.buffer;
  ch.env = computeEnvelope(ch.buffer.getChannelData(0), WAVE_BUCKETS);
  return ch.env;
}

const WAVE_COLORS = {
  empty: "#3a4152",
  armed: "#5b8def",
  recording: "#e5484d",
  playing: "#30a46c",
  overdubbing: "#f5a524",
};

function drawWave(ch, canvas) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 200;
  const cssH = canvas.clientHeight || 48;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }

  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);

  const mid = cssH / 2;
  const color = WAVE_COLORS[ch.state] || WAVE_COLORS.empty;

  // Centre line.
  g.strokeStyle = "#252a36";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, mid + 0.5);
  g.lineTo(cssW, mid + 0.5);
  g.stroke();

  // While recording, show the take as it arrives.
  let env = envelopeFor(ch);
  if (ch.state === "recording" && pendingRecord && pendingRecord.channel === ch) {
    const rec = pendingRecord;
    const filled = rec.lastFrame === null || rec.startFrame === null
      ? 0
      : rec.lastFrame - rec.startFrame + 1;
    // liveEnv is accumulated block by block in onCaptureFrame, so it already
    // spans exactly the captured region: draw all of it. Scaling by
    // filled / scratch.length would shrink the picture to nothing, because in
    // Free Mode the scratch buffer is the full 8-minute maximum.
    drawEnvelope(g, liveEnv, cssW, cssH, mid, color);

    // Progress against the maximum take length, so elapsed time is visible
    // even though the waveform itself always fills the width.
    const total = rec.lengthSamples || Math.ceil(ctx.sampleRate * MAX_TAKE_SECONDS);
    const frac = Math.max(0, Math.min(1, filled / total));
    g.fillStyle = color;
    g.fillRect(0, cssH - 2, cssW * frac, 2);
  } else if (env) {
    drawEnvelope(g, env, cssW, cssH, mid, color);
  }

  // Armed: show the wait as a bar filling toward the punch-in, with the beat
  // count on top. The waveform area is otherwise empty, so the countdown is
  // the only thing telling the user when capture opens.
  if (ch.state === "armed" && pendingRecord && pendingRecord.channel === ch) {
    const rec = pendingRecord;
    const total = rec.startTime - rec.armedAt;
    const left = rec.startTime - ctx.currentTime;
    const frac = total > 0 ? Math.max(0, Math.min(1, 1 - left / total)) : 1;
    g.fillStyle = color;
    g.fillRect(0, cssH - 3, cssW * frac, 3);

    const count = armCountdown(ch);
    if (count) {
      g.fillStyle = color;
      g.font = "600 13px system-ui, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(`IN ${count}`, cssW / 2, mid);
    }
  }

  // Playhead during playback.
  if (state.transport === "running" && state.loopLength && ch.buffer) {
    const L = state.loopLength / ctx.sampleRate;
    const pos = (((ctx.currentTime - state.t0) % L) + L) % L / L;
    g.strokeStyle = "rgba(255,255,255,0.55)";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(Math.round(pos * cssW) + 0.5, 2);
    g.lineTo(Math.round(pos * cssW) + 0.5, cssH - 2);
    g.stroke();
  }
}

function drawEnvelope(g, env, cssW, cssH, mid, color) {
  const barW = cssW / env.length;
  g.fillStyle = color;
  for (let i = 0; i < env.length; i++) {
    const amp = Math.min(1, env[i]) * (mid - 2);
    if (amp <= 0.5) continue;
    g.fillRect(i * barW, mid - amp, Math.max(1, barW - 0.5), amp * 2);
  }
}

let waveRaf = null;

function startWaveLoop() {
  if (waveRaf !== null) return;
  const tick = () => {
    waveRaf = requestAnimationFrame(tick);
    if (!ctx) return;
    let armed = false;
    for (let i = 0; i < TRACK_COUNT; i++) {
      const ch = state.channels[i];
      const tile = el.tracks.children[i];
      if (!ch || !tile) continue;
      if (ch.state === "armed") armed = true;
      const canvas = tile.querySelector("canvas.wave");
      if (canvas) drawWave(ch, canvas);
    }
    // The countdown lives in the button label, which only render() writes, so
    // an armed take needs a repaint per frame to tick. Nothing else does.
    if (armed) render();
  };
  waveRaf = requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function buildTracks() {
  for (let i = 0; i < TRACK_COUNT; i++) {
    const tile = document.createElement("div");
    tile.className = "track";
    tile.dataset.index = i;
    tile.innerHTML = `
      <div class="track-head">
        <span class="track-name">Track ${i + 1}</span>
        <span class="layers" data-layers="${i}">0</span>
      </div>
      <canvas class="wave" data-wave="${i}"></canvas>
      <button type="button" class="primary" data-primary="${i}">RECORD</button>
      <div class="track-foot">
        <button type="button" class="small" data-mute="${i}">MUTE</button>
        <button type="button" class="small" data-clear="${i}">CLEAR</button>
      </div>`;
    el.tracks.appendChild(tile);
  }

  el.tracks.addEventListener("click", (e) => {
    const t = e.target;
    if (t.dataset.primary !== undefined) onPrimary(Number(t.dataset.primary));
    else if (t.dataset.mute !== undefined) onMute(Number(t.dataset.mute));
    else if (t.dataset.clear !== undefined) onClear(Number(t.dataset.clear));
  });

  bindClearHold();
}

function bindClearHold() {
  let timer = null;
  let target = null;

  const start = (e) => {
    const btn = e.target.closest("[data-clear]");
    if (!btn) return;
    target = btn;
    btn.classList.add("holding");
    timer = setTimeout(() => {
      onClear(Number(btn.dataset.clear));
      btn.classList.remove("holding");
      timer = null;
    }, CLEAR_HOLD_MS);
  };

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (target) target.classList.remove("holding");
    target = null;
  };

  el.tracks.addEventListener("pointerdown", start);
  el.tracks.addEventListener("pointerup", cancel);
  el.tracks.addEventListener("pointerleave", cancel);
  el.tracks.addEventListener("pointercancel", cancel);
}

async function onPrimary(i) {
  await initAudio();
  const ch = state.channels[i];
  state.selected = i;

  if (ch.state === "empty") await beginRecord(ch);
  else if (ch.state === "armed") punchOut(ch);
  else if (ch.state === "recording") punchOut(ch);
  else if (ch.state === "playing") beginOverdub(ch);
  else if (ch.state === "overdubbing") punchOut(ch);
  render();
}

function onMute(i) {
  if (!ctx) return;
  toggleMute(state.channels[i]);
}

function onClear(i) {
  if (!ctx) return;
  clearChannel(state.channels[i]);
}

function render() {
  for (let i = 0; i < TRACK_COUNT; i++) {
    const ch = state.channels[i];
    const tile = el.tracks.children[i];
    if (!tile || !ch) continue;

    tile.classList.toggle("selected", state.selected === i);

    const primary = tile.querySelector("[data-primary]");
    // A later Free Mode track cannot be punched out: its length is fixed by
    // the first take, so the button only reports progress. An armed take is
    // always cancellable, in both modes.
    const locked = ch.state === "recording" && pendingRecord && !pendingRecord.freeMode;
    // An armed take counts down to its punch-in, so the wait is legible
    // instead of a dead press. Driven by the transport clock, not by audio.
    const countdown = ch.state === "armed" ? armCountdown(ch) : 0;
    const labels = {
      empty: "RECORD",
      armed: countdown ? `IN ${countdown}` : "ARMED",
      recording: locked ? "RECORDING…" : "STOP REC",
      playing: "OVERDUB",
      overdubbing: "STOP DUB",
    };
    primary.textContent = labels[ch.state] || "RECORD";
    primary.dataset.state = ch.state;
    primary.disabled = Boolean(locked);

    const mute = tile.querySelector("[data-mute]");
    mute.classList.toggle("latched", ch.muted);

    const layers = tile.querySelector("[data-layers]");
    layers.textContent = ch.layers;
    layers.classList.toggle("show", ch.layers > 0);
  }

  const hasAudio = state.channels.some((c) => c.buffer);
  el.exportBtn.disabled = !hasAudio;
  el.modeHelp.textContent =
    state.mode === "free"
      ? "Free Mode: the first take sets the loop length. Later tracks must match it."
      : `Tempo Lock: ${state.bars} bar${state.bars > 1 ? "s" : ""} at ${state.bpm} BPM. Recording snaps to the grid.`;
}

function showBanner(msg) {
  el.banner.textContent = msg;
  el.banner.hidden = false;
  clearTimeout(showBanner.timer);
  showBanner.timer = setTimeout(() => { el.banner.hidden = true; }, 6000);
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function bindControls() {
  el.bpm.addEventListener("input", () => {
    state.bpm = Number(el.bpm.value);
    el.bpmOut.textContent = state.bpm;
    render();
  });

  el.bars.addEventListener("change", () => {
    state.bars = Number(el.bars.value);
    render();
  });

  el.mode.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mode]");
    if (!btn) return;
    const busy = state.channels.some((c) => c.buffer) || state.transport === "running";
    if (busy) {
      showBanner("Clear all tracks before switching mode.");
      return;
    }
    state.mode = btn.dataset.mode;
    for (const b of el.mode.children) b.classList.toggle("on", b === btn);
    render();
  });

  el.click.addEventListener("change", () => {
    state.clickOn = el.click.checked;
  });

  el.mic.addEventListener("change", () => {
    switchMic(el.mic.value).catch((err) => showBanner("Could not switch microphone: " + err.message));
  });

  // Plugging or unplugging an input changes the list; labels also become
  // readable the moment the permission is granted.
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", () => {
      refreshMicList();
    });
  }

  el.reverb.addEventListener("change", () => {
    state.reverbOn = el.reverb.checked;
    if (!ctx) return;
    const now = ctx.currentTime;
    const g = wetGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(state.reverbOn ? 0.35 : 0, now + REVERB_RAMP);
  });

  el.master.addEventListener("input", () => {
    state.master = Number(el.master.value) / 100;
    el.masterOut.textContent = el.master.value;
    if (masterGain) {
      const now = ctx.currentTime;
      const g = masterGain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(state.master, now + 0.02);
    }
  });

  el.exportBtn.addEventListener("click", () => {
    exportMix().catch((err) => showBanner("Export failed: " + err.message));
  });

  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && t.matches && t.matches("input, select, textarea")) return;

    if (e.key >= "1" && e.key <= "4") {
      state.selected = Number(e.key) - 1;
      render();
    } else if (e.key === "r" || e.key === "R") {
      onPrimary(state.selected);
    } else if (e.code === "Space") {
      e.preventDefault();
      toggleTransport();
    }
  });
}

function toggleTransport() {
  if (!ctx) return;
  if (state.transport === "running") {
    rampMaster(0);
    stopTransport();
  } else if (state.loopLength) {
    rampMaster(state.master);
    startTransport(nextBoundaryTime(ctx.currentTime + 0.05));
  }
  render();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function boot() {
  buildTracks();
  bindControls();
  render();
  startWaveLoop();

  if (!window.AudioContext && !window.webkitAudioContext) {
    showBanner("This browser does not support the Web Audio API.");
  }
}

boot();
