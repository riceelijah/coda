# Coda — design

Coda is an open-source, browser-only music notation editor for people who used a simple
free notation program and need somewhere to go. It runs as a static site on GitHub Pages.

This document is the source of truth for *what* to build and *how the pieces fit*.
`docs/PLAN.md` says *in what order*. If the two disagree, this file wins; fix PLAN.md.

Markers used below:
- **[verified]** — checked against a primary source or the actual library build.
- **[expected]** — believed correct, not yet confirmed. Confirm before relying on it, then
  change the marker in this file.

---

## 1. Hard constraints

1. **Static only.** No server, no build step, no bundler, no framework, no `package.json`.
   Plain ES modules loaded by `index.html`. It must work when served from a subpath
   (`https://user.github.io/coda/`), so every path is **relative** (`./app.js`, never `/app.js`).
2. **Three vendored dependencies, pinned, committed to `vendor/`:**
   - VexFlow **4.2.3**, file `build/cjs/vexflow.js` (MIT; embeds the Bravura font, OFL). Classic
     `<script>`, exposes global `Vex`. Use `const VF = Vex.Flow`.
   - fflate **0.8.2**, file `umd/index.js` (MIT). Classic `<script>`, exposes global `fflate`.
   - wasm-media-encoders **0.7.0** (MIT loader `dist/umd/WasmMediaEncoder.min.js` and `wasm/mp3.wasm`,
     LAME, LGPL), for MP3 export only; `src/mp3.js` adds the script the first time it's needed.
   Do not add others without asking the user.
3. **No third-party branding.** The words "Finale", "NotePad", "MakeMusic" must not appear in the
   UI, the page title, icons, or file names. They may appear only (a) in the README's
   compatibility table and "not affiliated" line and (b) in the user-facing message explaining
   which file formats can be opened. No copied icons, layouts, or fonts. The UI is original.
4. **Licence:** MIT.
5. **Never lose user work.** Every edit autosaves. Any import that drops or approximates
   something says so in a report (§9.6). Nothing fails silently.
6. **Files and saved data are untrusted input.** Title, composer, staff names, file names and
   report warnings come from opened files or from `localStorage`. They reach the page through
   `textContent` (or VexFlow text drawing) only — **never `innerHTML`** or string-built markup.
   Refuse files larger than 50 MB before reading them, and refuse a zip whose entry to be
   decoded is larger than 200 MB uncompressed. XML is parsed with `DOMParser` only.
7. **Network:** the only runtime fetches are instrument audio (§13): MP3 files from the
   FluidR3_GM set, from jsDelivr pinned to one commit of `gleitz/midi-js-soundfonts`, then
   `gleitz.github.io` as a fallback. Audio data only — never the `*-mp3.js`/`*-ogg.js` script
   files. Scores are never uploaded, and everything works without these hosts (triangle-wave
   fallback).

---

## 2. File layout

```
index.html          markup, CSS, <dialog>s, script tags
src/model.js        PURE. score model, tick math, pitch math, edit commands. No DOM, no VexFlow.
src/render.js       model -> SVG via VexFlow; returns hit-test geometry
src/play.js         WebAudio playback
src/app.js          UI wiring: toolbar, palette, mouse, keyboard, undo, autosave, file open/save
src/demo.js         demo score for `?demo` (exercises every rendering case)
src/io/util.js      shared import helpers: text decoding, safe XML parse, size-capped unzip, Report
src/io/open.js      format sniffing + dispatch
src/io/musicxml.js  MusicXML import + export, MXL unzip
src/io/midi.js      Standard MIDI File import
src/io/mscz.js      MuseScore .mscz / .mscx import
src/io/musx.js      .musx decode + EnigmaXML import
vendor/vexflow.js   vendor/fflate.js   vendor/README.md (versions, source URLs, licences)
test.html           loads src modules, runs assert checks, shows PASS/FAIL
src/io/tests*.js    file-format checks loaded by test.html (one module per phase)
samples/            small test files, one or more per format
docs/DESIGN.md  docs/PLAN.md
README.md  LICENSE  .nojekyll  .gitignore  CLAUDE.md  .claude/launch.json
```

`model.js` being pure is a rule, not a preference: it is what makes `test.html` simple and
what lets every importer be tested by comparing plain objects.

---

## 3. Score model

Plain JSON. No classes. This exact shape is used for autosave, undo snapshots, and tests.

```js
score = {
  title: "Untitled",
  composer: "",
  tempo: 100,                    // quarter notes per minute, from bar 1 (later changes: §29)
  measures: [                    // one entry per bar, shared by all staves
    { key: 0, time: [4, 4] },    // bar 0 MUST have both
    {},                          // later bars: only set key/time where it CHANGES
  ],
  staves: [
    {
      name: "Piano",
      clef: "treble",            // "treble" | "bass" | "alto" | "tenor"
      brace: true,               // true = braced with the NEXT staff (grand staff). Default false.
      bars: [ [event, ...], [] ] // bars.length === score.measures.length  (INVARIANT)
    }
  ]
}

event = {
  dur: "q",                      // "w" | "h" | "q" | "8" | "16" | "32"
  dots: 0,                       // 0 | 1 | 2
  pitches: [ {step, oct, alter} ],   // EMPTY ARRAY = rest. Sorted low to high. No duplicates.
  tie: false,                    // true = tied to the NEXT event in this staff
  tup: [3, 2]                    // optional. [actual, normal]. Absent for ordinary notes.
}

pitch = {
  step: 0..6,                    // 0=C 1=D 2=E 3=F 4=G 5=A 6=B
  oct: 4,                        // scientific octave; C4 = middle C
  alter: 0                       // -2..2, ABSOLUTE sounding alteration (MusicXML meaning)
}
```

Key points:

- `key` is the number of fifths: `-7..7` (negative = flats). `time` is `[numerator, denominator]`.
- **`alter` is the real pitch, not "which accidental is printed".** F♯ in G major is
  `{step:3, oct:4, alter:1}`. Which accidentals get printed is decided at render time by
  VexFlow from the key and the bar's context (§5.4). Importers, playback and export therefore
  never need accidental-carrying logic.
- The effective key/time of bar `i` is the most recent one set at or before `i`.
  Provide `attrsAt(score, i) -> {key, time}`.

### 3.1 Ticks

`PPQ = 480` ticks per quarter note. Durations are stored symbolically; ticks are derived.

```
base ticks:  w 1920   h 960   q 480   8 240   16 120   32 60
dots:        1 dot ×1.5      2 dots ×1.75
tuplet:      × normal / actual       (triplet eighth = 240 × 2/3 = 160)
barCapacity(time) = time[0] × (1920 / time[1])        // 4/4 → 1920, 6/8 → 1440, 3/4 → 1440
```

These are integers for every plain and dotted value and for the common tuplets. The model only
ever holds a `tup` whose tick value is a whole number: **an importer keeps `tup` only when
`baseTicks × dotFactor × normal / actual` is an integer** (true for 3:2, 5:4, 6:4 on every value;
false for e.g. 7:4 on an eighth). Otherwise it drops `tup` from those notes, keeps their written
values, and reports "N notes in unsupported tuplets". `eventTicks(event)`, `barTicks(bar)`,
`barCapacity(time)` live in `model.js`.

### 3.2 Bar rules

- **Edits may never make a bar overfull.** A command that would exceed capacity is rejected
  and the status bar says "Bar is full".
- **Underfull and empty bars are legal** at all times (this is how the user works left to right).
- **Imported bars may be over- or under-full** (pickup bars, things we approximated). The
  renderer must tolerate any bar without throwing (§5.3). Do not "fix" imported bars.
- An empty bar is drawn with a centred whole-bar rest. That rest is not in the model.

### 3.3 Pitch helpers (in `model.js`)

```
diatonic(p)      = p.oct * 7 + p.step                       // C4 = 28, E4 = 30
fromDiatonic(d)  = { step: ((d % 7) + 7) % 7, oct: Math.floor(d / 7) }
midi(p)          = 12 * (p.oct + 1) + [0,2,4,5,7,9,11][p.step] + p.alter     // C4 = 60
keyAlter(key, step):
    sharps order (steps): [3,0,4,1,5,2,6]   (F C G D A E B)
    flats  order (steps): [6,2,5,1,4,0,3]   (B E A D G C F)
    key > 0 and step is in the first  key  sharps → +1
    key < 0 and step is in the first -key  flats  → -1
    otherwise 0
```

### 3.4 Edit commands (in `model.js`, each a pure function `(score, args) -> {ok, score|reason}` or mutate-in-place on a clone — pick one style and keep it)

| Command | Behaviour |
|---|---|
| `appendEvent(staff, bar, event)` | Adds at the end of the bar. Rejects if it would overfill. |
| `toggleChordPitch(staff, bar, idx, pitch)` | On a note: add the pitch, or remove it if a pitch with the same step+oct exists. Removing the last pitch turns the event into a rest. On a rest: makes it a note. |
| `deleteEvent(staff, bar, idx)` | Removes the event; later events in the bar shift left. Clears `tie` on the event before it. |
| `transpose(staff, bar, idx, steps)` | Moves every pitch by `steps` diatonic steps; each pitch's `alter` becomes `keyAlter` for its new step. |
| `setAlter(staff, bar, idx, alter)` | Sets `alter` on every pitch of the event. |
| `setDuration(staff, bar, idx, dur, dots)` | Rejects if the bar would overfill. |
| `toggleTie(staff, bar, idx)` | Only allowed when the next event (possibly in the next bar) is a note sharing at least one pitch. |
| `addMeasure(afterIdx)` / `deleteMeasure(idx)` | Acts on **all** staves and `score.measures` together. Cannot delete the last remaining bar. If bar 0 is deleted, the new bar 0 inherits key and time. |
| `setAttrs(barIdx, {key?, time?})` | Sets a key/time change at a bar. Rejects a time change that would overfill existing bars up to the next time change. |
| `newScore(opts)` | Builds a score from the setup dialog (§6.4). |

`app.js` wraps every command in one `edit(fn)` helper: snapshot for undo → run → re-render →
autosave. No code path mutates the score outside `edit`.

---

## 4. UI

### 4.1 Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Coda   New  Open  Save  Print │ ↶ ↷ │ ▶ Play  ■ Stop  ♩=[100] │ + Bar  − Bar  │  top bar
├────┬─────────────────────────────────────────────────────────────────────────┤
│ 𝅝  │                                                                         │
│ 𝅗𝅥  │        ┌───────────────────────────────────────────────────┐            │
│ ♩  │        │                    Title                          │            │
│ ♪  │        │                              Composer             │            │
│ 16 │        │  system 1 (one <svg>)                             │            │
│ 32 │        │  system 2 (one <svg>)                             │   desk     │
│ ── │        │  ...                                              │            │
│ 𝄽  │        └───────────────────────────────────────────────────┘            │
│ .  │                    the "sheet": white, centred, shadow                  │
│ ♯♭♮│                                                                         │
│ ⌒  │                                                                         │
├────┴─────────────────────────────────────────────────────────────────────────┤
│ Bar 3 · Staff 1 · Quarter note        Click to add · A–G to type · ? for help │  status bar
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Top bar**: file actions, undo/redo, transport, tempo number input, add/remove bar.
- **Left palette** (vertical, 56px wide): six duration buttons (radio group, exactly one active),
  then toggles: Rest, Dot, then accidentals Sharp / Flat / Natural (at most one active; none
  active = "follow the key signature"), then Tie.
- **Sheet**: a white page, max-width 1100px, on a neutral "desk" background. Title and composer
  are real text elements at the top; clicking either opens the setup dialog.
- **Status bar**: left = where the caret is and what is armed; right = one-line hint or the most
  recent message ("Bar is full"). Messages are also announced via `aria-live="polite"`.
- Below 800px wide the palette becomes a horizontal strip under the top bar. Phone-quality
  editing is not a goal; the page must still be readable and scrollable there.

### 4.2 Visual language

- Chrome follows `prefers-color-scheme`; **the sheet is always white with black ink**.
- CSS custom properties on `:root`: `--desk`, `--chrome`, `--chrome-text`, `--border`,
  `--accent` (selection + active buttons, one blue), `--danger`. Dark values under
  `@media (prefers-color-scheme: dark)`.
- System font stack for chrome. Title on the sheet uses a serif stack
  (`Georgia, "Times New Roman", serif`).
- **Palette icons are small hand-written inline SVGs** (an ellipse notehead, a stem line, flag
  paths, a rest squiggle). Do not use Unicode music characters (font support is unreliable)
  and do not copy icons from any other product.
- Every button has `aria-label` and a `title` that includes its shortcut. Toggle buttons use
  `aria-pressed`. Visible focus rings.

### 4.3 Print

`@media print`: hide top bar, palette, status bar, desk background and shadow; sheet at full
width; each system `<svg>` wrapper has `break-inside: avoid`. Selection highlight is not printed.
"Print" calls `window.print()`; saving as PDF is done from the browser's print dialog.

---

## 5. Rendering (`src/render.js`)

`render(score, container, selection) -> hitMap`. Clears the container and redraws everything.
Full redraw on every edit is intentional; optimise only if a real score is slow.

### 5.1 One `<svg>` per system

Each system (one line of music across all staves) is its own VexFlow renderer in its own
`<div class="system">`. This makes page breaks trivial for printing and keeps hit-testing local.

### 5.2 Layout algorithm

