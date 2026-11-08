"use strict";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRACK_COUNT = 4;

// Transport
const LOOKAHEAD_MS = 25;         // scheduler tick
const SCHEDULE_AHEAD = 0.1;      // seconds scheduled ahead of the clock
const RAMP_SECONDS = 0.01;       // mute / master ramp, avoids clicks
const REVERB_RAMP = 0.02;

// Recording
const SEAM_SECONDS = 0.008;      // crossfade folded into the loop point
const MIN_LOOP_SECONDS = 0.5;
const MAX_TAKE_SECONDS = 8 * 60;
const FREE_TOLERANCE = 0.05;     // seconds a later Free Mode take may miss L by
const LATENCY_MARGIN = 0.005;    // covers the worklet's 128-sample block
// Extra samples at the end of a capture window. The window is exactly the take
// length, so without slack the block that carries the last wanted sample is
// also the block that fills the buffer, and any rounding or late delivery cuts
// the tail. One worklet block would do; 4096 is a safe first experiment.
const CAPTURE_SLACK = 4096;

// Calibration. The round trip is measured by playing short bursts through the
// speakers and finding them in the mic. Five bursts, spaced further apart than
// the longest delay the search window allows, so each window holds exactly one
// and a late block cannot be mistaken for the next burst.
const CAL_BURSTS = 5;
const CAL_SPACING = 0.35;        // seconds between bursts
const CAL_MARGIN = 0.02;         // silence before each burst in its own window
const CAL_MAX_DELAY = 0.3;       // longest round trip a window allows
const CAL_BURST = 0.01;          // burst length
const CAL_WINDOW = 0.006;        // energy window, shorter than the burst
const CAL_GAIN = 0.2;            // burst amplitude
const CAL_MIN_AMPLITUDE = 0.01;  // below this the burst was not heard
const TAKE_MIN_PEAK = 0.02;      // first-transient threshold for takeOffset

// UI
const CLEAR_HOLD_MS = 600;
const WAVE_BUCKETS = 200;
const EXPORT_TAIL = 1;           // seconds of reverb tail

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  mode: "tempo",         // "free" | "tempo"
  bpm: 100,
  bars: 1,
  clickOn: true,
  clickWhileRecording: false,  // metronome keeps ticking under a take
  reverbOn: false,
  master: 0.85,
  micId: "",             // "" = system default input
  selected: 0,
  transport: "stopped",  // "stopped" | "running"
  loopLength: 0,         // samples; 0 = no loop exists yet
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
let inputLatency = 0;        // seconds, mic buffer; see measureInputLatency
let outputLatency = 0;       // seconds, speaker buffer; see measureOutputLatency
let schedulerTimer = null;
let armTimer = null;         // promotes an armed take at its loop boundary
let nextBoundaryIndex = 0;   // next loop index to schedule
let nextBeatIndex = 0;       // next metronome beat to schedule, in beats from t0
let pendingRecord = null;    // the take in progress, see armCapture
let liveEnv = null;          // envelope of the take in progress, for the waveform
let countInOscs = [];        // clicks of a count-in that has not finished yet
let calibration = null;      // the round-trip measurement in progress, see calibrate

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
  clickRec: document.getElementById("clickRec"),
  mic: document.getElementById("mic"),
  reverb: document.getElementById("reverb"),
  master: document.getElementById("master"),
  masterOut: document.getElementById("masterOut"),
  exportBtn: document.getElementById("export"),
  modeHelp: document.getElementById("modeHelp"),
  calibrate: document.getElementById("calibrate"),
  offsetOut: document.getElementById("offsetOut"),
  offsetHelp: document.getElementById("offsetHelp"),
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
    inputLatency = measureInputLatency();
    outputLatency = measureOutputLatency();
    // The measured offset belongs to the device, so it is re-read on every mic
    // open. Reading it once at boot would keep the previous device's number
    // after a switch, with nothing in the UI saying so. captureShift() reads it
    // from the store on every call, so there is no cached copy to go stale.
    logCaptureShift();
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

// How far behind the render clock the mic samples are. The worklet stamps a
// block with the frame it was processed at, but the samples inside it were
// captured `inputLatency` earlier, so a take anchored to that stamp lands late
// by exactly this much. `latency` is the device buffer; the margin covers the
// block the worklet has to fill before it can post anything. Browsers that do
// not report it (Safari) fall back to the context's own base latency.
function measureInputLatency() {
  let device = 0;
  if (micStream) {
    for (const track of micStream.getAudioTracks()) {
      const settings = track.getSettings ? track.getSettings() : null;
      if (settings && settings.latency > 0) device = settings.latency;
    }
  }
  if (!(device > 0)) device = ctx.baseLatency || 0;
  const total = device + LATENCY_MARGIN;
  // The number is invisible otherwise, and every "the take is late" report
  // needs it to be actionable. Logged once per mic open, not per take.
  console.info(
    "[loupeur] input latency: device %s ms + margin %s ms = %s ms (%s samples)",
    (device * 1000).toFixed(1),
    (LATENCY_MARGIN * 1000).toFixed(1),
    (total * 1000).toFixed(1),
    Math.round(total * ctx.sampleRate)
  );
  return total;
}

// How far behind the render clock the speaker is. The player hears a click
// `outputLatency` after the transport says it played, so they play that much
// late and the take lands that much late. It is a guaranteed error on every
// take and it is not part of the input path, so it is measured separately.
function measureOutputLatency() {
  const total = ctx.outputLatency || 0;
  console.info(
    "[loupeur] output latency: %s ms (%s samples)",
    (total * 1000).toFixed(1),
    Math.round(total * ctx.sampleRate)
  );
  return total;
}

