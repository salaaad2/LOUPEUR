"use strict";

// Projects. The file is a JSON manifest followed by one 16-bit WAV per track,
// wrapped in a small binary header. These tests cover the manifest, the binary
// round-trip, validation, and replacing a session from a decoded project.

const assert = require("assert");
const { load, boot } = require("./harness");

const RATE = 48000;

function makeBuffer(t, channels, frames) {
  const buffer = t.__ctx.createBuffer(channels, frames, RATE);
  for (let c = 0; c < channels; c++) {
    buffer.getChannelData(c).fill(0.1 * (c + 1));
  }
  return buffer;
}

function baseManifest(overrides = {}) {
  return {
    format: "loupeur-project",
    version: 1,
    savedAt: "2026-11-22T12:00:00.000Z",
    gui: {
      bpm: 100,
      bars: 1,
      mode: "free",
      clickOn: true,
      clickWhileRecording: false,
      reverbOn: false,
      master: 0.85,
      playMode: "loop",
      seqLoop: true,
      seqSteps: 4,
      selectedTrack: 1,
      ...(overrides.gui || {}),
    },
    loop: {
      frames: 115200,
      sampleRate: RATE,
      ...(overrides.loop || {}),
    },
    tracks: overrides.tracks || [
      { volume: 0.25, muted: true, layers: 2, audio: null },
      { volume: 1, muted: false, layers: 3, audio: null },
    ],
    sequencer: overrides.sequencer || {
      rows: [
        null,
        { steps: [true, false, true, false] },
      ],
    },
  };
}

// Builds the same container the app writes, for parser tests that need a
// deliberately broken manifest.
function projectBytes(manifest, payloadBytes = 0) {
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const out = new ArrayBuffer(16 + json.byteLength + payloadBytes);
  const view = new DataView(out);
  const magic = "LOUPEURP";
  for (let i = 0; i < magic.length; i++) view.setUint8(i, magic.charCodeAt(i));
  view.setUint32(8, 1, true);
  view.setUint32(12, json.byteLength, true);
  new Uint8Array(out).set(json, 16);
  return out;
}

const tests = [];

tests.push({
  name: "projects: the manifest captures the GUI, track settings and audio metadata",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    t.state.bpm = 132;
    t.state.bars = 2;
    t.state.mode = "free";
    t.state.clickOn = false;
    t.state.clickWhileRecording = true;
    t.state.reverbOn = true;
    t.state.master = 0.5;
    t.state.playMode = "sequence";
    t.state.seqLoop = false;
    t.state.seqSteps = 8;
    t.state.selected = 1;
    t.state.volumes[0] = 0.4;
    t.state.seqRows[0] = { steps: [true, false, true, false, true, false, true, false] };

    const ch = t.state.channels[0];
    ch.buffer = makeBuffer(t, 2, 48000);
    ch.state = "playing";
    ch.muted = true;
    ch.layers = 3;
    t.state.loopLength = 48000;

    const { manifest, payload } = t.projectManifest();
    const gui = manifest.gui;
    assert.strictEqual(manifest.format, "loupeur-project");
    assert.strictEqual(manifest.version, t.PROJECT_VERSION);
    assert.strictEqual(gui.bpm, 132);
    assert.strictEqual(gui.bars, 2);
    assert.strictEqual(gui.mode, "free");
    assert.strictEqual(gui.clickOn, false);
    assert.strictEqual(gui.clickWhileRecording, true);
    assert.strictEqual(gui.reverbOn, true);
    assert.strictEqual(gui.master, 0.5);
    assert.strictEqual(gui.playMode, "sequence");
    assert.strictEqual(gui.seqLoop, false);
    assert.strictEqual(gui.seqSteps, 8);
    assert.strictEqual(gui.selectedTrack, 1);
    assert.strictEqual(manifest.loop.frames, 48000);
    assert.strictEqual(manifest.loop.sampleRate, RATE);

    assert.strictEqual(manifest.tracks.length, t.DEFAULT_TRACK_COUNT);
    assert.strictEqual(manifest.tracks[0].volume, 0.4);
    assert.strictEqual(manifest.tracks[0].muted, true);
    assert.strictEqual(manifest.tracks[0].layers, 3);
    const audio = manifest.tracks[0].audio;
    assert.strictEqual(audio.offset, 0);
    assert.strictEqual(audio.length, 44 + 48000 * 2 * 2);
    assert.strictEqual(audio.encoding, "wav-pcm16");
    assert.strictEqual(audio.channels, 2);
    assert.strictEqual(audio.frames, 48000);
    assert.strictEqual(audio.sampleRate, RATE);
    assert.strictEqual(manifest.tracks[1].audio, null);

    assert.strictEqual(payload.length, 1);
    assert.strictEqual(payload[0].byteLength, audio.length);
    const head = String.fromCharCode(...new Uint8Array(payload[0], 0, 12));
    assert.strictEqual(head.slice(0, 4), "RIFF");
    assert.strictEqual(head.slice(8, 12), "WAVE");
    assert.deepStrictEqual(
      manifest.sequencer.rows[0].steps,
      [true, false, true, false, true, false, true, false]
    );
    assert.strictEqual(manifest.sequencer.rows[1], null);
  },
});

