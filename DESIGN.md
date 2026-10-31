# Design Doc — Browser 4-Track Looper Pedal ("Loop Station")

## 1. Overview

Build a free, no-signup, fully client-side web app that reproduces the features of an online
looper pedal (mental model: Boss RC-505). The user records live audio from their microphone
into up to 4 synced loop channels, overdubs layers, mutes/clears channels, and exports the
mix as a WAV. Everything runs locally in the browser via the Web Audio API; audio never
leaves the device.

Target: desktop Chrome, Edge, Safari, Firefox. Mobile is out of scope for v1.

## 2. Feature Summary

| Feature | Detail |
|---|---|
| 4 loop channels | Each with a big primary button (state-dependent action, see §4.5), plus small MUTE and CLEAR buttons |
| Free Mode | First take on any empty track sets the global loop length; later tracks must be exactly that length |
| Tempo Lock Mode | User sets BPM (60–180) and bar count (1/2/4/8); 4-beat count-in click; recording snaps to a sample-accurate bar grid; recording auto-stops at end of bar count |
| Overdub | Recording onto a channel that already has a loop layers takes on top; layer-count badge per channel |
| Mute | Per-channel mute, applied with a 10 ms gain ramp at the next loop boundary (no clicks) |
| Clear | Long-press CLEAR wipes a channel (long-press prevents accidental wipes) |
| Export | Mix all unmuted channels into a single WAV download |
| Global transport | Single transport clock; all channels stay locked as a unit; tracks recorded later join playback at the next loop boundary |
| Reverb | Global on/off reverb control |
| Master | Master volume slider |
| Keyboard shortcuts | R = record/punch out on the selected track, 1–4 = select track, Space = stop/resume |

## 3. UI Layout

1. **Header:** title ("Looper Pedal Online — 4-Track Browser Loop Station"), "Free Tool · No Signup" badge.
2. **Tempo section:** BPM slider (60–180, default 100), Bars-per-loop selector (1/2/4/8, default 4), click-track toggle (active in Tempo Lock only).
3. **Mode toggle:** Free Mode ↔ Tempo Lock. Switchable only while the transport is stopped and no channel holds audio.
4. **Four track tiles** (Track 1–4), each containing:
   - Large primary button — label and action depend on channel state (§4.5)
   - Layer-count badge (number of takes held)
   - MUTE button (toggle, visually latched)
   - CLEAR button (requires long-press ~600ms)
5. **Output section:** Reverb ON/OFF toggle, Master volume slider (default 85), Export Mix button.
6. **Help strip:** mode description + keyboard shortcut legend (R record/punch out, 1–4 select track, Space stop/resume).
7. **Supporting content (optional for parity):** "How it works" 3-step section, FAQ, related-tools cards.

Visual style: dark studio/DAW aesthetic, high-contrast record red and play green states,
large touch/click targets on the primary buttons.

## 4. Audio Engine Design

### 4.1 Core requirements
- **Tight loop seams** — no click at the loop point (see §4.8).
- **Sample-accurate channel sync** — no drift over minutes. Never use `setTimeout` scheduling for audio; use the Web Audio clock (`AudioContext.currentTime`) with lookahead scheduling.
- Single `AudioContext`; one master transport the whole UI observes.
- All lengths are computed and stored in **integer samples**. Seconds are derived for display only. Loop length is never computed by converting seconds to samples at playback time.

### 4.2 Capture
- `getUserMedia` on first record press (mic permission prompt).
- Request processing disabled: `echoCancellation: false, noiseSuppression: false, autoGainControl: false`. These are requests; browsers may ignore them. The app must function correctly either way.
- Capture with an `AudioWorklet` writing raw Float32 PCM into a ring buffer. The worklet timestamps its start against the AudioContext clock so the recorded start/end can be placed sample-accurately.
- **No `ScriptProcessorNode` fallback.** If `AudioWorklet` is unavailable, show the unsupported-browser banner and disable recording. A main-thread fallback would glitch under UI load, which is the one failure this app cannot tolerate.
- **No live input monitoring.** The mic is not routed to the destination. This avoids feedback and keeps the graph simple. (Milestone 1 therefore does not include monitoring.)

