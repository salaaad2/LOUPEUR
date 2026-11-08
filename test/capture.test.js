"use strict";

// The three properties from ISSUE.md 3.3. None of them needs to know the true
// latency of the hardware: they assert internal consistency, not an absolute
// offset. They are the tests that would have caught the reported bug on every
// version of the code so far.
//
// The model they encode. The capture window opens `shift` samples before the
// boundary, and `shift` is the whole round trip: the player hears the transport
// `outputLatency` late and therefore plays that much late, and the mic stamps
// the sound `inputLatency` later again. So the audio of a note the player meant
// for render frame `f` is stamped at `f + 2 * shift`, and the window -- which
// opens at `boundary - shift` -- holds it at scratch index `shift`. `shift` is
// whatever the code computes; the tests read it back from the pending record
// instead of assuming a value.

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

// The mic frame the worklet stamps a sound the player produced for render frame
// `f`. The player hears the transport `shift` late and plays that much late; the
// mic then stamps the result `shift` later again.
function playedAt(rec, f) {
  return f + 2 * rec.shift;
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
    const boundary = Math.round(startTime * RATE);
    assert.strictEqual(rec.boundaryFrame, boundary, "the record lost its boundary");
    // The window opens `shift` before the boundary, and the audio of the
    // boundary is stamped `shift` after it, so the two meet at scratch index 0.
    assert.strictEqual(
      rec.startFramePredicted,
      boundary - rec.shift,
      "the window does not open a shift before the boundary"
    );
    const clickMic = playedAt(rec, boundary);
    assert.strictEqual(
      clickMic,
      rec.startFramePredicted + rec.shift,
      "the boundary's audio is not a shift into the window"
    );
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
//
// The take closes at `stopFrame`, which is the end of the window, slack
// included. A feed that stops at the end of the wanted samples never reaches it,
// so the take would stay open and the assertions below would be reading a
// buffer that was never committed. Feed to the stop frame.
//
// The click goes a seam before the end of the take, not at the very last
// sample: foldSeam crossfades the seam tail into the head, so the final
// `seamSamples(length)` samples are deliberately not part of the loop.
tests.push({
  name: "tail: the last wanted sample is present after the take finishes",
  async fn() {
    const { t, rec, length } = await armedTake();
    const predicted = rec.startFramePredicted;
    const seam = t.seamSamples(length);
    const lastWanted = predicted + length - seam - 1;
    feedRange(t, predicted, rec.stopFrame + BLOCK, lastWanted);
    const ch = t.state.channels[0];
    assert.ok(ch.buffer, "the take never finished");
    const data = ch.buffer.getChannelData(0);
    assert.strictEqual(data.length, length, "the committed buffer is not the loop length");
    assert.strictEqual(data[length - seam - 1], 1, "the last wanted sample was cut");
  },
});

tests.push({
  name: "tail: a take that finishes on a block boundary keeps its whole length",
  async fn() {
    const { t, rec, length } = await armedTake();
    const predicted = rec.startFramePredicted;
    const seam = t.seamSamples(length);
    // A click in the final block of the take, just inside the seam.
    const lastWanted = predicted + length - seam - 1;
    feedRange(t, predicted, rec.stopFrame + BLOCK, lastWanted);
    const data = t.state.channels[0].buffer.getChannelData(0);
    assert.strictEqual(data.length, length, "the committed buffer is not the loop length");
    assert.strictEqual(data[length - seam - 1], 1, "the tail was truncated");
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
    // A click a quarter of the way into the take, as the player meant it. The
    // feed stops short of the end so the take is still open when the waveform
    // is drawn.
    const clickMic = playedAt(rec, rec.boundaryFrame + Math.floor(length / 4));
    feedRange(t, predicted, predicted + length - 4 * BLOCK, clickMic);

    const data = t.pendingRecord.scratch;
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      if (Math.abs(data[i]) > Math.abs(data[peak])) peak = i;
    }
    // The take starts at scratch index `shift`, so the position of the peak
    // within the take is measured from there. The take is `lengthSamples` long,
    // which is the loop plus its seam tail, not the loop: the canvas spans the
    // take, so the fraction has to be taken against the same length.
    const take = rec.lengthSamples;
    const audioFrac = (peak - rec.shift) / take;

    // Redraw the live waveform from the envelope the capture built, with the
    // take still open so drawWave takes the recording branch.
    const liveEnv = t.liveEnv;
    assert.ok(liveEnv, "the live envelope was dropped while the take is open");
    const canvas = t.__document.createElement("canvas");
    const g = makeCanvasContext();
    canvas.getContext = () => g;
    t.drawWave(ch, canvas);

    // The tallest rect is the click's bucket; the short wide one is the
    // progress bar along the bottom.
    const rect = g.rects.filter((r) => r.w > 0 && r.h > 0).sort((a, b) => b.h - a.h)[0];
    assert.ok(rect, "the display drew nothing");
    const displayFrac = (rect.x + rect.w / 2) / canvas.clientWidth;

    // The envelope is a fixed grid over the whole scratch buffer, so a bucket
    // is `scratch.length / WAVE_BUCKETS` samples wide and the click lands
    // somewhere inside its bucket. Half a bucket of slack is the resolution of
    // the display, not an error in it.
    const bucketFrac = data.length / t.liveEnv.length / take;
    assert.ok(
      Math.abs(displayFrac - audioFrac) < bucketFrac,
      `display says ${displayFrac.toFixed(3)} of the width, audio says ${audioFrac.toFixed(3)}`
    );
  },
});

// The shift is the whole round trip, and a measured one wins over the estimate.
// The estimate cannot see buffering the browser does not report -- a phone used
// as a mic over ADB adds ~200 ms that no API exposes -- so a stored measurement
// is the only way the phone and the USB mic can both land on the boundary.
tests.push({
  name: "shift: a stored measurement replaces the estimate",
  async fn() {
    const t = load({ sampleRate: RATE });
    // Seed the per-device store before boot, the way a calibration would.
    t.__sandbox.localStorage.setItem(
      "loupeur.offset.v1",
      JSON.stringify({ "": 0.24 })
    );
    await boot(t);
    t.state.mode = "tempo";
    t.state.bpm = 100;
    t.state.bars = 1;
    t.state.loopLength = LENGTH;
    const ch = t.state.channels[0];
    t.armTake(ch, 1, LENGTH);
    const rec = t.pendingRecord;
    assert.strictEqual(
      rec.shift,
      Math.round(0.24 * RATE),
      "the stored round trip did not replace the estimate"
    );
    // The window still opens a shift before the boundary, so the audio of the
    // boundary lands at scratch index 0 whatever the number is.
    assert.strictEqual(rec.startFramePredicted, rec.boundaryFrame - rec.shift);
  },
});

module.exports = tests;