```
SHEET_W   = 1020            // drawable width inside the sheet padding
STAFF_GAP = 95              // vertical distance between staff tops within a system
SYS_PAD   = 40 top, 50 bottom
LEFT_PAD  = 20              // room for brace / connector

minWidth(bar i) = max(150, 50 + 30 × (largest event count among staves in bar i))
prefix(system)  = 55 + 13 × |key| + 35          // clef + key signature + time signature
                  (time signature is only drawn on the first system and at changes; using the
                   same constant everywhere is fine)

Greedy: add bars to the current system while  prefix + Σ minWidth ≤ SHEET_W − LEFT_PAD.
        A system always takes at least one bar.
Justify: stretch every bar in the system by the same factor so the system fills SHEET_W,
         EXCEPT the last system when it is less than 60% full (leave it ragged).
```

The first bar of each system is given `minWidth + prefix`. After creating its stave, read the
true note start with `stave.getNoteStartX()`; across the staves of a system take the **max**
and call `stave.setNoteStartX(max)` on all of them so notes line up vertically.

### 5.3 Drawing a system

For each system, for each bar, for each staff:

1. `stave = new VF.Stave(x, y, width)`. On the first bar of the system add clef and key
   signature; add the time signature on the very first bar of the score and wherever `time`
   changes; add a key signature wherever `key` changes. Last bar of the score:
   `stave.setEndBarType(VF.Barline.type.END)`.
2. Convert events to `VF.StaveNote`s (§5.4). Empty bar → one centred whole rest.
3. `voice = new VF.Voice({num_beats: time[0], beat_value: time[1]}).setMode(VF.Voice.Mode.SOFT)`
   then `voice.addTickables(notes)`. **SOFT mode is mandatory**: it is what makes underfull and
   overfull bars render instead of throwing.
4. `VF.Accidental.applyAccidentals([voice], keyName)` — prints exactly the accidentals needed.
5. `beams = VF.Beam.generateBeams(notes)` (before drawing; skip rests-only bars).
6. Build `VF.Tuplet`s for runs of events that have `tup` (§5.5).

Then per bar, across **all staves together** so they align:
`new VF.Formatter().joinVoices([v1]).joinVoices([v2])…format(allVoices, usableWidth)` where
`usableWidth = stave.getNoteEndX() − stave.getNoteStartX() − 10`. Then draw staves, voices,
beams, tuplets, ties.

Per system: left connector `SINGLE_LEFT` joining top and bottom staves when there is more than
one staff; a `BRACE` connector for each staff with `brace: true` and the staff below it.

Wrap the body of "draw one system" in `try/catch`. On an exception, draw the empty staves for
that system, and put "Could not draw bars N–M" in the status bar. One bad bar must never blank
the whole score.

### 5.4 Event → StaveNote

```
keys      = pitches.map(p => "cdefgab"[p.step] + accidentalSuffix(p.alter) + "/" + p.oct)
            accidentalSuffix: -2 "bb", -1 "b", 0 "n", 1 "#", 2 "##"
            (always include the suffix, including "n"; applyAccidentals decides what to print)
duration  = dur + "d".repeat(dots) + (rest ? "r" : "")          // "q", "8d", "hr", "16ddr"
rest key  = "b/4" for treble, "d/3" for bass, "c/4" for alto, "a/3" for tenor
note      = new VF.StaveNote({ clef, keys, duration, auto_stem: true })
dots      : for i in 0..dots-1 → VF.Dot.buildAndAttach([note], { all: true })
whole-bar rest (empty bar): new VF.StaveNote({ clef, keys:[restKey], duration:"wr", align_center:true })
selected  : note.setStyle({ fillStyle: accent, strokeStyle: accent })
```

Key signature name for VexFlow:
`["Cb","Gb","Db","Ab","Eb","Bb","F","C","G","D","A","E","B","F#","C#"][key + 7]`.

Ties: for an event with `tie: true`, draw
`new VF.StaveTie({ first_note, last_note, first_indices, last_indices })` for each pitch that
also exists in the next event. If the next event is on the next system, draw two half ties:
one with `last_note: null` at the end of this system, one with `first_note: null` at the start
of the next.

**API caution.** These names were checked to exist in the vendored 4.2.3 build:
`Stave`, `StaveNote`, `Voice` (+`Mode.SOFT`), `Formatter` (+`formatToStave`), `Beam.generateBeams`,
`Accidental.applyAccidentals`, `Dot.buildAndAttach`, `StaveConnector`, `StaveTie`, `Tuplet`,
`getYForLine`, `getSpacingBetweenLines`, `getNoteStartX`, `setNoteStartX`, `getNoteEndX`,
`getAbsoluteX`, `setEndBarType`, `setStyle`, `align_center`, `auto_stem`. **[verified by name]**
Exact argument shapes are **[expected]**: when a call misbehaves, test it in the browser
console against the vendored file rather than guessing, and correct this section.

### 5.5 Tuplets (display only)

Walk a bar's events; collect a run of consecutive events with the same `tup`. Close the run
when its total ticks is a whole multiple of `baseTicks(firstEvent.dur) × normal`, or when the
ratio changes, or at the end of the bar. Each closed run →
`new VF.Tuplet(runNotes, { num_notes: actual, notes_occupied: normal })`.
There is no UI for *entering* tuplets yet; they arrive only from imports.

### 5.6 Hit map

`render` returns, for every drawn staff-bar cell:

```js
{ sys, staff, bar,
  svg,                      // the system's <svg> element
  x0, x1,                   // horizontal extent of the stave, SVG units
  yTop, yBottom,            // y of top line (getYForLine(0)) and bottom line (getYForLine(4))
  spacing,                  // getSpacingBetweenLines()
  notes: [ { idx, x } ]     // x = note.getAbsoluteX() for each event in the bar
}
```

---

## 6. Interaction (`src/app.js`)

### 6.1 State

```js
state = {
  score,
  caret: { staff: 0, bar: 0 },     // where typed notes go
  sel:   null | { staff, bar, idx },
  armed: { dur: "q", dots: 0, rest: false, alter: null /* null|-1|0|1 */ },
  undo: [], redo: []               // arrays of JSON strings, undo capped at 200
}
```

### 6.2 Mouse

1. Convert the click to SVG coordinates of the system that was clicked:
   `r = svg.getBoundingClientRect(); sx = (clientX − r.left) × (viewBoxWidth / r.width)`,
   same for y. (The SVG may be scaled by CSS; never assume 1:1.)
2. Pick the staff whose band contains y. Band boundaries are the midpoints between adjacent
   staves; the top and bottom bands extend to the system edges.
3. Pick the bar whose `x0..x1` contains x. Set `caret` to that staff/bar.
4. Compute the pitch:
   ```
   pos      = Math.round((yBottom − y) / (spacing / 2))        // diatonic steps above the bottom line
   pos      = clamp(pos, −10, 18)
   d        = BOTTOM_LINE[clef] + pos
              BOTTOM_LINE = { treble: 30 (E4), bass: 18 (G2), alto: 24 (F3), tenor: 22 (D3) }
   {step, oct} = fromDiatonic(d)
   alter    = armed.alter ?? keyAlter(currentKey, step)
   ```
5. If an existing event's `x` is within 14 SVG units of the click:
   - plain click → select it (no model change);
   - **Shift**+click → `toggleChordPitch` with the computed pitch.
6. Otherwise → `appendEvent` in that bar with the armed duration (a rest if `armed.rest`).
   The new event becomes the selection. If rejected: "Bar is full".

While the mouse moves over a staff, draw a faint ghost notehead at the snapped position (an
absolutely positioned element over the SVG is fine). It is the main affordance that tells the
user where the note will land.

Notes are always added at the **end** of a bar's content. Inserting in the middle of a bar is
out of scope for now.

### 6.3 Keyboard

Ignored while focus is in an input or a dialog is open.

| Key | Action |
|---|---|
| `A`–`G` | Enter that note with the armed duration at the caret. Octave: the one that puts it closest to the previous note in this staff (tie → the lower); with no previous note, closest to the middle line of the clef. If the caret bar is full, move the caret to the next bar first, adding a bar at the end of the score if needed. |
| `R` | Enter a rest of the armed duration (same auto-advance). |
| `7` `6` `5` `4` `3` `2` | Arm whole, half, quarter, eighth, 16th, 32nd. If an event is selected, also change its duration. |
| `.` | Toggle dot (armed; and on the selection if any). |
| `=`/`+`, `-`, `N` | Sharp, flat, natural. With a selection: `setAlter`. Without: arm it (pressing the armed one again disarms). |
| `T` | Toggle tie on the selection. |
| `↑` / `↓` | Transpose selection one step. With Ctrl/Cmd: one octave. |
| `←` / `→` | Move the selection to the previous / next event (crossing bars). |
| `Delete` / `Backspace` | Delete the selection; the selection moves to the previous event. |
| `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` | Undo, redo. |
| `Space` | Play / stop. |
| `Ctrl/Cmd+S`, `Ctrl/Cmd+O` | Save, open (`preventDefault`). |
| `Esc` | Clear selection. |
| `?` | Open the help dialog listing these shortcuts. |

### 6.4 Setup dialog (native `<dialog>`)

Shown by "New" and by clicking the title. Fields: Title, Composer, Staves (preset select:
*Treble*, *Bass*, *Piano (grand staff)*, *Treble + Bass*, *SATB (4 staves)*), Key (15 options
shown as names, e.g. "G major / E minor (1♯)"), Time (`2/4 3/4 4/4 6/8 2/2 3/8 9/8 12/8`),
Tempo, Number of bars (default 16).

When opened from the title on an existing score, only Title, Composer and Tempo are editable.
"New" on a non-empty score asks for confirmation first ("Replace the current score?").

### 6.5 Persistence

- **Autosave**: after every edit, the score is written to its entry in the in-browser score
  library (§12). On load, this tab's score, else the newest saved one, else a default 16-bar
  treble score. A corrupt value is ignored, not thrown. A failed write shows a warning that
  stays until a save succeeds.
- **Save** downloads `<title>.musicxml` (§9.2). MusicXML is the native file format; there is no
  custom format.
- **Open** uses a hidden `<input type="file">` with **no `accept` filter** (renamed or unusual
  extensions must still reach the sniffer in §9.1); dropping a file anywhere on the page does the same.
- Opening a file starts a new library entry and clears undo history. Nothing is lost, so there
  is no confirmation.

---

## 7. Playback (`src/play.js`)

- Create or resume the `AudioContext` **inside the Play click/keypress handler** (browsers block
  audio otherwise).
- Build a flat list of `{ startTick, durTicks, midi }` per staff: walk bars; **each bar occupies
  exactly `barCapacity` ticks** regardless of how full it is; within a bar events run from the
  bar start. A tied event extends the previous sounding note of the same MIDI number instead of
  starting a new one.
- `seconds = ticks / 480 × 60 / tempo`, each bar at its own tempo (§29: `schedule()` gives
  `timeOf(tick)`). Schedule everything up front with
  `osc.start(t)` / `osc.stop(t + len)`.
- Voice: the part's sampled instrument when loaded (§13.3); otherwise one `OscillatorNode`
  (`triangle`) → `GainNode` per note, gain 0 → 0.15 in 10 ms, holds, ramps to 0 over the last
  50 ms. Each playback gets a master gain at 0.8 into one shared compressor per `AudioContext`.
- `frequency = 440 × 2^((midi − 69) / 12)`.
- **Stop**: disconnect the master gain and drop references to scheduled nodes.
- While playing, highlight the current bar (a translucent rectangle from the hit map, advanced
  with `requestAnimationFrame` from `audioCtx.currentTime`). Play starts from the caret bar.
- Known ceiling: scheduling every note up front is fine for a few thousand notes. If long
  scores stutter, switch to a look-ahead scheduler. Leave a `ponytail:` comment saying so.

---

## 8. Things deliberately not in the first version

Lyrics, dynamics, slurs, grace notes, other articulations, repeats
and endings, mid-score clef changes, page-layout controls. (Transposing instruments: §21.) (Sampled General MIDI sounds: §13.3.) (Tuplet entry, inserting mid-bar and copy/paste: §11.)

All are additive on this model. Importers must **count and report** anything in these
categories that they skip (§9.6).

---

## 9. File formats (`src/io/`)

Every importer has the signature `import(bytes: Uint8Array) -> { score, report }` and is a pure
function of its input (testable without UI).

### 9.1 Sniffing (`open.js`) — by content first, extension second

| First bytes | Then | Format |
|---|---|---|
| `50 4B 03 04` (zip) | contains `score.dat` | `.musx` |
| zip | contains an entry ending `.mscx` | MuseScore `.mscz` (check this **before** the `.mxl` row: MuseScore 3 files also contain `META-INF/container.xml`) |
| zip | contains `META-INF/container.xml` | `.mxl` |
| `<` … | root element `museScore` | uncompressed MuseScore `.mscx` |
| `4D 54 68 64` ("MThd"), or a RIFF `RMID` wrapper | | MIDI |
| `<` after optional BOM/whitespace | root element `score-partwise` | MusicXML |
| `<` … | root element `finale` | raw EnigmaXML (accept it; go to §9.5 step 4) |
| `<` … | root element `score-timewise` | unsupported → message |
| anything else | extension `.mus` | legacy binary → message below |
| `{` | valid score JSON | a Coda autosave copied to a file (accepted as-is) |
| anything else | | "Coda doesn't recognise this file." |

Legacy message (the only place product names may appear in the UI):

> This is a legacy Finale file (.mus, 2012 and earlier). The format is closed and undocumented,
> so Coda can't read it directly. If you have a copy of Finale (2014 or later) or Finale NotePad,
> open the file there and export it as MusicXML, or save it as .musx, then open that file here.

