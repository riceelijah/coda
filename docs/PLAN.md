# Coda — implementation plan

Read `docs/DESIGN.md` first. It defines the model, algorithms, UI and file formats. This file
only says what to build in what order and how to know each phase is finished.

## How to work

- **One phase per session.** Finish it, run its checks, tick its boxes here, commit, stop.
- **Do not redesign.** If DESIGN.md is wrong or unworkable, fix the smallest thing that makes it
  work, update DESIGN.md in the same commit, and say so in the commit message. If the change
  affects the score model (§3) or a file format rule (§9), stop and ask the user first.
- **No new dependencies, no build tooling, no framework.** See DESIGN.md §1.
- **Check VexFlow calls in the browser console** against `vendor/vexflow.js` before building on
  them. Do not rely on memory of the API; versions differ.
- **Run it for real.** Serve with the `coda` entry in `.claude/launch.json` (or
  `python3 -m http.server 8000`) and use the browser pane. ES modules do not load from `file://`.
  "It should work" is not a finished phase; the checklist is.
- **Commits:** one per phase on `main`, message `Phase N: <summary>`. Never push or create a
  remote before Phase 7.
- When something is skipped or left rough, write it under "Open items" at the bottom of this
  file rather than leaving it only in a chat message.

## Status

| Phase | What | State |
|---|---|---|
| 0 | Repo scaffold | done |
| 1 | Model + rendering (read-only score on screen) | done |
| 2 | Editing, playback, autosave, print | done |
| 3 | MusicXML / MXL open + save | done |
| 4 | MIDI import | done |
| 5 | MuseScore `.mscz` import | done (4.x verified; 3.x untested) |
| 6 | `.musx` import | decode done; mapping **blocked on sample files from the user** |
| 7 | Publish to GitHub Pages | README + subpath check done; **repo creation needs the user's go-ahead** |

---

## Phase 0 — Repo scaffold

- [x] `git init -b main` in the project root (done; the docs are already committed on `main`).
- [x] `.gitignore` containing `.DS_Store`.
- [x] `LICENSE`: MIT, year 2026, copyright holder "Coda contributors".
- [x] `.nojekyll` (empty).
- [x] `vendor/vexflow.js` from `https://cdn.jsdelivr.net/npm/vexflow@4.2.3/build/cjs/vexflow.js`
      and `vendor/fflate.js` from `https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js`.
      `vendor/README.md` lists name, version, source URL and licence for each.
- [x] `.claude/launch.json` with one configuration named `coda`: `python3 -m http.server 8000`, port 8000.
- [x] `index.html` that loads both vendor scripts and `src/app.js` (module), and shows the page
      skeleton from DESIGN.md §4.1 with empty regions.
- [x] `README.md` stub: one paragraph, plus "Coda is an independent project and is not affiliated
      with or endorsed by MakeMusic, Inc."
- [x] Commit `Phase 0: scaffold`.

**Done when:** the page loads in the browser pane with no console errors, and
`typeof Vex.Flow.StaveNote` and `typeof fflate.unzipSync` are both `"function"` in the console.

---

## Phase 1 — Model and rendering

Build: `src/model.js` (DESIGN §3, all of it including edit commands), `src/render.js`
(DESIGN §5), `test.html`, and enough of `src/app.js` to render a hard-coded demo score.

- [x] `model.js`: constants, `eventTicks`, `barTicks`, `barCapacity`, `attrsAt`, pitch helpers,
      `yToPitch(yBottom, spacing, clef, y)` as a pure function, every command in §3.4, `newScore`.
- [x] `test.html` with checks 1–4 from DESIGN §10.
- [x] `render.js`: layout (§5.2), drawing (§5.3–5.5), hit map (§5.6), per-system try/catch.
- [x] Demo score (kept in `app.js` behind `?demo`): piano grand staff in D major, 3/4, ~20 bars,
      containing chords, rests, dotted notes, beamed eighths and 16ths, a tie within a bar, a tie
      across a barline, a tie across a system break, an accidental outside the key, an empty bar,
      an underfull bar, an **overfull** bar, a key change and a time change.

