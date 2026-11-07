"use strict";

// The three properties from ISSUE.md 3.3. None of them needs to know the true
// latency of the hardware: they assert internal consistency, not an absolute
// offset. They are the tests that would have caught the reported bug on every
// version of the code so far.
//
// The model they encode: the mic runs `shift` samples behind the render clock,
// so a sound played at render frame `f` is stamped `f + shift` by the worklet.
// The capture window opens `shift` before the boundary, so the sound of the
// boundary sits at scratch index 0. `shift` is whatever the code computes; the
// tests read it back from the pending record instead of assuming a value.

const assert = require("assert");
const { load, boot, makeCanvasContext } = require("./harness");

const RATE = 48000;
const BLOCK = 128;
const LENGTH = 4800;

// A take of `length` samples armed at `startTime`, with the capture window
// opened the way beginRecord does it for a later track.
async function armedTake(opts) {
  const o = opts || {};
  const t = load({ sampleRate: RATE, outputLatency: o.outputLatency });
  await boot(t);
  t.state.mode = "tempo";
  t.state.bpm = 100;
  t.state.bars = 1;
  t.state.loopLength = o.length || LENGTH;
  const ch = t.state.channels[0];
  const startTime = o.startTime === undefined ? 1 : o.startTime;
  const length = o.length || LENGTH;
  t.armTake(ch, startTime, length);
  return { t, ch, rec: t.pendingRecord, startTime, length };
}

// Feeds one block of silence, optionally with a click at a given mic frame.
function feed(t, frame, clickAt) {
  const data = new Float32Array(BLOCK);
  if (clickAt !== undefined && clickAt >= frame && clickAt < frame + BLOCK) {
    data[clickAt - frame] = 1;
  }
  t.onCaptureFrame({ data: { frame, data } });
}

// Feeds blocks from `from` to `to` (exclusive), one worklet block at a time.
function feedRange(t, from, to, clickAt) {
  for (let frame = from; frame < to; frame += BLOCK) feed(t, frame, clickAt);
}

// The scratch buffer of a take that is still open, or the committed buffer of
// one that has finished.
function takeData(t) {
  const rec = t.pendingRecord;
  if (rec) return rec.scratch;
  const ch = t.state.channels[0];
  return ch.buffer ? ch.buffer.getChannelData(0) : null;
}

// ---------------------------------------------------------------------------

const tests = [];

// 3.3.1 — the anchor is honoured. The worklet delivers blocks on its own
// schedule, so the first block that overlaps the window almost always starts
// after the prediction. The take must still be anchored to the prediction.
tests.push({
  name: "anchor: a first block after the prediction does not move the take",
  async fn() {
    const { t, rec } = await armedTake();
    const predicted = rec.startFramePredicted;
    // The first block arrives 3 blocks late, which is the normal case.
    feed(t, predicted + 3 * BLOCK);
    assert.strictEqual(
      t.pendingRecord.startFrame,
      predicted,
      "the take was re-anchored to the first block instead of the prediction"
    );
  },
});

tests.push({
  name: "anchor: the head between the prediction and the first block stays zero",
  async fn() {
    const { t, rec } = await armedTake();
    const predicted = rec.startFramePredicted;
    const firstBlock = predicted + 3 * BLOCK;
    // A click at the very first sample of the first block must land at the
    // scratch index that corresponds to it, not at index 0.
    feedRange(t, firstBlock, firstBlock + BLOCK, firstBlock);
    const scratch = t.pendingRecord.scratch;
    assert.strictEqual(scratch[0], 0, "the head was not padded with silence");
    assert.strictEqual(
      scratch[3 * BLOCK],
      1,
      "the click did not land at its own position in the window"
    );
  },
});

