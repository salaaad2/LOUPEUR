"use strict";

// Importing a WAV. The file is the first material in the app: its exact
// duration becomes the loop, the app moves to Free Mode so the BPM grid cannot
// trim or pad it, and an import is refused once any track holds audio. The
// tests use a decoded AudioBuffer directly, so they do not need a real file or
// an AudioContext decoder.

const assert = require("assert");
const { load, boot } = require("./harness");

const RATE = 48000;

// The shape decodeAudioData returns, built without the Web Audio API.
function makeDecoded(seconds, channelCount = 2) {
  const length = Math.round(seconds * RATE);
  const data = [];
  for (let c = 0; c < channelCount; c++) {
    const samples = new Float32Array(length);
    samples.fill(0.1 * (c + 1));
    data.push(samples);
  }
  return {
    numberOfChannels: channelCount,
    length,
    sampleRate: RATE,
    duration: length / RATE,
    getChannelData: (c) => data[c],
  };
}

const tests = [];

tests.push({
  name: "import: the file's exact duration becomes the loop and the app enters Free Mode",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const decoded = makeDecoded(4.8);   // 2 bars at 100 BPM, but not used as a grid

    assert.strictEqual(t.canImport(), true);
    assert.strictEqual(t.importDecodedBuffer(decoded, 100), true);

    assert.strictEqual(t.state.mode, "free");
    assert.strictEqual(t.state.bpm, 100);
    assert.strictEqual(t.state.loopLength, decoded.length);
    assert.strictEqual(t.loopSamples(), decoded.length);

    const ch = t.state.channels[0];
    assert.strictEqual(ch.state, "playing");
    assert.strictEqual(ch.layers, 1);
    assert.strictEqual(ch.buffer.length, decoded.length);
    assert.strictEqual(ch.buffer.numberOfChannels, 2);
    assert.strictEqual(ch.buffer.getChannelData(0)[123], decoded.getChannelData(0)[123]);
    assert.strictEqual(ch.buffer.getChannelData(1)[123], decoded.getChannelData(1)[123]);

    assert.strictEqual(t.canImport(), false);
  },
});

tests.push({
  name: "import: the first Space starts the file at once instead of waiting for a stale boundary",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    t.importDecodedBuffer(makeDecoded(2), 100);
    t.__ctx.__clock.now = 10;
    assert.strictEqual(t.state.freshLoop, true);

    t.toggleTransport();
    assert.strictEqual(t.state.transport, "running");
    assert.strictEqual(t.state.t0, 10.05);
    assert.strictEqual(t.state.freshLoop, false);
    assert.ok(t.state.channels[0].source);
  },
});

tests.push({
  name: "import: changing BPM later does not change the imported loop length",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const decoded = makeDecoded(3.7);
    t.importDecodedBuffer(decoded, 100);
    t.state.bpm = 133;

    assert.strictEqual(t.state.loopLength, decoded.length);
    assert.strictEqual(t.loopSamples(), decoded.length);
  },
});

tests.push({
  name: "import: the selected empty track receives the file",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    t.state.selected = 2;
    const decoded = makeDecoded(2);

    assert.strictEqual(t.importDecodedBuffer(decoded, 120), true);
    assert.strictEqual(t.state.selected, 2);
    assert.strictEqual(t.state.channels[0].buffer, null);
    assert.strictEqual(t.state.channels[1].buffer, null);
    assert.ok(t.state.channels[2].buffer);
  },
});

tests.push({
  name: "import: a mono WAV stays mono",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const decoded = makeDecoded(2, 1);

    assert.strictEqual(t.importDecodedBuffer(decoded, 100), true);
    assert.strictEqual(t.state.channels[0].buffer.numberOfChannels, 1);
  },
});

tests.push({
  name: "import: refused once any track holds audio",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    t.state.selected = 1;
    const ch = t.state.channels[0];
    ch.buffer = t.__ctx.createBuffer(1, 1000, RATE);
    ch.state = "playing";
    const decoded = makeDecoded(2);

    assert.strictEqual(t.canImport(), false);
    assert.strictEqual(t.importDecodedBuffer(decoded, 100), false);
    assert.strictEqual(t.state.loopLength, 0);
    assert.strictEqual(t.state.channels[1].buffer, null);
  },
});

tests.push({
  name: "import: a live take blocks the import",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    t.pendingRecord = { channel: t.state.channels[0] };
    assert.strictEqual(t.canImport(), false);

    t.pendingRecord = null;
    assert.strictEqual(t.canImport(), true);
  },
});

tests.push({
  name: "import: BPM must stay inside the app's 60-180 range",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const decoded = makeDecoded(2);

    assert.strictEqual(t.importDecodedBuffer(decoded, 59), false);
    assert.strictEqual(t.importDecodedBuffer(decoded, 181), false);
    assert.strictEqual(t.state.loopLength, 0);
    assert.strictEqual(t.state.channels[0].buffer, null);
  },
});

tests.push({
  name: "import: too short and too long files are refused before they are copied",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);

    assert.strictEqual(t.importDecodedBuffer(makeDecoded(0.25), 100), false);
    const tooLong = {
      numberOfChannels: 1,
      length: (8 * 60 + 1) * RATE,
      sampleRate: RATE,
      duration: 8 * 60 + 1,
      getChannelData() {
        throw new Error("the file was copied before its length was checked");
      },
    };
    assert.strictEqual(t.importDecodedBuffer(tooLong, 100), false);
    assert.strictEqual(t.state.loopLength, 0);
  },
});

tests.push({
  name: "import: clearing the imported track makes import available again",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    t.importDecodedBuffer(makeDecoded(2), 100);
    assert.strictEqual(t.canImport(), false);

    t.clearChannel(t.state.channels[0]);
    assert.strictEqual(t.state.loopLength, 0);
    assert.strictEqual(t.canImport(), true);
  },
});

tests.push({
  name: "import: an overdub keeps a stereo file stereo and adds the layer to both channels",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const decoded = makeDecoded(2);
    t.importDecodedBuffer(decoded, 100);
    const ch = t.state.channels[0];
    const left = ch.buffer.getChannelData(0)[0];
    const right = ch.buffer.getChannelData(1)[0];

    const scratch = new Float32Array(ch.buffer.length);
    scratch[0] = 0.5;
    t.commitOverdub(ch, scratch, scratch.length);

    assert.strictEqual(ch.buffer.numberOfChannels, 2);
    assert.ok(Math.abs(ch.buffer.getChannelData(0)[0] - (left + 0.5)) < 1e-6);
    assert.ok(Math.abs(ch.buffer.getChannelData(1)[0] - (right + 0.5)) < 1e-6);
    assert.strictEqual(ch.layers, 2);
  },
});

tests.push({
  name: "import: only .wav filenames are accepted",
  async fn() {
    const t = load({ sampleRate: RATE });
    assert.strictEqual(t.isWavFilename("beat.wav"), true);
    assert.strictEqual(t.isWavFilename("beat.WAV"), true);
    assert.strictEqual(t.isWavFilename("beat.wav.mp3"), false);
    assert.strictEqual(t.isWavFilename("beat.mp3"), false);
    assert.strictEqual(t.isWavFilename(""), false);
  },
});

module.exports = tests;