There is no known open-source reader for `.mus` anywhere. **[verified by search, Nov 2026]**
Do not attempt to reverse-engineer it as part of this plan.

### 9.2 MusicXML export

`score-partwise` version 4.0, `<divisions>480</divisions>` so `<duration>` equals model ticks.

- A staff with `brace: true` and the staff after it become **one `<part>`** with
  `<staves>2</staves>`; every note carries `<staff>1</staff>` or `<staff>2</staff>` and
  `<voice>1</voice>` / `<voice>2</voice>`; after writing staff 1's notes for a bar, emit
  `<backup><duration>{ticks written}</duration></backup>` and then staff 2's notes.
  Every other staff is its own `<part>`. The part name is the upper staff's `name`; on import
  both staves of a 2-staff part get the part name. (So the lower staff's own name is not
  preserved by a save; the setup dialog gives both staves of a braced pair the same name.)
- First bar of each part: `<attributes>` with `<divisions>`, `<key><fifths>`, `<time>`,
  `<staves>` if 2, and `<clef number="n"><sign>/<line>`: treble G/2, bass F/4, alto C/3, tenor C/4.
  Later bars: `<attributes>` with only the key/time that changed.
- Tempo: in bar 1 and each bar with a change (§29), `<direction>` with a quarter `<metronome>`
  and `<sound tempo="…"/>`.
- Note: `<pitch><step>` `<alter>` (omit when 0) `<octave>`; `<duration>`; `<type>`
  (`whole half quarter eighth 16th 32nd`); one `<dot/>` per dot; `<chord/>` on every pitch after
  the first; `<time-modification><actual-notes>/<normal-notes>` when `tup` is set.
- Ties: on the starting note `<tie type="start"/>` + `<notations><tied type="start"/></notations>`;
  on the following note the `stop` counterparts.
- Empty bar: `<note><rest measure="yes"/><duration>{capacity}</duration></note>`.
- Underfull bar: after the events, pad with rests. Decompose the remaining ticks greedily with
  `[1920,1440,960,720,480,360,240,180,120,90,60]`.
- Title → `<work><work-title>`; composer → `<identification><creator type="composer">`.
- Escape `& < > "` in all text.

### 9.3 MusicXML import (+ `.mxl`)

`.mxl`: `fflate.unzipSync(bytes)`; read `META-INF/container.xml`, take the first
`rootfile@full-path`; if missing, use the first `.xml`/`.musicxml` entry outside `META-INF/`.
Decode UTF-8 (honour a UTF-16 BOM), parse with `DOMParser` (`application/xml`); a
`<parsererror>` → fail with a clear message.

- Staves: for each `<part>`, the number of staves is `<attributes><staves>` (default 1).
  Staff name from `<part-list><score-part><part-name>`. A 2-staff part → two model staves, the
  first with `brace: true`.
- For each `<measure>` (index = position, not the `number` attribute): read `<attributes>` for
  `divisions`, `key/fifths`, `time/beats` + `time/beat-type`, `clef` (per `number`; only the
  first clef seen for each staff is used; later clef changes are counted in the report).
  `score.measures[i]` gets key/time only where they differ from the previous bar. Key and time
  are taken from the first part.
- Notes, in document order: skip `<grace>` notes (count). `<staff>` (default 1) picks the staff.
  **Keep one voice per staff**: the first `<voice>` value encountered for that staff in the
  part; notes in other voices are skipped (count). `<chord/>` → add the pitch to the previous
  kept event. `<rest>` → event with empty `pitches`; a rest with `measure="yes"`, or with no
  `<type>` and a duration equal to the bar capacity, adds nothing (empty bar).
- Duration: prefer `<type>` + number of `<dot>` + `<time-modification>`. If `<type>` is
  missing, convert `duration × 480 / divisions` to ticks and look it up in the table of all
  `dur × dots` values; if there is no exact match use the nearest and count it as approximated.
  Types longer than whole or shorter than 32nd are clamped and counted.
- `<tie type="start">` on any pitch → `event.tie = true`.
- `<backup>` / `<forward>` are ignored (voice filtering makes them unnecessary in the common
  case). Known limitation: a kept voice that uses `<forward>` to skip time will produce an
  underfull bar. That is legal in the model.
- Tempo (§29): per bar, `<sound tempo>`; else `<metronome>` converted from its beat unit (and dot)
  to quarters; else 100.
- Title: `work-title`, else `movement-title`, else the file name. Composer: `creator[type=composer]`.
- All parts are padded with empty bars to the same bar count.

### 9.4 MIDI import (`midi.js`)

Parse:
- Header `MThd`, length 6: `format` (0/1; 2 → unsupported), `ntrks`, `division`. If the top bit
  of `division` is set (SMPTE time) → unsupported, with a message.
- Each `MTrk`: variable-length delta times; **running status**; `8n`/`9n` note off/on (`9n` with
  velocity 0 is a note-off); `An Bn En` two data bytes; `Cn Dn` one data byte; `F0`/`F7` sysex
  with a variable-length length; meta `FF type len data`: `51` tempo (µs per quarter),
  `58` time signature (`nn`, `dd` = power of two), `59` key (`sf` signed fifths, `mi`),
  `03` track name, `2F` end of track.
- Format 1: one staff per track that has notes. Format 0: one staff per channel that has notes.
- Skip channel 10 (index 9, percussion); count it in the report.

Convert:
1. Scale every time to 480 PPQ: `t × 480 / division`.
2. Quantize starts and ends to a 16th-note grid (120 ticks), round to nearest; minimum length 120.
3. Use the **first** time signature and key only (defaults 4/4, 0). If there are later changes,
   say so in the report. Tempo: the first sets the score's (default 120); later ones become
   tempo changes (§29).
4. Per staff, reduce to one line of chords: group notes by start tick; a group's end is its
   shortest note's end, clipped so it does not run past the next group's start.
5. Walk the timeline: gaps become rests; any note or rest crossing a barline is split there;
   each segment is decomposed greedily into values from
   `[1920,1440,960,720,480,360,240,180,120]`; all pieces of one original note are joined by ties.
6. Spelling: MIDI number → step/alter. White notes are natural. Black notes are sharps when
   `key ≥ 0`, flats when `key < 0`.
7. Clef: mean MIDI pitch of the staff `< 60` → bass, else treble.
8. Staff name from the track name, else "Track n". Pad all staves to the same bar count.

MIDI has no notation in it, so the result is a transcription and will need tidying. The report
always says so.

### 9.5 `.musx` import (`musx.js`)

**Decode — [verified]** against `finale-lua/lua-scripts` `src/library/enigmaxml.lua` (CC0):

1. `files = fflate.unzipSync(bytes)`; take `files["score.dat"]`.
2. Decrypt (symmetric XOR keystream):
   ```js
   function crypt(buf) {                       // Uint8Array -> Uint8Array
     const INITIAL = 0x28006D45;
     let state = INITIAL;
     const out = new Uint8Array(buf.length);
     for (let i = 0; i < buf.length; i++) {
       if (i % 0x20000 === 0) state = INITIAL;                    // reset every 128 KiB
       state = (Math.imul(state, 0x41c64e6d) + 0x3039) >>> 0;     // 32-bit LCG
       const upper = state >>> 16;
       out[i] = buf[i] ^ ((upper + Math.floor(upper / 255)) & 0xFF);
     }
     return out;
   }
   ```
   `Math.imul` and `>>> 0` are required; plain `*` loses precision.
3. If the result starts with `1F 8B`, `fflate.gunzipSync` it. Decode as UTF-8.
4. Parse with `DOMParser` (`application/xml`). Root is
   `<finale xmlns="http://www.makemusic.com/2012/finale" version="…">` with children
   `header`, `options`, `others`, `details`, `entries`, `texts`. **[verified]**

References (read these rather than guessing; none of this code may be copied wholesale except
the CC0 decrypt routine above):
- Decrypt routine: `https://raw.githubusercontent.com/finale-lua/lua-scripts/master/src/library/enigmaxml.lua` (CC0)
- Format notes: `https://github.com/Project-Attacca/enigmaxml-documentation` (`docs/enigmaxml.md`, `experimental/enigmaxml.xsd`)
- Reference reader (C++, MIT): `https://github.com/openmusx/musxdom` — `src/musx/dom/Entries.cpp`,
  `CommonClasses.cpp`, `Others.h`, `Details.h`, `Options.h`. (The old `rpatters1/musxdom` URL redirects here.)

**Structure — [verified]** against nineteen real `.musx` files (musxdom's test data, kept in
`samples/musx/`) and musxdom's source and tests. Everything below was seen in decoded files
unless marked otherwise.

- Records are keyed by attributes: `cmper` in `<others>`; `cmper1` + `cmper2` in `<details>`;
  `entnum` in `<entries>`. Repeated records add a 0-based `inci`. **Records with a `part`
  attribute belong to linked parts: ignore them.**
- Staff order: `others > instUsed[cmper="0"]`, ordered by `inci`; each one's `<inst>` is a
  `staffSpec` cmper. `staffSpec` 32767 is a hidden template staff; skip it.
- Staff name: `staffSpec > fullName` → `textBlock[cmper] > textID` → `texts > blockText[number]`.
  Strip `^name(...)` formatting codes. Brace: a `details > staffGroup` spanning exactly two
  consecutive staves.
- Clef: `staffSpec > defaultClef` (absent = 0), overridden by `gfhold > clefID` in bar 1. Map
  through `options > clefOptions > clefDef[index]` by shape (`clefChar`, `clefYDisp`):
  38/−6 treble, 66/−4 alto, 66/−2 tenor, 63/−2 bass. Other shapes → treble, reported.
  Later bars: `gfhold > clefID`, or `clefListID` → `others > clefList[cmper]` (by `inci`, each a
  `clef` at `xEduPos`); a bar with no `gfhold` keeps the clef the last one ended with. "Set to
  clef" transpositions (`transposition > setToClef`) write the whole staff in
  `staffSpec > transposedClef`.
- Bars: `others > measSpec` by `cmper`. `<beats>` × `<divbeat>` EDU (quarter = 1024): time is
  `beats / (4096 / divbeat)`; `divbeat` 1536 (dotted quarter) gives `beats*3 / 8`.
- Key: `measSpec > keySig > key`. Linear key when `key & 0xC000` is 0: low byte = signed
  fifths, `key >> 8` = mode (0 major, 1 minor, others custom). Otherwise non-linear and the whole
  value is the mode. Custom modes have tables keyed by mode cmper: `fstKeySharps`/`fstKeyFlats`
  (tonal centres), `acciAmountSharps`/`Flats`, `acciOrderSharps`/`Flats`; `keyFormat > semitones`
  ≠ 12 means microtonal.
- Pitch: port of musxdom `KeySignature::calcPitch` with displacement `harmLev` and alteration
  `harmAlt` (independent of the clef):
  ```
  lev = tonalCentre + harmLev;  step = mod(lev, 7);  oct = floor(lev / 7) + 4
  alter = harmAlt + keyAlterationOn(step)
  ```
  Checked against musxdom's KeySigs test: Ab major, G# minor, Eb Lydian, C# Phrygian and a
  non-linear key all give E4 F#4 G4 Ab4 Bb4 C5 D5 Eb5 for the same written notes.
- Music for a staff + bar: `details > gfhold[cmper1=staff][cmper2=measure]`; missing = empty bar.
  `<frame1>`…`<frame4>` are layers 1–4, each a `frameSpec` cmper with `<startEntry>`/`<endEntry>`.
- `entries > entry` is a linked list via `next` (0 = end). Children: `<dura>` (EDU, dots included,
  e.g. 1536 = dotted quarter), `<isNote/>` (absent = rest), `<graceNote/>`, `<tupletStart/>`,
  and `<note>` with `<harmLev>`, `<harmAlt>`, `<tieStart/>`.
- Tuplets: `details > tupletDef[entnum][inci="0"]` with `symbolicNum`/`symbolicDur` and
  `refNum`/`refDur` (5 eighths in the time of 4 = 5/512, 4/512). The tuplet covers entries until
  `symbolicNum × symbolicDur` EDU of written values are used.
- Voice 2: entries flagged `<v2/>` follow, in the same frame chain, the voice-1 entry flagged
  `<controller/>` that launches them, and start where it starts. They keep their own tuplet state.
- Articulations: `details > articAssign[entnum] > articDef` → `others > articDef` `charMain`
  (+ `fontMain` → `fontName`). SMuFL code points: U+E4A0 accent, E4A2 staccato, E4A4 tenuto,
  E4AC marcato, E4AE marcato+staccato, E4B0 accent+staccato, E4B2 tenuto+staccato, E4B4
  tenuto+accent (odd = below), E4C0–E4CB fermatas. Legacy fonts (Maestro, Petrucci, Jazz,
  Broadway Copyist, Engraver Font Set): 45 tenuto, 46 staccato, 62 accent, 94/118 marcato, 85/117
  fermata, 60/248 tenuto+staccato, 223/249 accent+staccato, 172/232 marcato+staccato: the codes all
  five share in openmusx/smufl-mapping (46 and 62 also seen in a real file); others are counted.
- Transposition: `staffSpec > transposition`, the interval concert → written: `keysig > interval`
  (steps) + `adjust` (key change in fifths), or `chromatic > diatonic` + `alteration` (key change
  as musxdom `calcKeySigChangeFromInterval`). Semitones = (fifths + 12·steps) / 7. In chromatic
  mode Finale keeps the concert key signature. Mid-score changes come from `staffStyle` /
  `staffStyleAssign`.
