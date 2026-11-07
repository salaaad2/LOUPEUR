# Loupeur — 4-track browser looper

A looper pedal in the browser (Boss RC-505 mental model). Record up to four
synced loop tracks from a microphone, overdub layers, mute and clear them, and
export the mix as a WAV. Everything runs client-side; audio never leaves the
machine. No build step, no dependencies, no backend.

```
index.html            static markup
style.css             dark DAW theme
app.js                audio engine, UI, export, waveform
capture-worklet.js    AudioWorklet that forwards mic frames
DESIGN.md             the invariants that are easy to break
```

## Running it

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

It must be `localhost` (or https). `getUserMedia` needs a secure context, and
the worklet module cannot be loaded over `file://`. A LAN IP or a hostname over
plain http has no `navigator.mediaDevices` at all and the browser greys out the
mic permission with no way to enable it. The app checks `isSecureContext` and
says so in the banner.

Desktop Chrome, Edge, Safari and Firefox. Mobile is not a target.

## Using it

| Control | What it does |
|---|---|
| Track button | State-dependent: `RECORD` → `IN n` → `STOP REC` → `OVERDUB` → `STOP DUB` |
| `MUTE` | Per-track mute, ramped at the next loop boundary |
| `CLEAR` | Long-press (~600 ms) wipes the track |
| BPM / Bars | Tempo Lock grid: 60–180 BPM, 1/2/4/8 bars |
| Mode | Free (first take sets the length) or Tempo Lock (grid + count-in) |
| Click track | Count-in and metronome, Tempo Lock only. Never recorded or exported |
| Click while recording | Keeps the metronome ticking under a take, so you can play to the grid |
| Microphone | Input picker; `Default input` follows the system default |
| Reverb / Master | Global send and output level |
| Export Mix | Renders the unmuted tracks to a 16-bit stereo WAV |

Keyboard: `R` record/punch on the selected track, `1`–`4` select a track,
`Space` stop/resume.

### The two modes

**Tempo Lock** (default) derives the loop length from BPM and bars. The first
take gets a 4-beat count-in and records exactly one loop, then stops on its own.
Later takes punch in at the next loop boundary.

**Free Mode** has no grid. The first take defines the loop length when you punch
out; every later take must match it within 50 ms or it is rejected. Mode cannot
be switched while any track holds audio or the transport runs.

### Why a record press sometimes waits

Pressing record on an empty track while a loop is already running does not start
capture immediately. The track enters `ARMED` and counts down in beats
(`IN 16` … `IN 1`) until the next loop boundary, then capture opens exactly on
the loop top. This is deliberate: it is what makes what you hear while recording
match what plays back. Pressing again before the boundary cancels the take.

A take that runs a fixed length cannot be punched out — a later Free Mode track
and an overdub both run to the end of the loop on their own. The button shows
`RECORDING…` / `DUBBING…` and is disabled.

## Testing

There is no test suite in the repo. The audio math (loop length, seam fold,
boundary and offset arithmetic, envelope) is pure and can be exercised in Node
against a stubbed Web Audio API; that is how the current behaviour was checked.
Anything involving real capture, scheduling or rendering needs a browser and a
microphone.

## Known limitations

- No live input monitoring. The mic is never routed to the output, which avoids
  feedback but means you hear yourself only through the recorded loop.
- An overdub becomes audible one loop boundary after you punch out, because the
  buffer is replaced at the boundary rather than mutated in place.
- Latency compensation uses the device's reported input latency plus a 5 ms
  margin. There is no manual offset control, so an unusual device may still land
  a few milliseconds off.
- Export renders one loop plus a 1 s reverb tail, trimmed to the loop length.
