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
2. **Two vendored dependencies, pinned, committed to `vendor/`:**
   - VexFlow **4.2.3**, file `build/cjs/vexflow.js` (MIT; embeds the Bravura font, OFL). Classic
     `<script>`, exposes global `Vex`. Use `const VF = Vex.Flow`.
   - fflate **0.8.2**, file `umd/index.js` (MIT). Classic `<script>`, exposes global `fflate`.
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

---

## 2. File layout

```
index.html          markup, CSS, <dialog>s, script tags
src/model.js        PURE. score model, tick math, pitch math, edit commands. No DOM, no VexFlow.
src/render.js       model -> SVG via VexFlow; returns hit-test geometry
src/play.js         WebAudio playback
src/app.js          UI wiring: toolbar, palette, mouse, keyboard, undo, autosave, file open/save
src/io/open.js      format sniffing + dispatch
src/io/musicxml.js  MusicXML import + export, MXL unzip
src/io/midi.js      Standard MIDI File import
src/io/mscz.js      MuseScore .mscz / .mscx import
src/io/musx.js      .musx decode + EnigmaXML import
vendor/vexflow.js   vendor/fflate.js   vendor/README.md (versions, source URLs, licences)
test.html           loads src modules, runs assert checks, shows PASS/FAIL
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
  tempo: 100,                    // quarter notes per minute
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

- **Autosave**: after every edit, `localStorage.setItem("coda.score", JSON.stringify(score))`
  inside `try/catch`. On load, restore it if present and valid, otherwise show a default
  16-bar treble score. A corrupt value is ignored, not thrown.
- **Save** downloads `<title>.musicxml` (§9.2). MusicXML is the native file format; there is no
  custom format.
- **Open** uses a hidden `<input type="file">` with **no `accept` filter** (renamed or unusual
  extensions must still reach the sniffer in §9.1); dropping a file anywhere on the page does the same.
- Opening a file replaces the score and clears undo history, after a confirmation if the
  current score has any notes.

---

## 7. Playback (`src/play.js`)

- Create or resume the `AudioContext` **inside the Play click/keypress handler** (browsers block
  audio otherwise).
- Build a flat list of `{ startTick, durTicks, midi }` per staff: walk bars; **each bar occupies
  exactly `barCapacity` ticks** regardless of how full it is; within a bar events run from the
  bar start. A tied event extends the previous sounding note of the same MIDI number instead of
  starting a new one.
- `seconds = ticks / 480 × 60 / tempo`. Schedule everything up front with
  `osc.start(t)` / `osc.stop(t + len)`.
- Voice: one `OscillatorNode` (`triangle`) → `GainNode` per note; gain ramps 0 → 0.15 in 10 ms,
  holds, ramps to 0 over the last 50 ms. One master gain at 0.8.
- `frequency = 440 × 2^((midi − 69) / 12)`.
- **Stop**: disconnect the master gain and drop references to scheduled nodes.
- While playing, highlight the current bar (a translucent rectangle from the hit map, advanced
  with `requestAnimationFrame` from `audioCtx.currentTime`). Play starts from the caret bar.
- Known ceiling: scheduling every note up front is fine for a few thousand notes. If long
  scores stutter, switch to a look-ahead scheduler. Leave a `ponytail:` comment saying so.

---

## 8. Things deliberately not in the first version

Lyrics, articulations, dynamics, slurs, grace notes, tuplet *entry*, more than one voice per
staff, repeats and endings, mid-score clef changes, transposing instruments, inserting notes in
the middle of a bar, copy/paste, page-layout controls, sampled instrument sounds, MIDI export.

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
| `4D 54 68 64` ("MThd") | | MIDI |
| `<` after optional BOM/whitespace | root element `score-partwise` | MusicXML |
| `<` … | root element `finale` | raw EnigmaXML (accept it; go to §9.5 step 4) |
| `<` … | root element `score-timewise` | unsupported → message |
| anything else | extension `.mus` | legacy binary → message below |
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
- Tempo: in bar 1, `<direction><sound tempo="…"/></direction>`.
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
- Tempo: first `<sound tempo>`; else first `<metronome><per-minute>` (assume quarter beat); else 100.
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
3. Use the **first** time signature, key and tempo only (defaults 4/4, 0, 120 → rounded bpm).
   If there are later changes, say so in the report.
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

**Structure** (Project-Attacca enigmaxml-documentation, musxdom source). The overall shape —
the pools, the `cmper` keying, gfhold → frame → linked entries — is **[verified]** from the
written documentation. **Individual element names below are [expected]**: several were read
from an experimental schema or inferred from C++ field names, not seen in a real file. Confirm
each against decoded XML before relying on it.

- Records are keyed by attributes: `cmper` in `<others>`; `cmper1` + `cmper2` in `<details>`;
  `entnum` in `<entries>`. Repeated records add a 0-based `inci`.
- Staff order: `others > instUsed[cmper="0"]`, ordered by `inci`; each one's `<inst>` child is a
  `staffSpec` cmper. (`staffSpec` cmpers are **not** in score order.)
- Bars: `others > measSpec`, ordered by `cmper` (1-based, sequential). Children include
  `<beats>`, `<divbeat>`, and a key signature element.
- Music for a staff + bar: `details > gfhold[cmper1=staffCmper][cmper2=measureCmper]`. Missing
  gfhold = empty bar. Its `<frame1>`…`<frame4>` children are layers 1–4; each value is a
  `frameSpec` cmper. Its `<clefID>` is the clef index for that bar.
- `others > frameSpec[cmper=…]` has `<startEntry>` and `<endEntry>` (entry numbers).
- `entries > entry[entnum=…]` form a linked list via the `next` attribute (0 = end). Walk from
  `startEntry` following `next` until you have processed `endEntry`. **Never** assume entry
  numbers are consecutive.
- `<entry>` children: `<dura>`, `<numNotes>`, `<isNote/>` (present = notes, absent = rest),
  `<graceNote/>`, `<v2/>` (voice 2), `<note>` children each with `<harmLev>`, `<harmAlt>`.
  A rest may still contain one `<note>` giving its vertical position; ignore it.
- Duration from `<dura>` **[verified algorithm]**: the note value is the highest set bit; the
  number of dots is the count of consecutive set bits immediately below it.
- Pitch **[verified algorithm]**, for a standard major/minor key with `fifths` sharps (+) or flats (−):
  ```
  tonalCenter = fifths >= 0 ? [0,4,1,5,2,6,3,0][fifths]      // step index of the major tonic
                            : [0,3,6,2,5,1,4,0][-fifths]
               (minor keys: sharps [5,2,6,3,0,4,1,5], flats [5,1,4,0,3,6,2,5])
  lev   = tonalCenter + harmLev
  step  = ((lev % 7) + 7) % 7
  oct   = Math.floor(lev / 7) + 4
  alter = harmAlt + keyAlter(fifths, step)                   // keyAlter from §3.3
  ```
  i.e. `harmLev` 0 is the tonic in the middle-C octave, and `harmAlt` is relative to the key.

**Still to confirm on a real file — [expected]:**

| Item | Expected | How to confirm |
|---|---|---|
| EDU scale | quarter note `dura` = 1024 (whole 4096, eighth 512, 16th 256, 32nd 128) | find a known quarter note |
| `<divbeat>` unit | EDU, so 4/4 is `beats`=4, `divbeat`=1024 | read bar 1 of a 4/4 file |
| Key element | `<keySig><key>N</key></keySig>` in `measSpec`; N in 0..7 = that many sharps; 255 down to 249 = 1 to 7 flats (i.e. the low byte as a signed 8-bit number); a non-zero high byte (256+) = minor or non-standard | compare files in G, F, and a minor key |
| Clef index (`clefID`) | 0 treble, 1 alto, 2 tenor, 3 bass, 4 percussion, 5 treble-8vb, 6 bass-8vb | compare a piano file |
| Tie element names | `<tieStart/>` / `<tieEnd/>` inside `<note>` | file with a tie |
| Tuplets | `details > tupletDef` keyed by entry number, with the entry carrying a `tupletStart` flag | file with a triplet |
| Staff name | from `staffSpec` (`fullName` → a `texts` block) | — |
| Title / composer | `texts > fileInfo` blocks by type | — |
| Clef when bar 1 has no `gfhold` | falls back to a default clef on `staffSpec` | file with an empty first bar |
| `frameSpec` records | one per cmper; if several `inci` exist, each is a separate run of entries to concatenate | look for repeated cmpers |
| Absent `<key>` | same as 0 (C major) | file in C |
| Pitch formula end to end | the formula above gives the right note names | compare 5–10 notes against the reference export |

**Rules for this importer:**

- Use **layer 1 (`frame1`) only**, skip voice-2 entries and grace notes; count all three in the report.
- Unknown clef index → treble, reported. Non-standard key (high byte set) → use the low byte as
  fifths, reported.
- If tuplets cannot be resolved, import the notes with their written values and add
  "N bars contain tuplets that were not converted" to the report. Bars may then be overfull,
  which the model allows.
- The importer must not throw on missing pieces: a bar it cannot read becomes an empty bar and
  is counted.
- With `?debug` in the page URL, opening a `.musx` also offers the decoded EnigmaXML as a
  download. This is how the [expected] items get confirmed.

### 9.6 Import report

```js
report = { format: "MusicXML", notes: 412, warnings: [ "12 notes in a second voice were skipped", … ] }
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
  - `<Tempo>` → `<tempo>` is quarter notes per **second**; bpm = value × 60. First one only.
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
