# Recording sync: the take lands in the wrong place

> **Read this first.** `DESIGN.md` is the repo's invariants file and it is
> **stale on exactly the points this document is about**. Two of its sections
> described the current bug as deliberate design: "Capture is anchored to a
> predicted frame" documented `startFrame = max(frame, startFramePredicted)` as
> intentional, and "Only the input side matters" claimed `outputLatency` cancels
> out. Both are wrong and both have been corrected in `DESIGN.md`. If you find
> any other claim there that contradicts this document, this document is the one
> that was checked against the code.

## 1. The behaviour that is supposed to happen

The loop is a fixed-length buffer. Track 1 defines it. Every later track is
recorded against the same grid and must land where it was played.

```
transport starts, loop runs from the top

track_1   [........|||........]        ||| = the loop boundary, sample 0
track_2   [........|||........]        armed, capture opens at the boundary

I play one note on the boundary:

track_1   [........|||........]
track_2   [........<>.........]        <> = the note, at sample 0

result: the note is at sample 0 of track 2, so it plays back on the boundary,
        on top of track 1. That is the whole feature.
```

What actually happens:

```
track_1   [........|||........]
track_2   [........|||..<>....]        <> was shifted right

result: the note plays back late by an unknown amount. The two tracks are
        audibly out of sync.
```

The shift is not constant. It differs between the USB mic and the AndroidMic
phone, and it differs between takes. Measured by hand, the first click of a
take lands about 142 ms late on the USB mic and about 240 ms late on the phone
mic over ADB.

## 2. What the code does today

This section describes `app.js` at HEAD (`0407002 improve drawing`). There is
**no latency correction control in the code**. An `Input trim` feature was
written, tested in simulation, and then reverted because it did not work in the
browser. Section 2.7 records why, so it is not rebuilt the same way.

### 2.1 The signal path

```
getUserMedia ──► MediaStreamAudioSourceNode ──► AudioWorkletNode ──► port.postMessage
                 (browser resamples,               (capture-worklet.js)      │
                  buffers, adds latency)                                     ▼
                                                                    onCaptureFrame(e)
                                                                    writes into rec.scratch
```

`capture-worklet.js` stamps each block with `currentFrame`, the AudioContext's
own frame counter. That stamp is the **render** frame: the moment the block was
processed. The audio inside the block was captured earlier, by an amount the
browser does not report.

### 2.2 The three frame spaces

This is the part that keeps producing bugs, because getting it wrong is silent.

| Space | Meaning |
| --- | --- |
| render frame | what the worklet stamps, and what `ctx.currentTime * sampleRate` gives |
| mic frame | the frame the audio inside a block actually belongs to: `render - shift` |
| scratch index | a position in `rec.scratch`; index `i` holds mic frame `startFrame + i` |

### 2.3 The shift

There is no `captureShift()` function. The shift is computed inline, once, in
`armCapture` (`app.js:699`):

```js
const shift = Math.round(inputLatency * ctx.sampleRate);
```

`inputLatency` is set by `measureInputLatency` (`app.js:229`) when the mic is
opened, and is the only latency the code knows about:

```js
let device = 0;
if (micStream) {
  for (const track of micStream.getAudioTracks()) {
    const settings = track.getSettings ? track.getSettings() : null;
    if (settings && settings.latency > 0) device = settings.latency;
  }
}
if (!(device > 0)) device = ctx.baseLatency || 0;
const total = device + LATENCY_MARGIN;   // LATENCY_MARGIN = 0.005
```

Two things are missing from that number, and both are real:

1. **`ctx.outputLatency` is never read.** `grep outputLatency app.js` returns
   nothing. On the machine this was debugged on, `ctx.outputLatency` is
   `0.044` s and `ctx.baseLatency` is `0.0107` s at 48 kHz. The player hears
   the click 44 ms after the transport says it played, so they play 44 ms late,
   so the take lands 44 ms late — and the code does not account for it at all.
   This is a guaranteed, device-independent error on every take.

