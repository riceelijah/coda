# Coda

Coda is a free, open-source music notation editor that runs entirely in your web browser.
Write simple scores by clicking or typing notes, play them back, print them, and open files
from other notation programs. Nothing is uploaded anywhere: your score stays in your browser.

Coda is an independent project and is not affiliated with or endorsed by MakeMusic, Inc.

**Try it:** <https://riceelijah.github.io/coda/>

## Using Coda

- **File ▸ New** sets up a score: title, composer, staves (single staff, piano, SATB…), key, time, tempo, number of bars.
- **Click** on a staff to add a note of the selected length; clicking between two notes inserts it there. Click a note to select it. To build a chord, select a note and press **Shift+A–G**, **Shift+click** the staff, or turn on the chord button so clicks add to the selected note.
- **Type** letters to add notes quickly. Coda picks the octave closest to the previous note and moves to the next bar when one fills up.
- The **Selection tool** (arrow, top of the left palette, or `V`) selects instead of adding notes: click a note, drag a box around notes, Shift+click to extend. Duration, dot, accidentals, tie, transpose and tuplets then apply to all the selected notes. Right-click a note or bar for a menu of actions.
- The **Notes** menu adds dynamics, slurs (`S`), crescendo and diminuendo hairpins, articulations, lyrics (`L`, then type: Space moves to the next note, `-` splits a word, ↑/↓ switch between up to 5 verses) and grace notes (the grace button, then click a note or type A–G). Dynamics and hairpins change how loud the part plays.
- **Drums:** choose *Drums* in New, or add a *Drum staff* in Score ▸ Parts and instruments. Click a line or space (or type A–G) for the drum that goes there: bass drum, snare, toms, hi-hats and cymbals, with x noteheads for cymbals. ↑/↓ move to the next drum; Notes ▸ Drums ▸ Drum sound… picks any of the 47 General MIDI drums. Drums play a recorded General MIDI kit (FluidR3), downloaded on first use; offline, a kit built into Coda stands in.
- **Tracks:** the toolbar's *Tracks* button (or Score ▸ Tracks to play and export…) picks which parts play and go into exports: export just the trumpet part, or an audio file without the piano. Saving always keeps every part.
- **Falls and slides:** Notes ▸ Brass effects ▸ Scoop, Fall and Doit for brass effects, and Notes ▸ Brass effects ▸ Slide to next for a trombone-style glissando (select a phrase to make every note glide into the next). They play as real pitch bends.
- **Score ▸ Key and time** changes the key or time signature from the current bar on; **Score ▸ Clef from this bar** changes a staff's clef. **View** zooms the score.
- **Score ▸ Parts and instruments** adds, removes, renames and reorders parts (treble, bass, alto or tenor staff, or a grand staff), and picks a sound for each part from the 128 General MIDI instruments (New also asks for one). Sounds download the first time a part uses them and are then kept in your browser; without a connection, parts play a plain tone. Each part can also be set to a transposing instrument (B♭ clarinet or trumpet, F horn, E♭ alto sax and others): the notes are then written for that instrument and still sound the same.
- **Play** plays from the current bar.
- **File ▸ Print…** (Ctrl/Cmd+P) prints the score.
- **File ▸ Export** saves the score as a PDF (through your browser's print dialog), MusicXML, compressed MusicXML (`.mxl`), MuseScore (`.mscz`), MIDI, WAV or MP3 audio, or compressed audio (WebM, Ogg or M4A, whichever your browser can record; it takes as long as the piece).
- Your work is saved automatically in this browser. **File ▸ Scores in this browser** lists everything saved here: open, duplicate or delete. Scores stay only in this browser, so use **File ▸ Save as MusicXML** to keep a file (MusicXML) you can back up or open anywhere.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `A`–`G` | Add that note after the selected note (or at the end of the bar) |
| `Shift+A`–`G` | Add that note above the selected note (chord) |
| `R` or `0` | Add a rest |
| `7` `6` `5` `4` `3` `2` | Whole, half, quarter, eighth, 16th, 32nd (also changes the selected note) |
| `.` | Dot (again for a double dot, again for none) |
| `+` `-` `N` | Sharp, flat, natural |
| `T` | Tie the selected note to the next |
| `S` | Slur the selected notes |
| `L` | Type lyrics, starting at the selected note |
| `↑` `↓` | Move the selected notes by a step (with Shift or Ctrl/Cmd: an octave) |
| `←` `→` | Select the previous / next note (with Shift: extend the selection) |
| `Ctrl/Cmd+C`, `X`, `V` | Copy, cut, paste the selected notes |
| `9` or `;` | Tuplets on/off for the next notes (Notes ▸ Tuplet… picks 3:2, 2:3, 4:3, 5:4 or 6:4) |
| `Delete` | Delete the selected notes |
| `V` | Switch between the Selection tool and the Note entry tool |
| `Ctrl/Cmd+A` | Select all notes in this staff |
| Right-click, `Shift+F10` | Actions for the note or bar under the pointer |
| `Space` | Play / stop |
| `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` | Undo, redo |
| `Ctrl/Cmd+S`, `Ctrl/Cmd+O` | Save, open |
| `?` | Show these shortcuts |

## Opening files

| Format | Status |
|---|---|
| MusicXML (`.musicxml`, `.xml`) | Opens and saves. This is Coda's own file format. |
| Compressed MusicXML (`.mxl`) | Opens. |
| MuseScore (`.mscz`, `.mscx`) | Opens (tested with MuseScore 4 files), drum parts included. |
| MIDI (`.mid`, `.midi`) | Opens as an automatic transcription; it will usually need tidying. Channel 10 becomes a drum staff. |
| Finale (`.musx`, 2014 and later) | Opens notes, rests, chords, ties, tuplets, layers 1–4 and second voices, keys, time signatures (with C and ¢), clefs, staff names, staccato/accent/tenuto/marcato/fermata, transposing instruments, the opening tempo, an instrument sound when the staff name matches one, dynamics, slurs, hairpins, lyrics (up to 5 verses), clef changes and grace notes. Drum staves open as drum parts, but Finale's drum maps aren't read yet, so each drum is chosen from its place on the staff. Text and tempo marks, other lines and repeats are left out and counted in the report; page layout is not carried over. |
| Finale (`.mus`, 2012 and earlier) | Can't be opened. The format is closed and undocumented, and no open reader exists. Export MusicXML from a copy of Finale or Finale NotePad instead. |

Coda keeps up to four layers (voices) per staff. When a file contains things Coda doesn't support yet
(repeats, text marks…), it opens the rest and lists what it left out.

## Not supported yet

Articulations other than staccato/accent/tenuto/marcato/fermata, septuplets, repeats and endings, a concert-pitch view, page layout
controls, and a one-click PDF (PDF export uses the browser's print dialog). See [docs/ROADMAP.md](docs/ROADMAP.md).

## Running it locally

Coda is plain HTML and JavaScript with no build step. Serve the folder over HTTP (ES modules
don't load from `file://`):

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000/>. Self-checks run at <http://localhost:8000/test.html>.

`docs/DESIGN.md` describes how Coda works and `docs/PLAN.md` tracks what's done and what's next.

## Licence

MIT — see [LICENSE](LICENSE). Coda bundles [VexFlow](https://www.vexflow.com) (MIT, including the
Bravura music font under the SIL Open Font License), [fflate](https://github.com/101arrowz/fflate) (MIT)
and, for MP3 export, [wasm-media-encoders](https://github.com/arseneyr/wasm-media-encoders) (MIT) with
the [LAME](https://lame.sourceforge.io/) encoder (LGPL); see [vendor/README.md](vendor/README.md).

Instrument sounds are the FluidR3_GM sound set by Frank Wen (MIT), in the MP3 rendering from
[gleitz/midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts) (CC BY 3.0). They are not
in this repository: the browser downloads each one from jsDelivr (or gleitz.github.io) the first time
a score needs it. Drum sounds are FluidR3's GM Standard kit (Copyright (c) 2000-2002, 2008 Frank
Wen, MIT), as packaged by Sergey Surikov's [webaudiofontdata](https://github.com/surikov/webaudiofontdata)
(MIT), downloaded the same way from jsDelivr (or surikov.github.io).

The `.musx` test files in `samples/musx/` come from [musxdom](https://github.com/openmusx/musxdom)
(MIT); see [samples/musx/README.md](samples/musx/README.md).
