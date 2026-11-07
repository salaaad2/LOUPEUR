# Handoff — Browser 4-Track Looper Pedal

State of the project as of 2026-11-01, written so a fresh session can continue without
re-reading the whole history. `DESIGN.md` is the original spec; this file is the
"what actually exists and why" companion. Where they disagree, this file wins.

---

## 1. What this is

A fully client-side 4-track looper pedal (Boss RC-505 mental model) in vanilla
HTML/CSS/JS. No framework, no build step, no dependencies, no backend. Audio never
leaves the browser.

```
loupeur/
├── index.html          77 lines   static markup, no inline JS
├── style.css          348 lines   dark DAW theme
├── app.js            1097 lines   everything: audio engine, UI, export, waveform
├── capture-worklet.js  32 lines   AudioWorklet that forwards mic frames
├── DESIGN.md          169 lines   original spec (partly stale, see §9)
└── HANDOFF.md                     this file
```

Git: branch `master`, one commit (`1b249bb initial commit. deepseek`). `app.js` and
`style.css` are modified and staged; `index.html`, `capture-worklet.js`, `HANDOFF.md`
are untracked. Nothing has been committed since the initial import.

## 2. Running it

```bash
cd /home/salad/Documents/projects/loupeur
python3 -m http.server 8000
# open http://localhost:8000
```

**Must be `localhost`.** `getUserMedia` requires a secure context. `http://localhost`
counts as secure; `http://192.168.x.x` or a hostname does not, and the browser greys
out the mic permission with no way to enable it. `file://` also fails because the
worklet module cannot be loaded. `app.js` checks `window.isSecureContext` and shows a
banner explaining this.