// The offset a take is displaced by, in seconds: how far the audio of a sound
// the player meant for a given render frame is stamped from that frame.
//
// There is exactly one number, and it is the one the readout shows. Calibration
// does not keep a separate hidden measurement that the readout is added to: it
// writes its result into the same per-device offset the readout displays. Two
// numbers meant the user could not tell what was in force, and a calibration
// that "did nothing" because the readout still said 0.
//
// Before any calibration the offset falls back to the reported buffers, which
// is a lower bound: it cannot see buffering the browser does not report -- a
// phone used as a mic over ADB, a Bluetooth bridge, a virtual loopback. Those
// add tens to hundreds of milliseconds that no API exposes, and they are the
// reason the two tracks in the bug report were audibly apart.
function captureShift() {
  return Math.max(0, offsetFor(state.micId));
}

// The offset in force for a device, in seconds. One stored number per device,
// written by calibration and read by everything else.
function offsetFor(deviceId) {
  const stored = loadStore(OFFSET_KEY)[deviceId || ""];
  if (typeof stored === "number" && isFinite(stored)) return stored;
  return inputLatency + outputLatency;
}

// True when the offset in force is a real number rather than the estimate.
function offsetIsMeasured(deviceId) {
  const stored = loadStore(OFFSET_KEY)[deviceId || ""];
  return typeof stored === "number" && isFinite(stored);
}

// Measured offsets, keyed by deviceId. Per device, because the offset belongs
// to the interface and not to the app: a value dialled in for the phone must
// not silently apply to the USB mic.
const OFFSET_KEY = "loupeur.offset.v1";

function loadStore(key) {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

function saveStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_) {
    // Private mode or a full quota: the value still applies to this session,
    // it just will not survive a reload.
  }
}

function deviceOffsetFor(deviceId) {
  const value = loadStore(OFFSET_KEY)[deviceId || ""];
  return typeof value === "number" && isFinite(value) ? value : 0;
}

// Writes the offset for a device. Zero is a real value -- a device that needs no
// correction -- so it is stored rather than deleted; only a non-finite value
// clears the entry and falls back to the estimate.
function storeDeviceOffset(deviceId, seconds) {
  const offsets = loadStore(OFFSET_KEY);
  if (typeof seconds === "number" && isFinite(seconds)) offsets[deviceId || ""] = seconds;
  else delete offsets[deviceId || ""];
  saveStore(OFFSET_KEY, offsets);
}

// The shift is invisible otherwise, and a wrong shift is indistinguishable from
// a wrong measurement without it. Logged once per mic open, not per take.
function logCaptureShift() {
  console.info(
    "[loupeur] capture shift: %s ms (%s samples), %s",
    (captureShift() * 1000).toFixed(1),
    Math.round(captureShift() * ctx.sampleRate),
    offsetIsMeasured(state.micId)
      ? "measured"
      : "estimate: input " +
        (inputLatency * 1000).toFixed(1) +
        " ms + output " +
        (outputLatency * 1000).toFixed(1) +
        " ms"
  );
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

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

// Measures the round trip of the open input by playing short bursts through the
// speakers and finding them in the mic. This is the only number in the app that
// is measured instead of guessed, and it is the one that makes a take land
// where it was played.
//
// A burst is scheduled at a known render frame. It is heard `outputLatency`
// later, travels through the air, and is stamped by the worklet `inputLatency`
// after it was captured. So the burst sits at
//
//   burstFrame + roundTrip
//
// and `roundTrip` is the whole correction: the player hears the transport late
// by the output side and plays late by that much, and the mic stamps the result
// late by the input side. Both are in the number, which is why it replaces the
// estimate rather than adding to it.
//
// Five bursts, not one: a single measurement cannot tell a late block from a
// late room. The median of the five, with values far from it dropped, is the
// round trip. Each burst gets its own window, `CAL_MARGIN` before it was
// scheduled and `CAL_MAX_DELAY` after, so a burst that comes back late is still
// inside its own window and cannot be confused with the next one.
//
// The measurement is a raw capture, not a take: it does not touch the transport,
// the loop length or any channel, so it can run with tracks playing.
async function calibrate() {
  if (calibration) return;
  const ok = await ensureMic();
  if (!ok) return;

  const deviceId = state.micId;
  // A placeholder so the button reports progress before the window opens.
  calibration = { rec: null };
  render();

  try {
    const delay = await measureRoundTrip();
    if (delay === null) {
      showBanner(
        "Calibration heard nothing. Turn the speakers up, or use headphones " +
          "on the desk next to the mic, and try again."
      );
      return;
    }

    // The measurement replaces the offset outright, and the readout is the same
    // number: it is written here so the control shows what is in force instead
    // of staying at 0 while a hidden value does the work.
    storeDeviceOffset(deviceId, delay / ctx.sampleRate);
    logCaptureShift();
    render();
    showBanner(
      "Calibrated: round trip " +
        (delay / ctx.sampleRate * 1000).toFixed(1) +
        " ms. The input offset is now " +
        Math.round(delay / ctx.sampleRate * 1000) +
        " ms for this microphone, and every take uses it."
    );
  } finally {
    calibration = null;
    render();
  }
}

// Plays the bursts and returns the round trip in samples, or null when nothing
// was heard or the measurements disagreed.
//
// The window is a raw capture: it does not touch the transport, the loop length
// or any channel, so it can run with tracks playing. `calibration` owns the mic
// while it is open, so a take cannot be spliced into it.
async function measureRoundTrip() {
  const rate = ctx.sampleRate;
  const margin = Math.round(CAL_MARGIN * rate);
  const span = Math.round((CAL_MARGIN + CAL_MAX_DELAY) * rate);
  const win = Math.round(CAL_WINDOW * rate);

  const t0 = ctx.currentTime + 0.25;
  const times = [];
  for (let i = 0; i < CAL_BURSTS; i++) times.push(t0 + i * CAL_SPACING);

  // One window covering every burst: from the margin before the first to the
  // longest delay after the last. The bursts are scheduled first; the window
  // opens before the first one sounds, so nothing is missed.
  const windowStart = Math.round(times[0] * rate) - margin;
  const windowEnd = Math.round(times[times.length - 1] * rate) + span;
  const frames = windowEnd - windowStart;

  for (const t of times) playBurst(t);
  const scratch = await captureWindow(windowStart, frames);
  if (!scratch) return null;

  const offsets = [];
  let loudest = 0;
  for (const t of times) {
    const from = Math.round(t * rate) - windowStart - margin;
    const window = scratch.subarray(from, from + span);
    const amp = peakAmplitude(window, 0, window.length);
    if (amp > loudest) loudest = amp;
    const peak = energyPeak(window, 0, window.length, win);
    if (peak < 0) continue;
    offsets.push(peak - margin);
  }

  // Nothing came back: headphones, a muted mic, or a quiet room. Keep the API
  // estimate rather than trusting a measurement of noise.
  if (loudest < CAL_MIN_AMPLITUDE) return null;

  return robustDelay(offsets);
}

// Opens a raw capture window and resolves with its samples once the window is
// full, or null when the worklet stops delivering.
function captureWindow(startFrame, frames) {
  return new Promise((resolve) => {
    const rec = {
      startFrame,
      endFrame: startFrame + frames,
      scratch: new Float32Array(frames),
      lastFrame: null,
      resolve,
    };
    calibration = { rec };
    render();
    // A worklet that stops delivering must not leave the button stuck.
    rec.timer = setTimeout(() => {
      if (calibration && calibration.rec === rec) {
        calibration.rec = null;
        resolve(null);
      }
    }, (frames / ctx.sampleRate + 1) * 1000);
  });
}

// A short tone burst at an exact audio-clock time, straight to the destination
// so the master volume cannot silence the measurement. 10 ms at 2 kHz is loud,
// short, and has an unambiguous onset.
function playBurst(when) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = 2000;
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(CAL_GAIN, when + 0.001);
  g.gain.setValueAtTime(CAL_GAIN, when + CAL_BURST - 0.001);
  g.gain.linearRampToValueAtTime(0, when + CAL_BURST);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(when);
  osc.stop(when + CAL_BURST + 0.01);
  osc.onended = () => {
    osc.disconnect();
    g.disconnect();
  };
}