2. **The device buffer is not the whole input path.** `getSettings().latency`
   reports the browser's own buffer. It cannot see the buffering of a network
   or virtual input: a phone used as a mic over AndroidMic/ADB, a Bluetooth
   bridge, a virtual loopback device. Those add tens to hundreds of
   milliseconds that no API exposes. The 5 ms `LATENCY_MARGIN` covers the
   worklet's 128-sample block and nothing else.

So `shift` is a lower bound on the true offset, and on the phone mic it is off
by roughly 200 ms.

### 2.4 The capture window

`armCapture` (`app.js:692`) opens a window `shift` before the boundary:

```js
const cap = lengthSamples || Math.ceil(ctx.sampleRate * MAX_TAKE_SECONDS);
const shift = Math.round(inputLatency * ctx.sampleRate);
pendingRecord = {
  startFrame: null,
  startFramePredicted: Math.round(startTime * ctx.sampleRate) - shift,
  shift,
  lastFrame: null,
  endFrame: endTime === Infinity ? Infinity : Math.round(endTime * ctx.sampleRate) - shift,
  lengthSamples: lengthSamples || 0,
  scratch: new Float32Array(cap),
  ...
};
```

`onCaptureFrame` (`app.js:342`) then resolves the real start from the first
block that overlaps the window:

```js
if (rec.startFrame === null) {
  if (frame + data.length <= rec.startFramePredicted) return;
  rec.startFrame = Math.max(frame, rec.startFramePredicted);
  if (rec.endFrame !== Infinity) rec.endFrame = rec.startFrame + rec.lengthSamples;
}
```

and writes each block at `from - start`, where `start` is `rec.startFrame`.

Four defects live in those twenty lines.

**a. `Math.max(frame, rec.startFramePredicted)` throws the shift away.** The
window is predicted to open `shift` samples before the boundary, but the first
block that arrives almost always starts *after* that prediction — the worklet
delivers blocks on its own schedule, not on the predicted frame. When it does,
`startFrame` becomes `frame`, the actual first block, and the take is anchored
there instead of at the boundary. The correction is silently discarded, and
`endFrame` is recomputed from the wrong anchor, so the window slides with it.
This is the single most likely reason a correction "does nothing".

**b. The window has no slack.** `cap` is exactly `lengthSamples`, and the take
wants exactly `lengthSamples` samples starting at `startFrame`. The last wanted
sample sits at scratch index `cap - 1`, the final element. Any block that
arrives late, any rounding that goes the wrong way, or any finish that fires
before the block carrying that sample has been written, truncates the tail.
There is no margin anywhere.

**c. The head is never padded.** If the first block to arrive starts after
`startFramePredicted`, the samples between the two are never written and stay
zero. Nothing detects this. The code assumes the worklet delivers contiguous
blocks from the predicted frame, which it does not guarantee.

**d. There is no `stopFrame`.** `onCaptureFrame` finishes the take when
`to >= end`, i.e. as soon as a block reaches `endFrame`. Because `endFrame` is
`startFrame + lengthSamples` and `cap` is `lengthSamples`, the block that
reaches `end` is the block that fills the buffer — so the tail is cut by
however much of that block lies past `end`. A take that should end at the loop
boundary ends a block early.

### 2.5 The history of this bug

Every fix so far has been a correction to the same arithmetic, and each one
moved the error rather than removing it:

1. Writing at `frame - start` instead of `micFrame - start` — every block landed
   `shift` too far along.
2. Finishing at `endFrame` instead of a `stopFrame` — the last `shift` samples
   of every take were cut.
3. Slicing from `shift` instead of from an anchor — the manual trim cancelled
   itself exactly, so every trim value produced identical audio.
4. `state.t0 = rec.startTime` instead of `startFrame / rate` — track 1 was fine
   and every later track was off by a constant.

Four bugs, one root cause: **the code models latency as a number it can
subtract, and it cannot.** The number is a guess, it is different per device, it
is different per take, and it is applied in several places that must agree
exactly. Any disagreement is a silent displacement.

### 2.6 The real defect: no single owner of the conversion

`shift` is consumed by **three independent places**, and the same arithmetic is
written out **four times** inside them:

| Consumer | Uses | Purpose |
| --- | --- | --- |
| `onCaptureFrame` (`app.js:342`) | `rec.startFrame`, `rec.endFrame` | maps a block into scratch |
| `finishCapture` (`app.js:728`) | `rec.startFrame`, `rec.endFrame`, `rec.scratch.length` | slices the take, computes and validates the Free Mode length |
| `drawEnvelopeTimeline` (`app.js:1277`) | `rec.shift` | positions the live waveform |

Nothing owns the conversion. Each consumer re-derives it, and they do not agree.

**Concrete inconsistencies, verified in the current code:**

1. **The live waveform uses a different origin than the audio.**
   `drawEnvelopeTimeline` is called with `rec.shift` (`app.js:1210`) and places
   bucket `i` at `(i * per - shift) * scale`. The audio is written at
   `from - rec.startFrame`. Those are the same origin only when
   `rec.startFrame === rec.startFramePredicted`, which — per 2.4a — is the case
   that does not happen. So the waveform and the audio disagree by exactly the
   amount the anchor moved. This is why the waveform "sometimes looked like it
   matched".

2. **The Free Mode loop length uses a third expression.** `finishCapture`
   computes `recorded = rec.endFrame - start` (`app.js:752`) and then
   `length = Math.max(1, Math.min(recorded, rec.scratch.length))`. It clamps
   against the buffer length rather than against the requested take length, so
   a short capture silently becomes a short loop instead of an error.

3. **The Free Mode length check repeats the same expression.** `app.js:771`
   computes `rec.endFrame - rec.startFrame` to validate the take against
   `length + seamSamples(length)`. It is a fourth copy of the conversion, and it
   must stay in step with the one at `app.js:752` or a valid take is rejected.
   Two copies of the same arithmetic in one function is how the next off-by-one
   gets in.

4. **The overdub path slices from 0.** `beginOverdub` (`app.js:907`) passes `L`
   as `lengthSamples`, so `cap` is `L` and `commitOverdub` (`app.js:917`) adds
   `scratch.subarray(0, old.length)` to the existing buffer. That is only
   correct if `rec.startFrame` landed exactly on `startFramePredicted`. Per
   2.4a it usually does not, so the overdub layer is displaced by the same
   amount as everything else. This path has never been hand-tested.

### 2.7 Why the trim was removed

An `Input trim` control (±500 ms, persisted in `localStorage`, added to
`inputLatency`) was implemented and reverted. It is worth recording why,
because the obvious next move is to add it back.

- **It was a second guess stacked on the first.** It was added to `shift`,
  which moves the window *and* the anchor, and the two effects had to be kept
  in balance by hand-written arithmetic. That arithmetic was wrong three times.
- **It was frozen at page load, not per device.** `loadTrim()` ran once in
  `boot()`. `switchMic` (`app.js:298`) never reloaded it, so changing
  microphone mid-session kept the previous device's trim with no indication
  that it did. A value dialled in for the phone silently applied to the USB mic.
- **It was not observable.** Nothing in the UI said what the current shift was,
  so a user could not tell a wrong trim from a wrong `outputLatency` from a
  wrong `inputLatency`.
- **It was not verifiable.** There was no way to measure the result without
  exporting a WAV and eyeballing it in Audacity.
- **It could not work while 2.4a was present.** The trim moved
  `startFramePredicted`, and `Math.max(frame, rec.startFramePredicted)` then
  discarded the movement whenever the first block arrived late. The user's
  report — "0, 200, 500 all land the same" — is exactly what that code does.

A manual offset is the right *interface* (see 4.1). It is the wrong *first
step*. It should come back only as a fine adjustment on top of a measured
number, and only after the anchor bug in 2.4a is gone.

## 3. How to test it

### 3.1 By hand, in the browser

The point of this procedure is that it produces a **number**, not an impression.

1. Serve the app: `python3 -m http.server 8000`, open
   `http://localhost:8000` in Brave.
2. Pick the USB mic.
3. Tempo Lock, 100 BPM, 4 bars. Record track 1: clap once, hard, on beat 1.
   Let the loop run out.