**Done when:**
- `test.html` shows PASS.
- `?demo` renders every bar across at least three systems with no console errors; both staves'
  notes align vertically; brace and left connector are drawn; the final barline is a double bar.
- The overfull and underfull bars render without breaking their system.
- Take a screenshot and look at it. Accidentals appear only where they should (e.g. no sharp
  printed on F♯ in D major; a natural printed on F♮).

---

## Phase 2 — Editing, playback, persistence

Build: the rest of `src/app.js` (DESIGN §6), `src/play.js` (§7), all UI in `index.html` (§4).

- [x] Toolbar, palette with inline SVG icons, status bar, help dialog, setup dialog.
- [x] `edit(fn)` wrapper with undo/redo and autosave.
- [x] Mouse: coordinate conversion, staff/bar/pitch pick, select, shift-click chord, append,
      ghost notehead.
- [x] Keyboard table from §6.3 in full.
- [x] Add/remove bar. Selection highlight.
- [x] Playback with bar highlight; Space toggles.
- [x] Autosave restore on load; print stylesheet.

**Done when (do each by hand in the browser pane):**
- New → Piano, G major, 4/4. Click a note onto **every line and space** of the treble staff from
  middle C to high A, then of the bass staff from low E to middle C. Each lands where clicked
  and the status bar names the right pitch.
- Type `C D E F G A B C` — it forms an ascending scale (octave choice works), and auto-advances
  into bar 2 and bar 3.
- A fifth quarter note in a 4/4 bar is refused with "Bar is full".
- Shift-click builds a three-note chord; shift-click on one of its notes removes it.
- Arrow keys, delete, dot, sharp/flat/natural, tie, duration keys all act on the selection.
- Undo back to empty, redo forward again; the score is identical.
- Fill enough bars to reach a second system; clicking there enters notes in the right bar.
- Resize the window narrower so the sheet scales; clicking still lands on the right pitch.
- Reload the page: the score is still there.
- Play: sound is heard, tied notes are not re-struck, the highlight follows; Stop silences it.
- Print preview shows only the sheet.
- Tab through the toolbar and palette with the keyboard; every control is reachable and labelled.

---

## Phase 3 — MusicXML and MXL

Build: `src/io/open.js` (§9.1), `src/io/musicxml.js` (§9.2, §9.3), import report panel (§9.6),
Save / Open / drag-and-drop.

- [x] Export, then import, then test check 5 (round trip deep-equal).
- [x] `.mxl` unzip path.
- [x] `samples/`: write by hand `simple.musicxml` (one staff, a few bars), `piano.musicxml`
      (two-staff part with `<backup>`, two voices in the right hand, a grace note, a triplet),
      and build `simple.mxl` from the first. Add expected-event checks (test check 6).
- [x] File-size limits and `textContent`-only rule from DESIGN §1.6.
- [x] Sniffing table including the legacy `.mus` message and the `score-timewise` message.
      Leave the MIDI, MuseScore and `.musx` branches returning "not supported yet".

**Done when:**
- `test.html` PASS including round trip and samples.
- Save a score made in Phase 2, reopen it: identical on screen.
- `piano.musicxml` opens as a braced grand staff; the report lists the skipped second-voice notes
  and the grace note; the triplet shows a bracket with a 3.
- A file named `x.mus` containing arbitrary bytes shows the legacy message, not an error.
- Cross-check with the installed MuseScore: convert a Coda-saved file with
  `"/Applications/MuseScore 4.app/Contents/MacOS/mscore" -o /tmp/check.pdf saved.musicxml`
  and confirm it converts without errors and the PDF shows the same music. If MuseScore is
  missing or the command fails, say so; do not claim it was checked.

---

## Phase 4 — MIDI import

Build: `src/io/midi.js` (§9.4).

- [x] Parser with running status and all event lengths handled.
- [x] Conversion steps 1–8.
- [x] `samples/scale.mid`: generate it with a short script (keep the script in `samples/`),
      format 1, two tracks, including a note that crosses a barline and a chord. Add test check 6
      for it.

**Done when:** `test.html` PASS; the sample opens as two staves with correct notes, a tie across
the barline, and sensible clefs; a format-0 file and a file with a percussion channel both open
and report what was skipped.

---

