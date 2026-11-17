# Coda

Coda is a free, open-source music notation editor that runs entirely in your web browser.
Write simple scores by clicking or typing notes, play them back, print them, and open files
from other notation programs. Nothing is uploaded anywhere: your score stays in your browser.

Coda is an independent project and is not affiliated with or endorsed by MakeMusic, Inc.

**Try it:** <https://riceelijah.github.io/coda/>

## Using Coda

- **New** sets up a score: title, composer, staves (single staff, piano, SATB…), key, time, tempo, number of bars.
- **Click** on a staff to add a note of the selected length. Click a note to select it. To build a chord, select a note and press **Shift+A–G**, **Shift+click** the staff, or turn on the chord button so clicks add to the selected note.
- **Type** letters to add notes quickly. Coda picks the octave closest to the previous note and moves to the next bar when one fills up.
- **Key/Time** changes the key or time signature from the current bar on.
- **Play** plays from the current bar. **Print** prints the score, or saves it as a PDF from your browser's print dialog.
- Your work is saved automatically in this browser. Use **Save** to keep a file (MusicXML) you can open anywhere.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `A`–`G` | Add that note |
| `Shift+A`–`G` | Add that note above the selected note (chord) |
| `R` | Add a rest |
| `7` `6` `5` `4` `3` `2` | Whole, half, quarter, eighth, 16th, 32nd (also changes the selected note) |
| `.` | Dot (again for a double dot, again for none) |
| `+` `-` `N` | Sharp, flat, natural |
| `T` | Tie the selected note to the next |
| `↑` `↓` | Move the selected note by a step (with Ctrl/Cmd: an octave) |
| `←` `→` | Select the previous / next note |
| `Delete` | Delete the selected note |
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
| Finale (`.musx`, 2014 and later) | Opens notes, rests, chords, ties, tuplets, keys, time signatures, clefs and staff names. One layer per staff. Expressions, articulations, lyrics and slurs are left out and counted in the report; page layout is not carried over. |
| Finale (`.mus`, 2012 and earlier) | Can't be opened. The format is closed and undocumented, and no open reader exists. Export MusicXML from a copy of Finale or Finale NotePad instead. |

Coda keeps one voice per staff. When a file contains things Coda doesn't support yet (second
voices, grace notes, clef changes…), it opens the rest and lists what it left out.

## Not supported yet

Lyrics, articulations, dynamics, slurs, grace notes, entering tuplets, more than one voice per
staff, repeats and endings, mid-score clef changes, transposing instruments, inserting notes in the
middle of a bar, copy/paste, page layout controls, sampled instrument sounds, and MIDI export.

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

The `.musx` test files in `samples/musx/` come from [musxdom](https://github.com/openmusx/musxdom)
(MIT); see [samples/musx/README.md](samples/musx/README.md).
