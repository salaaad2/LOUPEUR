# Loupeur — browser looper

A looper pedal in the browser (Boss RC-505 mental model). Record up to eight
synced loop tracks from a microphone, overdub layers, mute and clear them, and
export the mix or the sequencer arrangement as a WAV. Copy a track to the
sequencer to arrange it over a 4/8/16/32-loop pattern. Everything runs
client-side; audio never leaves the machine. No build step, no dependencies, no
backend.

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
| Track volume | Per-track level, applied to playback and to the export |
| Add track | Appends an empty track, up to eight |
| `REMOVE` | Drops a track that holds no audio; disabled once it has a take |
| BPM / Bars | Tempo Lock grid: 60–180 BPM, 1/2/4/8 bars |
| Mode | Free (first take sets the length) or Tempo Lock (grid + count-in) |
| Playback mode (header) | `LOOP` plays every track every loop; `SEQUENCE` plays only the slots the grid has filled |
| `COPY TO SEQ` | Adds the track to the sequencer as a row; press again to remove it |
| Sequencer slot | One full loop. Click to fill (`X`) or empty it |
| Sequencer slots | 4/8/16/32 slots per pattern; each slot is one full loop |
| Loop pattern | On: the pattern repeats. Off: the pattern plays once and stops the transport |
| Click track | Count-in and metronome, Tempo Lock only. Never recorded or exported |
| Click while recording | Keeps the metronome ticking under a take, so you can play to the grid |
| Microphone | Input picker; `Default input` follows the system default |
| Reverb / Master | Global send and output level |
| Export Mix | Renders the unmuted tracks to a 16-bit stereo WAV, one loop long |
| Export Sequence | Renders one pass of the sequencer pattern to a 16-bit stereo WAV |
| Export tracks separately | One `track{n}.wav` per track that holds audio, into a folder you pick, or as downloads where the folder picker is unavailable |

Keyboard: `R` record/punch on the selected track (LOOP mode only), `1`–`8`
select a track, `Space` stop/resume.

### The two recording modes

**Tempo Lock** (default) derives the loop length from BPM and bars. The first
take gets a 4-beat count-in and records exactly one loop, then stops on its own.
Later takes punch in at the next loop boundary.

**Free Mode** has no grid. The first take defines the loop length when you punch
out; every later take must match it within 50 ms or it is rejected. Mode cannot
be switched while any track holds audio or the transport runs.

### LOOP and SEQUENCE

The switch in the header is the playback mode, and it is independent of the
recording mode above. The header badge and border show the current mode: green
for **LOOP**, amber for **SEQUENCE**.

**LOOP** is the original behaviour: every track plays every loop, and the
sequencer grid is inert. You can still fill it; you just cannot hear it.

**SEQUENCE** plays only what the grid says. A track with no row is silent and
its tile is dimmed. A track with a row is heard on the slots that row has
filled, and silent on the rest.

A slot is one full loop, so the pattern is 4, 8, 16 or 32 loops long, chosen by
the **Slots** control in the sequencer header. The step clock is the transport
clock divided by the loop length, which means the grid cannot drift against the
audio. Filling the slot that is playing is heard immediately; a slot that is
still ahead is picked up when its boundary arrives.

`COPY TO SEQ` is a copy, not a move: the track keeps its audio, its level and
its mute, and the row is a view of it. An overdub is heard through the row
without copying again, and clearing the track drops the row with it.

**Export Sequence** renders one pass of the pattern, not one loop: each row's
filled slots gate its track for the whole pattern, with the same mute, level,
reverb and master as **Export Mix**. `Loop pattern` is a playback setting; the
file always contains one pass. The button is disabled until at least one
unmuted row has a filled slot.

Recording is a LOOP mode action. In SEQUENCE mode the record button reads
`LOOP ONLY`, because a take recorded there would be silent until it was copied
to the grid.

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

```
node test/run.js
```