### 4.3 Transport clock
- Transport = loop length in samples `L` + a start time `t0` on the AudioContext clock.
- A lookahead scheduler (every 25 ms, schedule 100 ms ahead) starts `AudioBufferSourceNode`s per channel at the next loop boundary via `start(when, offset, duration)`.
- Loop length:
  - **Tempo Lock:** `L = round(bars × 4 × 60 / BPM × sampleRate)` samples, computed once when recording starts. At 100 BPM / 4 bars / 48 kHz = 460800 samples (9.6 s); at 44.1 kHz = 423360 samples.
  - **Free Mode:** the first completed take defines `L`. During that take there is no grid, no metronome, and no loop boundary. On punch-out, `L` is fixed to the recorded length (after the seam fold in §4.8) and `t0` is back-dated to the recording start. A take shorter than 0.5 s is rejected with a message and the channel returns to EMPTY.
- **Later tracks in Free Mode must be exactly `L`.** A take that is not within ±50 ms of `L` is rejected with a message; the channel returns to its prior state. There is no stretching, padding, or multiple-of-L quantization.
- **Boundary definition.** "Next loop boundary" means the next multiple of `L` after now. In Tempo Lock, "next bar boundary" means the next multiple of `L / bars`. In Free Mode there are no bars; every boundary is a loop boundary.
- New/changed channels join at the **next loop boundary** (Tempo Lock: next bar boundary, so changes land musically).

### 4.4 Count-in (Tempo Lock only)
- On record press: 4 clicks at the chosen BPM — accented click on beat 1, softer clicks on 2, 3, 4.
- The transport is (re)started at the end of the count-in: `t0` is set to the time of the 5th beat, which is beat 1 of the first recorded bar. This guarantees the recorded region is phase-aligned with the grid.
- Recording arms at `t0`. Audio during the count-in is discarded.
- Recording auto-stops after exactly `L` samples; loop length is fixed regardless of button timing.
- The click is synthesized into the master chain (see §4.6) and is never written into a track buffer and never included in export.

### 4.5 Channel states

Per channel: `EMPTY → RECORDING → PLAYING → OVERDUBBING → PLAYING → …` plus `CLEARED` (which is `EMPTY` with the buffer discarded).

Primary button behavior, by current state:

| State | Button label | Press action |
|---|---|---|
| EMPTY | RECORD | Start recording (Tempo Lock: count-in first) |
| RECORDING | STOP REC | Punch out (Tempo Lock: at next bar boundary; Free Mode: immediately, tail trimmed to `L`) |
| PLAYING | OVERDUB | Start overdub at next loop boundary |
| OVERDUBBING | STOP DUB | Punch out of overdub at next loop boundary; layer badge increments |
| MUTED (any of the above) | same as underlying state | Mute does not change the primary action |

- **Record (empty track):** capture to the track's buffer; in Free Mode sets `L` and `t0`; in Tempo Lock auto-stops at `L`.
- **Punch out:** as in the table. Free Mode punch-out is immediate and the take is trimmed to `L`; if the take is shorter than `L` it is rejected per §4.3.
- **Overdub:** the existing loop keeps playing; new audio is summed into the channel at the next loop boundary (see §4.7 for the buffer model). Layer badge increments on punch-out.
- **Mute:** ramp the per-channel GainNode to 0 over 10 ms starting at the next loop boundary; unmute mirrors this. Mute is a gain change only — it never touches buffers.
- **Clear:** long-press discards the buffer, resets state and layers. If the cleared track owned the transport in Free Mode, `L` and `t0` are recomputed from the remaining tracks; if none remain, the transport stops and `L` is undefined again.

### 4.6 Signal graph

```
mic → AudioWorklet capture ──→ ring buffer ──→ track buffers (never to destination)

track buffer → BufferSource → channel Gain ─┐
                                            ├→ master Gain → dry ──────────────┐
click synth ────────────────────────────────┤                                  ├→ destination
                                            └→ reverb send → convolver → wet ─┘
```

- Reverb is a send/return with a generated impulse response. ON/OFF is a 20 ms wet/dry crossfade, not a node disconnect, so toggling never clicks.
- The click synth enters after the channel gains and before master, so it is audible but never recorded or exported.

### 4.7 Channel buffer model (overdub)

Simplest workable model: **one buffer per channel, replaced at the loop boundary.**

