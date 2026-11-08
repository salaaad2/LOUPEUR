"use strict";

// Loads app.js into a vm context with a stubbed DOM and Web Audio API, and
// hands back the internals a test needs to drive capture directly.
//
// app.js is a plain script with no module boundary, so the only way in is to
// evaluate it and read the bindings out of its scope. `boot()` is replaced by
// an export of the functions under test: booting would build the DOM, start a
// requestAnimationFrame loop and read the real AudioContext, none of which
// exists here.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP = path.join(__dirname, "..", "app.js");

// The bindings a test may reach. Everything else stays private to app.js.
const EXPORTS = [
  "state",
  "initAudio",
  "armCapture",
  "armTake",
  "onCaptureFrame",
  "finishCapture",
  "beginOverdub",
  "commitOverdub",
  "foldSeam",
  "seamSamples",
  "loopSamples",
  "drawEnvelopeTimeline",
  "drawWave",
  "computeEnvelope",
  "makeCapture",
  "captureShift",
  "measureInputLatency",
  "scheduleChannel",
  "startTransport",
  "nextBoundaryTime",
  "calibrate",
  "syncCheck",
  "measureRoundTrip",
  "onCalibrationFrame",
  "firstCrossing",
  "takeOffset",
  "offsetFor",
  "offsetIsMeasured",
  "deviceOffsetFor",
  "storeDeviceOffset",
  "render",
];

// Names are probed with typeof so the harness still loads against a version of
// app.js that does not define all of them: a test that needs a missing binding
// fails on its own assertion instead of taking the whole suite down.
function exportBlock() {
  const getters = [
    "get pendingRecord() { return pendingRecord; }",
    "get liveEnv() { return liveEnv; }",
    "get inputLatency() { return inputLatency; }",
    "get outputLatency() { return outputLatency; }",
    "get ctx() { return ctx; }",
    "get micStream() { return micStream; }",
    "get calibration() { return calibration; }",
    "set inputLatency(v) { inputLatency = v; }",
    "set outputLatency(v) { outputLatency = v; }",
    "set pendingRecord(v) { pendingRecord = v; }",
  ];
  const probes = EXPORTS.map(
    (name) => `${name}: typeof ${name} === "undefined" ? undefined : ${name}`
  );
  return `globalThis.__t = { ${probes.join(", ")}, ${getters.join(", ")} };`;
}

// ---------------------------------------------------------------------------
// Web Audio stub
// ---------------------------------------------------------------------------

function makeParam(value) {
  return {
    value,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
    cancelScheduledValues() {},
  };
}

function makeNode(extra) {
  return Object.assign(
    {
      connect() {},
      disconnect() {},
    },
    extra
  );
}

function makeAudioBuffer(channels, length, sampleRate) {
  const data = [];
  for (let c = 0; c < channels; c++) data.push(new Float32Array(length));
  return {
    numberOfChannels: channels,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (c) => data[c],
  };
}

// A context whose clock the test drives by hand. `currentTime` is a getter so
// a test can advance it without touching the graph.
function makeContext(opts) {
  const o = opts || {};
  const rate = o.sampleRate || 48000;
  const clock = { now: o.currentTime || 0 };

  const ctx = {
    sampleRate: rate,
    baseLatency: o.baseLatency === undefined ? 0.0107 : o.baseLatency,
    outputLatency: o.outputLatency === undefined ? 0.044 : o.outputLatency,
    state: "running",
    destination: makeNode(),
    resume: async () => {},
    createGain: () => makeNode({ gain: makeParam(1) }),
    createConvolver: () => makeNode({ buffer: null }),
    createOscillator: () =>
      makeNode({
        frequency: makeParam(440),
        type: "sine",
        start() {},
        stop() {},
        onended: null,
      }),
    createBuffer: (channels, length, sampleRate) =>
      makeAudioBuffer(channels, length, sampleRate || rate),
    createBufferSource: () => {
      const src = makeNode({
        buffer: null,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        onended: null,
        started: [],
        start(when, offset) {
          src.started.push({ when, offset: offset || 0 });
        },
        stop() {},
      });
      return src;
    },
    createMediaStreamSource: () => makeNode(),
    audioWorklet: { addModule: async () => {} },
  };
  Object.defineProperty(ctx, "currentTime", { get: () => clock.now });
  ctx.__clock = clock;
  return ctx;
}

// ---------------------------------------------------------------------------
// DOM stub
// ---------------------------------------------------------------------------

function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    textContent: "",
    innerHTML: "",
    hidden: false,
    disabled: false,
    value: "",
    checked: false,
    clientWidth: 200,
    clientHeight: 48,
    width: 200,
    height: 48,
    appendChild(child) { this.children.push(child); return child; },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return makeElement("div"); },
    querySelectorAll() { return []; },
    closest() { return null; },
    matches() { return false; },
    getContext: () => makeCanvasContext(),
    click() {},
  };
  return el;
}

// Records every fillRect so a test can ask where the display put a sample.
function makeCanvasContext() {
  const rects = [];
  return {
    rects,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
    setTransform() {},
    clearRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fillText() {},
    fillRect(x, y, w, h) { rects.push({ x, y, w, h }); },
  };
}

// The slice of localStorage the app uses. Kept in memory so a test can seed a
// stored offset and read back what the app wrote.
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    __map: map,
  };
}

function makeDocument() {
  const byId = new Map();
  const doc = {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeElement("div"));
      return byId.get(id);
    },
    createElement: (tag) => makeElement(tag),
    addEventListener() {},
    querySelector() { return makeElement("div"); },
  };
  return doc;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

// Returns the app's internals plus the stub context it was built against.
// `opts` is forwarded to makeContext.
function load(opts) {
  let src = fs.readFileSync(APP, "utf8");
  if (!src.includes("\nboot();")) {
    throw new Error("app.js no longer ends with a bare boot(); the harness needs updating");
  }
  src = src.replace("\nboot();", "\n" + exportBlock());

  const ctx = makeContext(opts);
  const document = makeDocument();

  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    document,
    window: {
      AudioContext: function () { return ctx; },
      devicePixelRatio: 1,
      isSecureContext: true,
    },
    navigator: {
      mediaDevices: {
        getUserMedia: async () => ({
          getAudioTracks: () => [],
          getTracks: () => [],
        }),
        enumerateDevices: async () => [],
        addEventListener() {},
      },
    },
    location: { protocol: "http:" },
    // Per-device measured offsets live here. A plain in-memory map is enough:
    // the app only needs get/set/remove, and a test that wants a stored offset
    // can seed it before booting.
    localStorage: makeStorage(),
    AudioWorkletNode: function () {
      return { port: { onmessage: null }, connect() {}, disconnect() {} };
    },
    OfflineAudioContext: function () { return ctx; },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    URL: { createObjectURL: () => "", revokeObjectURL() {} },
    Blob: function () {},
    Float32Array,
    Math,
    Date,
    JSON,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: APP });

  const t = sandbox.__t;
  if (!t) throw new Error("app.js did not export its internals");
  t.__ctx = ctx;
  t.__document = document;
  t.__sandbox = sandbox;
  return t;
}

// Builds the audio graph and the channel list without touching the DOM.
async function boot(t, opts) {
  await t.initAudio();
  return t;
}

module.exports = { load, boot, makeContext, makeCanvasContext };
