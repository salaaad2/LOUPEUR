# Design invariants

`README.md` covers what the app does and how to run it. This file covers only
the decisions that are easy to undo by accident, each with the failure it
prevents. If you change one of these, change the reasoning here too.

## Time is measured in samples

Loop length, capture windows and offsets are integer samples. Seconds are
derived for display only. Never convert seconds to samples at playback time.

`loopSamples()` is the musical grid: `bars × 4 × (60/BPM) × sampleRate`. In Free
Mode it returns the length the first take defined.

## The grid is never shortened by the seam

Every take is captured `seamSamples(L)` (8 ms) **longer** than the loop.
`foldSeam()` crossfades that extra tail into the head and returns exactly `L`
samples, so the loop point is continuous in value and no audio is lost.

Do not subtract the seam from the grid. Doing so makes the loop 8 ms short of
the bar grid and cuts the tail of the last beat on every pass. At 100 BPM / 4
bars the loop must be 9.600 s (460800 samples at 48 kHz), not 9.592 s.

The fold weights are **linear**, not equal-power. Both halves are the same
signal, so the weights must sum to 1; equal-power weights sum to 1.41 at the
midpoint and put a 20% amplitude bump on every sustained note at the loop point.

## Offsets are taken against the buffer, not the grid

`loopOffset()` reduces modulo `ch.buffer.length`. In Free Mode the buffer is
`L - seam` long while the grid is `L`, and the buffer length is the only length
the source actually loops on. A modulo against `L` leaves the source up to
`seam` samples short of the loop top, and every take enters shifted right by
that much. The waveform playhead measures against the buffer length for the same
reason.

## A recorded take is entered at its own start, not at "now"

`finishCapture()` starts a later take with `scheduleChannel(ch, rec.startTime, 0)`.
Its capture window is `L + seam` long, so `finishCapture` fires `seam` samples
*after* the boundary the take began on. Entering at "now" starts the buffer
`seam` samples into itself and plays the whole take late, permanently, because
the buffer is `L` long and the error never cancels.

The first Free Mode take is the exception: it defines `t0` itself and has no
boundary to wait for, so it goes through `schedulePending()`.

`schedulePending()` enters a take at `max(now, t0)` with the offset the
transport has already reached. Waiting for the *next* boundary when the take's
start has already gone by skips a whole loop — the "full loop of silence after
punch-out" symptom.

## A looping source is never re-scheduled

`scheduleAhead()` skips channels that already have a source. A source with
`loop = true` loops on its own; restarting it at every boundary cuts the take
and re-enters it at the wrong offset. `scheduleChannel` clears `ch.source` in
`onended`, so a source that stopped on its own is treated as pending again.

## Capture is anchored to a predicted frame, not the first block

`armCapture` stores `startFramePredicted = round(startTime × sampleRate)`, shifted
back by the capture shift. `onCaptureFrame` drops blocks that end at or before
it, and the take is anchored to `startFramePredicted` itself:

```js
rec.startFrame = rec.startFramePredicted;
```

The worklet delivers blocks on its own schedule, so the first block that
overlaps the window almost always starts *after* the prediction. Anchoring to
that block instead would discard the latency correction and slide the whole
take, and `endFrame` with it. The samples between the prediction and the first
block stay zero, which is correct: they are the pre-boundary audio the window
was opened for.

The worklet stamps a block with the render frame it was processed at, but the
samples inside it were captured earlier. The window is shifted back by that much
so the take lands where it was played. The shift is applied to the **window**,
not the buffer, so the loop length, the seam fold and the boundary alignment are
untouched. `startFrame` and `lastFrame` are therefore already mic frames: do not
subtract the latency a second time.

**Both sides matter.** An earlier version of this file claimed `outputLatency`
cancels out because the click and the recorded audio share the render clock.
That is wrong. The click is *scheduled* on the render clock but *heard*
`outputLatency` later, so the player plays `outputLatency` late, and the take
lands that much late. `captureShift()` is the one place that number comes from:

```js
function captureShift() {
  const base = deviceOffsetFor(state.micId) || inputLatency + outputLatency;
  return Math.max(0, base + manualOffsetFor(state.micId));
}
```

A measured round trip wins over the estimate, because the estimate cannot see
buffering the browser does not report: a phone used as a mic over ADB, a
Bluetooth bridge, a virtual loopback. Those add tens to hundreds of
milliseconds that no API exposes. The estimate is a lower bound.

## The shift is measured, not guessed

The estimate above is a lower bound, and a lower bound is not a fix: a take that
lands 500 ms late is still 500 ms late if the correction only removes 49 ms of
it. So the shift is measured, per device, by a loopback calibration.

`calibrate()` runs `measureRoundTrip` three times and stores the median. Each
run plays a 1 kHz, 3 ms burst straight to `ctx.destination` -- not through the
master gain or the reverb, which would colour it -- and records the mic into a
window that opens at the scheduled click frame. The measurement is the index of
the first sample above `CALIBRATION_MIN_PEAK` in that window: the round trip,
output latency plus air plus input latency, all of it.

The first crossing, not the global peak. A room noise later in the window can be
louder than the click, and the click is the first thing in it.

A silent window resolves to `null`, never to zero. A silent room must not be
stored as "this device has no latency".

`calibration` is a module-level variable that owns the mic while it runs:
`onCaptureFrame` hands every block to `onCalibrationFrame` and returns, so a
measurement can never be spliced into a take that happens to be open.

### The manual offset

The measurement is a number, not a truth. A device can drift, a browser can
change its buffering, and a user can be playing slightly behind the click. The
`#offset` slider adds a per-device manual offset on top of the measurement, and
it may be negative: a take that lands early is as wrong as one that lands late.
`captureShift()` clamps the sum at zero, because a negative shift would open the
window after the boundary and lose the head of the take.

### The sync check

`syncCheck()` records one short take against the click and reports where the
click landed relative to the boundary, in the banner: "late by 40 ms, raise the
input offset by 40 ms". It goes through the real capture path -- armed at a loop
boundary, captured by the worklet, sliced by `finishCapture` -- so it measures
what a take does, not what the arithmetic says it should do. That is the number
the user reads to decide whether to touch the slider.

`finishCapture` also logs `[loupeur] take offset: … ms` for every take that
started on a boundary, so a wrong shift is visible in the console without
exporting a WAV and measuring it in an editor.

## The window is the take plus slack

`cap = take + CAPTURE_SLACK`. Without the slack the last wanted sample sits at
the final element of the buffer, so the block that carries it is also the block
that fills the buffer, and any rounding or late delivery cuts the tail.

The take closes at `stopFrame`, the end of the window, not at `endFrame`, the
end of the wanted samples. The block carrying the last wanted sample has to be
written before the take commits. The check is against the block's own end:

```js
const blockEnd = frame + data.length;
if (blockEnd >= rec.stopFrame) { finishCapture(); return; }
```

Testing the clamped write bound instead (`to = min(blockEnd, endFrame)`) can
never fire: past `endFrame` every block clamps to the same value, so the take
never closes at all. That was a real bug, caught by the tail tests.

`take` is computed once in `finishCapture` and used by the length, the Free Mode
validation and the slice. It is not re-derived from the frames at each site.

## ARMED is driven by the clock, not by audio

`promoteArmed()` flips `armed → recording` when `ctx.currentTime` reaches the
punch-in time, on its own 25 ms timer. It does not run from `scheduleAhead`,
because an armed take must still promote if the transport is stopped underneath
it. Keying off the first captured block would flip the label a few milliseconds
late and make the state invisible.

## A take of known length is drawn as a timeline

When `rec.lengthSamples` is set (Tempo Lock, overdub), `drawEnvelopeTimeline`
maps the canvas to the take length: bucket `b` sits at `(b * per - origin) / length`
of the width, so the wave grows left to right and the part not yet recorded
stays empty.

