"use strict";

// The sequencer. A slot is one full loop, so the step clock is the transport
// clock divided by the loop length: there is no second timer to drift against.
// The gate is a node of its own, in front of the channel gain, so mute and
// volume keep meaning exactly what they meant before.

const assert = require("assert");
const { load, boot } = require("./harness");

const RATE = 48000;
const LENGTH = 48000;   // 1 s, so one slot is one second and a boundary is easy to read

// The last automation call of `type` on a param.
function last(param, type) {
  const calls = param.calls.filter((c) => c.type === type);
  return calls[calls.length - 1];
}

// A running transport with one track holding a buffer. Free Mode is used
// because it lets the test set the loop length directly instead of deriving it
// from BPM and bars.
function setup(t) {
  t.state.mode = "free";
  t.state.loopLength = LENGTH;
  t.state.transport = "running";
  t.state.t0 = 0;
  const ch = t.state.channels[0];
  ch.buffer = t.__ctx.createBuffer(1, LENGTH, RATE);
  ch.state = "playing";
  return ch;
}

const tests = [];

tests.push({
  name: "sequencer: a slot is one full loop",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    setup(t);

    assert.strictEqual(t.seqStepIndex(0), 0);
    assert.strictEqual(t.seqStepIndex(0.5), 0);
    assert.strictEqual(t.seqStepIndex(1), 1);
    assert.strictEqual(t.seqStepIndex(2), 2);
    assert.strictEqual(t.seqStepIndex(3), 3);
    // The pattern is four loops long and then repeats.
    assert.strictEqual(t.seqStepIndex(4), 0);
    assert.strictEqual(t.seqStepIndex(5), 1);
  },
});

tests.push({
  name: "sequencer: a time before the transport starts reads as the first slot",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    setup(t);
    t.state.t0 = 10;
    // A negative step must not wrap to the last slot: the transport has not
    // started, so the pattern is at its top.
    assert.strictEqual(t.seqStepIndex(9.5), 0);
  },
});

tests.push({
  name: "sequencer: LOOP mode plays every track every loop",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const ch = setup(t);
    t.state.playMode = "loop";

    assert.strictEqual(t.channelAudible(ch, 0), true);
    assert.strictEqual(t.channelAudible(ch, 3.5), true);
  },
});

tests.push({
  name: "sequencer: SEQUENCE mode silences a track with no row",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const ch = setup(t);
    t.state.playMode = "sequence";

    assert.strictEqual(t.channelAudible(ch, 0), false);
    assert.strictEqual(t.channelAudible(ch, 2), false);
  },
});

tests.push({
  name: "sequencer: SEQUENCE mode follows the filled slots",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const ch = setup(t);
    t.state.playMode = "sequence";
    t.toggleSeqRow(0);
    t.toggleSeqStep(0, 0);
    t.toggleSeqStep(0, 2);

    assert.deepStrictEqual(Array.from(t.state.seqRows[0].steps), [true, false, true, false]);
    assert.strictEqual(t.channelAudible(ch, 0), true);
    assert.strictEqual(t.channelAudible(ch, 1), false);
    assert.strictEqual(t.channelAudible(ch, 2), true);
    assert.strictEqual(t.channelAudible(ch, 3), false);
    // And the pattern repeats.
    assert.strictEqual(t.channelAudible(ch, 4), true);
    assert.strictEqual(t.channelAudible(ch, 5), false);
  },
});

tests.push({
  name: "sequencer: the gate ramps at the loop boundary, not mid-loop",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const ch = setup(t);
    t.state.playMode = "sequence";
    t.toggleSeqRow(0);
    t.toggleSeqStep(0, 0);

    // Slot 0 is filled and slot 1 is not. The gate for slot 1 lands on the
    // boundary at 1 s, not at the moment the slot was clicked.
    t.rampSeqGain(ch, 1);
    const ramp = last(ch.seqGain.gain, "ramp");
    assert.strictEqual(ramp.value, 0);
    assert.strictEqual(ramp.time, 1 + 0.01);
  },
});

tests.push({
  name: "sequencer: the scheduler re-gates every track at each boundary",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const ch = setup(t);
    t.state.playMode = "sequence";
    t.toggleSeqRow(0);
    t.toggleSeqStep(0, 0);
    t.startTransport(0);

    // Boundary 1 is slot 1, which is empty: the gate must ramp to 0 there.
    t.__ctx.__clock.now = 0.95;
    t.scheduleAhead();
    const ramps = ch.seqGain.gain.calls.filter((c) => c.type === "ramp");
    const atBoundary = ramps.filter((c) => c.time === 1 + 0.01);
    assert.ok(atBoundary.length, "no gate ramp landed on the boundary");
    assert.strictEqual(atBoundary[atBoundary.length - 1].value, 0);
  },
});

