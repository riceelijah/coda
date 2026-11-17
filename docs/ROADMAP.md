# Missing features

What Coda can't do yet, grouped by priority. "NotePad" means the free editor Coda replaces; it's
the baseline. Size is a rough guess: **S** under a day, **M** a few days, **L** a week or more.
Sources are at the end.

## 1. Fix first: features that exist but can't be found

| Feature | Today | Fix | Size |
|---|---|---|---|
| **Chords** | **Done (Phase 8).** Shift+A–G adds above the selected note; a palette chord button makes clicks stack; the hint mentions both. (Alt+digit intervals dropped: Alt changes keys on macOS.) | — | — |
| **Hear notes as they're entered** | **Done (Phase 8).** | — | — |
| **Key / time changes mid-score** | **Done (Phase 8):** Key/Time button. | — | — |
| **Double dots** | **Done (Phase 8).** | — | — |
| **Measure numbers** | **Done (Phase 8).** | — | — |

## 2. NotePad parity: things NotePad users will look for

These were all in NotePad 2012's tools (Simple Entry, Tuplet, Articulation, Expression,
Smart Shape, Lyrics, Repeat, Key Signature, Mass Mover).

| Feature | Notes | Size |
|---|---|---|
| **Select a range, then copy / paste / delete / transpose it** | **Done (Phase 9)** with Shift+←/→. Mouse range selection is still to do. | — |
| **Insert notes mid-bar** | **Done (Phase 9):** typing goes after the selected note; clicking between notes inserts there. An overwrite mode is not done. | — |
| **Tuplet entry** (triplets first) | **Done (Phase 9)** for triplets (`;`). Other ratios still to do. | — |
| **Second voice** (stems up/down in one staff) | Needed for piano and SATB on two staves. Importers currently drop voice 2 and say so. | L |
| **Articulations**: staccato, accent, tenuto, marcato, fermata | VexFlow draws them. Playback should shorten staccato notes. | S |
| **Dynamics and hairpins** (p, mf, ff, cresc.) | NotePad's Expression tool also did tempo text and rehearsal letters. | M |
| **Slurs** | | M |
| **Lyrics** (one verse) | Type syllables under notes; space moves on, hyphen splits a word. | M |
| **Repeats and 1st/2nd endings**, played back | NotePad drew them but didn't play them back; Coda can do both. | M |
| **Clef changes mid-score** | Importers count and skip them today. | S |
| **Pickup bar** (anacrusis) | NotePad couldn't do this either; very common in songs and hymns. | S |
| **Grace notes** | NotePad couldn't do this either. | M |
| **MIDI keyboard entry** | Browsers can read a MIDI keyboard directly (Web MIDI API), so no dependency is needed. Chrome and Edge support it; Firefox asks for permission; Safari doesn't. | S |
| **MIDI export** | NotePad had it. The playback scheduler already has the note list. | S |
| **Up to 8 staves with instrument names** | **Instrument sounds done (Phases 12–13):** Score ▸ Instruments. Adding/renaming staves after New is still to do. | S |

## 3. What people praise in other editors (worth copying)

- **Fast keyboard entry that stays out of the way.** Dorico users say input is fast because they
  never stop to fix layout; MuseScore is recommended as the easiest to start with. Coda's
  letter-key entry is the right base. Next would be an always-visible input cursor and
  overwrite/insert modes (section 2).
- **Automatic layout.** Users like not having to drag things around. Coda already does this.
  Keep page layout automatic, with only a few controls (see section 4).
- **Shortcuts other programs use.** Switchers want the shortcuts they already know. MuseScore is
  adding a Finale-style input mode for this reason. Consider letting users switch the duration
  keys between Coda's current set and Dorico's layout.
- **Free, with nothing to install, and files that open elsewhere.** These are Coda's main
  advantages. Reliable MusicXML round-trips matter more than features.
- **Real-time collaboration and version history** (Flat's main selling point). This needs a
  server, so it doesn't fit a static site. A share link with the score compressed into the URL is
  a server-free middle ground. **M**

## 4. Commonly wanted next

Ordered roughly by how often they come up for students, teachers and hobbyists.

| Feature | Notes | Size |
|---|---|---|
| **Transpose the whole score** (by interval or to a new key) | A teacher must-have. | S |
| **Transposing instruments** and a concert-pitch toggle | Needed for band (Bb clarinet, trumpet, F horn, alto sax). | M |
| **Chord symbols** above the staff | Lead sheets; NotePad couldn't do this. | M |
| **Part extraction** (print one staff on its own) | | M |
| **Better playback sounds** | **Done (Phase 13):** all 128 General MIDI sounds, downloaded on demand. Still to do: your own samples, a note-level playback cursor. | — |
| **Export PDF / PNG / audio** | Printing to PDF works today; direct PDF/PNG and WAV export are the next steps. | M |
| **Page and system breaks**, staff size, page size | A small set of controls, not full engraving. | M |
| **Multi-measure rests** | Mostly matters for parts. | S |
| **Enharmonic respell** (F# ⇄ Gb) | Shortcut key. | S |
| **Beam control** (break/join beams) | | S |
| **Percussion staff** (drum kit) | | L |
| **Guitar tab** | | L |
| **Touch / tablet entry** | Taps already register as clicks, but the hover preview doesn't show on touch screens. | M |
| **Accessibility**: screen-reader navigation of the score | MuseScore is investing here for blind musicians. Coda's model makes a text description of the selected note cheap to produce. | M |

## 5. Not planned for now

Optical music recognition (scanning PDFs), plugins/scripting, VST instruments, real-time
multi-user editing, `.mus` (pre-2014 Finale) files.

## Sources

- NotePad 2012 tool list: [NotePad 2012 reference](https://usermanuals.finalemusic.com/NotePad2012Win/Content/NotePad/Reference.htm), [NotePad 2009 what's new](https://usermanuals.finalemusic.com/NotePad2009Win/Content/NotePad/Whats_New.htm)
- NotePad vs MuseScore, row by row (2011): [musescore.org comparison](https://musescore.org/en/comparing-musescore-and-finale-notepad-feature-feature)
- What Finale users asked MuseScore for: [MuseScore near-term plans](https://musescore.org/en/4.5-and-beyond), [MuseScore 4.5 review, Scoring Notes](https://www.scoringnotes.com/news/musescore-studio-4-5/), [MuseScore supporting Finale users](https://musescore.org/en/node/367594)
- User wish lists: [Top features I'd like to see](https://musescore.org/en/node/334724), [MuseScore 4 feature requests](https://musescore.org/en/node/337045)
- What users like in each editor: [r/composer: Dorico or MuseScore](https://pol1.lr.ggtyler.dev/r/composer/comments/1fq1mtz/dorico_or_musescore), [Sibelius vs Dorico (Steinberg forum)](https://forums.steinberg.net/t/sibelius-vs-dorico/997284)
- Browser editors: [Flat vs Noteflight](https://blog.flat.io/flat-for-education-vs-noteflight-which-music-notation-platform-is-right-for-your-classroom-2/), [Finale alternatives 2026](https://blog.flat.io/best-finale-alternatives-2026/)
- Teacher must-haves: [capella feature list](https://www.capella-software.com/us/index.cfm/products/capella/feature-list)