- A channel holds a single `AudioBuffer` of exactly `L` samples.
- Overdub records into a scratch buffer. At the next loop boundary the scratch is summed into a **copy** of the channel buffer, and the copy replaces the channel buffer. The currently playing `BufferSource` keeps playing the old buffer until its scheduled end; the new buffer is used by the next scheduled source.
- Buffers are never mutated while a source is playing them. No double-buffering beyond the single copy above, no per-layer buffers, no graph-level summing.
- Consequence: an overdub becomes audible at the loop boundary after the one where it was punched out. This is accepted.

### 4.8 Loop seam

- The seam is fixed **once, destructively, at punch-out**, not at playback time.
- Fold the last `N` samples of the take over the first `N` samples with an equal-power crossfade, `N = round(0.008 × sampleRate)` (8 ms). The result is a buffer of exactly `L` samples whose end and start match.
- `L` is defined as the post-fold length. In Free Mode, `L` is the recorded length rounded to samples, then the fold is applied within it.
- Overdubs are summed into an already-seam-fixed buffer, so no further seam work is needed per layer.

### 4.9 Transport stop / resume (Space)

- **Stop:** cancel all scheduled sources, ramp master to 0 over 10 ms, set transport state to STOPPED. Channel states and buffers are preserved.
- **Resume:** ramp master back up over 10 ms and set `t0` to the next loop boundary from now. All channels restart at offset 0 of their buffers. Phase is not preserved across a stop; the loop restarts from the top.

### 4.10 Export
- Render with `OfflineAudioContext` at the same sample rate, using the same channel gains (mute states applied), the same master gain (slider value baked in), and the same reverb send/wet level.
- Render **one loop plus a 1 s tail** to capture reverb decay, then trim to exactly `L` samples.
- Encode 16-bit PCM stereo WAV and trigger a download.
- The click is not part of the export.

## 5. Non-Functional Requirements

- 100% client-side; no accounts, no upload, no backend, no analytics beyond optional page-view.
- No dependencies required; vanilla JS + Web Audio API.
- `AudioContext` is created on the first user gesture and resumed if suspended (required by Safari).
- **Latency compensation:** subtract the round-trip latency `inputLatency + outputLatency` from the recorded start when aligning a take to the transport. `inputLatency` comes from the `MediaStreamTrack` settings where available; `outputLatency` is not implemented in Safari, so fall back to `baseLatency` there. If neither is available, use 0 and expose a manual offset in the UI (advanced, default 0).
- Graceful errors: unsupported browser banner (no AudioWorklet, no getUserMedia); mic-permission-denied message with retry.
- Desktop-first layout (~1200px content, responsive down to ~768px).

## 6. Acceptance Criteria

1. First take on Track 1 in Free Mode defines loop length; Tracks 2–4 loop the same length in sync with no audible drift over 3+ minutes. Verified by recording a click on Track 1 and Track 2, exporting, and measuring the offset in samples (must be 0).
2. In Tempo Lock at 100 BPM / 4 bars, pressing record plays a 4-click count-in, then records exactly `L` samples (460800 at 48 kHz, 423360 at 44.1 kHz) and auto-stops.
3. Loop seam is inaudible (no click/pop) on all channels.
4. Overdub on a channel preserves prior layers; layer badge increments; Clear (long-press) wipes it.
5. Mute/unmute ramps at the next loop boundary with no click.
6. Export produces a valid WAV containing the mix of all unmuted channels, with master volume applied and no click track.
7. Keyboard shortcuts R, 1–4, Space work as described.
8. App requests mic processing disabled and functions correctly on Chrome, Edge, Safari, Firefox desktop regardless of what the browser grants.
9. Page loads and runs entirely client-side; no network calls after page load.

## 7. Suggested Milestones

1. Scaffold page, mic capture with processing flags off, AudioWorklet ring buffer, unsupported-browser and permission-denied states.
2. Transport clock + Free Mode record/playback on Track 1 with seam fold. **Decide and implement the single-buffer channel model (§4.7) here**, since it constrains everything downstream.
3. Four channels synced to one transport; loop-boundary join; mute/clear.
4. Overdub + layer badges; punch in/out.
5. Tempo Lock: BPM/bars UI, count-in click, grid-quantized auto-stop.
6. Reverb + master volume.
7. WAV export via OfflineAudioContext.
8. Keyboard shortcuts, stop/resume, polish.