tests.push({
  name: "projects: the binary container round-trips its manifest and payload",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const ch = t.state.channels[0];
    ch.buffer = makeBuffer(t, 2, 48000);
    ch.state = "playing";
    ch.layers = 1;
    t.state.loopLength = 48000;

    const bytes = t.encodeProjectBytes();
    assert.strictEqual(Object.prototype.toString.call(bytes), "[object ArrayBuffer]");
    assert.strictEqual(
      String.fromCharCode(...new Uint8Array(bytes, 0, 8)),
      t.PROJECT_MAGIC
    );
    const view = new DataView(bytes);
    assert.strictEqual(view.getUint32(8, true), t.PROJECT_VERSION);

    const project = t.readProject(bytes);
    assert.strictEqual(project.manifest.tracks.length, t.DEFAULT_TRACK_COUNT);
    assert.strictEqual(project.manifest.tracks[0].audio.frames, 48000);
    assert.strictEqual(project.payloadLength, 44 + 48000 * 2 * 2);
    assert.strictEqual(project.manifest.loop.frames, 48000);
  },
});

tests.push({
  name: "projects: applying a project replaces the session and restores the GUI",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const buffer = makeBuffer(t, 1, 96000);
    const decoded = [null, buffer];
    const manifest = baseManifest({ gui: { mode: "free" } });

    const result = t.applyProject(manifest, decoded);
    assert.strictEqual(result.modeAdjusted, false);
    assert.strictEqual(t.state.trackCount, 2);
    assert.strictEqual(t.state.channels.length, 2);
    assert.strictEqual(t.state.channels[0].state, "empty");
    assert.strictEqual(t.state.channels[0].layers, 0);
    assert.strictEqual(t.state.channels[0].buffer, null);
    assert.strictEqual(t.state.channels[1].buffer, buffer);
    assert.strictEqual(t.state.channels[1].state, "playing");
    assert.strictEqual(t.state.channels[1].layers, 3);
    assert.strictEqual(t.state.volumes[0], 0.25);
    assert.strictEqual(t.state.volumes[1], 1);
    assert.ok(t.state.seqRows[1]);
    assert.strictEqual(t.state.seqRows[1].steps[0], true);
    assert.strictEqual(t.state.seqRows[0], null);
    assert.strictEqual(t.state.bpm, 100);
    assert.strictEqual(t.state.bars, 1);
    assert.strictEqual(t.state.mode, "free");
    assert.strictEqual(t.state.clickOn, true);
    assert.strictEqual(t.state.clickWhileRecording, false);
    assert.strictEqual(t.state.reverbOn, false);
    assert.strictEqual(t.state.master, 0.85);
    assert.strictEqual(t.state.playMode, "loop");
    assert.strictEqual(t.state.seqLoop, true);
    assert.strictEqual(t.state.seqSteps, 4);
    assert.strictEqual(t.state.selected, 1);
    assert.strictEqual(t.state.loopLength, 96000);
    assert.strictEqual(t.state.freshLoop, true);
    assert.strictEqual(t.state.transport, "stopped");
    assert.strictEqual(t.state.t0, 0);
  },
});