tests.push({
  name: "sequencer: a pattern that does not loop stops the transport after its last slot",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    setup(t);
    t.state.playMode = "sequence";
    t.state.seqLoop = false;
    t.startTransport(0);

    t.__ctx.__clock.now = 3.5;
    t.scheduleAhead();
    assert.strictEqual(t.state.transport, "running", "the transport stopped before the last slot ended");

    t.__ctx.__clock.now = 4;
    t.scheduleAhead();
    assert.strictEqual(t.state.transport, "stopped");
  },
});

tests.push({
  name: "sequencer: a non-looping pattern is silent past its last slot",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const ch = setup(t);
    t.state.playMode = "sequence";
    t.state.seqLoop = false;
    t.toggleSeqRow(0);
    for (let s = 0; s < 4; s++) t.toggleSeqStep(0, s);

    assert.strictEqual(t.channelAudible(ch, 3.5), true);
    assert.strictEqual(t.channelAudible(ch, 4), false);
  },
});

tests.push({
  name: "sequencer: copying a track adds a row, copying again removes it",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    setup(t);

    t.toggleSeqRow(0);
    assert.ok(t.state.seqRows[0], "no row was added");
    assert.deepStrictEqual(Array.from(t.state.seqRows[0].steps), [false, false, false, false]);

    t.toggleSeqRow(0);
    assert.strictEqual(t.state.seqRows[0], null);
  },
});

tests.push({
  name: "sequencer: an empty track cannot be copied",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    // No buffer: the tile has nothing to copy.
    t.toggleSeqRow(0);
    assert.strictEqual(t.state.seqRows[0], null);
  },
});

tests.push({
  name: "sequencer: clearing a track drops its row",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const ch = setup(t);
    t.toggleSeqRow(0);
    t.clearChannel(ch);
    assert.strictEqual(t.state.seqRows[0], null);
  },
});

tests.push({
  name: "sequencer: the mode switch waits for a take in progress",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const ch = setup(t);

    ch.state = "recording";
    t.setPlayMode("sequence");
    assert.strictEqual(t.state.playMode, "loop", "the mode changed under a live take");

    ch.state = "playing";
    t.setPlayMode("sequence");
    assert.strictEqual(t.state.playMode, "sequence");
  },
});

tests.push({
  name: "sequencer: switching to SEQUENCE silences a track with no row",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const ch = setup(t);
    t.setPlayMode("sequence");
    assert.strictEqual(last(ch.seqGain.gain, "ramp").value, 0);
  },
});

tests.push({
  name: "sequencer: switching back to LOOP restores every track",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const ch = setup(t);
    t.setPlayMode("sequence");
    t.setPlayMode("loop");
    assert.strictEqual(last(ch.seqGain.gain, "ramp").value, 1);
  },
});

tests.push({
  name: "sequencer: the gate is a separate node, so mute and volume are untouched",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const ch = setup(t);

    t.setVolume(0, 0.4);
    t.setPlayMode("sequence");

    // The channel gain still holds the slider's level; the silence is the gate.
    assert.strictEqual(last(ch.gain.gain, "ramp").value, 0.4);
    assert.strictEqual(last(ch.seqGain.gain, "ramp").value, 0);
  },
});

tests.push({
  name: "sequencer: filling the slot that is playing is heard now",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const ch = setup(t);
    t.state.playMode = "sequence";
    t.toggleSeqRow(0);

    t.__ctx.__clock.now = 0.5;
    t.toggleSeqStep(0, 0);
    // The immediate ramp is the one that ends at now + RAMP_SECONDS. The last
    // ramp on the param is the boundary one, which is a different decision.
    const immediate = ch.seqGain.gain.calls.find(
      (c) => c.type === "ramp" && c.time === 0.5 + 0.01
    );
    assert.ok(immediate, "no gate ramp for the slot that is playing");
    assert.strictEqual(immediate.value, 1);
  },
});

tests.push({
  name: "sequencer: a boundary reads as its own slot, not the one before",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    setup(t);
    // 4 s loops from t0 = 0.1: (0.1 + 4 - 0.1) / 4 is 0.9999999999999999 in
    // floating point, so a plain floor reads slot 0 at the slot 1 boundary.
    t.state.loopLength = 4 * RATE;
    t.state.t0 = 0.1;
    for (let n = 0; n < 12; n++) {
      assert.strictEqual(
        t.seqStepIndex(0.1 + n * 4),
        n % 4,
        `boundary ${n} read the wrong slot`
      );
    }
  },
});