`origin` is the **scratch index** the take starts at, not a mic frame: `0` once
the anchor is resolved, `shift` before that. The audio is written at
`micFrame - rec.startFrame`, so the display and the audio share one origin. An
earlier version passed `rec.shift` and multiplied it by the take scale, mixing
two frame spaces; the waveform then disagreed with the audio by exactly the
amount the anchor moved.

The canvas spans the take, not the window. The window carries `CAPTURE_SLACK`
samples past the end of the take, and drawing those would squeeze the take into
the left of the picture.

The envelope is a fixed grid over the whole scratch buffer, so a bucket is
`scratch.length / WAVE_BUCKETS` samples wide and a sample lands somewhere inside
its bucket. That bucket width is the resolution of the display; the display test
allows half a bucket, not an absolute tolerance.

Stretching the captured fraction to full width instead re-scaled the whole
picture on every block, which read as peaks arriving from the right and
compressing the space.

The first Free Mode take has no length until punch-out, so it keeps the stretch:
its scratch buffer is the full 8-minute maximum, and drawing all of it would
shrink the picture to a sliver at the left edge.

## The live envelope is a fixed grid over the scratch buffer

`liveEnv` has `WAVE_BUCKETS` buckets spanning the whole scratch buffer, and
`onCaptureFrame` updates only the buckets the incoming block covers. Cost is
O(block) per block.

Do not rescale the envelope to the captured length on every block. That version
rescanned the entire take each time, which is quadratic: a 2-minute take cost
~11M operations per 128-sample block, on the main thread, every ~2.7 ms. It
glitches capture, which is the one failure this app cannot tolerate.

`drawWave` draws the live envelope through `drawEnvelopeTimeline` when the take
length is known, and through the stretched `filled / scratch.length` fraction
otherwise. Never draw the whole envelope stretched: in Free Mode the scratch
buffer is the full 8-minute maximum, which shrinks the picture to a sliver at the
left edge.

## One buffer per channel, replaced at the boundary

A channel holds a single `AudioBuffer` of exactly `L` samples. An overdub records
into a scratch buffer; at the next boundary the scratch is summed into a **copy**
of the channel buffer and the copy replaces it. Buffers are never mutated while a
source is playing them. The consequence — an overdub is audible one boundary
after punch-out — is accepted.

## State

`state.loopLength` is what marks "a loop exists", in both modes. It is set by the
first take in either mode and dropped when the last track is cleared. In Tempo
Lock the grid is derived from BPM and bars, but the flag still has to follow the
buffers or the next record press arms against a loop with nothing in it.

`pendingRecord.definesLoop` is true only for the first Free Mode take, which
defines the loop length instead of matching it. `isLockedTake()` is the single
place that decides whether a take can be punched out; `render()` and `punchOut()`
both use it so they cannot disagree.

## Signal graph

```
mic → AudioWorklet capture → ring buffer → track buffers (never to destination)

track buffer → BufferSource → channel Gain ─┐
                                            ├→ master Gain → dry ──────────────┐
click synth ────────────────────────────────┤                                  ├→ destination
                                            └→ reverb send → convolver → wet ─┘
```

The click enters after the channel gains and before master, so it is audible but
never recorded or exported. Reverb ON/OFF is a 20 ms wet/dry crossfade, not a
node disconnect, so toggling never clicks.

## Deliberate non-features

- **No `ScriptProcessorNode` fallback.** A main-thread fallback glitches under UI
  load, which is the one failure this app cannot tolerate. Without AudioWorklet
  the app shows a banner and disables recording.
- **No live monitoring.** The mic is not routed to the destination.
- **No stretching or padding.** A later Free Mode take must match `L` within
  50 ms or it is rejected.
- **No punch-out of a fixed-length take.** A later Free Mode track and an overdub
  both run to the end of the loop.