4. Record track 2: clap once, hard, on beat 1. Let the loop run out.
5. Export Mix. Open the WAV in Audacity.
6. Measure the distance between the two clap transients. That distance, in ms,
   is the error. Positive means track 2 is late.

**The single most useful diagnostic** is to log the numbers at arm time and at
the first captured block, and compare them with the measurement:

```js
// in armCapture, after pendingRecord is built
console.log("[loupeur] arm: input", (inputLatency * 1000).toFixed(1),
            "ms, shift", shift, "predicted", pendingRecord.startFramePredicted,
            "end", pendingRecord.endFrame, "cap", cap);

// in onCaptureFrame, inside the `rec.startFrame === null` branch
console.log("[loupeur] take start: block frame", frame,
            "predicted", rec.startFramePredicted,
            "resolved", rec.startFrame,
            "moved", rec.startFrame - rec.startFramePredicted);
```

If `moved` is not 0, 2.4a is confirmed and the shift is being discarded. If
`moved` is 0 and the audio still lands late, the number itself is wrong and the
gap is `outputLatency` plus whatever the device hides.

### 3.2 Automatically, in Node

`app.js` is a plain script with no module boundary, so it can be loaded with
stubbed Web Audio objects and driven directly. The pattern:

```js
let src = fs.readFileSync("app.js", "utf8");
src = src.replace("boot();", "globalThis.__t = { state, initAudio, armCapture,\n  onCaptureFrame, get pendingRecord(){ return pendingRecord; } };");
eval(src);
```

Then a test places a click at a known mic frame and asserts the buffer index it
lands at:

```js
// The click is played on the boundary. The mic delivers it `shift` samples
// later in render time, so it sits at mic frame `boundary + shift`.
const clickMic = boundary + shift;
for (let frame = rec.startFramePredicted; frame < rec.endFrame; frame += BLOCK) {
  const data = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) if (frame + i === clickMic) data[i] = 1;
  t.onCaptureFrame({ data: { frame, data } });
}
// assert the click landed at buffer index 0
```

**The limitation that matters:** these tests encode the same model as the code.
They prove the arithmetic is self-consistent. They cannot prove the model is
right, because the model is the thing under test. A test that says "a click at
mic frame `boundary + shift` lands at index 0" is a restatement of the
implementation, not a check on it.

That is why the browser measurement in 3.1 is not optional. The Node tests catch
regressions; only the browser tells you whether the model matches reality.

### 3.3 The tests that would actually have caught this

Three properties, none of which needs to know the true latency:

1. **The anchor is honoured.** Feed blocks that start *after*
   `startFramePredicted` and assert that `rec.startFrame` is still
   `startFramePredicted`, and that the samples between the two are zero rather
   than the take being re-anchored. This is 2.4a, and it is the bug that made
   the trim look broken.

2. **The tail survives.** Feed blocks up to and past `endFrame` and assert the
   last wanted sample is present. This is 2.4b and 2.4d.

3. **The display agrees with the audio.** For a synthetic take, assert that the
   buffer index of the peak and the x position `drawEnvelopeTimeline` gives that
   same sample refer to the same fraction of the take. This is 2.6.1, and it is
   the only test that would have caught the waveform lying.

All three are model-independent: they assert internal consistency, not an
absolute offset. They would have failed on every version of the code so far.

### 3.4 What the current tests do and do not cover

There is no test suite in the repo. The audio math (loop length, seam fold,
boundary and offset arithmetic, envelope) is pure and can be exercised in Node
against a stubbed Web Audio API; that is how the current behaviour was checked.
Anything involving real capture, scheduling or rendering needs a browser and a
microphone.

A suite of nine files was written against the reverted trim code. It is gone
with the code and should not be resurrected: it tested a control that no longer
exists, and two of its tests were **wrong when first written** — they placed the
click inside the region the slice legitimately discards, and their block loop
was too short to reach the end of the window. Both were test bugs, not code
bugs, but they are a reminder that a passing suite written against the same
mental model as the code proves very little.

## 4. Proposed solutions

### 4.1 What other software does

