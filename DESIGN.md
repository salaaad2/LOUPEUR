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
| 4 loop channels | Each with a big primary button cycling Record → Play → Overdub, plus small MUTE and CLEAR buttons |
| Free Mode | First take on any empty track sets the global loop length; later tracks snap to that length |
| Tempo Lock Mode | User sets BPM (60–180) and bar count (1/2/4/8); 4-beat count-in click; recording snaps to a sample-accurate bar grid; recording auto-stops at end of bar count |
| Overdub | Recording onto a channel that already has a loop layers takes on top; layer-count badge per channel |
| Mute | Per-channel mute, applied with a gain ramp at the next bar boundary (no clicks), unmute also at next bar |
| Clear | Long-press CLEAR wipes a channel (long-press prevents accidental wipes) |
| Export | Mix all unmuted channels into a single WAV download |
| Global transport | Single transport clock; all channels stay locked as a unit; tracks recorded later join playback at the next bar boundary |
| Reverb | Global on/off reverb control |
| Master | Master volume slider |
| Keyboard shortcuts | R = record/punch out, 1–4 = select/trigger track, Space = stop/resume |

## 3. UI Layout

1. **Header:** title ("Looper Pedal Online — 4-Track Browser Loop Station"), "Free Tool · No Signup" badge.
2. **Tempo section:** BPM slider (60–180, default 100), Bars-per-loop selector (1/2/4/8, default 4), click-track toggle (active in Tempo Lock only).
3. **Mode toggle:** Free Mode ↔ Tempo Lock. Switchable any time before recording.
4. **Four track tiles** (Track 1–4), each containing:
   - Large primary button — state-labeled (empty / RECORD / PLAY / OVERDUB); cycles record → play → overdub on press
   - Layer-count badge (number of takes held)
   - MUTE button (toggle, visually latched)
   - CLEAR button (requires long-press ~600ms)
5. **Output section:** Reverb ON/OFF toggle, Master volume slider (default 85), Export Mix button.
6. **Help strip:** mode description + keyboard shortcut legend (R record/punch out, 1–4 track, Space stop/resume).
7. **Supporting content (optional for parity):** "How it works" 3-step section, FAQ, related-tools cards.

Visual style: dark studio/DAW aesthetic, high-contrast record red and play green states,
large touch/click targets on the primary buttons.

## 4. Audio Engine Design

### 4.1 Core requirements
- **Tight loop seams** — no click at the loop point (apply short equal-power crossfades at loop edges, e.g. 5–10 ms).
- **Sample-accurate channel sync** — no drift over minutes. Never use `setTimeout` scheduling for audio; use the Web Audio clock (`AudioContext.currentTime`) with lookahead scheduling.
- Single `AudioContext`; one master transport the whole UI observes.

### 4.2 Capture
- `getUserMedia` on first record press (mic permission prompt).
- Disable all processing flags: `echoCancellation: false, noiseSuppression: false, autoGainControl: false` so loop edges stay clean.
- Capture with an `AudioWorklet` (fallback: `ScriptProcessorNode`) writing raw Float32 PCM into a ring buffer; the worklet timestamps its start against the AudioContext clock so the recorded start/end can be placed sample-accurately.

### 4.3 Transport clock
- Transport = fixed loop length in samples + a start time on the AudioContext clock.
- A lookahead scheduler (e.g. every 25 ms, schedule 100 ms ahead) starts `AudioBufferSourceNode`s per channel at the next loop boundary via `start(when, offset, duration)`.
- Loop length:
  - **Free Mode:** first completed take defines length L. Subsequent tracks quantize to multiples of L.
  - **Tempo Lock:** L = bars × 4 beats × (60 / BPM) seconds exactly. At 100 BPM / 4 bars = 9.6 s.
- New/changed channels join at the **next bar boundary** so changes land musically.

### 4.4 Count-in (Tempo Lock only)
- On record press: 4 clicks at the chosen BPM — accented click on beat 1, softer clicks on 2, 3, 4.
- Recording arms on beat 5 (beat 1 of the next bar). Audio during the count-in is discarded.
- Recording auto-stops after exactly `bars` of audio; loop length fixed regardless of button timing.

### 4.5 Channel states
Per channel: `EMPTY → RECORDING → PLAYING → OVERDUBBING → PLAYING → …` plus `CLEARED`.

- **Record (empty track):** capture to the track's buffer; sets transport in Free Mode; auto-stop at bar count in Tempo Lock.
- **Punch out:** pressing record while recording stops capture at the next bar boundary (or immediately, rounded to the grid).
- **Overdub:** existing loop keeps playing; new audio is mixed/summed into the same channel buffer; increment layer badge.
- **Mute:** ramp a per-channel GainNode to 0 with a short linear ramp at the next bar boundary; unmute mirrors this.
- **Clear:** long-press discards buffer, resets state/layers; if the cleared track owned the transport (Free Mode first track), transfer or recompute transport from remaining tracks.

### 4.6 Signal graph

```
mic → AudioWorklet capture (tap) ───────────────→ ring buffer → track buffers
track buffer → BufferSource → channel Gain → ┐
                                              ├→ master Gain → [Reverb send/dry] → destination
                       click synth ──────────→┘   (convolver w/ generated impulse, wet/dry mix)
```

### 4.7 Export
- Mixdown: render all unmuted channels through the same master/reverb chain using `OfflineAudioContext` (offline render of N loop iterations), encode 16-bit PCM stereo WAV, trigger download.

## 5. Non-Functional Requirements

- 100% client-side; no accounts, no upload, no backend, no analytics beyond optional page-view.
- No dependencies required; vanilla JS + Web Audio API.
- Recording latency compensation: subtract input latency (`AudioContext.baseLatency` + track `outputLatency`) from recorded start so live overdubs align with what the user heard.
- Graceful errors: unsupported browser banner; mic-permission-denied message with retry.
- Desktop-first layout (~1200px content, responsive down to ~768px).

## 6. Acceptance Criteria

1. First take on Track 1 in Free Mode defines loop length; Tracks 2–4 loop the same length in sync with no audible drift over 3+ minutes.
2. In Tempo Lock at 100 BPM / 4 bars, pressing record plays a 4-click count-in, then records exactly 9.6 s and auto-stops.
3. Loop seam is inaudible (no click/pop) on all channels.
4. Overdub on a channel preserves prior layers; layer badge increments; Clear (long-press) wipes it.
5. Mute/unmute ramps at the next bar boundary with no click.
6. Export produces a valid WAV containing the mix of all unmuted channels.
7. Keyboard shortcuts R, 1–4, Space work as described.
8. Works with mic processing flags disabled on Chrome, Edge, Safari, Firefox desktop.
9. Page loads and runs entirely client-side; no network calls after page load.

## 7. Suggested Milestones

1. Scaffold page, mic capture with processing flags off, live input monitoring.
2. Transport clock + Free Mode record/playback on Track 1 with clean seam.
3. Four channels synced to one transport; bar-boundary join; mute/clear.
4. Overdub + layer badges; punch in/out.
5. Tempo Lock: BPM/bars UI, count-in click, grid-quantized auto-stop.
6. Reverb + master volume.
7. WAV export via OfflineAudioContext.
8. Keyboard shortcuts, error/permission states, polish.