- Tempo: `measExprAssign[cmper=measure] > textExprID` → `textExprDef` with `playType` time,
  `value` and, with `useAuxData`, `auxdata1` = the beat unit in EDU.
- C/¢: as musxdom `TimeSignature::getAbbreviatedSymbol`: with `measSpec > useDisplayTimesig` the
  bar's `abbrvTime` decides; otherwise `options > timeSignatureOptions > timeSigDoAbrvCommon` /
  `timeSigDoAbrvCut`.
- Expressions: `measExprAssign[cmper=measure]` with `textExprID`, `horzEduOff` (EDU from the bar
  start), `staffAssign` (a staff cmper; −1 top, −2 bottom staff), `layer` (0 = all), `<v2/>`,
  `<hidden/>`, `graceNoteIndex`. `textExprDef > textIDKey` → `textBlock` → `texts > expression`;
  `categoryID` → `markingsCategory > categoryType` (`dynamics`, `tempoMarks`, …). The text holds
  codes (`^fontMus(Font0,0)`, `^fontid(n)`, `^size(…)`) then the characters: SMuFL U+E520–E53D,
  or in a legacy music font the Mac Roman byte (stored decoded: pp is "π" = 185, mp "P", ff "ƒ").
- Smart shapes: `others > smartShape` with `shapeType` (absent = `slurDown`; `slurUp`/`Auto`,
  `dashSlur*`, `dashContourSlur*`, `cresc`, `decresc`, `hyphen`, `wordExt`, lines, trills, …),
  `startTermSeg`/`endTermSeg > endPt` with `inst`, `meas`, `edu`, and `entryNum` when
  `<entryBased/>`.
- Lyrics: `details > lyrDataVerse` / `lyrDataChorus` / `lyrDataSection` [entnum] with
  `lyricNumber` (the text block) and `syll` (1-based) → `texts > verse` / `chorus` / `section`.
  Syllables split as musxdom `createSyllableInfo`: spaces and hyphens separate, a hyphen right
  after a syllable joins it to the next, formatting codes vanish (checked against its tests).
- Grace notes: `<graceNote/>` entries sit in the chain before the entry they lead to.
- **[expected], not seen in a sample:** title and composer from `texts > fileInfo[type]`,
  multiple `frameSpec` incis.

**Rules for this importer:**

- Frames 1–4 become layers 1–4. Voice-2 runs go to the first layer no frame uses in that bar,
  after rests up to their launch point; a run that starts before the layer's end, can't be
  reached with plain rests (inside a tuplet) or overfills the bar is skipped and counted. A tie whose next note in the same layer has no matching pitch
  is dropped and counted.
- Non-linear and microtonal keys: pitches keep their real spelling (microtonal alterations are
  rounded to semitones and counted); the key signature shown is the nearest standard one.
- Entries store concert pitch; a transposing staff's notes are moved to written pitch and the
  staff gets `transpose` (DESIGN §21). Counted instead: chromatic-mode staves (key shown
  transposed), braced staves that disagree, microtonal keys, non-integer intervals, notes out of
  range, and staff-style changes.
- Marks: unknown symbols, and articulations other than a fermata on rests, are counted.
- Tempo (§29): expressions that set the playback tempo (`playType` time with `useAuxData`;
  quarters a minute = value × auxdata1 / 1024) become tempo changes; text expressions and
  `<ignore/>` entries are counted.
- Dynamics (§22): an expression in the dynamics category, or whose text is a dynamic, goes on the
  note it starts on (within 2 ticks) or covers in its layer (then that layer's voice 2; all layers when 0;
  only voice 2 with `<v2/>`), else the next note, as MusicXML. Rarer marks map as MusicXML's (pppp → ppp, sfp → fp …).
  Counted: hidden ones, ones on grace notes, other text in the dynamics category, a second one on
  a note, ones on empty bars or after the last note.
- Slurs and hairpins (§23): slur shapes (dashed shown solid, counted) and `cresc`/`decresc` from
  their two end points (entries, or bar + EDU in layer 1, an end past the bar's notes on its last
  event). Counted: ends on grace notes or entries not kept, ends in different staves or layers,
  single-note ones, overlaps (also `clearBrokenSpans`), `wordExt` as extender lines, and every
  other shape.
- Lyrics (§24): each verse, chorus and section used becomes a lyric line, verses first, up to 5.
  Counted: more lines, lyrics on rests, missing text, long syllables (shortened), extenders.
- Clefs (§25): bar 1 sets the staff clef; a later different clef goes in `staff.clefs`. A clef
  list gives the bar its last clef; mid-bar changes are counted as moved to the bar start.
  Unsupported clefs, changes on "set to clef" staves and ones after the last bar are counted.
- Grace notes (§26): the first note of each grace entry goes on the next note of its voice, up to
  8. Counted: grace chords (first note kept), grace rests, graces before rests or at a bar end,
  graces with marks, ties, lyrics or slurs, and runs not drawn as one slashed eighth or sixteenths. A display time signature different from the real one is
  counted (the real one is used).
- Sound: the staff's full name matched against the General MIDI names, like MuseScore; the
  lower staff of a braced pair takes the upper one's.
- Voice-2 launch times come from the file's durations (tuplet ratios applied), not from the
  converted events, so an unsupported tuplet before a launch doesn't shift it.
- `staffSpec` transpositions are checked only against synthetic data (the real samples transpose
  through staff styles); the formula gives the known presets for their values.
- With `?debug` in the page URL, opening a `.musx` also offers the decoded EnigmaXML as a download.

### 9.6 Import report

```js
report = { format: "MusicXML", notes: 412, warnings: [ "Notes in other voices skipped: 12", … ] }
```

After any import, show a small non-modal panel: "Opened *file* — 412 notes." followed by the
warnings as a list, with a dismiss button. No warnings → show the first line only, for 4 seconds.

### 9.7 MuseScore import (`src/io/mscz.js`)

`.mscz` is a zip; the score is the entry ending in `.mscx` (if several, the one at the zip root;
ignore anything under `Excerpts/`, which are extracted parts). `.mscx` is the same XML,
uncompressed. Import only; Coda does not write this format.

MuseScore is open source (GPL). Read its documentation or files to learn the format, but **do not
copy its source code** into this MIT project.

MuseScore 4 is installed on the development machine at
`/Applications/MuseScore 4.app/Contents/MacOS/mscore`, and can convert from the command line
(`mscore -o out.mscz in.musicxml`). Use it to make real sample files from the MusicXML samples,
so the importer is tested against genuine output rather than hand-written guesses.

**[verified against MuseScore 4.7 output, Nov 2026]** for 4.x files; the 3.x branches
(`<accidental>` key field, `Tuplet` ids, `<Tie>` elements) are **[expected]** — no 3.x file has
been tested yet. Findings from the real file that differ from the first draft:
- `Part > Staff` declarations carry **no `id` and no `defaultClef`** in 4.x. The clef comes from
  the first `<Clef>` in the staff's first bar. Staves are matched to `Score > Staff[id]` by order.
- Title is usually in `metaTag workTitle`, but a MusicXML-converted file may only have
  `metaTag movementTitle`; both are checked before the `VBox` title text.
- In 4.x, `<Tuplet>` carries the ratio inline (no id) and is closed by `<endTuplet/>`.
- A `.mscz` also contains `score_style.mss`, `Thumbnails/`, `audiosettings.json` etc.; only the
  root-level `.mscx` is read.

- Root `<museScore version="…">` → `<Score>`. Target versions 3.x and 4.x. A `version` below 3
  → still try, and add "This file is from an old MuseScore version; some content may be missing"
  to the report.
- **Parts and staves.** `Score > Part` elements, each with one or more `<Staff id="n">`
  declarations and a `<trackName>` (staff name). A Part with two staves → braced pair. The
  declared clef is `Part > Staff > defaultClef` (absent = treble).
- **Music.** `Score > Staff[id="n"]` (direct children of Score, distinct from the declarations
  inside Part) hold the bars in order as `<Measure>` elements. In 3.x/4.x each Measure has
  `<voice>` children; **use the first `<voice>` only**, count notes in the others.
- Inside a voice, in order:
  - `<KeySig>` → fields `<concertKey>` (4.x) or `<accidental>` (3.x): fifths.
  - `<TimeSig>` → `<sigN>`, `<sigD>`.
  - `<Clef>` → `<concertClefType>`: `G` treble, `F` bass, `C3` alto, `C4` tenor; anything else →
    treble + report. Only the first clef per staff is used.
  - `<Tempo>` → `<tempo>` is quarter notes per **second**; bpm = value × 60. One per bar (§29).
  - `<Chord>` → `<durationType>` (`whole half quarter eighth 16th 32nd`; others clamp + report),
    `<dots>`, and one `<Note>` per pitch. A Chord containing `<acciaccatura>`, `<appoggiatura>`
    or `<grace…>` is a grace note: skip and count.
  - `<Rest>` → `<durationType>`; `measure` means a whole-bar rest → add nothing.
  - `<Tuplet>` … `<endTuplet/>` bracket the events between them; ratio from `<actualNotes>` /
    `<normalNotes>`. Apply the integer rule in §3.1.
- **Pitch.** `<Note>` has `<pitch>` (MIDI number) and `<tpc>` (tonal pitch class, a position on
  the line of fifths where 14 = C, 13 = F, 15 = G):
  ```
  step  = [3,0,4,1,5,2,6][ (tpc + 1) mod 7 ]        // F C G D A E B
  alter = Math.floor((tpc + 1) / 7) − 2             // tpc 14 → 0, 21 (C♯) → 1, 7 (C♭) → −1
  oct   = Math.floor((pitch − alter) / 12) − 1
  ```
  Sanity check while importing: `midi({step, oct, alter})` must equal `<pitch>`; if not, fall
  back to spelling from the MIDI number as in §9.4 step 6 and count it.
- **Ties.** A tie starts on a `<Note>` that contains `<Spanner type="Tie">` with a `<next>` child
  (3.1+/4.x) or a `<Tie>` element (older). Either → `event.tie = true`.
- **Title / composer.** `<metaTag name="workTitle">` and `<metaTag name="composer">`; if empty,
  the first `VBox > Text` whose `<style>` is `title` / `composer` (case-insensitive).
- Key and time for `score.measures` come from the first staff. Pad all staves to the same bar count.
- Report: other voices, grace notes, unsupported tuplets, clef changes, unknown clefs, plus
  anything encountered and ignored that falls under §8.

---

## 11. Entry improvements (Phases 8–9)

Designed after the first release, from `docs/ROADMAP.md` §1–2. Every new score change goes
through `edit()`; every new model function is pure and gets a `test.html` check.

### 11.1 Chords (Phase 8)

- **Shift+A–G** adds that letter to the selected event, at the first octave *above* its top
  pitch (`chordAbove(top, step)` in `model.js`). On a rest it adds above the letter's nearest
  pitch to the previous note, turning the rest into a note. Branch on `e.shiftKey` before the
  plain-letter path, so Caps Lock does not trigger chord mode.
- **Chord toggle** in the palette (`armed.chord`): a plain click then behaves like Shift+click.
  Target: the clicked note if the click is on one, else the selection if it is in the clicked
  staff and bar. The ghost notehead shows in chord mode.
- `toggleChordPitch` on a rest turns it into a note; removing the last pitch turns it back into
  a rest (existing behaviour, now tested).
- No Alt+digit interval shortcuts: Alt changes `e.key` on macOS.

### 11.2 Audition (Phase 8)

`play.js` exports `audition(pitches)`: a short note (≈0.35 s) on the shared AudioContext with
the playback voice. `app.js` calls it from one helper after a successful note entry, chord change,
pitch or accidental change, and when a note is selected by clicking. Never during playback,
undo/redo or file open, and never for rests.

### 11.3 Key / time change at a bar (Phase 8)

Toolbar button **Key/Time** opens a small `<dialog>` for the caret bar, reusing the key list.
It applies from that bar on (`setAttrs`); "Remove change" (`clearAttrs`) appears when the bar
has its own attributes and is not bar 1. A time change that would overfill a bar is refused
with a reason naming the bar; nothing is truncated. Pitches keep their absolute alters.

### 11.4 Double dots, measure numbers (Phase 8)

- `.` cycles 0 → 1 → 2 → 0. On a selection, if 2 does not fit the bar, it goes to 0.
- The first bar of every system after the first shows its bar number above the top staff.

### 11.5 Insert at a position (Phase 9)

`insertEvent(score, s, b, idx, ev)`; `appendEvent` is the `idx = bar.length` case.

- Keyboard: the new event goes after the selected event when that is in the caret bar,
  otherwise at the bar end. Auto-advance to the next bar only when inserting at the end;
  mid-bar overflow is "Bar is full".
- Mouse on empty space: the index is the number of notes in the bar left of the click's x.

### 11.6 Triplet entry (Phase 9)

Palette toggle and key `;` set `armed.tup = [3, 2]` (sticky, shown in the status bar).
`makeEvent` applies it only when `tupletOk`. Display and export already handle `tup`.

### 11.7 Range selection and clipboard (Phase 9)

- `state.selEnd` (same staff as `state.sel`) extends with Shift+←/→, or with the mouse in the
  Selection tool (§14.2). In the entry tool Shift+click still adds chord notes.
- Delete, ↑/↓ transpose, Ctrl/Cmd+C, X and V act on the whole range, each as one `edit()`
  (one undo step, rolled back whole on failure).