Worth knowing, because the current design is not the idiomatic one.

| Software | Approach |
| --- | --- |
| Ableton Live | "Driver Error Compensation": a guided loopback measurement. You route output to input, play a click, and Live measures the round trip and stores the result. No manual number. |
| Logic / GarageBand | Automatic latency compensation from the driver's reported latency, plus a per-device manual offset in samples. |
| Reaper | Per-device offset in samples, plus a "loopback latency" measurement tool that writes the measured value into the preference. |
| Audacity | "Latency correction" in ms, applied at record time, with a documented procedure to measure it by loopback. |
| Ardour | Hardware latency calibration: a click is emitted, recorded, and the offset computed automatically. |

Three patterns recur:

1. **Measure, do not guess.** Every serious DAW has a loopback calibration that
   produces the number empirically.
2. **Store per device.** The offset belongs to the interface, not to the app.
3. **Express it in samples, not milliseconds.** Milliseconds round badly and
   hide off-by-one errors.

The current app does none of the three. That is the design problem, and it is
why any manual number feels arbitrary.

### 4.2 Solution A — measure the offset, per device

Stop guessing. Add a calibration that measures the actual round trip and stores
it per `deviceId`.

**How it works.** The app already has everything needed: it can play a click and
it can record. A calibration take is just a normal take with a known stimulus.

```
1. User clicks "Calibrate".
2. App plays a short impulse (a single-sample click, or a 1 kHz burst) at a
   known render frame, through the normal output path.
3. The mic records it. The impulse travels: output buffer -> speaker -> air ->
   mic -> input buffer -> worklet.
4. The app finds the peak in the recorded buffer. Its mic frame minus the
   scheduled render frame IS the total round-trip offset.
5. Store it under the deviceId. Done.
```

The measurement is a single number, `roundTrip`, and it replaces the entire
`inputLatency + outputLatency` sum:

```js
function captureShift() {
  return deviceOffset(state.micId);   // measured, in seconds
}
```

**Why this is better.** It removes two guesses and replaces them with one
measurement. It is per device, so the USB mic and the phone each keep their own
number. And it is verifiable: the calibration reports the number it measured, so
the user can see it. A manual trim then becomes an optional fine adjustment on
top of a measured value, which is exactly what Reaper and Audacity do.

**Cost.** One new UI flow, one new storage key per device, and a peak-finding
routine. The peak finder is the only non-trivial part, and it is ~20 lines.

**Risk.** The measurement is only as good as the acoustic path. A speaker and
mic in the same room will pick up the click, but a headset with the mic far from
the driver may not. Mitigation: fall back to the current estimate if no peak is
found, and say so.

**A caveat specific to this app.** The phone mic runs over ADB, and the round
trip through it is ~240 ms. A calibration impulse played through the speakers
and picked up by the phone will measure that path, which is the right number for
that device. But the phone is also the device most likely to have a *stable*
offset, so it is the one that benefits most from being measured once and stored.

### 4.3 Solution B — capture dumb, playback owns the offset

The most radical option, and the one that addresses the actual defect from 2.6:
**stop correcting at capture time and correct at playback time instead.**

The insight is that the take does not need to be sliced at the right place. It
needs to *play back* at the right place. Those are different problems, and the
second one is much easier.

```
capture:  record the raw window, no slicing, no anchor arithmetic
          store the take with a known start offset

playback: start the source at (boundary + offset), not at the boundary
          offset is a single number, applied in one place
```

Concretely: keep `rec.scratch` as captured, and store `rec.offset` — the number
of samples the take is late. When the channel is scheduled, pass that offset to
`scheduleChannel` (`app.js:628`) as a start delay. The buffer is never sliced,
so there is no anchor arithmetic, and no way for a correction to cancel itself.

**Why this is the right answer to 2.6.** It collapses three consumers into one.
`onCaptureFrame` writes blocks at their natural position, `finishCapture` copies
the buffer without slicing, and `drawEnvelopeTimeline` draws the buffer as it
is. The offset is applied once, at `scheduleChannel`, which is the only place
where the error is audible. There is no second place for the arithmetic to
disagree with the first.

