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

## `loopOffset()` returns samples; `start()` wants seconds

`scheduleChannel()` is the only caller of `AudioBufferSourceNode.start()`, and it
divides the offset by `ctx.sampleRate`. Nothing else may convert.

Passing the sample count straight through is silent and expensive. The number is
thousands of seconds, far past the buffer duration, and the API clamps it to the
end of the buffer: the source starts at its head at `when` instead of at the
phase `when` represents. Every track entered mid-loop then landed
`(when − t0) mod L` late — 330 ms for a take that had just committed — and stayed
there, because a looping source is never re-scheduled. The metronome is scheduled
directly on the grid, so it stayed correct, which is what made the error look
like "the playback is shifted" rather than "the capture is shifted": a track
recorded from the metronome landed on the beat, and a track recorded from another
track's playback landed late by the same amount.

## A committed take is entered at the loop position the transport reached

`finishCapture()` enters every take through `schedulePending()`, which starts it
at `max(now, t0)` with the offset the transport has already reached.

It must not start it at `rec.startTime`. That boundary is always in the past by
the time the take commits: the window opens at `boundary + shift` and runs the
take, the seam and `CAPTURE_SLACK`, so `finishCapture` fires
`shift + L + seam + CAPTURE_SLACK` after the boundary. `start(rec.startTime, 0)`
clamps to "now" and plays the buffer from its head at whatever phase the loop
happens to be at, so the take lands `shift + seam + CAPTURE_SLACK` late — and
stays there, because a looping source is never re-scheduled. That is the "track
2 is late, track 1 is fine" report: track 1 had been re-entered by a stop/start
in the meantime, and only the freshly committed take carried the error.

Waiting for the *next* boundary instead would be exact but skips up to a whole
loop of silence — the "full loop of silence after punch-out" symptom. Entering
at the current position is what a stop/start and an overdub already do, so all
three agree.

## A looping source is never re-scheduled

`scheduleAhead()` skips channels that already have a source. A source with
`loop = true` loops on its own; restarting it at every boundary cuts the take
and re-enters it at the wrong offset. `scheduleChannel` clears `ch.source` in
`onended`, so a source that stopped on its own is treated as pending again.

## The sequencer is a gate, not a second clock

A slot is one full loop, so the step is `floor((now − t0) / L) mod state.seqSteps`.
There is no second timer: the grid is read off the transport clock, which is the
only clock the audio is scheduled on. A separate interval would drift against
the loop, and the drift would be audible as a track entering a few milliseconds
late on every pass.

The gate is a `seqGain` node in front of the channel gain:

```
buffer → BufferSource → seqGain (sequencer) → gain (mute × volume) → dry/reverb
```

It is a **third, independent factor**, not a third term in `channelTarget()`.
Folding it into the channel gain would have made "the channel gain is mute times
volume" false, and the level tests exist to keep that true. The gate is ramped
with the same hold-then-ramp shape as `rampChannelGain`, so a slot change is a
10 ms fade rather than a click.

The gate is re-evaluated at every loop boundary by `scheduleAhead()`, which
already walks the boundaries for the sources. That is the whole scheduler
change: one `rampSeqGain` per track per boundary, in SEQUENCE mode only.

`channelAudible()` is the single place that decides what a mode means:

- LOOP: every track, every loop. The grid is inert.
- SEQUENCE: a track with no row is silent; a track with a row is heard on the
  slots it has filled.
- A stopped transport answers true. Nothing is playing, so the gate only has to
  be right once the transport starts, and `startTransport()` re-applies it
  against the new `t0`. Reading a stale `t0` would gate a track off before the
  first boundary.

`seqStepIndex()` clamps at zero before wrapping. A time before `t0` is a
negative step, and `-1 % 4` is `-1`, which would read as the last slot instead
of the first.

Two things about that clock are easy to get wrong, and both were audible as a
track playing on the wrong slot:

- A boundary is `t0 + n·L`, and floating point can leave `(when − t0) / L` a
  hair below `n`. A plain floor then reads the previous slot at the boundary,
  which is a whole slot of the wrong gate. `seqStepAt()` adds a `1e-9` epsilon,
  far below one sample and far above the rounding error.
- The gate has two writers: `scheduleAhead()` queues the next boundary, and
  `refreshSeqGates()` re-applies the current slot when the mode, a slot, a row
  or a take changes. A `cancelScheduledValues(now)` in the second writer wipes
  the boundary the first one queued, and `nextBoundaryIndex` has already moved
  past it, so nothing puts it back. `refreshSeqGates()` therefore re-schedules
  the next boundary in the same pass, and `rampSeqGain()` cancels from the
  boundary rather than from `now`, so an immediate ramp survives.

