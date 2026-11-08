"use strict";

// The per-track level. The channel gain is the product of the mute latch and
// the volume slider, and both write it through one place, so the tests here are
// about the two agreeing: a volume move must not undo a mute that is waiting
// for its boundary, and a cleared track must come back at its own level rather
// than at full scale.

const assert = require("assert");
const { load, boot } = require("./harness");

const RATE = 48000;
const LENGTH = 48000;   // 1 s, so a boundary is easy to read

// The last automation call of `type` on a param.
function last(param, type) {
  const calls = param.calls.filter((c) => c.type === type);
  return calls[calls.length - 1];
}

const tests = [];

tests.push({
  name: "level: the channel gain is the volume, and mute overrides it",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const ch = t.state.channels[0];

    t.setVolume(0, 0.4);
    assert.strictEqual(last(ch.gain.gain, "ramp").value, 0.4);

    t.toggleMute(ch);
    assert.strictEqual(last(ch.gain.gain, "ramp").value, 0);

    // Unmuting restores the level the slider holds, not full scale.
    t.toggleMute(ch);
    assert.strictEqual(last(ch.gain.gain, "ramp").value, 0.4);
  },
});

tests.push({
  name: "level: a volume move during a pending mute lands on the mute's boundary",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    t.state.mode = "free";
    t.state.loopLength = LENGTH;
    t.startTransport(0);
    t.__ctx.__clock.now = 0.25;

    const ch = t.state.channels[0];
    t.toggleMute(ch);
    const muteRamp = last(ch.gain.gain, "ramp");
    assert.ok(muteRamp.time > 0.25, "the mute did not wait for a boundary");

    // The slider is dragged while the mute is still waiting. Cancelling the
    // mute and ramping now would drop the track in the middle of the loop.
    t.setVolume(0, 0.4);
    const volRamp = last(ch.gain.gain, "ramp");
    assert.strictEqual(volRamp.time, muteRamp.time, "the volume move cancelled the pending mute");
    assert.strictEqual(volRamp.value, 0, "the track unmuted before its boundary");
  },
});

tests.push({
  name: "level: clearing a track restores its own level, not full scale",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const ch = t.state.channels[0];

    t.setVolume(0, 0.4);
    t.clearChannel(ch);
    assert.strictEqual(last(ch.gain.gain, "set").value, 0.4);
  },
});

tests.push({
  name: "level: a level set before the audio graph exists is kept",
  async fn() {
    const t = load({ sampleRate: RATE });
    // No boot(): the channels do not exist yet, exactly as before the first
    // record press. The slider still has to hold the number it shows.
    t.setVolume(2, 0.3);
    assert.strictEqual(t.state.volumes[2], 0.3);

    await boot(t);
    assert.strictEqual(t.channelTarget(t.state.channels[2]), 0.3);
  },
});

module.exports = tests;