**Why it is risky.** A take that is late by more than the loop length wraps, and
the wrap has to be handled by rotating the buffer rather than delaying the
start. That is a real complication, and it is why this is listed second rather
than first.

### 4.4 Solution C — one owner of the conversion (the refactor)

Solutions A and B change *what* the number is. This one changes *who computes
it*, and it is the answer to 2.6. It is independent of A and B and can be done
before, after, or alongside them.

**The shape.** Introduce a single object that owns every frame-space conversion,
and make the three consumers ask it instead of doing arithmetic:

```js
// One place that knows the three frame spaces. Nothing else may convert.
function makeCapture(startTime, lengthSamples) {
  const rate  = ctx.sampleRate;
  const shift = Math.round(captureShift() * rate);
  const take  = lengthSamples || Math.ceil(rate * MAX_TAKE_SECONDS);
  const cap   = take + SLACK;               // SLACK: see 2.4b, the window has none today

  return {
    rate, shift, take, cap,
    startFrame: Math.round(startTime * rate) - shift,
    // mic frame -> scratch index. The ONLY conversion in the codebase.
    toScratch: (micFrame) => micFrame - (Math.round(startTime * rate) - shift),
    // scratch index -> x position in a canvas of `width` px, for the display.
    toX: (scratchIndex, width) => scratchIndex * (width / take),
  };
}
```

Then:

- `onCaptureFrame` calls `cap.toScratch(micFrame)` and writes. No
  `Math.max(frame, rec.startFramePredicted)`, no `- rec.startFrame`.
- `finishCapture` slices `scratch.subarray(0, cap.take)`. No `Math.max(0, ...)`
  anywhere.
- `drawEnvelopeTimeline` calls `cap.toX(i * per, cssW)`. No `- shift`.
- The Free Mode length is `cap.take`, computed once, used by both the length and
  the validation at `app.js:771`.

**Why this is the right refactor and not just tidying.** It makes the class of
bug in 2.5 and 2.6 *unrepresentable*. There is one expression for each
conversion, so there is nothing to keep in step. The four copies become one, and
the display cannot disagree with the audio because they call the same function.

**What it does not fix.** It does not make the number correct. If
`captureShift()` is wrong, every consumer is now wrong in the same way instead
of differently — which is a real improvement, because the error becomes
consistent and therefore measurable, but it is not a fix. That is what A is for.

**Cost.** Roughly a day. The risk is low because the change is mechanical: each
consumer's arithmetic is replaced by a call, and the tests from 3.3 should pass
unchanged if the refactor is faithful. If a test needs editing, the refactor
changed behaviour and that is a signal, not a chore.

### 4.5 Recommendation

Do the **three independent bugs first** (5.1), then **C**, then **A**, with **B**
as the target shape for the next rewrite.

The bugs in 5.1 are cheap, they are real, and none depends on any guess about
the hardware: `outputLatency` is simply not read, the anchor is simply
overwritten, and the tail is simply cut. Fixing them will not make the tracks
sync — the phone mic's hidden buffering is still unmeasured — but it removes
44 ms of guaranteed error, makes any correction actually take effect, and stops
the take from being truncated, which makes every later measurement meaningful.

C is the only option that removes the *structural* defect — the four copies of
the conversion — and it is cheap, mechanical, and makes every later fix land in
one place. A is the only option that removes the guess. B is the end state:
capture becomes dumb, playback owns the offset.

## 5. What to do next

Ordered by "how much does this unblock", not by size.

### 5.1 Fix the three bugs that need no measurement

Each of these is independently testable with the properties in 3.3, and each
should be its own commit so a regression is attributable.

1. **Read `outputLatency`.** `app.js:699`, inside `armCapture`:

   ```js
   // today
   const shift = Math.round(inputLatency * ctx.sampleRate);
   // after
   const shift = Math.round((inputLatency + (ctx.outputLatency || 0)) * ctx.sampleRate);
   ```

   One line. It removes a device-independent 44 ms of lateness on the machine
   this was debugged on. Do not claim it fixes sync; it does not, because the
   input side is still under-reported.

