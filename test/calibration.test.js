"use strict";

// The calibration and the manual offset. These are the two things that make the
// shift a measured number instead of a guess, so the tests here are about the
// measurement being read back correctly and about the correction actually
// reaching the capture window.
//
// The model. A burst is scheduled at render frame `burstFrame`. It is heard
// `outputLatency` later, travels through the air, and is stamped by the worklet
// `inputLatency` after it was captured, so the burst sits at
// `burstFrame + roundTrip`. The calibration reports that distance, and the take
// path then puts the audio of the boundary at scratch index 0.

const assert = require("assert");
const { load, boot } = require("./harness");

const RATE = 48000;
const BLOCK = 128;
const LENGTH = 4800;

// The mic frames the five bursts land at, given the window the calibration
// opened and the round trip the device has.
function burstFrames(t, rec, roundTrip) {
  const margin = Math.round(t.CAL_MARGIN * RATE);
  const out = [];
  for (let i = 0; i < t.CAL_BURSTS; i++) {
    out.push(rec.startFrame + margin + Math.round(i * t.CAL_SPACING * RATE) + roundTrip);
  }
  return out;
}

// Feeds a calibration window the way the worklet would: blocks of silence with
// a burst at each of `at`. The burst is as long as the real one, so the energy
// window is shorter than it and the peak is its onset.
function feedAt(t, rec, at) {
  const len = Math.round(t.CAL_BURST * RATE);
  for (let frame = rec.startFrame; frame < rec.endFrame; frame += BLOCK) {
    const data = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      const f = frame + i;
      for (const b of at) {
        if (f >= b && f < b + len) data[i] = 0.5;
      }
    }
    t.onCalibrationFrame(frame, data);
  }
}

function feedBursts(t, rec, roundTrip) {
  feedAt(t, rec, burstFrames(t, rec, roundTrip));
}

const tests = [];

// The measurement is the distance between the scheduled burst and where it was
// heard. A round trip of 240 ms -- the phone over ADB -- has to come back as
// 240 ms, not as the 49 ms the estimate would have guessed.
tests.push({
  name: "calibration: the measured round trip is the burst's distance from its schedule",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const roundTrip = Math.round(0.24 * RATE);

    const pending = t.measureRoundTrip();
    const rec = t.calibration.rec;
    assert.ok(rec, "the calibration window did not open");
    // Each burst is heard `roundTrip` after it was scheduled.
    feedBursts(t, rec, roundTrip);
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
    const pending = t.measureRoundTrip();
    const rec = t.calibration.rec;
    assert.ok(rec, "the calibration window did not open");
    for (let frame = rec.startFrame; frame < rec.endFrame; frame += BLOCK) {
      t.onCalibrationFrame(frame, new Float32Array(BLOCK));
    }
    const heard = await pending;
    assert.strictEqual(heard, null, "silence was measured as an offset");
  },
});

// One burst that caught a room noise is dropped by the robust estimate: the
// median of the five is the round trip, and a value far from it does not move
// the result.
tests.push({
  name: "calibration: one bad burst does not move the measurement",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const roundTrip = Math.round(0.24 * RATE);
    const pending = t.measureRoundTrip();
    const rec = t.calibration.rec;
    assert.ok(rec, "the calibration window did not open");
    // Four bursts on time, one 100 ms late.
    const at = burstFrames(t, rec, roundTrip);
    at[2] += Math.round(0.1 * RATE);
    feedAt(t, rec, at);
    const heard = await pending;
    assert.strictEqual(heard, roundTrip, "one bad burst moved the measurement");
  },
});

// There is one offset per device, and it is the number the slider shows. A
// calibration writes it, the slider writes it, and captureShift() reads it. A
// second hidden measurement the slider was added to meant the user could not
// tell what was in force, and a calibration that left the slider at 0 looked
// like it had done nothing.
tests.push({
  name: "offset: calibration and the slider write the same number",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    // Before anything is stored, the offset is the reported-buffer estimate.
    assert.ok(
      Math.abs(t.captureShift() - (t.inputLatency + t.outputLatency)) < 1e-9,
      "the uncalibrated offset is not the estimate: " + t.captureShift()
    );
    assert.strictEqual(t.offsetIsMeasured(""), false, "the estimate reported as measured");

    // What calibration writes.
    t.storeDeviceOffset("", 0.2);
    assert.ok(Math.abs(t.captureShift() - 0.2) < 1e-9, "the measurement did not take effect");
    assert.strictEqual(t.offsetIsMeasured(""), true, "a measurement did not report as measured");

    // What the slider writes: the same store, so it replaces the measurement
    // rather than being added to it.
    t.storeDeviceOffset("", 0.23);
    assert.ok(Math.abs(t.captureShift() - 0.23) < 1e-9, "the slider value did not take effect");

    // A negative offset is a real correction: a take that lands early is as
    // wrong as one that lands late.
    t.storeDeviceOffset("", -0.05);
    assert.strictEqual(t.captureShift(), 0, "a negative offset was not clamped at zero");
  },
});