// Index of the highest short-window energy in [from, to), or -1 when the window
// holds no energy at all (silence) or is too short to scan. Energy rather than
// raw peak, so a single stray sample cannot win.
function energyPeak(samples, from, to, windowSamples) {
  const lo = Math.max(0, from);
  const hi = Math.min(samples.length, to);
  const win = Math.max(1, windowSamples);
  if (hi - lo < win) return -1;

  let bestIndex = -1;
  let bestEnergy = 0;
  let energy = 0;
  for (let i = lo; i < lo + win; i++) energy += samples[i] * samples[i];

  for (let i = lo; i + win <= hi; i++) {
    if (energy > bestEnergy) {
      bestEnergy = energy;
      bestIndex = i;
    }
    const out = samples[i];
    const inc = samples[i + win];
    energy += inc * inc - out * out;
  }
  return bestIndex;
}

// Peak amplitude in [from, to), for deciding whether the burst was heard.
function peakAmplitude(samples, from, to) {
  const lo = Math.max(0, from);
  const hi = Math.min(samples.length, to);
  let peak = 0;
  for (let i = lo; i < hi; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Robust estimate from several measurements. Drops values far from the median
// so one bad detection cannot skew the result. Returns null when there is not
// enough agreement to trust the measurement.
function robustDelay(offsets) {
  if (!offsets || offsets.length < 3) return null;
  const med = median(offsets);
  const tolerance = Math.max(1, Math.abs(med) * 0.25);
  const kept = offsets.filter((v) => Math.abs(v - med) <= tolerance);
  if (kept.length < 3) return null;
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

// The index of the first sample above `threshold`, or -1. The first crossing,
// not the global peak: a room noise later in the window can be louder than the
// click, and the click is the first thing in it.
function firstCrossing(data, threshold) {
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) >= threshold) return i;
  }
  return -1;
}

// Writes a calibration block into the measurement buffer. Mirrors the write in
// onCaptureFrame, minus the envelope and the take bookkeeping.
function onCalibrationFrame(frame, data) {
  const rec = calibration.rec;
  if (!rec) return;
  const from = Math.max(frame, rec.startFrame);
  const to = Math.min(frame + data.length, rec.endFrame);
  if (to > from) {
    rec.scratch.set(data.subarray(from - frame, to - frame), from - rec.startFrame);
    rec.lastFrame = to - 1;
  }
  if (frame + data.length < rec.endFrame) return;

  clearTimeout(rec.timer);
  calibration.rec = null;
  rec.resolve(rec.scratch);
}