Browser: Brave (user's daily driver), desktop. Firefox is used for headless testing.

## 3. Architecture

### 3.1 Signal graph

```
mic ──► MediaStreamSource ──► AudioWorkletNode (capture-processor, 0 outputs)
                                     │ port.postMessage({frame, data})
                                     ▼
                              main thread: onCaptureFrame
                                     │
                              pendingRecord.scratch (Float32Array)
                                     │ finishCapture → foldSeam → AudioBuffer
                                     ▼
track AudioBuffer ──► BufferSource ──► channel Gain ──┬──► dryGain ──┐
                                                      └──► convolver ──► wetGain ──┤
                                                                                   ├──► masterGain ──► destination
click synth (osc + gain envelope) ─────────────────────────────────────────────────┘
```

One `AudioContext` for everything. `initAudio()` is called from the first user gesture
(`onPrimary`) and builds the graph plus the four channel objects.

### 3.2 Transport

- `state.loopLength` — loop length in **samples**, 0 = undefined.
- `state.t0` — `AudioContext.currentTime` of loop sample 0.
- `state.transport` — `"stopped" | "running"`.
- `nextBoundaryIndex` — next loop iteration to schedule.

`scheduleAhead()` runs on a 25 ms `setInterval`, looks 100 ms ahead, and for each
boundary inside the horizon calls `scheduleChannel()` for every channel in
`playing`/`overdubbing` **that has no source**. A source that is already running loops
on its own (`src.loop = true`), so re-scheduling it at every boundary would cut the take
and re-enter it at the wrong offset. `scheduleChannel` starts a fresh `BufferSource` at
`when` and `offset`, and clears `ch.source` in `onended`. This is the standard lookahead
pattern: no `setTimeout` ever touches audio timing, so there is no drift.

`nextBoundaryTime(after)` returns the first loop boundary at or after `after`. Used for
mute ramps, later-track record starts, overdub starts, and resume.

`schedulePending()` starts every `playing`/`overdubbing` channel that has no source. It
is called from `startTransport()` and from `finishCapture()` (both the new-take and the
overdub-commit paths). `scheduleChannel` clears `ch.source` in `onended`, so a source
that stopped on its own is treated as pending again.

**Loop offset.** `scheduleChannel(ch, when, offset)` starts the source at `offset`
samples into the buffer with `src.loop = true`. `loopOffset(ch, when)` computes it from
the channel's anchor — `ch.anchorTime`, or `state.t0` when that is `null` — as
`(when - anchor) mod L`. Only the first Free Mode take sets `anchorTime` (to `state.t0`,
which `finishCapture` back-dates to the frame capture began at); every other take is
anchored to the loop top.

**The "full loop of silence after punch-out" bug.** It had two causes, one per branch of
`schedulePending`, and both are the same mistake: waiting for the *next* boundary when
the take's own anchor had already gone by.

- *First Free Mode take.* `finishCapture` sets `t0 = startFrame / rate`, which is
  `press + 50 ms`, not a boundary. At punch-out the transport is already exactly one
  loop past `t0`, so `nextBoundaryTime(now + 0.02)` returns `t0 + 2L`.
- *Later tracks.* Capture is armed at a real boundary and runs `L + seam`, so
  `finishCapture` fires just *after* that take's end boundary. `nextBoundaryTime` then
  returns the following one, again a full loop away.

The fix is one rule: `when = anchor > now ? anchor : now`, then start at
`loopOffset(ch, when)`. A take whose anchor is still ahead waits for it; one whose
anchor has passed is entered immediately at the position the transport has reached.
`scheduleAhead` also skips channels that already have a source, because a looping source
needs no re-scheduling and restarting it at each boundary would cut the take.

### 3.3 Loop length and the seam fold

Every take is captured **longer** than the loop by `seamSamples(L)` (8 ms, capped at
`L/2`). `foldSeam()` crossfades that extra tail into the head and returns a buffer of
exactly `L` samples, so the loop point is continuous in value — no click — and no audio
is lost.

Consequence: `loopSamples()` in Tempo Lock returns the **unshortened** musical grid,
`bars × 4 × (60/BPM) × sampleRate`. Everything downstream (scheduler, boundary math,
export) derives from that one value, and it equals the buffer length.

**Do not subtract the seam from the grid.** That was the bug fixed on 2026-11-04: the
grid was `raw - seamSamples(raw)` while the fold was handed a take of `raw` and returned
`raw - seam`, so the buffer was 8 ms shorter than the material and the tail of the last
beat was cut on every loop. At 100 BPM / 4 bars the loop ran 9.592 s against 9.600 s of
audio. The grid must stay 9.600 s (460800 samples at 48 kHz) so the click stays on the
beat and the last beat is heard.

- **Free Mode, first take:** `armCapture(ch, startAt, Infinity, 0)` — free-running,
  length fixed at punch-out. `finishCapture` sets `state.loopLength` and back-dates
  `state.t0` to the first captured frame. Here the fold trims the take's own tail, so
  `L` is the post-fold length by definition.
- **Free Mode, later tracks:** punch in at the loop top (see §3.5). The take is armed
  immediately, capture opens at the next boundary, and the window is exactly `L + seam`.
  The take must match within `FREE_TOLERANCE` (50 ms) or it is rejected.
- **Tempo Lock:** `L = bars × 4 × (60/BPM) × sampleRate`, no seam subtraction. 4 clicks
  of count-in, capture arms on beat 5, auto-stops at the end of the `L + seam` window.

### 3.4 Capture path

`capture-worklet.js` posts `{frame, data}` per 128-sample block. `frame` is derived from
the worklet's `currentFrame` global (the AudioContext frame counter), so indices line up
with `ctx.currentTime * sampleRate`.

`armCapture` stores `startFramePredicted = round(startTime * sampleRate)`. The take is
anchored to that frame, not to the first block that happens to arrive: `onCaptureFrame`
drops any block that ends at or before it and sets `startFrame = max(frame,
startFramePredicted)`. This is what makes an armed take begin exactly on the loop
boundary instead of a block late.

`onCaptureFrame` copies the block into `pendingRecord.scratch` at
`frame - startFrame`, tracks `lastFrame`, folds the block into `liveEnv` (see §4), and
calls `finishCapture()` when the window is full.

**`frame` is the render clock, not the mic clock.** The worklet stamps each block with
the AudioContext frame it was *processed* at, but the samples inside it were captured
`inputLatency` earlier (the device buffer: tens of ms on a wired mic, 100–300 ms on a
phone or Bluetooth headset). A take anchored to that stamp lands late by the input
latency and plays back that much after the click. It is a constant offset, so it does
not drift.

**Latency compensation (implemented).** `measureInputLatency()` runs in `ensureMic()`
and returns `MediaStreamTrack.getSettings().latency` plus `LATENCY_MARGIN` (5 ms, the
worklet's 128-sample block), falling back to `ctx.baseLatency` when the browser does not
report it (Safari). `armCapture` shifts the whole capture window back by that many
frames — both `startFramePredicted` and `endFrame` — so the block that carries the sound
of the boundary is the one that opens the take. The window keeps its length, so the loop
length, the seam fold and the Free Mode length check are untouched.

Consequences worth knowing:

- `startFrame` and `lastFrame` are **mic frames**, i.e. already the render time the
  audio belongs at. `finishCapture` uses `startFrame / rate` as `t0` directly and must
  not subtract the latency a second time.
- The first Free Mode take's length is `end - start`, both mic frames, so the latency
  cancels out of it. Only the punch-out path that falls back to `ctx.currentTime`
  subtracts it explicitly.
- The correction is applied to the *window*, not to the buffer, so nothing is rotated
  and no audio is dropped at the head. A take still begins exactly on the boundary.
- `inputLatency` is reset to 0 in `releaseMic()`, so a take can never be shifted by a
  stale value from a device that is no longer open.

**Measured on the user's machine (2026-11-07):** `track.latency` = 21.33 ms (1024
samples at 48 kHz), `baseLatency` = 10.67 ms, `outputLatency` = 46–50 ms. Only the
input side matters here: the click and the recorded audio share the render clock, so
`outputLatency` cancels out of the looper's math. Do not add it to the correction.

**The Free Mode "track 2 is shifted" bug (fixed).** A later take's capture window is
`L + seam` long, so `finishCapture` fires `seam` samples *after* the boundary the take
began on. `finishCapture` used to enter the new buffer via `schedulePending()`, which
starts it at `loopOffset(ch, now)` — the loop position at that moment, i.e. `seam`
samples into the buffer. The take then played `seam` late, permanently, because the
buffer is `L` long while the transport's loop is `L + seam` and the error never
cancels. Track 1 never showed it: its `t0` is back-dated to its own start frame, so
its offset came out to 0.

The fix: a later take is entered at its own start boundary with offset 0 —
`scheduleChannel(ch, rec.startTime, 0)` — not at "now". The first Free Mode take still
goes through `schedulePending()`, because it defines `t0` itself and has no boundary to
wait for.

Two related corrections landed with it:

- `loopOffset` takes its modulo against `ch.buffer.length`, not `loopSamples()`. The
  two differ by the seam in Free Mode, and the buffer length is the only length the
  source actually loops on.
- The playhead in `drawWave` measures against `ch.buffer.length` for the same reason.

**Do not reintroduce `schedulePending()` for a later take.** It looks equivalent and is
not: it is the whole bug.

### 3.5 Channel states

```
EMPTY ──record──► RECORDING ──auto/punch──► PLAYING ──overdub──► OVERDUBBING ──► PLAYING
   ▲                  ▲                                                          │
   │                  │                                                          │
   │            ARMED ┘  (later Free Mode track only)                            │
   │              │                                                              │
   └──────────────┴──────────────── CLEAR (long-press) ───────────────────────────┘
```

Per-channel object: `{index, state, buffer, gain, source, muted, layers, env, envBuffer}`.

**ARMED — punch in at the loop top.** When a later Free Mode track is recorded, the
press does not start capture. The channel enters `armed`, and capture opens at the next
loop boundary, which is also loop sample 0. The button reads `ARMED` in accent blue
(`WAVE_COLORS.armed`). Pressing again cancels back to `EMPTY`.

This exists because the alternative — capture from the press and anchor the buffer at
index 0 — makes the take play back shifted by the press-to-boundary distance, so the
mix does not match what the user heard while recording. Do not reintroduce a start
offset or a buffer rotation: the take is anchored to the boundary, and that is the whole
fix. A rotation keyed off `nextBoundaryTime` can never fire, because that function
returns `t0 + n·L` by construction.

`promoteArmed()` flips `armed → recording` once `ctx.currentTime >= rec.startTime`. It
runs on its own 25 ms timer (`startArmTimer`/`stopArmTimer`), **not** from
`scheduleAhead`, so an armed take still promotes if the transport is stopped underneath
it. Driving it off the first captured block instead would flip the label a few
milliseconds late and make the state invisible.

If the transport is stopped when a later track is armed, `t0` is stale and there is no
boundary to wait for, so `beginRecord` restarts the transport first.

- **Mute:** `toggleMute` schedules a hold at the current value, then a 10 ms linear ramp
  at the next boundary. Unmute mirrors it.
- **Clear:** long-press 600 ms (`CLEAR_HOLD_MS`). Stops the source, nulls the buffer,
  resets layers/state/mute. In Free Mode, if the cleared track owned the transport,
  `loopLength` is recomputed from the first remaining buffer, or the transport stops if
  none remain.
- **Overdub:** captures a full loop, then `commitOverdub` sums the scratch into a copy of
  the existing buffer and increments `layers`.

### 3.6 Export

`exportMix()` builds an `OfflineAudioContext(2, L + 1s tail, rate)` with the same
master/dry/convolver/wet topology, starts every unmuted buffer at 0, renders, and
encodes 16-bit PCM stereo WAV (`encodeWav`) for download. Reverb wet is 0.35 when on.

## 4. Waveform display (the part with the history)

Each track tile has a `<canvas class="wave">`. A single `requestAnimationFrame` loop
(`startWaveLoop`) redraws all four canvases every frame. `drawWave` handles DPR scaling,
centre line, envelope, recording progress bar, and the playback playhead.

**Static envelopes** are cached per channel in `ch.env`, keyed by buffer identity
(`ch.envBuffer`), computed by `computeEnvelope` into `WAVE_BUCKETS = 200` peak buckets.

**Live envelope while recording** is the subtle part, and it has been broken twice:

- `liveEnv` is a global `Float32Array(200)`, reset in `armCapture`.
- `onCaptureFrame` refolds the whole envelope on every block: `total = writeAt + count`,
  each bucket takes the max of (a) the old bucket's peak that overlaps it, carried
  forward, and (b) the new samples in range. Cost is one pass over 200 floats per block,
  not over the take. `rec.envTotal` tracks the span the envelope currently covers.
- `drawWave` draws **all** of `liveEnv` at full width, so the waveform stretches to fill
  the canvas as the take grows. A 2 px progress bar at the bottom shows
  `filled / maxTakeLength` so elapsed time is still visible.

**The bug that cost the most time:** in Free Mode's first take, `armCapture` is called
with `lengthSamples = 0`, so `rec.lengthSamples || rec.scratch.length` fell back to the
8-minute max-take buffer (~23M samples). Dividing by that mapped every block into bucket
0 and drew a 2%-wide sliver at the left edge. The display was live the whole time; it
just had nowhere to draw. **Never scale the live envelope by `scratch.length`.** The
envelope spans the captured region, not the buffer.

If the user later wants a scrolling fixed-time axis instead of a stretching one, that is
a deliberate change to `drawWave`'s recording branch, not a bug fix.

## 5. Recording rules (deliberate, do not "fix")

- **A later Free Mode track punches in at the loop top.** See §3.5. The take is silent
  for the part of the loop that played before capture began; that is correct, because
  the user was not recording then.
- **A later Free Mode track cannot be punched out once recording.** Its length is fixed
  by the first take; stopping early would leave a short take that cannot loop.
  `punchOut` shows a banner ("This track records for the full loop length. It stops on
  its own."), the button reads `RECORDING…` and is `disabled`, and keyboard `R` hits the
  same guard. `render()` computes this as `locked = ch.state === "recording" &&
  pendingRecord && !pendingRecord.freeMode`. Note `locked` matches `"recording"` only,
  so an `armed` take stays clickable — cancelling it is the only way out.
- **The first Free Mode take can be punched out** at any time; the length is whatever
  was captured up to the last received frame. Takes under 0.5 s are rejected.
- **Tempo Lock takes always run the full bar count** and auto-stop; pressing the button
  during recording is a no-op.
- **Mode cannot be switched while any track holds audio** or the transport runs.

## 6. UI

`index.html` is static; `buildTracks()` generates the four tiles from a template string
and delegates clicks on `#tracks` via `data-primary` / `data-mute` / `data-clear`.
`render()` is the single source of truth for button labels, disabled state, layer
badges, mute latch, selected-track highlight, export enablement, and the help text.

Keyboard: `1`–`4` select, `R` primary action on the selected track, `Space` stop/resume
(ramps master to 0 before stopping, back to `state.master` on resume). Ignored while
focus is in an `input`/`select`/`textarea`.

## 7. Verification status

- `env -u LD_LIBRARY_PATH /usr/bin/node --check app.js` → passes.
- Envelope math was unit-tested in `/tmp/lt/envtest.js` (4 cases, all pass): constant
  signal fills all 200 buckets from the second block on; silence in the second half
  stays empty; an early spike survives to the end; the old formula is confirmed to draw
  4/200 buckets.
- **Not verified in a browser by the assistant.** The headless Firefox harness stopped
  posting reports mid-session and the cause was never diagnosed. The user confirmed the
  feature works ("It seems ok") after the last fix, so treat the current behaviour as
  user-verified and the harness as broken.
- **Playback-after-punch-out fix is user-verified** (2026-11-02): the first take and
  later tracks both come back at the loop position the transport has reached, with no
  full loop of silence. See §3.2.
- Nothing is committed.

## 8. Environment gotchas

- Bundled `node` is broken (GLIBCXX). Use `env -u LD_LIBRARY_PATH /usr/bin/node`. Same
  prefix for `firefox`, `magick`, `tesseract`.
- `pkill -f firefox` kills the calling shell. Use `pkill -9 -f firefox` in a separate
  call.
- Use a fresh Firefox profile dir per run (`/tmp/ffwN`) or you get "Firefox is already
  running".
- `firefox --screenshot` captures before async JS runs — useless for audio testing.
- Test scaffolding lived in `/tmp/lt/` (server on :8765 with `POST /report`, inject.js,
  probe.js, envtest.js, prefs.js). Nothing test-related is in the repo.
- **Do not run long polling/sleep loops.** The user objected twice. If browser
  verification is needed, start Firefox as a tracked background process and poll with
  short reads, or ask the user to check.

## 9. Where DESIGN.md is stale

- §4.2 says "fallback: ScriptProcessorNode". There is no fallback; the app requires
  AudioWorklet and shows a banner if it is missing.
- §4.3 says later tracks "quantize to multiples of L". They do not — they must match `L`
  exactly (within 50 ms) or the take is rejected.
- §4.5 says punch-out "stops capture at the next bar boundary (or immediately, rounded to
  the grid)". Free Mode punch-out is immediate at the last received frame; Tempo Lock
  punch-out is a no-op.
- §3 lists "How it works", FAQ, and related-tools sections. They were never built.
- §4.1 mentions equal-power crossfades at loop edges; the implementation uses a linear
  seam fold (`foldSeam`), which is sufficient at 8 ms.
- The waveform display (§3 track tiles) is not in DESIGN.md at all — it was added later.

## 10. Likely next steps

1. Commit the current work (waveform + recording-lock fixes).
2. Whatever the user asks next. The user said "a new change" is coming but has not
   described it yet — ask for the spec before touching code.
3. Optional cleanups, only if asked: reconcile DESIGN.md with reality; add a
   `ScriptProcessorNode` fallback; make the waveform axis scroll instead of stretch.
