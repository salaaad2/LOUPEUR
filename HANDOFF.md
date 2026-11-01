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
`playing`/`overdubbing`. `scheduleChannel` stops the previous source at `when` and
starts a fresh `BufferSource` at `when`. This is the standard lookahead pattern: no
`setTimeout` ever touches audio timing, so there is no drift.

`nextBoundaryTime(after)` returns the first loop boundary at or after `after`. Used for
mute ramps, later-track record starts, overdub starts, and resume.

### 3.3 Loop length and the seam fold

Every take is captured **longer** than the loop by `seamSamples(L)` (8 ms, capped at
`L/2`). `foldSeam()` crossfades the tail into the head and returns a buffer shortened
by that amount, so the loop point is continuous in value — no click.

Consequence: `loopSamples()` in Tempo Lock returns `raw - seamSamples(raw)`, i.e. the
**post-fold** length. Everything downstream (scheduler, boundary math, export) derives
from that one value. Do not "fix" the 8 ms discrepancy; it is intentional.

- **Free Mode, first take:** `armCapture(ch, startAt, Infinity, 0)` — free-running,
  length fixed at punch-out. `finishCapture` sets `state.loopLength` and back-dates
  `state.t0` to the first captured frame.
- **Free Mode, later tracks:** capture window is exactly `L + seam`, started at the next
  boundary. The take must match within `FREE_TOLERANCE` (50 ms) or it is rejected.
- **Tempo Lock:** `L = bars × 4 × (60/BPM) × sampleRate`, minus the seam. 4 clicks of
  count-in, capture arms on beat 5, auto-stops at the end of the window.

### 3.4 Capture path

`capture-worklet.js` posts `{frame, data}` per 128-sample block. `frame` is derived from
the worklet's `currentFrame` global (the AudioContext frame counter), so indices line up
with `ctx.currentTime * sampleRate`. The first block that arrives defines the real start
of the take — the predicted `startFrame` is only a lower bound.

`onCaptureFrame` copies the block into `pendingRecord.scratch` at
`frame - startFrame`, tracks `lastFrame`, folds the block into `liveEnv` (see §4), and
calls `finishCapture()` when the window is full.

### 3.5 Channel states

```
EMPTY ──record──► RECORDING ──auto/punch──► PLAYING ──overdub──► OVERDUBBING ──► PLAYING
   ▲                                                                              │
   └──────────────────────────── CLEAR (long-press) ──────────────────────────────┘
```

Per-channel object: `{index, state, buffer, gain, source, muted, layers, env, envBuffer}`.

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

- **A later Free Mode track cannot be punched out.** Its length is fixed by the first
  take; stopping early would leave a short take that cannot loop. `punchOut` shows a
  banner ("This track records for the full loop length. It stops on its own."), the
  button reads `RECORDING…` and is `disabled`, and keyboard `R` hits the same guard.
  `render()` computes this as `locked = ch.state === "recording" && pendingRecord &&
  !pendingRecord.freeMode`.
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