- The clipboard is an in-page copy of the events. Paste inserts them after the selection (or
  at the caret bar's end) using `insertEvent`, carrying into following bars as needed, and
  clears the tie on the last pasted event. `preventDefault` only when there is something to act on.

## 12. Score library (Phase 10, `src/store.js`)

Scores are kept in `localStorage`, one key per score, so autosave stays synchronous and no
dependency is needed.

- `coda.doc.<id>` = `{modified, score}`. There is no index key: the list is made by scanning the
  prefix, so two tabs never overwrite each other's list. Ids come from `crypto.randomUUID()` and
  live in `state.docId`, not in the score.
- `coda.current` = the open id, in `sessionStorage` (this tab) and `localStorage` (fallback), so
  reloading a tab reopens that tab's score.
- Migration: an old single `coda.score` becomes the first entry; the old key is removed only
  after the new entry is written.
- `store.js` has no DOM; its functions take `(storage, prefix)`: `list` (newest first, unreadable
  entries listed with `ok: false`), `load`, `save` (false on quota/blocked), `remove`, `migrate`.
- New gets a fresh id, written on its first edit (abandoned blank scores don't pile up). Opening
  or dropping a file gets a fresh id, written at once.
- **Scores** dialog: title, composer, bars, last modified (newest first, the open one marked),
  with Open, Duplicate and Delete. Delete confirms by title; deleting the open score opens the
  newest remaining one, or a blank one. Built with `textContent`. One line says scores live only
  in this browser and Save makes a file.
- Tests use the `codatest.` prefix and clean up, because `test.html` shares the app's origin.

## 13. Menus, instruments and sounds (Phases 11–13)

### 13.1 Menu bar (Phase 11)

`#topbar` holds a `role="menubar"` of plain buttons, each opening a `role="menu"` list:

- **File:** New…, Open file…, Scores in this browser…, Save as MusicXML, Print…
- **Edit:** Undo, Redo, Cut, Copy, Paste, Delete
- **View:** Zoom in, Zoom out, Actual size
- **Score:** Add bar, Delete bar, Key/Time…, Score details…, Parts and instruments…
- **Help:** Keyboard shortcuts, About Coda

Play, Stop and tempo stay as visible buttons. Existing element ids are kept on the menu items.
Shortcuts are shown right-aligned (⌘ on Mac). Edit items are enabled/disabled when the menu
opens. Keyboard: ←/→ between menus, ↑/↓ within, Enter/Space activate, Esc closes; a click
outside closes. `onKey` ignores keys while a menu is open, and focus leaves the menu after an
item runs. Zoom sets the sheet width (menu items only; Ctrl +/− stays the browser's).

### 13.2 Instrument per staff (Phase 12)

- `staff.program`: optional integer 0–127 (General MIDI, 0-based). Absent = piano. Checked by
  `isValidScore`. `setStaffProgram(score, staff, program)` changes the whole part (a braced pair).
- `src/gm.js`: the 128 programs as `{slug, name, family}`; slugs match the sound set's folder names.
- MusicXML: `<score-instrument>` + `<midi-instrument><midi-channel/><midi-program>` (1-based),
  written only when `program` is set; import sets it only when present.
- MIDI: first program change per track; later ones counted. MuseScore: `Instrument > Channel >
  program@value` if present. `.musx`: the staff name matched against the General MIDI names; no match is counted.

### 13.3 Sounds on demand (Phase 13)

- URL: `<base>/<slug>-mp3/<note>.mp3`, notes named with flats (`Db4`), A0–C8. Bases: jsDelivr at
  the pinned commit, then gleitz.github.io. A failed request tries the next base; only `res.ok`
  responses are cached (`caches.open("coda-sounds-v1")`, in try/catch).
- Sparse: one sample per 3 semitones (`round(midi/3)*3`, clamped 21–108), repitched with
  `playbackRate`. Decoded once per session.
- Play: load what the score needs ("Loading sounds…", ≈ 8 s timeout); anything missing plays the
  triangle voice, with one status message. The playback token is set before awaiting, so Stop
  during loading works.
- Audition: sampled when loaded, else the triangle voice now and a background fetch. Sounds are
  prefetched after a file opens and after an instrument change.
- Notes longer than the 3.16 s recordings: sustained families loop 0.8–2.4 s; others ring out.
- Pickers: Score ▸ Parts and instruments… (one row per part, §20), and a Sound select in New. SATB defaults to
  Choir Aahs (52).
- Credits: FluidR3_GM (MIT; CC BY 3.0 per the gleitz README) in the README and Help ▸ About.
- Your own sounds: §18.

## 10. Testing

`test.html` loads the modules and runs plain assertions. It writes each result to the page and
sets `document.title` to `PASS (n)` or `FAIL (k of n)` so it can be checked at a glance.
No test framework.

Minimum checks, added in the phase that introduces the code:

1. Tick math: every `dur × dots`; triplet eighth = 160; `barCapacity` for 4/4, 3/4, 6/8, 2/2.
2. `appendEvent` rejects an overfilling event and accepts an exactly filling one.
3. y → pitch: for treble and bass, every line and space from two ledger lines below to two
   above maps to the right `{step, oct}` (drive the pure function with synthetic `yBottom`/`spacing`).
4. `midi()` for C4, A4, B♭3, F♯5; `keyAlter` for keys −7, −1, 0, 1, 7.
5. MusicXML round trip: build a score exercising chords, rests, dots, ties, accidentals, a key
   change, a time change, a braced pair and a tuplet → export → import → deep-equal.
   The fixture must be round-trippable: **every bar exactly full or completely empty** (export
   pads underfull bars with rests, so those cannot compare equal), both staves of the braced
   pair share one name, and every `tup` passes the integer rule in §3.1. Add a second, separate
   check that an underfull bar exports with padding rests that sum to the bar capacity.
6. Each file in `samples/` imports to an expected, hand-written list of events.
7. `.musx`: `crypt(crypt(x))` equals `x`; and decoding the sample yields text starting with `<?xml`.

Interactive behaviour (clicking, typing, playback, printing) is verified by hand in the browser
pane, following the checklist at the end of each phase in `docs/PLAN.md`.

## 14. Selection tool, commands, context menu, tuplets (Phases 14–17)

Rule for this and later rounds: **a NotePad user should feel at home.** Keep every existing
shortcut; add NotePad's where they don't clash (checked against the NotePad 2012 manual:
Keyboard Shortcuts, Simple Entry, Selection tool, Tuplets pages). New power (context menus,
range-wide commands) is added alongside, never instead.

### 14.1 Command table (Phase 14)

`CMD[id] = { run, on? }` in app.js, keyed by the menu item ids. Menu items, the context menu and
modifier shortcuts (read from each item's `data-short`) all call `CMD[id].run()`; a menu disables
an item when `on()` is false. Letter, digit and arrow entry keys stay in `onKey`.
New **Notes** menu: Select all (mod+A), Transpose up/down a step (↑/↓), up/down an octave
(Shift+↑/↓, NotePad's; Ctrl+↑/↓ still works), Tie (T), Tuplet…, Remove tuplet.

### 14.2 Selection tool (Phase 15)

- `state.tool`: `"entry"` (default, current behaviour) or `"select"`. Two buttons at the top of
  the palette (arrow, pencil); **V** toggles. Typing letters enters notes in either tool.
- Select tool, mouse: click selects the nearest event in that staff and bar; Shift+click extends
  (NotePad's gestures). No ghost note. Empty bars move the caret only.
- Drag (> 4 px, starting anywhere on the page) draws a selection box (`#sel-box`); the selection
  runs from the first to the last event whose head is inside it. Ranges stay on one staff: the
  one pressed on if the box holds notes there, else the top one. An empty box clears it.
- Range-wide commands: duration, dot, accidental, tie, transpose, tuplet act on every event in
  `range()` inside one `edit()`, so any failure rolls back the whole change.

### 14.3 Context menu (Phase 16)

Right-click (or Shift+F10 / the Menu key) opens `#ctx`, built from clones of menu items.
On a note (selected first if outside the range): Cut, Copy, Paste, Delete · Transpose up/down ·
Tie · Tuplet… · Key and time… · Parts and instruments…. Elsewhere on a staff: Paste · Add bar · Delete bar ·
Key and time… · Parts and instruments…. Clamped to the viewport; Esc, a click outside, or scrolling closes it.

### 14.4 Tuplets (Phase 17)

- Palette **Tuplet** button and Notes ▸ Tuplet… open `#tuplet`: "N in the space of M" with the
  presets 3:2, 2:3, 4:3, 5:4, 6:4 (all whole-tick on every duration; 7-tuplets can't be, §3.1).
- With a selection: `setTuplet` on the range. Without: arms the ratio for the next notes.
- `;` and NotePad's **9** toggle the last-used ratio (3:2 at first).
- An armed ratio that doesn't fit the duration gives a message instead of being dropped.

## 15. Layers: more than one voice per staff (Phase 18)

NotePad's name and limits: **layers 1–4** per staff, each its own rhythm; stems up for layers
1 and 3 and down for 2 and 4 when more than one layer has notes in a bar.

- **Model:** `staff.bars` stays layer 1. Optional `staff.layers`: up to three more bars arrays
  (layers 2–4), each `measures.length` long, absent when unused. `layerBars(staff, v)` and
  `allLayers(staff)`; navigation and edit functions take a trailing `v = 0`. Each layer fits the
  bar on its own; empty layer bars draw nothing, and a bar where every layer is empty draws one
  whole rest.
- **Every bar walker covers all layers:** `isValidScore`, `addMeasure`, `deleteMeasure`, the
  time-change fit check, `padBars`, `noteCount`, `clearBrokenTies`, `schedule` (ties per layer),
  render, export.
- **MusicXML:** import maps each staff's `<voice>` ids, in numeric order, to layers 1–4 (more are
  counted and skipped). A time cursor follows notes, `<backup>` and `<forward>`; a note starting
  after where its layer has reached gets rests in front (counted). Export
  writes each non-empty layer bar as voice `staff × 4 + layer + 1`, separated by `<backup>`.
- **Phase 18a:** model, MusicXML, drawing, playback. **18b:** a Layer 1–4 control at the lower
  left (NotePad's place for it) and Notes ▸ Layer 1–4. `state.layer` picks the active layer;
  `edit()` runs each change inside `withLayer(score, v, fn)`, which swaps that layer into
  `staff.bars` for every staff, then swaps back and drops trailing empty layers, so every edit
  command works on any layer unchanged. Other layers draw grey (not when printing); clicks and
  the caret use the active layer. **18c:** MuseScore
  voices and `.musx` layers.

## 16. Marks: fermata and articulations (Phase 19)

- **Model:** optional `ev.marks`, names from `MARKS` = fermata, staccato, accent, tenuto,
  marcato, kept in that order and absent when empty. Only a fermata goes on a rest.
  `toggleMark(events, m)` adds to all, or removes from all when every one has it.
- **Drawing:** VexFlow articulations. Alone in a bar: a fermata above, the others on the
  notehead side. Layers sharing a bar: all marks on the stem side. Not printed on rests except
  a fermata.
- **Playback:** staccato sounds half its length. A fermata doesn't change timing.
- **Entry:** Notes ▸ Articulations ▸ Fermata / Staccato / Accent / Tenuto / Marcato over the selection; the first
  three are also in the right-click menu.
- **Files:** MusicXML `<fermata>` and `<articulations>` (`staccato`, `accent`, `tenuto`,
  `strong-accent` = marcato) both ways; other articulations are counted. A fermata on a
  whole-bar rest is counted (an empty bar holds no event). MuseScore: `<Fermata>` before the
  chord or rest, `<Articulation>` subtypes inside it (`markOf`). `.musx`: `articAssign` → `articDef` symbol (§9.5).

## 17. Common and cut time (Phase 20)

- **Model:** optional `measures[b].sym`, "common" or "cut", only next to a `time` of 4/4 or 2/2
  (`TIME_SYMS`); `attrsAt` returns it. `setAttrs` treats 4/4 and C as different, drops a symbol
  that doesn't match the meter, and `clearAttrs`/`deleteMeasure(0)` handle it like `time`.
- **UI:** both time menus offer "C (common time)" and "¢ (cut time)"; `parseTime`/`timeLabel`
  convert between the menu value ("C", "C|", "n/d", also what VexFlow draws) and the model.
- **Files:** MusicXML `<time symbol="common|cut">` both ways; MuseScore `TimeSig` subtype 1 =
  common, 2 = cut. Importers build `measures` with the shared `measuresFrom`. `.musx`: the bar's
  `abbrvTime` or the document options (§9.5).

## 18. Your own sounds (Phase 21)

- **What:** one audio file, the note it was recorded at, and the lowest and highest notes it
  plays. No loop points: long notes stop when the recording does.
- **Storage:** `src/usersounds.js`, Cache API `coda-user-sounds-v1`, one entry per sound (the
  file as stored, name/root/low/high in `x-` headers, the name URL-encoded). A file over 20 MB
  is refused before reading; a file the browser can't decode is refused before storing.
- **Model:** optional `staff.sound` (the id), set for a whole part by `setStaffSound`;
  `program` stays as the fallback and is what MusicXML saves.
- **Playback:** each sound is decoded once and repitched from its root. Notes outside its range,
  or a sound no longer in this browser, play the part's instrument, with one status line.
- **UI:** Parts and instruments ▸ Your sounds… adds and deletes sounds; each part's menu lists them under
  "Your sounds". Names go into the page with `textContent` / `Option` text only.

## 19. Export (Phase 22)

File ▸ Export is a submenu (CSS: it opens on hover or focus inside the File menu); it replaces
Print, and ⌘/Ctrl+P is now its PDF item.

- **PDF (via the print dialog)…:** `window.print()` with the print stylesheet; the browser's dialog saves PDF. File ▸ Print… (mod+P) does the same. Systems keep a 4-unit right margin in their drawing so print, which clips to it, keeps the closing barline.
  A one-click PDF needs a PDF library (a new dependency), so it isn't done.
- **MusicXML / .mxl:** the existing export; `.mxl` zips it with `META-INF/container.xml` and an
  uncompressed `mimetype` entry.
- **MuseScore .mscz:** `exportMSCX` writes MuseScore 4 format modelled on MuseScore's own output:
  parts and instruments (program, clefs), a title box, header clef (`isHeader`), key, time
  (subtype for C/¢), tempo, voices = layers, `Tuplet`/`endTuplet` per group, `Tie` spanners
  with `next`/`prev` locations, `Fermata` before the chord, `Articulation` inside it. Layer 1 is
  padded to the bar; an empty layer-1 bar is a measure rest. Checked two ways: Coda reads it back
  equal, and MuseScore 4 opens it and its MusicXML re-export reads back equal.
- **MIDI:** format 1, PPQ 480. A conductor track (title, tempo, time and key at their bars), then
  one track per staff (name, program; channel 10 skipped) from `schedule()`, note-offs before
  note-ons at equal ticks. A status line says what MIDI doesn't keep.
- **Audio:** `renderAudio` renders the whole score in an `OfflineAudioContext` through the same
  `scheduleNotes` as Play, after waiting for every sound (no time limit). WAV is 16-bit PCM.
  Compressed audio plays that buffer silently through `MediaRecorder` in real time (the only
  encoder browsers have built in); the item shows the type this browser records (WebM/Ogg Opus or
  M4A) and is hidden where there is none. MP3 encodes that buffer with LAME (wasm-media-encoders,
  VBR quality 2), in slices so the page keeps updating; the encoder loads on first use.
- **Not exported:** Finale `.musx` (closed format; nothing here could check the result).

## 20. Parts: add, remove, rename, reorder (Phase 23)

- **Dialog:** Score ▸ Parts and instruments… lists one row per part (name, sound, up, down,
  remove) and adds new parts (treble, bass, alto, tenor staff, or grand staff). The rows are the
  draft; Cancel discards it, Apply makes one `edit()`, so one undo step.
- **Model:** `arrangeParts(score, rows)`, rows in the new order as `{from, name, kind?}`. `from`
  is an existing part's first staff index: its staff objects are reused, so layers, sounds and
  anything added later travel with them. New parts get empty bars. Everything is checked before
  anything changes; an empty list or a repeated part is refused. A lone staff never keeps
  `brace`. Sounds are then set by position.
- **Removing a part with notes** asks first. The selection is cleared; the caret is clamped.

## 21. Transposing instruments (Phase 24)

- **Model:** a staff may carry `transpose: [chromatic, diatonic]`, the interval from written to
  sounding, same sign as MusicXML (B♭ clarinet `[-2, -1]`, F horn `[-7, -4]`, tenor sax
  `[-14, -8]`). Both staves of a grand staff share it. Notes are stored as **written**;
  `measures[].key` stays the **concert** key.
- **Written key:** `keyAt(score, staff, bar)` = concert key − `7c − 12d` fifths, wrapped into
  −7…7. Rendering, accidentals, letter entry and click entry all use it.
- **Sound:** playback, MIDI and audio export add the chromatic interval (`soundingMidi`).
- **Setting it** (Parts and instruments, a menu under each part: concert pitch, B♭, A, F, E♭
  alto, E♭ high, B♭ low, E♭ low, octave lower/higher; other values from files show as "Other"):
  `setStaffTranspose` moves the written notes so the music sounds the same, and keeps the part's
  sound. Part of the same Apply `edit()`. The key dialog says "Key (concert)" when any part
  transposes.
- **MusicXML:** import reads `<transpose>` (chromatic, diatonic, octave-change) per part; part 1's
  written key is turned into the concert key. Different transpositions on staves of one part,
  later changes, and out-of-range values are counted. Export writes each part's written key and
  `<transpose>`, octaves as `<octave-change>`.
- **MuseScore:** `Instrument > transposeChromatic/transposeDiatonic` (full interval). Notes:
  `pitch` and `tpc` are concert, `tpc2` written; KeySig `concertKey` and `actualKey`.
- **Paste** into a part with a different transposition shifts the notes so they sound the same.
- **Known:** a concert key far from C can wrap the written key to the other side (concert F♯ with
  a B♭ part shows A♭ major, as G♯ would need 8 sharps) while notes keep sharp spellings, so expect extra accidentals.
  MuseScore 3 files with only `<accidental>` in a transposing first part are counted, not
  converted (no MuseScore 3 file to check against).
- **.musx:** `staffSpec > transposition` (§9.5). Chromatic-mode staves get a transposed key
  signature, unlike Finale; counted.
- Not yet: a concert-pitch view toggle.


## 22. Dynamics (Phase 26)

- **Model:** `ev.dyn`, one of `ppp pp p mp mf f ff fff fp sf sfz fz`, on a note or rest.
- **Entry:** Notes ▸ Dynamics (also right-click) sets or clears it on the first selected event.
- **Drawn** under the note in bold italic; a staff's drawing grows to fit what hangs below.
- **Sound:** a level (`ppp`…`fff`) holds until the next one, for the whole part (all its staves
  and layers); `mf` before the first. `sf`, `sfz`, `fz` accent one note; `fp` accents, then `p`.
  Playback, MIDI and audio export use it as note velocity. Hairpins ramp it (§23).
- **Files:** MusicXML `<direction><dynamics>` before the note; MuseScore `<Dynamic>` before the
  chord or rest. Rarer marks map to the nearest (`pppp`→`ppp`, `sfp`→`fp`, `rfz`→`sfz`…); a
  dynamic after a part's last note is counted.

## 23. Slurs and hairpins (Phase 27)

- **Model:** flags on the first and last event of a layer: `slur`/`slurEnd`, `hp` (`"<"` or
  `">"`)/`hpEnd`. No nesting or overlap within a kind. `clearBrokenSpans` runs after every
  `edit()` and import, dropping orphan ends and overlaps (imports count them).
- **Entry:** select a range, then S (slur) or Notes ▸ Slurs and lines ▸ Crescendo / Diminuendo hairpin. The same
  command on exactly that range removes it; a new one replaces any inside it.
- **Drawn** by hand on the SVG (slurs as filled curves, hairpins as lines), split at line ends;
  hairpins sit under slurs, lyrics and dynamics.
- **Files:** MusicXML `<slur number="1">` in `<notations>` (other numbers counted) and `<wedge>`
  directions, the stop after its note. MuseScore Slur spanners in the chords, HairPin spanners at
  voice level. Other MuseScore lines are counted.
- **Sound:** a hairpin ramps velocity from the level where it starts to the next dynamic, if that
  comes no later than a beat after its end and goes its way, else by 16 steps; the level reached
  holds afterwards. A dynamic inside the hairpin ends the ramp there; a hairpin starting on the
  last note of another (a swell) ends the first ramp at that note.

## 24. Lyrics (Phase 28)

- **Model:** `ev.lyrics = [{text, hyph?} | null, …]`, verse v at index v, up to 5 verses; text
  1–40 characters, `hyph` a hyphen to the next syllable in that verse. No holes or trailing nulls;
  absent when empty; notes only. Scores saved with the earlier one-verse `ev.lyric`/`lyricHyph`
  are upgraded when the library reads them (`upgradeScore`).
- **Entry:** select a note, press L (Notes ▸ Lyrics…). A box opens under the note. Space or Tab
  moves to the next note, `-` moves on with a hyphen, Shift+Tab goes back, Enter or clicking
  away finishes, Escape drops what's typed, ↑/↓ change verse (kept for next time). Each syllable
  is one undo step. Rests are skipped.
- **Drawn** a line per verse per staff per system, under the notes and dynamics; a staff gets room
  for its verses below and bars widen for long words. The render hit map gives verse 1's baseline
  (`lyricY`) so the box sits on the line being typed.
- **Files:** MusicXML `<lyric number="1">`–`"5"` with `<syllabic>`; MuseScore `<Lyrics>` with
  `<no>` = verse − 1 (none for verse 1). Syllabic values are worked out from the hyphens, per verse.
  Verses past 5, non-numeric numbers, extender lines and lyrics on rests are counted. Elided
  syllables join with ‿.

## 25. Clef changes (Phase 29)

- **Model:** `staff.clefs = {bar: clef}`, at barlines only, bar ≥ 1; `staff.clef` is the clef at
  bar 0. `clefAt(staff, bar)` gives the clef in effect. `tidyClefs` drops changes to the clef
  already in effect. Adding a bar shifts later changes; deleting a bar moves its change to the
  next bar.
- **Entry:** Score ▸ Clef from this bar (the caret's staff and bar).
- **Drawn** small before the barline where it starts, which also gives a courtesy clef at the end
  of a line. Notes, rests, clicks and letter entry use the clef in effect.
- **Files:** MusicXML `<clef>` in that bar's `<attributes>`; MuseScore `<Clef>` at the end of the
  bar before, as MuseScore writes it. On import a clef at the end of a bar starts the next bar; one
  inside a bar moves to the bar's start, counted; one after the last bar is counted.

## 26. Grace notes (Phase 30)

- **Model:** `ev.grace = [pitch, …]`, up to 8 single notes before a note (not a rest). One draws as
  a slashed eighth, more as beamed sixteenths. They move with their note (arrows, part
  transposition, paste between parts).
- **Entry:** grace mode (palette button, Notes ▸ Grace notes): click a note to add one at the
  clicked pitch, or select a note and type A–G (nearest to the last grace or the note). The armed
  sharp/flat/natural applies. Delete removes the selected notes' graces; Escape leaves the mode.
- **Sound:** on the beat, a 32nd each (at most half the note); the note starts after them.
- **Files:** MusicXML `<grace slash="yes"/>` notes before their note; MuseScore `<acciaccatura/>`
  or `<grace16/>` chords. Imported groups drawn differently (unslashed single, other values) are
  counted as redrawn; grace chords keep their first note; graces after a note, before a rest or
  at a bar end are counted. `.musx` grace notes are still skipped and counted.

## 27. Unpitched percussion (Phase 32)

- **Model:** a drum part is a staff with `clef: "percussion"` (the only flag). It has no
  `program`, `transpose`, `brace` or `clefs`, and no key signature. Each pitch on it is
  `{step, oct, alter: 0, drum}`: `step`/`oct` is the staff position (read as treble), `drum` the
  General MIDI drum number 35–81. `drum` appears only on drum staves; `isValidScore` checks both.
- **Kit** (`src/drums.js`): the 47 GM drums with name, default position and notehead (normal,
  x, circled x, diamond, triangle), after MuseScore's drum kit (line 0 = top line, F5).
  Entry positions: D4 pedal hi-hat, E4 bass drum 2, F4 bass drum, G4/A4 floor toms, B4 low tom,
  C5 snare, D5/E5 toms, F5 ride, G5 closed hi-hat, A5 crash, B5 crash 2, C6 splash.
- **Entry:** a click or typed letter snaps to the nearest entry position and takes its drum;
  ↑/↓ move to the next one. Notes ▸ Drums ▸ Drum sound (and the context menu) sets any kit drum on the
  selected notes, which also moves them to that drum's position. Accidentals and transposition
  don't apply; ties match by drum, not position. A Shift+letter or chord click that snaps to a
  drum already in the chord is refused rather than taking it out. Copy/paste between drum and
  pitched staves is refused.
- **Sound:** FluidR3's GM Standard kit, one recording per drum, fetched like the instrument
  samples (§13.3, same cache and loading) from surikov/webaudiofontdata at a pinned commit on
  jsDelivr, else surikov.github.io: `sound/128{N}_0_FluidR3_GM_sf2_file.js`, N the drum number.
  Each file is a script holding the mp3 as base64; Coda reads the base64 out with a regex and never
  runs it. A hit plays the whole recording at its own pitch, whatever the written length. Until a
  drum's recording loads (offline, or a host down) it plays the built-in synth (`src/drumsynth.js`:
  a few families shaped by the drum number). Dynamics apply.
- **Files:** MusicXML `<unpitched>` with display step/octave, one `<score-instrument>` +
  `<midi-instrument>` (channel 10, `midi-unpitched` = drum + 1) per drum, `<instrument id>` on
  each note, `<notehead>` for non-normal heads, `<clef><sign>percussion</sign>`. MuseScore:
  `useDrumset` with a `<Drum>` per kit drum, note `<pitch>` = drum, clef `PERC`. MIDI: channel 10
  imports as one drum staff (keys outside 35–81 counted); drum staves export on channel 10.
  `.musx` percussion maps are not read yet: those staves become drum staves with drums chosen by
  staff position, and the report says so. Importers share `toDrumStaff`: drums snapped by
  position that land twice in one chord are merged, and dropped clef changes and transpositions
  are counted.

## 28. Repeats and navigation; nothing import-only (Phase 33)

- **Model** (`measures[b]`, beside `key`/`time`): `repStart: true` (‖: at the bar's start),
  `repEnd: n` (:‖ at its end; the section plays n times, 2–10), `volta: [1, 2]` (the ending
  numbers this bar belongs to, ascending, 1–10; consecutive bars with the same numbers are one
  bracket), `segno: true` and `coda: true` (signs at the bar's start: the D.S. and To Coda
  targets), `toCoda: true`, `fine: true` and `jump: "dc" | "dcFine" | "dcCoda" | "ds" | "dsFine" |
  "dsCoda"` (at the bar's end). Absent when not set; `isValidScore` checks each. `setBarMark`,
  `setVolta`, `parseVolta` in `model.js`. Adding a bar inside an ending leaves the new bar out of
  it (the bracket splits); deleting a bar drops its marks.
- **Playing order** (`playOrder(score)`, pure, shared by playback, audio and MIDI export): a
  section runs from the last ‖: (or the bar after the last :‖ or run of endings, or bar 1) to :‖
  and plays `repEnd` times; a :‖ inside an ending also goes back while a higher-numbered ending in
  the same run is still to come (so `[1. :‖] [2. :‖] [3.]` reaches the 3rd); on pass n only
  endings holding n play. D.C. goes to bar 1, D.S. to the
  first segno (bar 1 if none); each jump is taken once, repeats are not taken again after it, and
  each run of endings then plays only its last ending. "al Fine" stops after a Fine bar; "al Coda"
  goes from a To Coda bar to the next coda sign (ignored if there is none). Plain D.C./D.S. play to
  the end. The order is capped (bars × 12 + 100) so a broken file can't loop forever.
- **Playback:** `schedule()` lays bars out in playing order; Play from bar N starts where N first
  plays (straight on from N if it never plays). The cursor follows the order. A tie doesn't carry
  across a jump (the next note strikes again). Dynamics are looked up by the bar as written, so
  a repeated section starts at the level written before it. MIDI export is unrolled; its key and
  time meta events are sent wherever the signature in effect changes in playing order.
- **Drawing:** VexFlow `Barline` REPEAT_BEGIN/REPEAT_END on every staff; `Volta` (BEGIN, MID, END,
  BEGIN_END; the number only where the bracket begins) and `Repetition` (segno, coda, To Coda,
  Fine, D.C./D.S. variants) on the top staff. A :‖ played more than twice gets "×n" above it.
- **Editing:** Score ▸ Repeats and endings. Marks go on the caret bar (the selected note's bar);
  choosing one that's there removes it. An ending covers the selected range of bars; "Ending with
  numbers…" takes "1, 2" or "1-3"; "End repeat, play several times…" asks for the count. These and
  the part transposition's "Other…" ask in a small in-page dialog (`#ask`), not `window.prompt`,
  which some embedded browsers block. Marks are drawn above the bar's highest note; one ending
  bracket keeps one height.
- **MusicXML:** `<barline>` left/right with `<repeat direction times>` and `<ending number type>`
  (start; stop before a repeat or at the end; discontinue otherwise), in every part. Segno and
  coda are `<direction>`s with `<segno/>`/`<coda/>`; To Coda, Fine and jumps are `<words>` with
  `<sound tocoda|fine|dacapo|dalsegno>`, in the first part. Import takes barlines from the first
  part and directions from any; `<sound>` attributes decide, else the words ("D.C.", "Da Capo",
  "D.S.", "al Fine", "al Coda", "To Coda", "Fine"). Signs mid-bar move to its start (counted);
  other words become text above the next note (§30); unreadable ending numbers and counts over 10 are
  counted.
- **MuseScore:** `<startRepeat/>`, `<endRepeat>n</endRepeat>` in each staff's `<Measure>`;
  in the first staff, `<Spanner type="Volta">` (`<endings>`, `<next><location><measures>`),
  `<Marker>` with label segno/codab/coda (To Coda)/fine, and `<Jump>` with jumpTo start/segno,
  playUntil fine/coda, continueAt codab. Unknown markers and jumps are counted.
- **.musx:** forward and backward repeat barlines from the measure's flags; endings and text
  repeats are counted, not read yet.
- **Nothing import-only.** Everything the model holds can be made from File ▸ New:

  | Feature | Where |
  |---|---|
  | Notes, rests, dots (double), ties, chords | palette, keys (§6.3, §11.1) |
  | Double sharps / flats | Notes ▸ Accidentals |
  | Any tuplet ratio | Notes ▸ Tuplet… (typed, e.g. 5:3) |
  | Layers 1–4 | Notes ▸ Layer, status bar |
  | Grace notes | Notes ▸ Grace notes |
  | Marks, dynamics, slurs, hairpins | Notes menu |
  | Lyrics, verses 1–5 | Notes ▸ Lyrics…, ↑/↓ in the box |
  | Clef changes | Score ▸ Clef from this bar |
  | Key and any time signature mid-score | Score ▸ Key and time… (typed, e.g. 7/8) |
  | Repeats, endings, D.C./D.S./segno/coda/Fine | Score ▸ Repeats and endings |
  | Part names, order, grand staff, drum staff | Score ▸ Parts and instruments… |
  | Any transposition | Parts dialog ▸ Other… (semitones, steps) |
  | Instrument (GM program), drum per note | Parts dialog; Notes ▸ Drums ▸ Drum sound… |
  | Drum note away from its kit position | Notes ▸ Drums ▸ Drum note up / down a line (same sound) |
  | Title, composer, tempo | Score ▸ Title, composer, tempo… |
  | Tempo change | Score ▸ Tempo from this bar… (§29) |
  | Text above a note (dolce, pizz.) | Notes ▸ Text above note… (§30) |
  | Rehearsal mark | Score ▸ Rehearsal mark… (§30) |
  | Pickup bar, short last bar | File ▸ New (Pickup beats); Score ▸ Bar length (pickup)… (§33) |
  | Trill, mordents, turn, tremolo, arpeggio | Notes ▸ Ornaments (§34) |
  | Breath mark, caesura | Notes ▸ Articulations (§34) |
  | Fingering (per chord note, finger changes) | Notes ▸ Fingering… (§34) |

## 29. Tempo changes (Phase 34)

- **Model:** `score.tempo` is bar 1's tempo; `measures[b].tempo` (b ≥ 1, a whole number 20–400,
  quarter notes a minute) changes it from bar b on. `tempoAt(score, b)` is the tempo in effect;
  `setTempo(score, b, bpm)` stores a change only where the tempo differs from the bar before (bar
  1 sets `score.tempo`), and drops a following change left equal to it. Deleting a bar moves its
  change to the bar after; deleting bar 1 makes bar 2's tempo the score's. No gradual changes
  (accel./rit.) yet.
- **Playback:** bars play at the tempo of the bar as written, also after a repeat or jump.
  `schedule()` returns `timeOf(tick)` (seconds), used for notes, the audio export and the cursor.
- **Drawing:** ♩ = n above the top staff at each change, and at bar 1 when the score has changes.
- **Editing:** Score ▸ Tempo from this bar… (the in-page dialog); empty removes the change. The
  toolbar tempo and the setup dialog set bar 1's.
- **Files:** one tempo per bar, at its start. A change inside a bar moves to the bar's start, a
  second different one in the same bar is skipped, values outside 20–400 are set to the nearest;
  each is counted. MusicXML reads `<sound tempo>` or a `<metronome>` in any plain or dotted beat
  unit and writes a quarter metronome with `<sound tempo>`; MuseScore `<Tempo>` (per second);
  MIDI tempo meta events (export: at each played bar whose tempo differs); `.musx` playback tempo
  expressions.

## 30. Text above notes and rehearsal marks (Phase 35)

- **Model:** `ev.text` is one line (whitespace collapsed, at most 60 characters) above a note or
  rest of its staff; `measures[b].rehearsal` (at most 8) is a boxed mark at the bar's start, drawn
  on the top staff. Words that read as a jump or sign (D.C., D.S., Da Capo, Dal Segno, To Coda,
  Fine) are refused with a pointer to Repeats and endings, so a file never turns them into a jump.
- **Editing:** Notes ▸ Text above note… (the first selected note or rest) and Score ▸ Rehearsal
  mark… (the caret bar; suggests the next letter or number after the last one). Empty removes.
- **Drawing:** text is drawn after layout, starting at the note, above the staff or the note,
  in italic; it takes no room between notes. A bar's top-staff marks rise above any text in it.
  At a bar's start, left to right: rehearsal mark, segno or coda, tempo; all above an ending.
- **Files:** MusicXML `<words>` (not read as a jump) and MuseScore `<StaffText>`, `<SystemText>`,
  `<Expression>`, `<PlayTechAnnotation>` go on the staff's next note or rest (several before one
  note are joined); `<rehearsal>` and `<RehearsalMark>` from the first part or staff (later
  ones that differ, ones inside a bar, longer than 8 or after the last note are counted). Both
  are written back. MIDI keeps neither. `.musx` text expressions stay counted.

## 31. Brass effects and slides (Phase 36)

- **Marks:** `scoop`, `fall` and `doit` join `MARKS` (notes only; a fall and a doit replace each
  other). Drawn with VexFlow's jazz ornaments beside each notehead: a scoop before, a fall or doit
  after. Plops have no glyph in the vendored VexFlow, so they aren't in the model; importers
  count them.
- **Slides:** `ev.gliss = true` slides from this note to the next event in its layer, which must
  follow at once (same bar or the next), be a note, differ, and have as many notes (chord note
  *n* goes to note *n*). Not on tied notes or drum staves. Drawn as a straight line from each
  notehead to its partner; across a line break, to the system's end and on from the next start.
  Notes ▸ Brass effects ▸ Slide to next: over a range, every note slides into the next, so a phrase glides.
  Edits that break a slide drop it (`clearBrokenSlides`, with the broken ties).
- **Sound:** pitch bends on the note's own voice (sample `playbackRate` or the tone's frequency):
  a scoop rises from a minor third below over 0.12 s; a fall or doit moves a fifth down or up
  over the last 0.3 s (half the note at most) and fades out; a slide glides over the last half of
  its note, a beat at most, and the same voice holds through the next note with no new attack.
  Drums ignore all of these. MIDI export plays slides as separate notes and leaves out the bends.
- **Files:** MusicXML `<articulations>` `<scoop/>`, `<falloff/>`, `<doit/>` (plop counted);
  `<slide>` and `<glissando>` both import, and export is `<slide line-type="solid">`, numbered per
  chord note. MuseScore `<ChordLine>` subtype 1 fall, 2 doit, 3 plop (counted), 4 scoop, and a
  `Glissando` spanner per note. `.musx` SMuFL brass symbols: U+E5D0 scoop, E5D1–E5D6 lifts and
  doits, E5D7–E5DF falls (from the SMuFL table; no `.musx` sample with them yet). Slides that break
  the rules above are counted.

## 32. Tracks: which parts play and export (Phase 37)

- **Model:** a track is a part (`partGroups`: one staff, or a braced pair). `st.off = true` on
  every staff of a part turns it off; `setTrackOn` sets the whole part, so a pair never splits
  (hands-separate practice is left out). `tracks(score)` lists `{staves, name, on, perc}` rows (a
  DAW-style track view would list the same), and `tracksOn(score)` is a copy holding only the
  parts that are on, every bar kept, so timing, repeats, tempo and bar numbers match the full
  score; null when every track is off.
- **Uses:** Play and every Export item (MusicXML, .mxl, MuseScore, MIDI, WAV, MP3, compressed
  audio) take `tracksOn`, so exporting one part is part extraction. Save, autosave and Print/PDF
  always keep every part. The export message names the parts left out; with every track off, Play
  and Export refuse.
- **UI:** the toolbar's Tracks button ("Tracks: all", or "Tracks: 1 of 3" highlighted) and Score ▸
  Tracks to play and export… open a dialog: a checkbox per part, "Only this", "All on". Each change
  is an edit (undoable, kept in the browser's copy of the score; files don't hold it, so a saved
  MusicXML file reopens with every track on). Changes while playing apply at the next Play.
  ponytail: no per-track volume or live mute; a gain bus per track in play.js is the upgrade, and
  where a DAW view's volume and pan would go.

## 33. Short bars: pickups (Phase 39)

- `measures[b].len` (ticks, optional) makes bar b shorter than its time signature: a pickup at the
  start, or the short bar that completes it at the end. `barLen(score, b)` is the one place bar
  length comes from; entry, paste, time changes, playback, MIDI and both exports use it.
- Set in the new-score setup ("Pickup beats", as a setup wizard asks) or on any bar with
  Score ▸ Bar length (pickup)…, in beats of the bar's time signature. Refused below the bar's
  notes; a time change clears a length the new time makes full.
- A pickup is bar 0: printed numbers, MusicXML `number="0" implicit="yes"`, MuseScore
  `len` + `<irregular>`. Other short bars keep their number (`len` only).
- Import: MusicXML `implicit="yes"` bars take their longest staff's length; MuseScore `len`.
  A length Coda can't hold (not whole 32nds) is counted and shown full. MuseScore's
  `<multiMeasureRest>` summary measures are drawings, not bars, and are skipped.

## 34. Ornaments and breath marks (Phase 40)

- New `MARKS`: trill, mordent, invMordent, turn (one of these four per note), tremolo (single-note,
  three strokes), arpeggio (drawn on chords), breath and caesura (one of the two, drawn after the
  note). Notes only; rests keep just the fermata.
- Names follow MusicXML: `mordent` has the stroke (down to the note below), `invMordent` is the upper
  one without. VexFlow and MuseScore name them the other way round: VexFlow `mordent_inverted` /
  MuseScore `ornamentMordent` is Coda's `mordent`; `mordent` / `ornamentShortTrill` is `invMordent`.
- MusicXML: `<ornaments>` (trill-mark, mordent, inverted-mordent, turn, single tremolo),
  `<arpeggiate/>` on every chord note, `<breath-mark/>` and `<caesura/>` in articulations.
  Counted: two-note tremolos, other stroke counts (drawn as three), arrowed arpeggios, trill lines,
  other ornaments.
- MuseScore: `<Ornament>` (and MuseScore 3 articulation subtypes), `<Arpeggio>`,
  `<TremoloSingleChord>`/`<Tremolo>`, and voice-level `<Breath>` after the chord it follows.
- Playback (`perform` in play.js, so MIDI export too): accent +20 and marcato +30 velocity; breath
  and caesura end the note early (a quarter of it, at most an eighth); arpeggio rolls the chord up in
  steps of a 64th at most; the top note of a chord carries the ornament: trill and tremolo
  repeat in 32nds (a drum tremolo is a roll), mordents are two 32nds before the main note, a turn
  splits the note in four. Neighbours are the written notes a step away in the written key
  (accidentals earlier in the bar are not applied). Not on notes tied into, tied on, or sliding.
- Fingering: `p.finger` on a pitch, 0–5 or a change such as 3-1 (`FINGER`); Notes ▸ Fingering…
  takes them from the lowest note up ("1 3 5", "-" skips one). Drawn above a single note, beside
  each notehead of a chord. MusicXML `<technical><fingering>`, MuseScore `<Fingering>` in `<Note>`.
- Fermatas hold a note or rest twice as long in every part: `schedule` keeps `fermatas` (unrolled
  tick -> shortest held length there) and `timeOf` adds the extra seconds, so audio, WAV and the
  play cursor agree and a repeated bar holds again. MIDI writes half the tempo for the held span;
  MIDI import reads such a dip that returns by the barline as a held note (counted, not a tempo).

## 35. Marking palettes

- Below the note tools, six palette buttons (Articulations, Ornaments, Dynamics, Slurs and
  lines, Brass effects, Text/lyrics/tempo) each open a small grid of tools beside the palette,
  like a sub-palette. A tool runs the same command as its menu item on the selection, is greyed out
  when that command can't run, and the grid stays open for the next selection (Esc, the button
  again, or another palette button closes it).
- Icons come from the score's music font (VexFlow's glyphs, cropped to their box) or small SVGs
  where the font has none (tremolo, arpeggio, hairpins, slide, text).

## 36. Part names

- Each part's name is drawn right-aligned before the first system, centred on a braced pair; the
  first system is indented to fit the longest (up to 170 px). A score of one part with the
  default name "Staff" shows none. Later systems show no names (no abbreviations yet).


## 37. Octave lines, pedal marks, lyric extenders, nested slurs (Phase 41)

- Notes ▸ Slurs and lines holds Slur, the hairpins, 8va, 8vb, 15ma, 15mb and Pedal; the same tools
  are in the Slurs and lines palette. Each goes over the selection (one note is enough for an
  octave line or a pedal); again removes it; a different octave line replaces it.
- Model: spans like slurs (§23): `ott` ("8va", "8vb", "15ma", "15mb") or `ped: true` on the first
  event, `ottEnd` / `pedEnd` on the last. They may start and end on one event, so their start is
  read before their end (`ONE_NOTE`) and they can't share a note with the one before. Pitches stay
  as written; `staffLines` gives each staff's lines in ticks (from any layer, for the whole staff).
- Playback: notes under an octave line sound 1 or 2 octaves away. A note struck under a pedal
  rings to the end of the pedal's last note (`ring`, audio only); MIDI export writes the pedal as
  CC64 instead. MIDI import counts sustain pedal (not read).
- Drawing: "8va" (etc.) with a dashed line and an end hook above the staff (below for 8vb/15mb);
  "Ped." with a line under the notes, up at the lift. Split at line breaks: "(8)" on later lines.
- Files: MusicXML `<octave-shift>` (pitches in the file sound: Coda writes the notes an octave away
  under one and reads them back written; sizes other than 8 and 15 counted, notes kept sounding) and
  `<pedal>` (start, change, stop; sostenuto counted). MuseScore `Ottava` and `Pedal` spanners
  (MuseScore keeps written pitch, as Coda does).
- Lyric extenders: `ext: true` on a syllable, typed as `_` in the lyric box (moves on, like `-`). The
  line runs under the notes up to the last one before the verse's next syllable (`melismas`), to
  the line's end if that's on a later line. MusicXML `<extend/>`; MuseScore `<ticks_f>` (the
  distance to that last note).
- Nested slurs: a slur that overlaps one already in the layer (inside it or around it) goes on a
  second level, `slur2` / `slur2End`, drawn clear of the other. A third over the same notes is
  refused. MusicXML: slur numbers voice and voice + 8; any two open at once are read, a third is
  counted. MuseScore: the inner (later) one is taken to end first.

## 38. Chord symbols, transposing the score, respelling, concert pitch (Phase 42)

- Chord symbols: Notes ▸ Chord symbol… (and the text palette) on the selected note or rest, typed
  as C, Am7, Bb7, F#m7b5, C/E. `ev.harm = {root: {step, alter}, kind, bass?}`; `kind` is the suffix
  as shown (12 characters at most). Drawn in a row above the staff on each line, accidentals from
  the music font; text above a note goes over them, octave lines over both. Written like the notes:
  a B♭ trumpet's symbols are a tone above concert, and they move with the part's transposition and
  with paste between parts (`shiftEvent`), not with ↑/↓. Not played.
- One per note or rest: a symbol inside a note (or over an empty bar) moves to the next note and is
  counted; a second one waiting for the same note is counted.
- MusicXML `<harmony>`: root, kind (its `text` is the suffix, else a name from `KIND_SUFFIX`), bass;
  degrees, roman numerals, frames, inversions, N.C. and unknown kinds counted. MuseScore `<Harmony>`
  root and bass as tpc, `<name>` the suffix; written in the 4.20 layout (`<root>`, `<name>`,
  `<base>`), and read in that and the later `<harmonyInfo>` one (both checked in MuseScore 4).
- Score ▸ Transpose…: up or down by an interval (unison to octave) plus up to two octaves; every
  note, grace note and chord symbol on parts that aren't drums, and every key signature, in one
  undoable step. If the opening key would need more than 7 sharps or flats the interval is spelled
  the other way (C♯ major up a fifth → A♭ major). Later keys past 7 wrap; their notes keep the
  interval's spelling (a known ceiling).
- Notes ▸ Accidentals ▸ Respell: the selected notes take their other spelling with the fewest
  accidentals (C♯ ↔ D♭, E ↔ F♭); notes tied to them follow so ties hold. Refused for drums and
  when two notes of a chord would land on one line.
- View ▸ Concert pitch: transposing parts drawn as they sound (`concertView`, a copy used only for
  drawing; not saved or undone). Notes entered by click, A–G, chord letters or grace notes go
  through `entered()`, which takes the accidental from the concert key and writes the note where
  the part reads it; pitch names in the status bar are the ones shown.

## 39. Playback: click, count-in, loop, cursor, swing, rit. and accel. (Phase 43)

**Play menu.** Play from this bar (Space), Stop, then three ticks: **Click**, **Count-in**, **Loop the
selected bars**, and **Swing ▸** Off / Light (3:2) / Medium (2:1) / Heavy (3:1). Click, count-in and loop
are this browser's preferences (localStorage, never the score or undo). Swing is part of the score.

- **Click.** A wood block on every beat, louder on the downbeat; built in `start()` so audio export,
  MIDI and the sounds a score needs never include it. Beats are dotted quarters in 6/8, 9/8, 12/8.
- **Count-in.** A bar of clicks at the starting bar's tempo. From a pickup, only the beats it is
  missing: an eighth pickup in 4/4 hears four clicks and comes in on the "and" of the fourth. A pickup has no accented click.
- **Loop.** With notes selected, the bars from the first to the last selected play over and over
  (count-in only before the first time). With nothing selected, from the caret to the end. Without
  Loop, Space plays from the caret as before: selecting two notes for a slur doesn't change Play.
- **Cursor.** A line moves through the notes during playback, placed from the drawn notes of every
  staff in the bar (whole-bar rests, drawn mid-bar, are skipped).

**Swing.** `score.swing = [first, second]`. In x/4 and x/2 bars each quarter's two eighths play in that
ratio; 6/8 and other x/8 bars stay straight. A tuplet group swings as a whole, with its notes even
inside it. A pickup's beats are counted from its end, so an eighth pickup plays as the short
off-beat. Ties, slides, ornaments and pedals follow the swung notes; dynamics don't move. "Swing" is
drawn above bar 1. MusicXML `<sound><swing>` (first, second, eighth); MuseScore `<StaffText><swing
unit="eighth" ratio="67"/>` (MuseScore itself neither reads nor writes MusicXML's swing). Only the first
swing in a file is used; a change later on is counted.

**rit., accel., a tempo.** `measures[b].ramp` is "rit", "accel" or "atempo" (Score ▸ Tempo ▸). A ramp runs
from its bar to the next bar with a tempo, a ramp or a tempo, or to the end, changing tempo every
eighth note: towards that next tempo when it goes the same way, else by a quarter (rit. to ¾, accel.
to 4⁄3). A ramp straight after another starts where it ended. `tempoSteps(score)` gives each bar's
steps; playback and the MIDI conductor track both use it, so the file's tempo map times out the same
(halved while a fermata holds, §34). Drawn in italics over the first staff, above the line's chord
symbols, text and octave lines. Typed "rit." text is refused with a pointer to the menu, as for D.C.
(§28); old saves holding such text still load. MusicXML and MuseScore words and staff text "rit.",
"rall.", "accel.", "a tempo" (and spelled-out forms) become the bar mark; inside a bar they move to its
start and are counted. MuseScore gets them as staff text, which it shows but doesn't play.
ponytail: one ramp shape (linear, eighth steps) and fixed ¾ / 4⁄3 targets.

## 40. 64th notes (Phase 44)

A 64th is 30 ticks: palette button (four flags), key **1** (continuing 7 whole … 2 32nd), beamed with
the shorter values, MusicXML "64th", MuseScore `64th`. `okDur(dur, dots)` allows a value only when it is a
whole number of ticks, so a 64th takes one dot at most (45 ticks; two dots would be 52.5). `setDuration`,
the dot key, the palette and validation all use it. An imported double-dotted 64th keeps one dot and is
counted, and 128ths and shorter become 64ths and are counted. Padding fills down to 30 ticks.

Ceilings:
- **No 7-tuplets.** 480 ticks a quarter has no factor of 7, so no note value divides by 7. A typed 7:4 is
  refused like any ratio that can't be whole ticks, and imported septuplets keep their written
  lengths and are counted (§14.4). Changing the tick grid would change every stored pickup length.
- A dotted 64th left alone leaves 15 ticks no rest can fill, as a double-dotted 32nd already does.

## 41. Layout: breaks, beams, cue notes, multi-bar rests, go to bar (Phase 45)

Entry points stay short: Edit ▸ Go to bar…, Score ▸ Breaks ▸ (line, page, none), Notes ▸ Beams and cue
notes ▸ (break beam, join beam, automatic, cue note), the same four in the palette's "Beams and cue
notes" group, and View ▸ Multi-bar rests.

**Breaks.** `measures[b].brk` is "line" or "page" (`setBreak`, refused on bar 1; deleting bar 1 clears
it from the new first bar). `layout()` starts a new system at the bar; a system ended by a break is not
stretched when it fills under 60%. On screen a small label marks the break; print starts a page break
on a new page (`break-before: page`). The browser pane can't preview print pages, so page breaks were
checked by label and print CSS only. MusicXML `<print new-system|new-page>`, MuseScore `LayoutBreak`
(section breaks become line breaks and are counted). Breaks are read only from Coda's own MusicXML:
another program's line starts are its layout, not the composer's.

**Beams.** `ev.beam` is "break" (start a new beam here) or "join" (beam to the previous note).
`beamGroups(bar, time, auto)` copies VexFlow's `generateBeams`, quirks included (a rest splits a
group; a group holding a quarter or longer is dropped), then applies the overrides, so the page and
the files agree. A test checks it against VexFlow on samples and 400 random bars. MusicXML writes
`<beam>` on every bar (a reader that sees any takes them literally); MuseScore `BeamMode` only where
overridden. Imported begin/continue/end become overrides only where they differ from automatic.

**Cue notes.** `ev.cue` draws the notes small (VexFlow's grace note class) and silent: playback, MIDI
and audio skip them. MusicXML `<cue/>` and `size="cue"`, MuseScore `<small>` with `<play>0</play>`.
ponytail: cue rests stay full size; VexFlow has no small rest.

**Multi-bar rests.** A view preference of this browser (stored with the Play options, not in the
score). `restRuns(score)` merges two or more bars that have no notes in any staff or layer, are full
length and carry no end-of-bar mark (repeat end, jump, Fine, To Coda, ending); only the run's first bar
may carry marks (key, time, tempo, rehearsal, break) and no later bar may change clef. The run draws
as one `MultiMeasureRest` with its count; its hit cell carries `last`, so the caret, lyric box and
play cursor (which sweeps each bar's share) find it. Typing a note into a run splits it on redraw.

**Go to bar.** Edit ▸ Go to bar… moves the caret and scrolls to the bar number as printed (pickups
counted as in §11.4).