A pattern that does not loop ends at `t0 + seqSteps·L`. The gate has already
ramped every track to silence at that boundary, so `stopTransport()` cannot cut
a tail; it only releases the sources.

The row is a **view** of the track, not a copy of its samples. An overdub is
heard through the row without copying again, and `clearChannel()` drops the row
with the track. A snapshot would go stale the moment the track was overdubbed,
and nothing in the UI would say so.

Recording is a LOOP mode action. A take recorded in SEQUENCE mode would be
silent until it was copied to the grid, which reads as a broken take, so the
button is disabled and `onPrimary()` refuses the `R` shortcut too.

## Capture is anchored to a predicted frame, not the first block

`armCapture` stores `startFramePredicted = round(startTime × sampleRate)`, shifted
**forward** by the capture shift. `onCaptureFrame` drops blocks that end at or
before it, and the take is anchored to `startFramePredicted` itself:

```js
rec.startFrame = rec.startFramePredicted;
```

The worklet delivers blocks on its own schedule, so the first block that
overlaps the window almost always starts *after* the prediction. Anchoring to
that block instead would discard the latency correction and slide the whole
take, and `endFrame` with it. The samples between the prediction and the first
block stay zero, which is correct: they are the audio the window was opened for.

The worklet stamps a block with the render frame it was processed at, but the
samples inside it were captured earlier. A sound the player meant for render
frame `f` is therefore stamped at `f + shift`, where `shift` is the whole round
trip. The window opens at `boundary + shift`, so the audio of the boundary is
scratch index 0. Opening it at `boundary - shift` instead put the take
`2 * shift` late, which is why a calibrated offset had no audible effect. The
shift is applied to the **window**, not the buffer, so the loop length, the seam
fold and the boundary alignment are untouched. `startFrame` and `lastFrame` are
therefore already mic frames: do not subtract the latency a second time.

**Both sides matter.** An earlier version of this file claimed `outputLatency`
cancels out because the click and the recorded audio share the render clock.
That is wrong. The click is *scheduled* on the render clock but *heard*
`outputLatency` later, so the player plays `outputLatency` late, and the take
lands that much late. `captureShift()` is the one place that number comes from:

```js
function captureShift() {
  return Math.max(0, offsetFor(state.micId));
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

`calibrate()` plays five 2 kHz, 10 ms bursts straight to `ctx.destination` -- not
through the master gain or the reverb, which would colour them -- and records the
mic into one window that covers all five. Each burst gets its own search window,
`CAL_MARGIN` before it was scheduled and `CAL_MAX_DELAY` after, so a burst that
comes back late is still inside its own window and cannot be confused with the
next one. The measurement is the index of the highest short-window energy in
that window: the round trip, output latency plus air plus input latency, all of
it.

Energy, not the first crossing. A single stray sample cannot win a window, and
the energy window is shorter than the burst, so the peak is its onset.

Five bursts, not one, and the median of the five with values far from it
dropped. A single measurement cannot tell a late block from a late room; the
robust estimate can.

A window with nothing above `CAL_MIN_AMPLITUDE` resolves to `null`, never to
zero. A silent room must not be stored as "this device has no latency".

`calibration` is a module-level variable that owns the mic while it runs:
`onCaptureFrame` hands every block to `onCalibrationFrame` and returns, so a
measurement can never be spliced into a take that happens to be open.

### One offset, and calibration is the only writer

There is exactly one number per device, stored under `loupeur.offset.v1` and
read by `offsetFor()`. Calibration writes it and `captureShift()` reads it.
`render()` shows it in the readout next to the Latency label, and the help line
under it says whether it is measured or still the estimate.

The number is **not** editable. It is a measurement of the device, not a
preference: a hand-set value is a guess the user has no way to verify, and the
only thing that can produce a correct one is playing a burst and hearing it
back. The readout exists so the measurement is visible, not so it can be
overridden.

An earlier version kept two numbers: a measured round trip and a separate manual
offset added on top. That was wrong for a reason that has nothing to do with
arithmetic. The slider showed only the manual half, so after a calibration it
still read 0 while a hidden value did the work. The user could not tell whether
calibration had done anything, could not see what was in force, and had no way
to know whether the number applied to the first take or only later ones. A
control that does not show the value it controls is worse than no control.

The offset applies to **every** take on **every** track, including the first
one. It is a property of the input device, not of the take: `armCapture` reads
it when the window opens, and every window opens through `armCapture`.

`captureShift()` clamps the result at zero: a negative shift would open the
window after the boundary and lose the head of the take.

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

`state.playMode` is the playback mode, not the recording mode: `"loop"` or
`"sequence"`. `state.seqSteps` is the pattern length: 4, 8, 16 or 32 slots, one
full loop each. `state.seqRows` is a sparse array indexed by track, holding
`{ steps }` for a copied track and `null` for one that was never copied. It is
indexed by track rather than kept as a list so the gate lookup is one array
index, and so a row cannot outlive the track it belongs to.

`state.trackCount` is the number of tracks. `state.channels`, `state.volumes`
and `state.seqRows` are parallel arrays indexed by track position.

`pendingRecord.definesLoop` is true only for the first Free Mode take, which
defines the loop length instead of matching it. `isLockedTake()` is the single
place that decides whether a take can be punched out; `render()` and `punchOut()`
both use it so they cannot disagree.

## Track indices are positions, not identities

Adding a track appends to all three parallel arrays. Removing an empty track
splices all three and rewrites `ch.index` for every channel after the gap. The
gate, the level, the row and the stem name are all looked up by that index, so a
removal that skips the rewrite makes the gate read the next track's row and the
volume slider write the next track's level.

A track that holds audio is never removed: the UI disables the control and
`removeTrack()` refuses. The last remaining track is kept for the same reason the
app always has at least one record target.

## The channel gain is mute times volume

`channelTarget()` is the only place the two per-track levels are combined:
`muted ? 0 : state.volumes[index]`. `toggleMute()` and `setVolume()` both write
the gain through `rampChannelGain()`, so the latch and the slider cannot
disagree about what the gain should be.

They land at different times on purpose. A mute waits for the next loop
boundary, because it is a performance move: the track has to drop in and out on
the beat. The volume slider lands immediately, because it is a mix move, and a
slider that waits a whole loop reads as broken. `ch.muteAt` remembers a mute
that is still waiting, so a volume move during the wait is scheduled on the same
boundary instead of cancelling it and muting early.

`state.volumes` is indexed by track and lives in `state`, not on the channel,
because the slider has to work before the audio graph exists: the channels are
created in `initAudio()`, and a level set before the first record would
otherwise be lost while the slider still showed it.

`exportMix()` applies the same number through a gain node per track. An export
that ignored the sliders would not be the mix the user hears.

## A stem is the mix, one track at a time

`renderChannels()` builds the export graph and is the only place it is built. It
can render a longer frame count and insert a per-track sequencer gate.
`exportMix()` hands it every unmuted track; `exportStems()` hands it one track
at a time; `exportSequence()` hands it the tracks with filled rows and a gate
schedule. A stem therefore carries the same per-track level, reverb send and
master as the mix, and the stems sum to the mix when nothing is muted.

Mute is not applied to a stem. It is a performance state, not part of the
material: a track that is muted right now still holds a take worth exporting,
and the file is the take.

`stemFiles()` numbers by track index, not by position in the list. Clearing
track 2 must not renumber track 3: `track3.wav` is the third track whether or
not the second one exists.

The folder write is the File System Access API. Firefox and Safari have no
`showDirectoryPicker`, and Brave ships it turned off, so a missing picker is not
a reason to refuse: `downloadStems()` writes the same files through the existing
download path, and the banner names the Brave flag so the folder path can be
recovered. The names and the numbering are identical either way, which is what
makes the fallback a fallback and not a second feature.

The checkbox is the trigger, not a mode: it opens the picker, writes the files
and unchecks itself, so a second export is one click away and a cancelled picker
leaves nothing behind. `exportingStems` keeps `render()` from re-enabling the
box while the writes are in flight.

## The sequence export is one pass of the gate

`exportSequence()` renders `state.seqSteps × L` frames, one pass of the pattern.
Every source loops for the whole render and a gain node in front of the level
applies the row's filled slots, using the same slot length as the live
sequencer. The gate holds through runs and ramps only when the value changes, so
a filled run is continuous. Mute is applied like Export Mix; stems still ignore
it. The reverb tail is rendered and trimmed exactly like Export Mix, so the file
ends at the pattern boundary.

`Loop pattern` is a playback setting: the export always contains one pass, not a
fixed number of repeats. A track with no row, an all-empty row, or a muted track
is not in the file.

## Signal graph

```
mic → AudioWorklet capture → ring buffer → track buffers (never to destination)

track buffer → BufferSource → seqGain (sequencer) → channel Gain (mute × volume) ─┐
                                                                                 ├→ master Gain → dry ──────────────┐
click synth ─────────────────────────────────────────────────────────────────────┤                                  ├→ destination
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
- **No looping sequence export.** `Export Sequence` renders one pass of the
  pattern. `Loop pattern` is a playback setting; the file is the arrangement.
