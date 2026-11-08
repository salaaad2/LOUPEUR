"use strict";

// The calibration and the manual offset. These are the two things that make the
// shift a measured number instead of a guess, so the tests here are about the
// measurement being read back correctly and about the correction actually
// reaching the capture window.
//
// The model. The click is scheduled at render frame `clickFrame`. It is heard
// `outputLatency` later, travels through the air, and is stamped by the worklet
// `inputLatency` after it was captured, so the peak of the recorded click sits
// at `clickFrame + roundTrip`. The calibration reports that distance, and the
// take path then puts the audio of the boundary at scratch index 0.

const assert = require("assert");
const { load, boot } = require("./harness");

const RATE = 48000;
const BLOCK = 128;
const LENGTH = 4800;

// Feeds a calibration window the way the worklet would: blocks of silence with
// the click at `clickAt`, from `from` to `to`.
function feedCalibration(t, from, to, clickAt) {
  for (let frame = from; frame < to; frame += BLOCK) {
    const data = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      const f = frame + i;
      if (f >= clickAt && f < clickAt + 8) data[i] = 0.5;
    }
    t.onCalibrationFrame(frame, data);
  }
}

const tests = [];

// The measurement is the distance between the scheduled click and the peak of
// the recorded one. A round trip of 240 ms -- the phone over ADB -- has to come
// back as 240 ms, not as the 49 ms the estimate would have guessed.
tests.push({
  name: "calibration: the measured round trip is the click's distance from its schedule",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const roundTrip = Math.round(0.24 * RATE);
    const clickFrame = 100000;
    const frames = Math.round(1.5 * RATE);

    const pending = t.measureRoundTrip(0, clickFrame, frames);
    // The click is heard `roundTrip` after it was scheduled.
    feedCalibration(t, clickFrame, clickFrame + frames, clickFrame + roundTrip);
    const heard = await pending;

    assert.strictEqual(heard, roundTrip, "the calibration did not measure the round trip");
  },
});

// A window with nothing in it is a failed measurement, not a zero offset. A
// silent room must not be stored as "this device has no latency".
tests.push({
  name: "calibration: silence is reported as no measurement, not as zero",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const frames = Math.round(1.5 * RATE);
    const pending = t.measureRoundTrip(0, 50000, frames);
    feedCalibration(t, 50000, 50000 + frames, -1);
    const heard = await pending;
    assert.strictEqual(heard, null, "silence was measured as an offset");
  },
});

// The first crossing, not the global peak: a room noise after the click can be
// louder than the click, and the click is the first thing in the window.
tests.push({
  name: "calibration: a louder noise after the click does not move the measurement",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const frames = Math.round(1.5 * RATE);
    const clickFrame = 50000;
    const roundTrip = Math.round(0.05 * RATE);
    const pending = t.measureRoundTrip(0, clickFrame, frames);
    const rec = t.calibration.rec;
    assert.ok(rec, "the calibration window did not open");
    // The click, then a louder burst later in the same window.
    feedCalibration(t, clickFrame, clickFrame + frames, clickFrame + roundTrip);
    const at = roundTrip + 2000;
    for (let i = 0; i < 8; i++) rec.scratch[at + i] = 0.9;
    const heard = await pending;
    assert.strictEqual(heard, roundTrip, "the measurement followed the loudest peak");
  },
});

// The manual offset is added on top of the measurement, and it may be negative:
// a take that lands early is as wrong as one that lands late.
tests.push({
  name: "manual offset: it is added to the measured round trip",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    t.storeDeviceOffset("", 0.2);
    t.storeManualOffset("", 0.03);
    assert.ok(
      Math.abs(t.captureShift() - 0.23) < 1e-9,
      "the manual offset was not added: " + t.captureShift()
    );
    t.storeManualOffset("", -0.05);
    assert.ok(
      Math.abs(t.captureShift() - 0.15) < 1e-9,
      "a negative manual offset was not applied: " + t.captureShift()
    );
  },
});

// The manual offset is per device, like the measurement. A value dialled in for
// the phone must not follow the USB mic.
tests.push({
  name: "manual offset: it is stored per device",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    t.storeManualOffset("phone", 0.1);
    t.storeManualOffset("usb", -0.02);
    assert.strictEqual(t.manualOffsetFor("phone"), 0.1);
    assert.strictEqual(t.manualOffsetFor("usb"), -0.02);
    assert.strictEqual(t.manualOffsetFor(""), 0, "an unset device inherited another's offset");
  },
});

// The correction has to reach the window. A manual offset of +100 ms must move
// the window 100 ms earlier, so the audio of the boundary is captured at the
// head of the take instead of 100 ms into it.
//
// The window opens `shift` before the boundary, so the audio stamped at the
// boundary lands at scratch index `shift`, not at index 0. That is the whole
// point of the shift: the take is read from index 0 of the folded buffer, and
// `takeOffset` subtracts `shift` to report where the boundary's audio actually
// sits. A click placed at `boundary + shift` would be past `stopFrame` and
// could never be captured, so the click goes at the boundary itself.
tests.push({
  name: "manual offset: it moves the capture window, so the boundary's audio is captured",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    t.state.mode = "tempo";
    t.state.bpm = 100;
    t.state.bars = 1;
    t.state.loopLength = LENGTH;
    t.storeManualOffset("", 0.1);
    const ch = t.state.channels[0];
    t.armTake(ch, 1, LENGTH);
    const rec = t.pendingRecord;
    const boundary = Math.round(1 * RATE);
    assert.strictEqual(
      rec.startFramePredicted,
      boundary - Math.round(0.1 * RATE),
      "the manual offset did not move the window"
    );
    // The click is the audio of the boundary, stamped where the mic hears it.
    const clickMic = boundary;
    for (let frame = rec.startFramePredicted; frame < rec.stopFrame; frame += BLOCK) {
      const data = new Float32Array(BLOCK);
      if (clickMic >= frame && clickMic < frame + BLOCK) data[clickMic - frame] = 1;
      t.onCaptureFrame({ data: { frame, data } });
    }
    assert.strictEqual(t.pendingRecord, null, "the take never closed");
    // The boundary's audio sits `shift` into the window, which is where the
    // take begins once the shift is accounted for.
    assert.strictEqual(
      rec.scratch[rec.shift],
      1,
      "the boundary's audio was not captured at the head of the take"
    );
    assert.strictEqual(t.takeOffset(rec), 0, "the take did not report as on the boundary");
  },
});

// The sync check reports where the click landed relative to the boundary. This
// is the number the user reads to decide whether to touch the manual offset.
tests.push({
  name: "sync check: a late take is reported as late by the amount it is late",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const frames = Math.round(1.5 * RATE);
    const lead = Math.round(0.15 * RATE);
    const late = Math.round(0.04 * RATE);

    const pending = t.syncCheck();
    // syncCheck opens the mic before it opens its window, and the harness's
    // getUserMedia is async, so the window appears a few microtask turns later.
    for (let i = 0; i < 50 && !(t.calibration && t.calibration.rec); i++) {
      await Promise.resolve();
    }
    const rec = t.calibration && t.calibration.rec;
    assert.ok(rec, "the sync check did not open a window");
    // The click is heard `lead + late` after the window opened.
    feedCalibration(t, rec.startFrame, rec.startFrame + frames, rec.startFrame + lead + late);
    await pending;

    // The banner is the report; the console line carries the number. Read the
    // banner, which is what the user sees.
    const banner = t.__document.getElementById("banner");
    assert.ok(
      /late by 40 ms/.test(banner.textContent),
      "the sync check did not report the offset: " + banner.textContent
    );
  },
});

module.exports = tests;
