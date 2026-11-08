"use strict";

// The stem export. The audio path is the mix export's, so what is worth testing
// here is the selection and the naming: one file per track that holds audio,
// numbered by track so an empty track leaves a gap instead of renumbering the
// ones after it.

const assert = require("assert");
const { load, boot } = require("./harness");

const RATE = 48000;
const LENGTH = 4800;

// The selection rule only asks whether a buffer exists; the length is read
// later, by renderChannels.
function fakeBuffer() {
  return { length: LENGTH };
}

const tests = [];

tests.push({
  name: "stems: one file per track that holds audio, numbered by track",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const ch = t.state.channels;
    ch[0].buffer = fakeBuffer();
    ch[2].buffer = fakeBuffer();

    const files = t.stemFiles(ch);
    assert.strictEqual(files.map((f) => f.name).join(","), "track1.wav,track3.wav");
    assert.strictEqual(files[1].channel, ch[2]);
  },
});

tests.push({
  name: "stems: a muted track still gets a file",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const ch = t.state.channels;
    ch[1].buffer = fakeBuffer();
    ch[1].muted = true;

    assert.strictEqual(t.stemFiles(ch).map((f) => f.name).join(","), "track2.wav");
  },
});

tests.push({
  name: "stems: an empty session has nothing to write",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    assert.strictEqual(t.stemFiles(t.state.channels).length, 0);
  },
});

// Brave ships the File System Access API turned off, so showDirectoryPicker is
// missing on a Chromium engine. Refusing there would leave the feature dead on
// a browser the app otherwise supports, so the same files go out as downloads.
tests.push({
  name: "stems: without a folder picker the files are downloaded instead",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    const ch = t.state.channels;
    ch[0].buffer = fakeBuffer();
    ch[2].buffer = fakeBuffer();

    const saved = [];
    t.download = (blob, name) => saved.push(name);
    await t.exportStems();
    assert.strictEqual(saved.join(","), "track1.wav,track3.wav");
  },
});

tests.push({
  name: "stems: the fallback banner names the Brave flag",
  async fn() {
    const t = load({ sampleRate: RATE });
    await boot(t);
    t.__sandbox.navigator.brave = {};
    t.state.channels[0].buffer = fakeBuffer();
    t.download = () => {};

    await t.exportStems();
    const banner = t.__document.getElementById("banner").textContent;
    assert.ok(
      banner.includes("brave://flags/#file-system-access-api"),
      "the banner does not say how to get the folder picker back: " + banner
    );
  },
});

module.exports = tests;