// The offset a finished take landed at, in samples: how far the audio of the
// loop boundary sits from the start of the take. Positive means the take is
// late, which is the direction every correction so far has been fighting.
//
// This is the number the user can check without exporting anything. A take
// recorded against a click on the boundary should report ~0.
function takeOffset(rec) {
  if (!rec || rec.startFrame === null) return null;
  const at = firstCrossing(rec.scratch, TAKE_MIN_PEAK);
  if (at < 0) return null;
  return at;
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
  inputLatency = 0;
  outputLatency = 0;
}

function onCaptureFrame(e) {
  const { frame, data } = e.data;
  // A calibration owns the mic while it runs: it is a raw capture, not a take,
  // and it must not be spliced into a take that happens to be open.
  if (calibration) {
    onCalibrationFrame(frame, data);
    return;
  }
  if (!pendingRecord) return;
  const rec = pendingRecord;

  // The take starts at the first block that overlaps the capture window. For
  // an armed take the window opens `shift` after a loop boundary, so blocks
  // that arrive before it are dropped and the take is anchored to the boundary
  // itself. The window is shifted forward by the round trip, so the block that
  // carries the sound of the boundary is the one that opens the take.
  //
  // The anchor is the prediction, never the first block. The worklet delivers
  // blocks on its own schedule, so the first one to arrive almost always starts
  // after the prediction; anchoring there would discard the latency correction
  // and slide the whole take, and the end with it. The samples between the two
  // stay zero, which is correct: they are the pre-boundary audio the window was
  // opened for.
  if (rec.startFrame === null) {
    if (frame + data.length <= rec.startFramePredicted) return;
    rec.startFrame = rec.startFramePredicted;
    if (rec.endFrame !== Infinity) rec.endFrame = rec.startFrame + rec.lengthSamples;
    if (rec.stopFrame !== Infinity) rec.stopFrame = rec.endFrame + CAPTURE_SLACK;
  }

  const start = rec.startFrame;
  const end = rec.endFrame;
  const blockEnd = frame + data.length;
  const from = Math.max(frame, start);
  const to = Math.min(blockEnd, end);
  // The take closes at the end of the window, not at the end of the wanted
  // samples: the block that carries the last wanted sample has to be written
  // before the take is committed, or the tail is cut by however much of that
  // block lies past `end`. This is tested against the block's own end, not the
  // clamped `to`: past `end` every block clamps to the same value, so a check
  // on `to` can never fire and the take would never close.
  if (blockEnd >= rec.stopFrame) {
    finishCapture();
    return;
  }
  if (to <= from) return;

  const offset = from - frame;
  const count = to - from;
  const target = rec.scratch;
  const writeAt = from - start;
  if (writeAt < 0 || writeAt + count > target.length) return;
  target.set(data.subarray(offset, offset + count), writeAt);
  rec.lastFrame = to - 1;

  // Fold the new samples into the live envelope. The envelope is a fixed grid
  // over the whole scratch buffer, so a block only touches the buckets it
  // covers: cost is O(block), not O(take). Rescaling the envelope to the
  // captured length on every block instead would rescan the entire take each
  // time, which is quadratic and glitches capture on long takes.
  const buckets = liveEnv.length;
  const per = target.length / buckets;
  const firstBucket = Math.floor(writeAt / per);
  const lastBucket = Math.min(buckets - 1, Math.floor((writeAt + count - 1) / per));
  for (let b = firstBucket; b <= lastBucket; b++) {
    const bFrom = Math.max(writeAt, Math.floor(b * per));
    const bTo = Math.min(writeAt + count, Math.floor((b + 1) * per));
    let peak = liveEnv[b];
    for (let i = bFrom; i < bTo; i++) {
      const v = target[i] < 0 ? -target[i] : target[i];
      if (v > peak) peak = v;
    }
    liveEnv[b] = peak;
  }
}
// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

// The musical loop length in samples, derived from BPM and bars. Never
// shortened by the seam: capture runs seamSamples(L) longer and foldSeam
// crossfades that tail into the head, so the buffer is exactly L and the last
// beat is not cut. Free Mode has no grid, so it uses the length the first take
// defined.
function loopSamples() {
  if (state.mode === "tempo") {
    return Math.round(state.bars * 4 * (60 / state.bpm) * ctx.sampleRate);
  }
  return state.loopLength;
}

function seamSamples(length) {
  return Math.min(Math.round(SEAM_SECONDS * ctx.sampleRate), Math.floor(length / 2));
}

// First loop boundary at or after `after`. Used for mute ramps, record starts,
// overdub starts, and resume. Never used to enter a take that has already been
// recorded: its start may be in the past, and the next boundary would then be a
// whole loop away. See schedulePending.
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
  // The metronome counts beats from t0, so a transport that starts mid-beat
  // (a resume) picks up on the next whole beat rather than re-clicking one.
  const beatSec = 60 / state.bpm;
  nextBeatIndex = Math.max(0, Math.ceil((ctx.currentTime - atTime) / beatSec));
  startScheduler();
  // Tracks that are already playing have no source after a stop; start them
  // now rather than waiting for the scheduler to reach a boundary.
  schedulePending();
}

// Starts every playing/overdubbing track that has no source yet. Called when
// the transport starts or a take is committed, so a freshly recorded track is
// heard immediately instead of after a full loop of silence.
//
// A take whose start is still ahead (a later track armed at the loop top,
// committed before that boundary arrives) waits for it; one whose start has
// already gone by is entered right away at the position the transport has
// reached. Waiting for the *next* boundary in that case would skip a whole
// loop, which is the "full run before any sound" symptom.
function schedulePending() {
  if (state.transport !== "running" || !ctx) return;
  if (!loopSamples()) return;
  const now = ctx.currentTime;
  // The offset must be measured at the time the source actually starts, not at
  // "now": when t0 is still ahead (a count-in), starting at t0 with the offset
  // of "now" would enter the take partway through instead of at the loop top.
  const when = Math.max(now, state.t0);
  for (const ch of state.channels) {
    if (!ch.buffer || ch.source) continue;
    if (ch.state !== "playing" && ch.state !== "overdubbing") continue;
    scheduleChannel(ch, when, loopOffset(ch, when));
  }
}