tests.push({
  name: "sequencer: refreshing the gates keeps the boundary ramp",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const ch = setup(t);
    t.state.playMode = "sequence";
    t.toggleSeqRow(0);
    t.toggleSeqStep(0, 0);
    t.startTransport(0);

    // The scheduler has already queued the slot 1 gate at the 1 s boundary.
    t.__ctx.__clock.now = 0.95;
    t.scheduleAhead();

    // A click on a slot re-applies the gate now. It must not drop the boundary
    // ramp: nextBoundaryIndex has moved past it, so nothing would put it back
    // and the gate would hold slot 0's value through slot 1.
    t.toggleSeqStep(0, 2);

    // The stub records cancels without applying them, so the check is order:
    // a boundary ramp queued before the last cancel is wiped by it.
    const calls = ch.seqGain.gain.calls;
    const lastCancel = calls.reduce((at, c, i) => (c.type === "cancel" ? i : at), -1);
    const boundary = calls.reduce(
      (at, c, i) => (c.type === "ramp" && c.time === 1 + 0.01 ? i : at),
      -1
    );
    assert.ok(boundary >= 0, "the boundary ramp was dropped");
    assert.ok(
      boundary > lastCancel,
      "the boundary ramp was queued before the last cancel, so it is wiped"
    );
    assert.strictEqual(calls[boundary].value, 0);
  },
});

tests.push({
  name: "sequencer: a boundary the scheduler reached late still gates",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const ch = setup(t);
    t.state.playMode = "sequence";
    t.toggleSeqRow(0);
    t.toggleSeqStep(0, 0);
    t.startTransport(0);

    // The tick lands 50 ms after the 1 s boundary. Skipping the boundary would
    // leave slot 0's gate in place for the whole of slot 1.
    t.__ctx.__clock.now = 1.05;
    t.scheduleAhead();
    const late = ch.seqGain.gain.calls.filter(
      (c) => c.type === "ramp" && c.time === 1.05 + 0.01
    );
    assert.ok(late.length, "the late boundary was skipped");
    assert.strictEqual(late[late.length - 1].value, 0);
  },
});

tests.push({
  name: "sequencer: the pattern length changes the step clock",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    setup(t);
    assert.strictEqual(t.state.seqSteps, t.DEFAULT_SEQ_STEPS);

    t.setSeqSteps(8);
    assert.strictEqual(t.seqStepIndex(7), 7);
    assert.strictEqual(t.seqStepIndex(8), 0);

    t.setSeqSteps(16);
    assert.strictEqual(t.seqStepIndex(15), 15);
    assert.strictEqual(t.seqStepIndex(16), 0);

    t.setSeqSteps(32);
    assert.strictEqual(t.seqStepIndex(31), 31);
    assert.strictEqual(t.seqStepIndex(32), 0);
  },
});

tests.push({
  name: "sequencer: changing the pattern length pads and truncates rows",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    setup(t);
    t.toggleSeqRow(0);
    t.toggleSeqStep(0, 0);
    t.toggleSeqStep(0, 3);

    t.setSeqSteps(8);
    assert.deepStrictEqual(
      Array.from(t.state.seqRows[0].steps),
      [true, false, false, true, false, false, false, false]
    );

    t.setSeqSteps(4);
    assert.deepStrictEqual(Array.from(t.state.seqRows[0].steps), [true, false, false, true]);

    // Shrinking is permanent: growing again pads with empty slots.
    t.setSeqSteps(8);
    assert.deepStrictEqual(
      Array.from(t.state.seqRows[0].steps),
      [true, false, false, true, false, false, false, false]
    );
  },
});

tests.push({
  name: "sequencer: a row is created at the current pattern length",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    setup(t);
    t.setSeqSteps(16);
    t.toggleSeqRow(0);
    assert.strictEqual(t.state.seqRows[0].steps.length, 16);
  },
});

tests.push({
  name: "sequencer: a non-looping pattern ends at the configured last slot",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const ch = setup(t);
    t.state.playMode = "sequence";
    t.state.seqLoop = false;
    t.setSeqSteps(8);
    t.toggleSeqRow(0);
    for (let s = 0; s < 8; s++) t.toggleSeqStep(0, s);
    t.startTransport(0);

    assert.strictEqual(t.channelAudible(ch, 7.5), true);
    assert.strictEqual(t.channelAudible(ch, 8), false);

    t.__ctx.__clock.now = 7.5;
    t.scheduleAhead();
    assert.strictEqual(t.state.transport, "running", "stopped before the last slot ended");

    t.__ctx.__clock.now = 8;
    t.scheduleAhead();
    assert.strictEqual(t.state.transport, "stopped");
  },
});

tests.push({
  name: "sequencer: the header badge follows the playback mode",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const badge = t.__document.getElementById("modeBadge");
    const header = t.__document.getElementById("header");

    t.setPlayMode("sequence");
    assert.strictEqual(badge.textContent, "SEQUENCE");
    assert.ok(badge.classList.contains("mode-sequence"));
    assert.ok(header.classList.contains("mode-sequence"));

    t.setPlayMode("loop");
    assert.strictEqual(badge.textContent, "LOOP");
    assert.ok(badge.classList.contains("mode-loop"));
    assert.ok(header.classList.contains("mode-loop"));
  },
});

module.exports = tests;