tests.push({
  name: "projects: a Tempo Lock project whose grid no longer matches loads in Free mode",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const manifest = baseManifest({ gui: { mode: "tempo", bpm: 100, bars: 1 } });
    // 2 s at 48 kHz, while 1 bar at 100 BPM is 2.4 s (115200 samples).
    const decoded = [null, makeBuffer(t, 1, 96000)];

    const result = t.applyProject(manifest, decoded);
    assert.strictEqual(result.modeAdjusted, true);
    assert.strictEqual(t.state.mode, "free");
    assert.strictEqual(t.state.loopLength, 96000);
  },
});

tests.push({
  name: "projects: a Tempo Lock project that still matches keeps Tempo Lock",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const manifest = baseManifest({ gui: { mode: "tempo", bpm: 100, bars: 1 } });
    const decoded = [null, makeBuffer(t, 1, 115200)];

    const result = t.applyProject(manifest, decoded);
    assert.strictEqual(result.modeAdjusted, false);
    assert.strictEqual(t.state.mode, "tempo");
    assert.strictEqual(t.state.loopLength, 115200);
  },
});

tests.push({
  name: "projects: malformed containers are rejected before anything is applied",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const valid = t.encodeProjectBytes();

    assert.throws(() => t.readProject(new ArrayBuffer(0)), /not a Loupeur project/i);

    const wrongMagic = valid.slice(0);
    new Uint8Array(wrongMagic)[0] = 0;
    assert.throws(() => t.readProject(wrongMagic), /not a Loupeur project/i);

    const newer = valid.slice(0);
    new DataView(newer).setUint32(8, t.PROJECT_VERSION + 1, true);
    assert.throws(() => t.readProject(newer), /newer version/i);

    const truncated = valid.slice(0, 12);
    assert.throws(() => t.readProject(truncated), /not a Loupeur project/i);

    const noGui = baseManifest();
    delete noGui.gui;
    assert.throws(() => t.readProject(projectBytes(noGui)), /GUI state/i);

    const noTracks = baseManifest({ tracks: [] });
    assert.throws(() => t.readProject(projectBytes(noTracks)), /track count/i);

    const badAudio = baseManifest();
    badAudio.tracks[0].audio = {
      offset: 0,
      length: 44,
      encoding: "wav-pcm16",
      channels: 1,
      frames: 1,
      sampleRate: RATE,
    };
    assert.throws(() => t.readProject(projectBytes(badAudio)), /truncated/i);

    const badEncoding = baseManifest();
    badEncoding.tracks[0].audio = {
      offset: 0,
      length: 44,
      encoding: "flac",
      channels: 1,
      frames: 1,
      sampleRate: RATE,
    };
    assert.throws(
      () => t.readProject(projectBytes(badEncoding, 44)),
      /unsupported audio encoding/i
    );
  },
});

tests.push({
  name: "projects: only .loupeur filenames are accepted",
  async fn() {
    const t = load({ sampleRate: RATE });
    assert.strictEqual(t.isProjectFilename("session.loupeur"), true);
    assert.strictEqual(t.isProjectFilename("SESSION.LOUPEUR"), true);
    assert.strictEqual(t.isProjectFilename("session.zip"), false);
    assert.strictEqual(t.isProjectFilename("session.loupeur.zip"), false);
    assert.strictEqual(t.isProjectFilename(""), false);
  },
});

module.exports = tests;