// Loop position, in samples, that a channel's buffer starts at when its source
// is started at `when`. `scheduleChannel` converts it to the seconds `start()`
// wants; nothing else may.
//
// The modulo is taken against the buffer's own length, not loopSamples(). The
// two differ by the seam in Free Mode, and the buffer length is the only length
// the source actually loops on; a modulo against L would leave the source up to
// `seam` samples short of the loop top.
function loopOffset(ch, when) {
  const L = ch.buffer ? ch.buffer.length : loopSamples();
  if (!L) return 0;
  const elapsed = Math.round((when - state.t0) * ctx.sampleRate);
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

  scheduleMetronome(horizon);
}

// Metronome under a take. Only runs when the user asked for it, the click
// track is on, and a take is live or armed: the point is to play to the grid
// while recording, not to leave a click running under playback.
//
// Beats are placed on the transport clock (t0 + n * beat) rather than on a
// timer, so they stay locked to the loop even when the scheduler tick is late.
// The accent falls on beat 1 of each bar, which is what makes the grid audible
// while playing into it.
function scheduleMetronome(horizon) {
  if (!state.clickOn || !state.clickWhileRecording) return;
  if (!takeInProgress()) return;
  const beatSec = 60 / state.bpm;
  if (!(beatSec > 0)) return;

  // The cursor only advances while a take is live, so it falls behind whenever
  // the click is paused between takes. Snap it forward to the first beat that
  // has not gone by yet, instead of walking through the beats that elapsed,
  // which would burn the guard and could skip the beat that is due now.
  //
  // The floor is the beat *before* the one due, not the due beat itself: a
  // beat that is still ahead of the clock must be scheduled, and rounding up
  // to the due beat would drop it whenever the scheduler tick lands a few
  // milliseconds early. Beats already in the past are filtered below.
  const due = Math.floor((ctx.currentTime - state.t0) / beatSec);
  if (nextBeatIndex < due) nextBeatIndex = due;

  let guard = 0;
  while (state.t0 + nextBeatIndex * beatSec < horizon && guard++ < 64) {
    const when = state.t0 + nextBeatIndex * beatSec;
    // Skip beats already in the past (a transport started mid-beat).
    if (when >= ctx.currentTime - 0.01) {
      playClick(when, nextBeatIndex % 4 === 0, false);
    }
    nextBeatIndex++;
  }
}