2. **Honour the anchor.** `app.js:354`, inside `onCaptureFrame`:

   ```js
   // today
   rec.startFrame = Math.max(frame, rec.startFramePredicted);
   // after
   rec.startFrame = rec.startFramePredicted;
   ```

   The samples between the prediction and the first block then stay zero, which
   is correct: they are the pre-boundary audio the window was opened for. This
   is 2.4a, and until it is fixed no correction — manual or measured — can have
   any effect. **Do this one first**: it is the reason the trim looked broken,
   and it is a prerequisite for 3 and for anything in section 4.

3. **Stop cutting the tail.** Three sites, all in `armCapture` /
   `onCaptureFrame`:

   - `app.js:693` — allocate slack: `const cap = (lengthSamples || Math.ceil(ctx.sampleRate * MAX_TAKE_SECONDS)) + SLACK;`
   - `app.js:712` — add `stopFrame: endTime === Infinity ? Infinity : Math.round(endTime * ctx.sampleRate) - shift + SLACK,` to `pendingRecord`.
   - `app.js:392` — finish on `to >= rec.stopFrame` instead of `to >= end`, and
     keep `end` as the write bound so the extra samples land in the slack.

   `SLACK` of one worklet block (128 samples) is enough; 4096 is a safe first
   experiment. This is the "truncated both sides" symptom.

Note that 2 and 3 interact: with the anchor honoured, `endFrame` is
`startFramePredicted + lengthSamples`, so the tail cut is a fixed 128-sample
block overrun rather than a variable one. Fix 2 before measuring 3.

### 5.2 Then the structural work

4. Add the three tests from 3.3. They are model-independent and they are the
   only tests that would have caught the reported bug.
5. Put the Node harness in the repo under `test/`, with a plain
   `node test/run.js`.
6. Implement **C** (4.4). One owner of the conversion, four copies collapsed to
   one, slack made explicit.
7. Implement **A** (4.2). The calibration flow is the actual fix for the number.
8. Plan **B** (4.3). It is the only change that removes the class of bug rather
   than an instance of it.

## 6. Status of the current working tree

The tree is clean at HEAD `0407002 improve drawing`. `ISSUE.md` is the only
untracked file.

The `Input trim` feature described in earlier revisions of this document has
been reverted. There is no trim control in `index.html`, no `inputTrimMs` in
`state`, no `captureShift()` in `app.js`, and no `stopFrame` in `pendingRecord`.
Everything in section 2 describes the code as it is, not as it was.

`DESIGN.md` has been corrected on the two points that contradicted this
document (the `Math.max` anchor and the `outputLatency` claim). Its other
sections were not re-audited.

Nothing in this document has been implemented. The bugs in 5.1 are diagnosed
from reading the code, not from a browser run.

## 7. Can someone else pick this up?

Two questions worth answering explicitly, because the answer is not the same for
both.

**Can they collapse the dispersed logic into one source of truth?** Yes. 4.4
gives the shape, the three call sites, and the exact arithmetic each one
currently does. The refactor is mechanical and the tests from 3.3 are the safety
net — if a test needs editing, the refactor changed behaviour. This is the most
tractable part of the document.

**Can they fix the bug?** Not from this document alone, and it would be
dishonest to claim otherwise. What the document gives them is:

- a precise statement of the symptom and the one measurement that distinguishes
  the candidate causes (3.1);
- three concrete code defects that are visible by reading, and that explain why
  every previous correction had no effect (2.4a, 2.4b, 2.4d);
- the four historical bugs and why each fix moved the error rather than removing
  it (2.5), so they do not repeat them;
- the structural reason the bug keeps coming back (2.6);
- the reason the manual trim was removed, so it is not rebuilt the same way
  (2.7).

What it cannot give them is the true latency of the user's hardware. That number
is not in the code, not in the browser API, and not in this document. It has to
be measured, which is what Solution A is for. Until it is measured, every fix is
a guess that happens to fit one device.

The honest summary: **5.1 makes the code stop lying, C makes it
correct-by-construction, A makes the number correct, and none is a substitute
for another.**
