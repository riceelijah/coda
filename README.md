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
- The **Selection tool** (arrow, top of the left palette, or `V`) selects instead of adding notes: click a note, drag across notes, Shift+click to extend. Duration, dot, accidentals, tie, transpose and tuplets then apply to all the selected notes. Right-click a note or bar for a menu of actions.
- **Score ▸ Key and time** changes the key or time signature from the current bar on. **View** zooms the score.
- **Score ▸ Instruments** picks a sound for each part from the 128 General MIDI instruments (New also asks for one). Sounds download the first time a part uses them and are then kept in your browser; without a connection, parts play a plain tone.
- **Play** plays from the current bar.
- **File ▸ Export** saves the score as a PDF (through your browser's print dialog), MusicXML, compressed MusicXML (`.mxl`), MuseScore (`.mscz`), MIDI, WAV audio, or compressed audio (WebM, Ogg or M4A, whichever your browser can record; it takes as long as the piece).
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
| MuseScore (`.mscz`, `.mscx`) | Opens (tested with MuseScore 4 files). |
| MIDI (`.mid`, `.midi`) | Opens as an automatic transcription; it will usually need tidying. |
| Finale (`.musx`, 2014 and later) | Opens notes, rests, chords, ties, tuplets, layers 1–4, keys, time signatures, clefs and staff names. Expressions, articulations, lyrics and slurs are left out and counted in the report; page layout is not carried over. |
| Finale (`.mus`, 2012 and earlier) | Can't be opened. The format is closed and undocumented, and no open reader exists. Export MusicXML from a copy of Finale or Finale NotePad instead. |

Coda keeps up to four layers (voices) per staff. When a file contains things Coda doesn't support yet
(grace notes, clef changes…), it opens the rest and lists what it left out.

## Not supported yet

Lyrics, articulations other than staccato/accent/tenuto/marcato/fermata, dynamics, slurs, grace notes, septuplets, repeats and endings, mid-score clef changes, transposing instruments, page layout
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
Bravura music font under the SIL Open Font License) and [fflate](https://github.com/101arrowz/fflate) (MIT);
see [vendor/README.md](vendor/README.md).

Instrument sounds are the FluidR3_GM sound set by Frank Wen (MIT), in the MP3 rendering from
[gleitz/midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts) (CC BY 3.0). They are not
in this repository: the browser downloads each one from jsDelivr (or gleitz.github.io) the first time
a score needs it.

The `.musx` test files in `samples/musx/` come from [musxdom](https://github.com/openmusx/musxdom)
(MIT); see [samples/musx/README.md](samples/musx/README.md).