tests.push({
  name: "anchor: a click on the boundary lands at scratch index 0",
  async fn() {
    const { t, rec, startTime } = await armedTake();
    // The boundary is the render frame the take starts at. The mic delivers it
    // `shift` samples later in render time, so it sits at mic frame
    // boundary + shift, which is exactly startFramePredicted.
    const boundary = Math.round(startTime * RATE);
    const clickMic = boundary + rec.shift;
    assert.strictEqual(clickMic, rec.startFramePredicted, "harness assumption");
    // The block carrying the click is the one that opens the window, so the
    // feed has to start there: a click the worklet never delivers is not a
    // test of where the take is anchored.
    feedRange(t, rec.startFramePredicted, rec.startFramePredicted + 40 * BLOCK, clickMic);
    const buf = takeData(t);
    assert.ok(buf, "nothing was captured");
    assert.strictEqual(buf[0], 1, "the click on the boundary did not land at index 0");
  },
});

// 3.3.2 — the tail survives. The block that reaches the end of the window must
// not cut the last wanted sample, and the take must not finish before the block
// carrying it has been written.
tests.push({
  name: "tail: the last wanted sample is present after the take finishes",
  async fn() {
    const { t, rec, length } = await armedTake();
    const predicted = rec.startFramePredicted;
    const lastWanted = predicted + length - 1;
    feedRange(t, predicted, predicted + length + 4 * BLOCK, lastWanted);
    const ch = t.state.channels[0];
    assert.ok(ch.buffer, "the take never finished");
    const data = ch.buffer.getChannelData(0);
    assert.strictEqual(data.length, length, "the committed buffer is not the loop length");
    assert.strictEqual(data[length - 1], 1, "the last wanted sample was cut");
  },
});

tests.push({
  name: "tail: a take that finishes on a block boundary keeps its whole length",
  async fn() {
    const { t, rec, length } = await armedTake();
    const predicted = rec.startFramePredicted;
    // Put a click in the final block, at the last sample of the take.
    const lastWanted = predicted + length - 1;
    feedRange(t, predicted, predicted + length + 8 * BLOCK, lastWanted);
    const data = t.state.channels[0].buffer.getChannelData(0);
    assert.strictEqual(data[length - 1], 1, "the tail was truncated");
  },
});

// 3.3.3 — the display agrees with the audio. The buffer index of the peak and
// the x position the display gives that same sample must refer to the same
// fraction of the take. The display is driven through drawWave, the function
// the render loop actually calls, so the test cannot pass by calling a helper
// with arguments the app never passes.
tests.push({
  name: "display: the waveform x of a sample matches its position in the take",
  async fn() {
    const { t, ch, rec, length } = await armedTake();
    // The channel is armed until the boundary arrives; the waveform only draws
    // the live take once it is recording.
    ch.state = "recording";
    const predicted = rec.startFramePredicted;
    // A click a quarter of the way into the take. The feed stops short of the
    // end so the take is still open when the waveform is drawn.
    const clickMic = predicted + Math.floor(length / 4);
    feedRange(t, predicted, predicted + length - 4 * BLOCK, clickMic);

    const data = t.pendingRecord.scratch;
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      if (Math.abs(data[i]) > Math.abs(data[peak])) peak = i;
    }
    const audioFrac = peak / length;

    // Redraw the live waveform from the envelope the capture built, with the
    // take still open so drawWave takes the recording branch.
    const liveEnv = t.liveEnv;
    assert.ok(liveEnv, "the live envelope was dropped while the take is open");
    const canvas = t.__document.createElement("canvas");
    const g = makeCanvasContext();
    canvas.getContext = () => g;
    t.drawWave(ch, canvas);

    const rect = g.rects.find((r) => r.w > 0 && r.h > 0);
    assert.ok(rect, "the display drew nothing");
    const displayFrac = (rect.x + rect.w / 2) / canvas.clientWidth;

    assert.ok(
      Math.abs(displayFrac - audioFrac) < 0.02,
      `display says ${displayFrac.toFixed(3)} of the width, audio says ${audioFrac.toFixed(3)}`
    );
  },
});

module.exports = tests;
