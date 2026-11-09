"use strict";

// The track count. Tracks are positions in three parallel arrays: the audio
// channels, the volume levels and the sequencer rows. Adding appends; removing
// an empty track splices all three and rewrites every channel's index, because
// the gate, the level and the stem name are all looked up by that index.

const assert = require("assert");
const { load, boot } = require("./harness");

const RATE = 48000;
const LENGTH = 48000;   // 1 s, enough for a buffer that holds audio

const tests = [];

tests.push({
  name: "tracks: adding a track grows the state and the audio graph",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    assert.strictEqual(t.state.trackCount, t.DEFAULT_TRACK_COUNT);
    assert.strictEqual(t.state.channels.length, t.DEFAULT_TRACK_COUNT);

    t.addTrack();
    assert.strictEqual(t.state.trackCount, t.DEFAULT_TRACK_COUNT + 1);
    assert.strictEqual(t.state.channels.length, t.DEFAULT_TRACK_COUNT + 1);
    assert.strictEqual(t.state.volumes.length, t.DEFAULT_TRACK_COUNT + 1);
    assert.strictEqual(t.state.seqRows.length, t.DEFAULT_TRACK_COUNT + 1);
    assert.strictEqual(t.state.channels[t.DEFAULT_TRACK_COUNT].index, t.DEFAULT_TRACK_COUNT);
    assert.strictEqual(t.state.selected, t.DEFAULT_TRACK_COUNT);
  },
});

tests.push({
  name: "tracks: adding stops at the maximum",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    while (t.state.trackCount < t.MAX_TRACKS) t.addTrack();
    assert.strictEqual(t.state.trackCount, t.MAX_TRACKS);
    assert.strictEqual(t.state.channels.length, t.MAX_TRACKS);

    t.addTrack();
    assert.strictEqual(t.state.trackCount, t.MAX_TRACKS);
    assert.strictEqual(t.state.channels.length, t.MAX_TRACKS);
  },
});

tests.push({
  name: "tracks: a track added before the graph exists is created on boot",
  async fn() {
    const t = load({ sampleRate: RATE });
    t.addTrack();
    assert.strictEqual(t.state.trackCount, t.DEFAULT_TRACK_COUNT + 1);
    assert.strictEqual(t.state.channels.length, 0);

    await boot(t);
    assert.strictEqual(t.state.channels.length, t.state.trackCount);
    assert.strictEqual(t.state.channels[t.DEFAULT_TRACK_COUNT].index, t.DEFAULT_TRACK_COUNT);
  },
});

tests.push({
  name: "tracks: removing an empty track reindexes rows and levels",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const ch2 = t.state.channels[2];
    ch2.buffer = t.__ctx.createBuffer(1, LENGTH, RATE);
    ch2.state = "playing";
    t.toggleSeqRow(2);
    t.toggleSeqStep(2, 1);
    t.setVolume(2, 0.4);

    t.removeTrack(0);
    assert.strictEqual(t.state.trackCount, 3);
    assert.strictEqual(t.state.channels.length, 3);
    assert.strictEqual(t.state.channels[1], ch2);
    assert.strictEqual(ch2.index, 1);
    assert.strictEqual(t.state.volumes[1], 0.4);
    assert.ok(t.state.seqRows[1], "the row did not move with the track");
    assert.strictEqual(t.state.seqRows[1].steps[1], true);
    assert.strictEqual(t.state.seqRows[0], null);
    assert.strictEqual(t.state.seqRows.length, 3);
  },
});

tests.push({
  name: "tracks: a track with audio cannot be removed",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const ch = t.state.channels[0];
    ch.buffer = t.__ctx.createBuffer(1, LENGTH, RATE);
    ch.state = "playing";

    t.removeTrack(0);
    assert.strictEqual(t.state.trackCount, t.DEFAULT_TRACK_COUNT);
    assert.strictEqual(t.state.channels[0], ch);
  },
});

tests.push({
  name: "tracks: the last track cannot be removed",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    while (t.state.trackCount > 1) t.removeTrack(t.state.trackCount - 1);
    assert.strictEqual(t.state.trackCount, 1);
    assert.strictEqual(t.state.channels.length, 1);

    t.removeTrack(0);
    assert.strictEqual(t.state.trackCount, 1);
    assert.strictEqual(t.state.channels.length, 1);
  },
});

module.exports = tests;