// The offset is per device. A value dialled in for the phone must not follow
// the USB mic.
tests.push({
  name: "offset: it is stored per device",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    t.storeDeviceOffset("phone", 0.1);
    t.storeDeviceOffset("usb", 0.02);
    assert.strictEqual(t.offsetFor("phone"), 0.1);
    assert.strictEqual(t.offsetFor("usb"), 0.02);
    assert.strictEqual(
      t.offsetIsMeasured(""),
      false,
      "an unset device inherited another's offset"
    );
  },
});

// The slider must show the number in force, not a separate manual value. This
// is the bug the user hit: calibrate ran, stored a measurement, and the slider
// still read 0, so there was no way to tell whether anything had happened.
tests.push({
  name: "offset: the slider shows the number in force after a calibration",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    t.storeDeviceOffset("", 0.24);
    t.render();
    const slider = t.__document.getElementById("offset");
    const out = t.__document.getElementById("offsetOut");
    assert.strictEqual(Number(slider.value), 240, "the slider did not show the measured offset");
    assert.strictEqual(out.textContent, "+240", "the readout did not show the measured offset");
  },
});

// The correction has to reach the window, and it has to move it the right way.
// The mic stamps a sound `shift` after the render frame it belongs at, so the
// window opens `shift` after the boundary and the audio of the boundary is the
// first sample of the take. Opening it `shift` before the boundary instead put
// the take `2 * shift` late, which is why a calibrated offset had no audible
// effect.
tests.push({
  name: "manual offset: it moves the capture window, so the boundary's audio is captured",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    t.state.mode = "tempo";
    t.state.bpm = 100;
    t.state.bars = 1;
    t.state.loopLength = LENGTH;
    t.storeDeviceOffset("", 0.1);
    const ch = t.state.channels[0];
    t.armTake(ch, 1, LENGTH);
    const rec = t.pendingRecord;
    const boundary = Math.round(1 * RATE);
    assert.strictEqual(
      rec.startFramePredicted,
      boundary + Math.round(0.1 * RATE),
      "the manual offset did not move the window"
    );
    // The click is the audio of the boundary, stamped where the mic hears it.
    const clickMic = boundary + rec.shift;
    for (let frame = rec.startFramePredicted; frame < rec.stopFrame; frame += BLOCK) {
      const data = new Float32Array(BLOCK);
      if (clickMic >= frame && clickMic < frame + BLOCK) data[clickMic - frame] = 1;
      t.onCaptureFrame({ data: { frame, data } });
    }
    assert.strictEqual(t.pendingRecord, null, "the take never closed");
    // The window opens `shift` after the boundary, so the boundary's audio is
    // the first sample of the take.
    assert.strictEqual(
      rec.scratch[0],
      1,
      "the boundary's audio was not captured at the head of the take"
    );
    assert.strictEqual(t.takeOffset(rec), 0, "the take did not report as on the boundary");
  },
});

// The sync check measures the round trip and compares it to the offset in
// force. A positive residual means the offset is short, and the check corrects
// it itself rather than telling the user to do the arithmetic.
tests.push({
  name: "sync check: a short offset is reported and corrected",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    // The offset in force is 200 ms; the device actually has 240 ms.
    t.storeDeviceOffset("", 0.2);
    const roundTrip = Math.round(0.24 * RATE);

    const pending = t.syncCheck();
    for (let i = 0; i < 50 && !(t.calibration && t.calibration.rec); i++) {
      await Promise.resolve();
    }
    const rec = t.calibration && t.calibration.rec;
    assert.ok(rec, "the sync check did not open a window");
    feedBursts(t, rec, roundTrip);
    await pending;

    // The banner is the report; the console line carries the number. Read the
    // banner, which is what the user sees.
    const banner = t.__document.getElementById("banner");
    assert.ok(
      /short by 40/.test(banner.textContent),
      "the sync check did not report the residual: " + banner.textContent
    );
    assert.ok(
      Math.abs(t.offsetFor("") - 0.24) < 1e-9,
      "the sync check did not correct the offset: " + t.offsetFor("")
    );
  },
});

module.exports = tests;
