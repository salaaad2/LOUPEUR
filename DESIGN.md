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
back by the input latency. `onCaptureFrame` drops blocks that end at or before
it and sets `startFrame = max(frame, startFramePredicted)`. Anchoring to the
first block that happens to arrive would start an armed take a block late.

The worklet stamps a block with the render frame it was processed at, but the
samples inside it were captured `inputLatency` earlier. The window is shifted
back by that much so the take lands where it was played. The shift is applied to
the **window**, not the buffer, so the loop length, the seam fold and the
boundary alignment are untouched. `startFrame` and `lastFrame` are therefore
already mic frames: do not subtract the latency a second time.

Only the input side matters. The click and the recorded audio share the render
clock, so `outputLatency` cancels out of the looper's math.

## ARMED is driven by the clock, not by audio

`promoteArmed()` flips `armed → recording` when `ctx.currentTime` reaches the
punch-in time, on its own 25 ms timer. It does not run from `scheduleAhead`,
because an armed take must still promote if the transport is stopped underneath
it. Keying off the first captured block would flip the label a few milliseconds
late and make the state invisible.

## The live envelope spans the captured region

`liveEnv` is refolded block by block in `onCaptureFrame` and drawn at full width,
so the waveform stretches to fill the canvas as the take grows. Never scale it
by `scratch.length`: in Free Mode the first take's scratch buffer is the full
8-minute maximum, which maps every block into bucket 0 and draws a 2%-wide
sliver at the left edge.

## The live envelope is a fixed grid over the scratch buffer

`liveEnv` has `WAVE_BUCKETS` buckets spanning the whole scratch buffer, and
`onCaptureFrame` updates only the buckets the incoming block covers. Cost is
O(block) per block.

Do not rescale the envelope to the captured length on every block. That version
rescanned the entire take each time, which is quadratic: a 2-minute take cost
~11M operations per 128-sample block, on the main thread, every ~2.7 ms. It
glitches capture, which is the one failure this app cannot tolerate.

`drawWave` draws only the first `filled / scratch.length` fraction of the
envelope, at full width, so the waveform still stretches to fill the canvas as
the take grows. Never draw the whole envelope: in Free Mode the scratch buffer is
the full 8-minute maximum, which shrinks the picture to a sliver at the left
edge.

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