## Phase 5 — MuseScore import

Build: `src/io/mscz.js` (DESIGN §9.7).

- [x] Make real samples with the installed MuseScore:
      `"/Applications/MuseScore 4.app/Contents/MacOS/mscore" -o samples/piano.mscz samples/piano.musicxml`
      (and the same for `simple`). If the command fails or MuseScore is missing, ask the user
      for a `.mscz` file instead; do not hand-write one.
- [x] Unzip a sample, read the `.mscx`, and **correct DESIGN §9.7** to match what is really
      there. Change its marker to [verified].
- [x] Write the importer. Wire the `.mscz` and `.mscx` rows of the sniffing table.
- [x] Test check 6: `piano.mscz` imports to the same events as `piano.musicxml` does (same
      skipped-voice and grace-note counts in the report).

**Done when:** `test.html` PASS; both samples open and look the same as their MusicXML
originals; a `.mscz` with its `.mscx` entry removed gives a message, not an exception.

---

## Phase 6 — `.musx` import

**Before starting, ask the user for:** two or three real `.musx` files, ideally small, and for
each one the same piece exported as MusicXML or a PDF/screenshot to compare against. A piano
piece, something in a flat key, and something with a triplet and a tie cover the unknowns.
Without real files this phase cannot be verified; do not write the mapper blind.

Order matters here:

1. [x] `crypt` + unzip + gunzip + parse (§9.5 "Decode"). Test check 7. (Tested on a synthetic file only.)
2. [x] `?debug` download of the decoded EnigmaXML.
3. [ ] **Open the decoded XML and confirm every element name and formula in §9.5**, not only
       the rows of its "[expected]" table: the Structure bullets were partly inferred too.
       Update DESIGN.md with what the file actually says and change the markers to [verified]. If the structure differs from §9.5 in a way that changes the
       approach, stop and tell the user.
4. [ ] Write the mapper: staves in score order → bars → layer-1 entries → events.
5. [ ] Report everything skipped (layers 2–4, voice 2, grace notes, tuplets, unknown clefs/keys).
6. [ ] If a sample may be redistributed (ask the user), add it to `samples/` with an
       expected-events check. Otherwise test locally and note that in Open items.

**Done when:** each provided file opens; notes, rhythms, key, time, clefs and ties match the
reference for layer 1; the report accounts for everything not carried over; a truncated or
corrupt `.musx` produces a message rather than an exception.

---

## Phase 7 — Publish

**Ask the user before any step that creates or pushes to a remote.** The user said GitHub Pages
is the target and approved a public repo named `coda`, but confirm at the time.

- [x] Finish `README.md` (live link still a placeholder): what Coda is, the live link, how to run locally, keyboard shortcuts,
      the format support table (what opens, what is approximated, the `.mus` situation), what is
      not supported yet (DESIGN §8), licence, not-affiliated line.
- [x] Serve the project from a subpath and confirm everything loads (done via a scratch folder
      containing only a `coda` link, so other projects in the parent folder aren't served).
- [ ] `gh auth status`. If not authenticated, or the repo name is taken, stop and ask.
- [ ] `gh repo create coda --public --source=. --push`.
- [ ] Enable Pages from `main`, root. Wait for the build, open the live URL, open a sample file there.

**Done when:** the live URL loads, a sample opens, and the README link points to it.

---

## After the first version (not scheduled)

In rough order of how much users will miss them: tuplet entry; inserting notes mid-bar and
copy/paste; second voice; slurs, articulations, dynamics; lyrics; repeats; clef changes;
MIDI export; better sounds (a small soundfont). Each needs a short design note added to
DESIGN.md before work starts.

## Open items

- **MuseScore 3.x files are untested.** The importer has 3.x branches but no 3.x sample exists here.
  A real 3.x `.mscz` would confirm them.
- **Rest padding in exported MusicXML is greedy** (e.g. after an eighth in 3/4: half + eighth),
  not beat-aware. Correct durations, but not how an engraver would write it.
- **Undo history is per session**; it is not saved with the autosave.
- **Phase 6 (`.musx`) is blocked** on sample files from the user (see Phase 6).
- **Phase 7 (publish) is waiting** for the user's go-ahead.