// True while a take is live or waiting to punch in. An armed take counts: the
// grid has to run through the countdown so the punch-in lands on a beat the
// user can hear, rather than the click dropping out and resuming late.
function takeInProgress() {
  return state.channels.some(
    (c) => c.state === "armed" || c.state === "recording" || c.state === "overdubbing"
  );
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

// `offsetSamples` is a position in the buffer, in samples; `when` is a time on
// the context clock, in seconds. `start()` takes both in seconds, so the
// conversion happens here and nowhere else. Passing the sample count straight
// through made it larger than the buffer duration, which the API clamps to the
// end of the buffer: the source then started at its head at `when` instead of at
// the phase `when` represents, and a track entered mid-loop landed
// `(when - t0) mod L` late -- permanently, because a looping source is never
// re-scheduled.
function scheduleChannel(ch, when, offsetSamples) {
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
  src.start(when, (offsetSamples || 0) / ctx.sampleRate);
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

  // A loop already exists: punch in at the loop top, in both modes. The take is
  // armed now and capture opens at the next loop boundary, which is also loop
  // sample 0, so what the user hears while recording is what plays back.
  if (state.loopLength) {
    // If the transport is stopped, t0 is stale and there is no boundary to wait
    // for: restart the loop from the top and record from there.
    if (state.transport !== "running") startTransport(ctx.currentTime + 0.05);
    armTake(ch, nextBoundaryTime(ctx.currentTime + 0.05), state.loopLength);
  } else if (state.mode === "tempo") {
    // First Tempo Lock take: count in, then start the transport on beat 5.
    const beat = 60 / state.bpm;
    const countInStart = ctx.currentTime + 0.1;
    playCountIn(countInStart, beat);
    const armAt = countInStart + 4 * beat;
    state.loopLength = loopSamples();
    startTransport(armAt);
    armTake(ch, armAt, state.loopLength);
  } else {
    // First Free Mode take: free-running, length fixed at punch-out.
    armCapture(ch, ctx.currentTime + 0.05, Infinity, 0);
    ch.state = "recording";
  }
  render();
}

// Arms a take that runs exactly `length` samples from `startAt`, plus the seam
// tail that foldSeam folds back into the head. The channel waits in ARMED until
// the boundary arrives; see promoteArmed.
function armTake(ch, startAt, length) {
  const raw = length + seamSamples(length);
  armCapture(ch, startAt, startAt + raw / ctx.sampleRate, raw);
  ch.state = "armed";
  startArmTimer();
}

function armCapture(ch, startTime, endTime, lengthSamples) {
  const take = lengthSamples || Math.ceil(ctx.sampleRate * MAX_TAKE_SECONDS);
  // The window is the take plus slack. Without the slack the last wanted sample
  // sits at the final element of the buffer, so the block that carries it is
  // also the block that fills the buffer and any rounding or late delivery cuts
  // the tail. The slack is never part of the take: finishCapture slices it off.
  const cap = take + CAPTURE_SLACK;
  // The mic stamps a sound `shift` after the render frame it belongs at: the
  // player hears the transport late by the output side and plays late by that
  // much, and the worklet stamps the result late by the input side again. So
  // the window opens `shift` *after* the boundary, and the audio of the
  // boundary lands at scratch index 0. Opening it `shift` before the boundary
  // instead puts the take `2 * shift` late and the correction does nothing.
  // The window keeps its length, so the loop length and the seam fold are
  // unaffected. `shift` is a measured round trip when one exists, and the sum of
  // the reported buffers otherwise; see captureShift.
  const shift = Math.round(captureShift() * ctx.sampleRate);
  pendingRecord = {
    channel: ch,
    // Resolved from the first captured block; see onCaptureFrame.
    startFrame: null,
    // Frame the capture window opens at. Blocks before it are discarded, so an
    // armed take begins exactly at the loop boundary.
    startFramePredicted: Math.round(startTime * ctx.sampleRate) + shift,
    // Samples the window opens after the boundary. The audio of the boundary is
    // stamped `shift` after it, so the two meet at scratch index 0.
    shift,
    // Render frame the take belongs at.
    boundaryFrame: Math.round(startTime * ctx.sampleRate),
    lastFrame: null,
    // Last scratch index the take wants. The write bound: samples past it are
    // the slack and are dropped.
    endFrame: endTime === Infinity ? Infinity : Math.round(endTime * ctx.sampleRate) + shift,
    // Frame the take finishes at. It is the end of the window, slack included,
    // so the block carrying the last wanted sample has been written before the
    // take closes. Finishing on endFrame instead cut the tail by however much of
    // that block lay past it.
    stopFrame: endTime === Infinity ? Infinity : Math.round(endTime * ctx.sampleRate) + shift + CAPTURE_SLACK,
    lengthSamples: lengthSamples || 0,
    scratch: new Float32Array(cap),
    // True only for the first Free Mode take, which defines the loop length
    // instead of matching it.
    definesLoop: state.mode === "free" && !state.loopLength,
    overdub: false,
    // AudioContext time the capture window opens. An armed take waits for this
    // before it counts as recording.
    startTime,
    // When the arm began, so the waveform can show the wait as a progress bar.
    armedAt: ctx.currentTime,
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

  // A rejected take leaves the channel empty and says why.
  const reject = (msg) => {
    ch.state = "empty";
    showBanner(msg);
    render();
  };

  let length;
  // How many samples of the window belong to the take. The window is the take
  // plus CAPTURE_SLACK, so this is the only number that says where the take
  // ends; the length, the Free Mode validation and the slice all use it instead
  // of each re-deriving it from the frames.
  let take;
  if (rec.definesLoop) {
    // The take ends where the user punched out, not where the buffer ends.
    // Both ends are in mic frames, so the latency cancels out of the length; it
    // only moves where the loop sits on the transport clock.
    const start = rec.startFrame === null ? Math.round(ctx.currentTime * rate) : rec.startFrame;
    const recorded = rec.endFrame === Infinity
      ? Math.round(ctx.currentTime * rate) - Math.round(captureShift() * rate) - start
      : rec.endFrame - start;
    take = Math.max(1, Math.min(recorded, rec.scratch.length));
    length = take;
    if (length / rate < MIN_LOOP_SECONDS) {
      return reject("Take too short. Record at least half a second.");
    }
    state.loopLength = length;
    // startFrame is a mic frame, so it is already the render time the take
    // belongs at: the latency correction is baked into the window, not applied
    // again here.
    state.t0 = start / rate;
  } else {
    length = state.loopLength;
    take = Math.min(rec.scratch.length, length + seamSamples(length));

    // A later Free Mode take must match the existing loop. The capture window is
    // already L + seam samples, so a take that ended early means the user
    // punched out before the loop finished. An armed take that never reached its
    // boundary has no startFrame at all.
    if (state.mode === "free" && rec.endFrame !== Infinity) {
      const got = rec.startFrame === null ? 0 : rec.endFrame - rec.startFrame;
      const want = length + seamSamples(length);
      if (Math.abs(got - want) > FREE_TOLERANCE * rate) {
        return reject("That take did not match the loop length. Try again.");
      }
    }
  }

  if (rec.overdub) {
    commitOverdub(ch, rec.scratch, take);
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

  // In Tempo Lock the capture holds L + seam samples, so fold all of it back to
  // L. In Free Mode the take is exactly what was recorded, and the fold trims
  // its own tail.
  const folded = foldSeam(rec.scratch.subarray(0, take));
  const buf = ctx.createBuffer(1, folded.length, rate);
  buf.getChannelData(0).set(folded);

  // Report where the take landed, so a wrong shift is visible without exporting
  // a WAV and measuring it in an editor. Only for a take that started on a
  // boundary: the first Free Mode take starts wherever the user pressed record,
  // so its first transient says nothing about the latency.
  if (!rec.definesLoop) {
    const offset = takeOffset(rec);
    if (offset !== null) {
      console.info(
        "[loupeur] take offset: %s ms (%s samples) from the boundary",
        (offset / rate * 1000).toFixed(1),
        offset
      );
    }
  }

  // The first Free Mode take defines the loop from its folded length.
  if (rec.definesLoop) {
    state.loopLength = folded.length;
    startTransport(state.t0);
  }
  ch.buffer = buf;
  ch.layers = 1;
  ch.state = "playing";

  // Enter the take at the loop position the transport has reached, never at the
  // boundary it was recorded from. That boundary is always in the past by the
  // time the take commits: the window opens at `boundary + shift` and runs the
  // take, the seam and CAPTURE_SLACK, so `start(rec.startTime, 0)` clamps to
  // "now" and plays the buffer from its head at whatever phase the loop happens
  // to be at. The take then sits `shift + seam + CAPTURE_SLACK` late, and stays
  // there, because a looping source is never re-scheduled. Every track recorded
  // over an existing loop landed that far behind the one it was played against.
  //
  // schedulePending enters at `max(now, t0)` with the offset the transport has
  // reached, which is the same rule a stop/start and an overdub use.
  schedulePending();
  render();
}

// True while a channel is capturing a take that must run its full length, so
// there is nothing to punch out of. A later Free Mode track is fixed by the
// first take's length; an overdub always runs a full loop.
function isLockedTake(ch) {
  if (!pendingRecord || pendingRecord.channel !== ch) return false;
  if (ch.state === "overdubbing") return true;
  return ch.state === "recording" && !pendingRecord.definesLoop;
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
    // must also silence the clicks still queued and stop the transport that was
    // started for it. A later take is armed against a loop that is already
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
    if (pendingRecord.definesLoop) {
      // First take: the length is whatever was captured up to now. The worklet
      // delivers blocks asynchronously, so the take ends at the last frame we
      // actually received, not at the wall clock. That frame is a mic frame, so
      // it is already latency-corrected like the start.
      const rec = pendingRecord;
      if (rec.startFrame === null) {
        finishCapture();
        return;
      }
      rec.endFrame = rec.lastFrame === null ? rec.startFrame : rec.lastFrame + 1;
      finishCapture();
    } else {
      showBanner("This track records for the full loop length. It stops on its own.");
    }
  } else if (ch.state === "overdubbing") {
    showBanner("The overdub runs to the end of the loop. It stops on its own.");
  }
}

// Crossfades the last n samples of the take into its first n samples and
// returns a buffer shortened by n. The loop point then lands where the tail
// hands over to the head, so the seam is continuous in value.
//
// The weights are linear, not equal-power: both halves are the same signal, so
// they must sum to 1. Equal-power weights sum to 1.41 at the midpoint, which
// puts a 20% amplitude bump on every sustained note at the loop point.
function foldSeam(data) {
  const n = seamSamples(data.length);
  if (n < 2) return data;

  const out = data.slice(0, data.length - n);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    out[i] = data[i] * t + data[data.length - n + i] * (1 - t);
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
  ch.state = "overdubbing";
  render();
}

function commitOverdub(ch, scratch, take) {
  const old = ch.buffer;
  const buf = ctx.createBuffer(1, old.length, old.sampleRate);
  const data = buf.getChannelData(0);
  data.set(old.getChannelData(0));
  // The take starts at scratch index 0, which is the loop boundary: the window
  // was opened `shift` after it and the anchor is the prediction, so the layer
  // lines up with the buffer it is added to. `take` is the loop length, not the
  // whole window, so the slack is not folded in.
  const add = scratch.subarray(0, Math.min(take, old.length));
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
  const g = ch.gain.gain;
  g.cancelScheduledValues(ctx.currentTime);
  g.setValueAtTime(1, ctx.currentTime);

  // loopLength is what marks "a loop exists" in both modes, so it has to follow
  // the buffers. In Free Mode the surviving tracks define the length; in Tempo
  // Lock the grid is derived from BPM and bars, but the flag still has to drop
  // when the last track goes, or the next record press would arm against a loop
  // with nothing in it.
  const remaining = state.channels.filter((c) => c.buffer);
  if (!remaining.length) {
    state.loopLength = 0;
    stopTransport();
  } else if (state.mode === "free") {
    state.loopLength = remaining[0].buffer.length;
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
  const now = ctx.currentTime;
  for (const osc of countInOscs) {
    osc.onended = null;
    try { osc.stop(now); } catch (_) {}
  }
  countInOscs.length = 0;
}

// `cancellable` marks a count-in click, which stopCountIn may silence. The
// metronome passes false: its beats are not part of a count-in, and tracking
// them would let a cancelled take kill the grid and grow the list without bound.
function playClick(when, accent, cancellable = true) {
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
  if (!cancellable) return;
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

// Transport states own their colour so a live state always reads louder than
// the track's own hue. An idle track draws in its hue, matching the tile.
const WAVE_COLORS = {
  armed: "#5b8def",
  recording: "#e5484d",
  playing: "#30a46c",
  overdubbing: "#f5a524",
};

// Must stay in step with the --track hues in style.css.
const TRACK_COLORS = ["#83e28b", "#98bfe7", "#e6acec", "#c0f1ed"];

function trackColor(ch) {
  return TRACK_COLORS[ch.index % TRACK_COLORS.length];
}

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
  const color = WAVE_COLORS[ch.state] || trackColor(ch);

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
    // liveEnv is a fixed grid over the whole scratch buffer, so only the
    // buckets covering the captured region hold anything.
    //
    // A take of known length (Tempo Lock, overdub) is drawn as a timeline: the
    // canvas spans `lengthSamples`, so the wave grows left to right and the
    // part not yet recorded stays empty. Stretching the captured fraction to
    // full width instead made every new block re-scale the whole picture, which
    // read as peaks arriving from the right and compressing the space.
    //
    // The first Free Mode take has no length until punch-out, so it keeps the
    // stretch: its scratch buffer is the full 8-minute maximum, and drawing all
    // of it would shrink the picture to a sliver at the left edge.
    const span = rec.scratch.length;
    const total = rec.lengthSamples || Math.ceil(ctx.sampleRate * MAX_TAKE_SECONDS);
    if (rec.lengthSamples) {
      // The envelope is a grid over the whole scratch buffer, so bucket i sits
      // at scratch index i * per. The audio is written at `micFrame -
      // startFrame`, and the window opens `shift` after the boundary, so
      // scratch index 0 is the boundary's audio: the display and the audio
      // share one origin.
      //
      // The canvas spans the take, not the window: the window carries
      // CAPTURE_SLACK samples past the end of the take, and drawing those would
      // squeeze the take into the left of the picture.
      const per = span / liveEnv.length;
      drawEnvelopeTimeline(g, liveEnv, per, 0, rec.lengthSamples, cssW, cssH, mid, color);
    } else {
      const used = Math.max(1, Math.ceil((filled / span) * liveEnv.length));
      drawEnvelope(g, liveEnv.subarray(0, used), cssW, cssH, mid, color);
    }

    // Progress against the take length, so elapsed time is visible even for the
    // Free Mode take whose waveform fills the width.
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

  // Playhead during playback. Measured against the buffer's own length, the
  // same length the source loops on, so it sits where the audio actually is.
  if (state.transport === "running" && ch.buffer) {
    const L = ch.buffer.length / ctx.sampleRate;
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

// Draws a take of known length as a timeline: the canvas spans `length` samples
// of the take, so a bucket sits at the position of the audio it holds and the
// region not yet captured stays empty.
//
// `env` is a grid over the whole scratch buffer, which starts `shift` samples
// before the take (the latency correction). `per` is the number of scratch
// samples per bucket and `origin` is the scratch index the take starts at, so a
// bucket lands at the same x the audio would: the display and the audio share
// one origin instead of each deriving their own.
function drawEnvelopeTimeline(g, env, per, origin, length, cssW, cssH, mid, color) {
  if (!(length > 0) || !env.length) return;
  const scale = cssW / length;
  g.fillStyle = color;
  for (let i = 0; i < env.length; i++) {
    const amp = Math.min(1, env[i]) * (mid - 2);
    if (amp <= 0.5) continue;
    const x = (i * per - origin) * scale;
    if (x >= cssW) break;
    const w = Math.max(1, per * scale - 0.5);
    g.fillRect(Math.max(0, x), mid - amp, w, amp * 2);
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
    tile.className = "track nb-card";
    tile.dataset.index = i;
    tile.innerHTML = `
      <div class="track-head">
        <span class="track-name">Track ${i + 1}</span>
        <span class="layers" data-layers="${i}">0</span>
      </div>
      <canvas class="wave" data-wave="${i}"></canvas>
      <button type="button" class="primary nb-button" data-primary="${i}">RECORD</button>
      <div class="track-foot">
        <button type="button" class="small nb-button" data-mute="${i}">MUTE</button>
        <button type="button" class="small nb-button" data-clear="${i}">CLEAR</button>
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
    // A take that runs a fixed length cannot be punched out: a later Free Mode
    // track (its length is fixed by the first take) and an overdub (it always
    // runs a full loop). The button only reports progress for those. An armed
    // take is always cancellable, in both modes.
    const locked = isLockedTake(ch);
    // An armed take counts down to its punch-in, so the wait is legible instead
    // of a dead press. Driven by the transport clock, not by audio.
    const countdown = ch.state === "armed" ? armCountdown(ch) : 0;
    const labels = {
      empty: "RECORD",
      armed: countdown ? `IN ${countdown}` : "ARMED",
      recording: locked ? "RECORDING…" : "STOP REC",
      playing: "OVERDUB",
      overdubbing: locked ? "DUBBING…" : "STOP DUB",
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

  // The offset readout shows the number actually in force for the open device:
  // the measured one once calibration has run, the estimate before that. It is
  // the same number captureShift() uses, so what it reads is what the next take
  // is corrected by -- there is no second hidden value, and nothing to edit.
  const offsetMs = Math.round(captureShift() * 1000);
  el.offsetOut.textContent = offsetMs > 0 ? "+" + offsetMs : String(offsetMs);
  el.offsetHelp.textContent = offsetIsMeasured(state.micId)
    ? "Measured for this microphone. Applies to every take, on every track."
    : "Estimated from the browser's reported buffers. Run Calibrate to measure it.";

  // Calibration owns the mic while it runs, so nothing else may start a take.
  const busy = Boolean(calibration);
  el.calibrate.disabled = busy;
  el.calibrate.textContent = busy ? "Calibrating…" : "Calibrate";

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

  el.clickRec.addEventListener("change", () => {
    state.clickWhileRecording = el.clickRec.checked;
    // Turning the metronome on mid-loop must not replay the beats already
    // behind the playhead, so the cursor is re-seated on the first beat that
    // has not gone by yet. Floor, not ceil: a beat still ahead of the clock
    // must be scheduled, and rounding up would drop it.
    if (ctx && state.transport === "running") {
      const beatSec = 60 / state.bpm;
      nextBeatIndex = Math.max(0, Math.floor((ctx.currentTime - state.t0) / beatSec));
    }
  });

  el.mic.addEventListener("change", () => {
    switchMic(el.mic.value).catch((err) => showBanner("Could not switch microphone: " + err.message));
  });

  el.calibrate.addEventListener("click", () => {
    calibrate().catch((err) => showBanner("Calibration failed: " + err.message));
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