No dependencies, no build step. `test/harness.js` loads `app.js` into a `vm`
context with a stubbed DOM and Web Audio API and hands back the internals a test
needs to drive capture directly, so the audio math (loop length, seam fold,
boundary and offset arithmetic, envelope) runs in Node.

The capture tests assert four properties that do not depend on knowing the true
latency of the hardware:

1. **The anchor is honoured.** Blocks that start after the prediction do not move
   the take, and the head between the two stays zero.
2. **The tail survives.** The last wanted sample is present after the take
   commits, including when the take ends on a block boundary.
3. **The display agrees with the audio.** The buffer index of a peak and the x
   position the waveform gives that sample refer to the same fraction of the take.
4. **A committed take enters at the loop top.** The source starts at the position
   the transport has reached, with the offset converted to the seconds `start()`
   wants, so a track recorded over a running loop is not left behind the one it
   was played against.

The calibration tests cover the measurement itself: a known round trip comes back
as that round trip, silence is reported as no measurement rather than as zero,
one bad burst does not move the robust estimate, a stored measurement replaces
the estimate, the offset is stored per device, and the readout shows the number
in force.

The level tests cover the per-track gain: the slider sets it, mute overrides it,
a volume move during a pending mute lands on the mute's boundary, and a cleared
track comes back at its own level rather than at full scale.

The stem tests cover the selection and the naming: one file per track that holds
audio, numbered by track so an empty track leaves a gap, a muted track still
gets a file, and the download fallback used where the folder picker is missing.

The sequence export tests cover the selection and the gate schedule: only tracks
with a filled row and no mute are included, an all-empty row is skipped, and the
gate holds through runs and ramps only when the value changes.

The sequencer tests cover the step clock and the gate: a slot is one full loop,
the pattern length can be 4/8/16/32 and rows are padded or truncated when it
changes, a time before the transport starts reads as the first slot, LOOP mode
plays every track, SEQUENCE mode silences a track with no row, the gate follows
the filled slots and repeats, the gate ramps on the boundary rather than
mid-loop, a pattern that does not loop stops the transport after its last slot,
copying and clearing a track add and drop its row, the mode switch waits for a
live take, and the gate is a separate node so mute and volume keep their
meaning. Three of them pin the timing hazards that made a track play on the
wrong slot: a boundary that floors to the previous slot, a gate refresh that
drops the boundary ramp the scheduler had queued, and a boundary the scheduler
reached late.

The track tests cover the parallel arrays: adding grows the channels, volumes
and rows; the add control stops at eight; removing an empty track splices all
three and rewrites the channel indices; and a track with audio or the last
remaining track cannot be removed.

They assert internal consistency, not an absolute offset, which is why they hold
on any device. Anything involving real capture, scheduling or rendering still
needs a browser and a microphone.

## Known limitations

- No live input monitoring. The mic is never routed to the output, which avoids
  feedback but means you hear yourself only through the recorded loop.
- An overdub becomes audible one loop boundary after you punch out, because the
  buffer is replaced at the boundary rather than mutated in place.
- Latency compensation is only as good as the calibration. Until you run
  **Calibrate**, the shift falls back to the device's reported input latency plus
  `outputLatency`, which is a lower bound: a phone used as a mic over ADB or a
  Bluetooth bridge still lands late. Run **Calibrate** once per microphone. The
  offset applies to every take on every track, including the first one, and the
  readout next to the Latency label always shows the number in force.
- Export Mix and the stems render one loop plus a 1 s reverb tail, trimmed to
  the loop length.
- **Export Mix and the stems ignore the sequencer pattern.** They render one
  loop of the tracks, not the arrangement: a track that plays on slots 1 and 3
  appears once in the file. Use **Export Sequence** for one pass of the grid.
- **Export tracks separately prefers a folder, and falls back to downloads.**
  The folder path uses the File System Access API (`showDirectoryPicker`).
  Firefox and Safari do not have it, and Brave turns it off by default
  (`brave://flags/#file-system-access-api`). Without it the checkbox saves the
  same `track{n}.wav` files as individual downloads, so the names and the
  numbering are identical either way.
