"use strict";

// The sequence export. It renders one pass of the pattern, not one loop: the
// sources loop for the whole render and a gate in front of each level follows
// the row's filled slots. The selection and the gate schedule are the parts
// worth pinning here; the audio graph itself is the mix export's.

const assert = require("assert");
const { load, boot } = require("./harness");

const RATE = 48000;
const LENGTH = 4800;   // 0.1 s, enough to render quickly

function fakeBuffer() {
  return { length: LENGTH };
}

function makeParam() {
  return {
    calls: [],
    setValueAtTime(value, time) { this.calls.push({ type: "set", value, time }); },
    linearRampToValueAtTime(value, time) { this.calls.push({ type: "ramp", value, time }); },
  };
}

const tests = [];

tests.push({
  name: "sequence export: only tracks with a filled row are included",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const ch = t.state.channels;
    ch[0].buffer = fakeBuffer();
    ch[1].buffer = fakeBuffer();
    ch[2].buffer = fakeBuffer();
    ch[3].buffer = fakeBuffer();
    t.state.seqRows[0] = { steps: [true, false, false, false] };
    t.state.seqRows[1] = { steps: [false, false, false, false] };
    // Track 2 has no row. Track 3 has a row but is muted.
    t.state.seqRows[3] = { steps: [true, false, false, false] };
    ch[3].muted = true;

    assert.deepStrictEqual(Array.from(t.sequenceExportTracks(), (c) => c.index), [0]);
  },
});

tests.push({
  name: "sequence export: the gate holds through runs and ramps on changes",
  async fn() {
    const t = load({ sampleRate: RATE });
    const param = makeParam();
    t.scheduleSeqGate(param, [true, true, false, false], 1);

    assert.deepStrictEqual(param.calls, [
      { type: "set", value: 1, time: 0 },
      { type: "set", value: 1, time: 2 },
      { type: "ramp", value: 0, time: 2 + t.RAMP_SECONDS },
    ]);
  },
});

tests.push({
  name: "sequence export: the gate opens on the first filled slot",
  async fn() {
    const t = load({ sampleRate: RATE });
    const param = makeParam();
    t.scheduleSeqGate(param, [false, true, true, false], 1);

    assert.deepStrictEqual(param.calls, [
      { type: "set", value: 0, time: 0 },
      { type: "set", value: 0, time: 1 },
      { type: "ramp", value: 1, time: 1 + t.RAMP_SECONDS },
      { type: "set", value: 1, time: 3 },
      { type: "ramp", value: 0, time: 3 + t.RAMP_SECONDS },
    ]);
  },
});

tests.push({
  name: "sequence export: the download is one pattern pass",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    t.state.mode = "free";
    t.state.loopLength = LENGTH;
    t.state.seqSteps = 4;
    const ch = t.state.channels[0];
    ch.buffer = t.__ctx.createBuffer(1, LENGTH, RATE);
    ch.state = "playing";
    t.state.seqRows[0] = { steps: [true, false, true, false] };

    const saved = [];
    t.download = (blob, name) => saved.push(name);
    await t.exportSequence();
    assert.strictEqual(saved.join(","), "sequence-mix.wav");
  },
});

tests.push({
  name: "sequence export: the file is the whole pattern, not one loop",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    t.state.mode = "free";
    t.state.loopLength = LENGTH;
    t.state.seqSteps = 4;
    const ch = t.state.channels[0];
    ch.buffer = t.__ctx.createBuffer(1, LENGTH, RATE);
    t.state.seqRows[0] = { steps: [true, false, false, false] };

    let captured = null;
    t.__sandbox.Blob = function (parts, opts) { captured = { parts, opts }; };
    t.download = () => {};
    await t.exportSequence();

    assert.ok(captured, "no WAV was encoded");
    const frames = 4 * LENGTH;
    assert.strictEqual(captured.parts[0].byteLength, 44 + frames * 2 * 2);
  },
});

tests.push({
  name: "sequence export: an empty pattern has nothing to write",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const ch = t.state.channels[0];
    ch.buffer = fakeBuffer();
    t.state.seqRows[0] = { steps: [false, false, false, false] };

    const saved = [];
    t.download = (blob, name) => saved.push(name);
    await t.exportSequence();
    assert.strictEqual(saved.length, 0);
  },
});

module.exports = tests;
