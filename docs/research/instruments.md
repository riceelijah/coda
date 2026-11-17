# Research: instrument sounds

Status: research and plan only (Nov 2026). Nothing here is built yet. DESIGN.md §8 lists
"sampled instrument sounds" as out of scope for the first version, and PLAN.md asks for a design
note before that work starts. This file is the input to that note.

Markers: **[verified]** means I checked the primary source (a licence file, the repo, or a measured
file). **[unverified]** means it comes from a secondary source or from memory.

---

## 1. Summary

- **Default sounds:** self-host a subset of the pre-rendered **FluidR3_GM** per-note MP3s
  (gleitz/midi-js-soundfonts). Keep about one note per minor third, only within each instrument's
  range. Repitch with `playbackRate` and lazy-load per instrument. This needs no new library and
  no parser, and the source is MIT. That's about 3 MB in the repo for a 9-instrument starter set,
  and about 1 MB downloaded the first time a typical score plays.
- **Main cost:** each rendered note is a fixed **3.16 s** with no loop points. Long notes need a
  crude loop over a middle region, or they cut off. SoundFont (SF2) has real loops; that is the
  upgrade path.
- **User sounds:** add them in this order: a single audio file mapped to a range, then SF2 (with a
  hand-written reader of about 250 lines), then SFZ supplied as a zip. Store them in IndexedDB. A
  missing user sound falls back to the staff's General MIDI program, and Coda says so.
- **Model:** add two optional staff fields, `program` (0–127, General MIDI) and `sound` (an ID for
  a user sound). This is a §3 model change and a §9 format change, so it needs the user's
  sign-off.

---

## 2. Sample sources

| Source | Licence | Size | Coverage | Format | Quality | Use? |
|---|---|---|---|---|---|---|
| **FluidR3_GM** (Frank Wen) | **MIT** per upstream COPYING [verified, Debian copyright; also quoted in MuseScore's licence file]. The gleitz README labels the same set "CC BY 3.0" ⚠ | SF2 ≈ 148 MB [gleitz README] | GM 128 + drum kits | SF2 | Decent, dated | **Yes**, as the source of the default set |
| **gleitz/midi-js-soundfonts**, FluidR3_GM folder | Repo is **MIT**; the README says the Fluid set is CC BY 3.0 ⚠. Credit both. | 128 instruments × 88 notes; ≈ 240 MB of MP3 in total; **≈ 2 MB per instrument**, ≈ 22 KB per note [verified, git tree] | GM 128 melodic. **No drum kit** (channel 10) [verified] | Per-note MP3 (64 kbps stereo, 44.1 kHz, **3.16 s**). OGG exists only inside `*-ogg.js`, like `*-mp3.js` (base64 in JavaScript; never load these) [verified] | Same as FluidR3 | **Yes**, copy the raw `.mp3` files |
| gleitz MusyngKite / FatBoy | **CC BY-SA 3.0** ⚠ (share-alike) | larger | GM 128 | Same | Better than Fluid | No; avoid share-alike assets in an MIT repo |
| **MuseScore_General** / **MS Basic** (S. Christian Collins, on FluidR3Mono) | **MIT**. The acknowledgements and copyright notices "must be included in any derivative work" [verified]. ⚠ `MS Basic_License.md` in the MuseScore repo still contains the MuseScore_General v0.2 text, so MS Basic's own licence is inferred. The HQ variant mixes in CC0 and public-domain parts. | `MS Basic.sf3` 51 MB; `FluidR3Mono_GM.sf3` 24 MB [verified, MuseScore repo] | GM 128 + drums + extra banks | **SF3**: Ogg Vorbis inside, decoded per sample | Better than FluidR3 | Later, as a render source (needs tooling) or as an SF2 default; see §7 |
| **GeneralUser GS** v2.0.3 (S. Christian Collins) | Custom permissive licence: use "without restriction … private or commercial", modify and repackage. ⚠ The author says he "cannot be 100% sure where all of the samples originated". Asks not to hotlink his downloads. [verified, LICENSE.txt] | SF2 **32 MB** [verified] | GM + GS: 261 presets, 13 kits | SF2 | Good, but relies on SF2 modulators that a minimal reader ignores | Possible SF2 default; provenance caveat |
| **Salamander Grand Piano** v3 (Alexander Holm) | **CC BY 3.0** [verified, sfzinstruments LICENSE] | ≈ 750 MB FLAC [verified, git tree] | Piano only (16 velocity layers, sampled in minor thirds) | SFZ (ARIA extensions) + FLAC | Very good | Later, as a "better piano" with a few velocity layers re-encoded |
| **VSCO 2 CE** (Versilian) | **CC0 1.0** [verified]. The readme *asks* you not to sell the samples and to give credit; that is a request, not a condition. | Repo ≈ 3.2 GB [verified]; 3,138 samples | Orchestral: strings, woodwinds, brass, keys, percussion | SFZ + WAV | Good, uneven | Possible orchestral upgrade or drum source |
| **VCSL** (Versilian Community Sample Library) | **CC0 1.0** [verified, repo licence] | Repo ≈ 4 GB [verified]; 20–75 MB per instrument | Broad: by instrument family, including percussion | WAV, with SFZ in releases | Good, uneven | **Drum and percussion source** later |
| **Sonatina Symphonic Orchestra** (peastman/sso) | **CC Sampling Plus 1.0** ⚠ [verified, LICENSE]. Retired by CC. Copying the samples verbatim is allowed only for **noncommercial** purposes; commercial use only once they are transformed [verified, CC deed]. That is incompatible with shipping them in an MIT repo that permits commercial reuse. | Download size not checked: release assets came back empty [unverified] | Full orchestra, many articulations | SFZ | Good | **No** |
| **Philharmonia** samples | Own terms: free to use in works, but "must not be sold or made available 'as is' (i.e. as samples or as a sampler instrument)" ⚠ [verified, philharmonia.co.uk] | ZIPs | All orchestral instruments, guitars, percussion | MP3 [unverified] | Short, single notes | **No**: hosting them would be "making them available as samples" |
| **surikov/webaudiofont** | Code is **GPL-3.0** ⚠ [verified]. Sounds come from many SoundFonts (FluidR3, GeneralUser, and others such as "SBLive" and "Aspirin") of mixed or unclear origin. | ≈ 150 MB repo | GM 128 + drums, several variants | JavaScript files that define variables (loaded as scripts) | Varies | **No**: GPL, unclear sample origin, and the sounds are executable JS |

Licence flags in one place:
- **FluidR3:** upstream says MIT, gleitz says CC BY 3.0. Ship a `sounds/CREDITS.txt` that keeps the
  MIT notice *and* gives CC BY attribution; that satisfies both readings.
- **MuseScore_General / MS Basic:** MIT, plus a required acknowledgements block.
- **GeneralUser GS:** permissive, but the author admits uncertain provenance.
- **Not usable:** Sonatina (Sampling Plus: verbatim copying noncommercial only, retired), Philharmonia ("not as-is"), webaudiofont (GPL),
  MusyngKite and FatBoy (share-alike).

---

## 3. Formats and loading

### 3.1 Format comparison

| | Per-note MP3 (pre-rendered) | SF2 | SF3 | SFZ + WAV/FLAC |
|---|---|---|---|---|
| Parser code | None: `fetch` + `decodeAudioData` | ≈ 250 lines (RIFF, the preset tables, 16-bit PCM to float) | SF2 reader + `decodeAudioData` per sample | ≈ 100 lines (text opcodes) + `decodeAudioData` |
| Loop points | **None.** Notes are fixed-length (3.16 s here) | Yes | Yes | Yes (`loop_start`/`loop_end`) |
| Download size | Small (64 kbps MP3) | Large (uncompressed PCM, ≈ 88 KB/s mono) | Small | Depends (FLAC ≈ ½ WAV) |
| Lazy per instrument | Trivial: one folder per program | Needs HTTP Range requests or per-instrument files | Same | One folder per instrument |
| Browser decode | MP3: all browsers | Our own code | Ogg Vorbis: Chrome and Firefox yes; **Safari only from 18.4, unverified** ⚠ | WAV, FLAC: all browsers; OGG: same Safari caveat |
| User files in the wild | Rare | **Most common** | Common (MuseScore) | Common for higher-end free libraries |

Notes:
- **SF2 detail a minimal reader handles:** generators for key and velocity range, sample ID,
  root key, coarse and fine tune, sample modes (loop), address offsets, attenuation, pan and
  volume-envelope release, plus global zones. Preset-level generators add to instrument-level
  ones. It ignores modulators, filters, LFOs, the modulation envelope and 24-bit `sm24` data,
  and counts them in a report. GeneralUser GS and MuseScore_General lean on modulators, so they
  will sound plainer through a reader like this than in FluidSynth.
- **HTTP Range on Pages:** `accept-ranges: bytes` is present [verified on gleitz.github.io].
  That would allow loading one SF2's preset table and then only the sample bytes it needs.
  `Cache.put` rejects 206 (partial) responses, so cached ranges would have to go into IndexedDB.
  Workable, but more code than per-file packs.
- **Per-file limit:** GitHub blocks files over **100 MiB** and warns over 50 MiB [verified].
  FluidR3_GM.sf2 (≈ 148 MB) cannot be committed whole. GeneralUser GS (32 MB) and the SF3 files
  can. Pages: 1 GB site, 100 GB/month soft bandwidth [verified]. Pages sends
  `cache-control: max-age=600` [verified], so add a Cache API layer for instant replays and
  offline use.

### 3.2 Keeping the first load small

1. **Lazy load:** when Play (or audition) starts, load only the programs that staves use. The
   first Play shows "Loading sounds…" and waits. If loading fails, that staff plays with the
   existing triangle-wave voice and the status bar says so.
2. **Sparse notes:** keep one sample per **minor third** (pitches shift at most ±1.5 semitones,
   which sounds natural; Salamander is sampled the same way), only within each instrument's range.
   Piano needs about 30 files; most other instruments about 12–16.
3. **Repitch:** set `AudioBufferSourceNode.playbackRate = 2^((midi − root)/12)`.
4. **Sustain workaround (ponytail ceiling):** for sustained families (strings, winds, brass, organ,
   voice, pads), set `loop = true` with `loopStart`≈0.8 s and `loopEnd`≈2.4 s. Measured on String
   Ensemble 1 C4: the level stays flat (about −30 to −33 dB) from 0.4 s to 2.8 s, with no release
   in the file, so this window holds [verified for that one note; check each sustained program].
   Decaying sounds (piano, guitar, plucked) need no loop: piano C4 has dropped about 30 dB by
   3 s. This can click at
   the loop point; masked on ensemble sounds, audible on a pure flute. The upgrade is SF2 sounds,
   which have real loop points.
5. **Memory:** decoded stereo is about 1.1 MB per 3 s note, so a piano would take about 33 MB.
   Mix down to mono when decoding to halve that.
6. **Cache:** use `caches.open("coda-sounds-v1")`: match, else fetch and put. About 10 lines.
   Bump the cache name when the pack changes.
7. **MP3 encoder delay:** about 25 ms of leading silence. Start each source at `offset` 0.025 s, or
   ignore it.

### 3.3 Size estimate for a default set

All figures are **estimates** from the measured average of about 22 KB per note.

| Instrument (GM program, 0-based) | Notes kept | Download |
|---|---|---|
| Acoustic Grand Piano (0) | ≈ 30 | ≈ 0.65 MB |
| String Ensemble 1 (48) | ≈ 18 | ≈ 0.4 MB |
| Flute (73), Clarinet (71) | ≈ 13 each | ≈ 0.3 MB each |
| Trumpet (56), French Horn (60) | ≈ 13 each | ≈ 0.3 MB each |
| Choir Aahs (52) | ≈ 13 | ≈ 0.3 MB |
| Acoustic Guitar, nylon (24) | ≈ 15 | ≈ 0.3 MB |
| Acoustic Bass (32) | ≈ 12 | ≈ 0.25 MB |
| **Drum kit** | **Not covered by this source.** Needs a kit from VCSL (CC0) or one rendered from MuseScore_General, and percussion is out of scope anyway | n/a |
| **Starter set total** | | **≈ 3.2 MB** |
| All 128 GM programs | | ≈ 45 MB in the repo |

A typical score (piano plus one or two instruments) downloads about 1 MB the first time it plays.
That leaves plenty of room under the 100 GB/month Pages limit.

---

## 4. User-supplied sounds

| Format | How it arrives | Effort | Notes |
|---|---|---|---|
| **One audio file → range** | File picker; the user sets the root note (default C4) and a low and high note | S | `decodeAudioData` handles WAV, MP3, FLAC, M4A, and OGG except on older Safari. Optional "sustain loop" toggle using the same region trick as §3.2. |
| **SF2** (and SF3 where the browser decodes Vorbis) | File picker | M | Same reader as §3.1. The user picks a preset from the file's list (names shown with `textContent`). Decode only the presets in use. |
| **SFZ + samples** | **A zip**, read with `fflate` through the existing size-capped unzip in `src/io/util.js`. A folder picker (`webkitdirectory`) is an alternative. | M | Supports `<control>`, `<global>`, `<group>` and `<region>` with the opcodes `sample`, `lokey`/`hikey`/`key`, `pitch_keycenter`, `lovel`/`hivel`, `tune`, `transpose`, `volume`, `loop_mode`, `loop_start`/`loop_end`, `ampeg_release`, `offset`, and `default_path`. `#include`, `#define` and unknown opcodes are counted and reported. |

**Storage (IndexedDB).** Use a database `coda-sounds` with one store `{id, name, kind, blob, meta,
addedAt}`. Keep the original file as a `Blob`, and read only the slices that are needed
(`blob.slice().arrayBuffer()`); this does for local files what Range requests do for remote ones.
- Quotas [verified, MDN]: Chrome allows up to 60 % of the disk per origin. Firefox best-effort
  storage allows the smaller of 10 % of the disk or 10 GiB. Safari 17+ allows about 60 % of the
  disk.
- **Safari deletes script-written storage if the origin has had no user interaction (click or tap)
  in the last 7 days of browser use** [verified, MDN]. Call `navigator.storage.persist()` when the
  user adds a sound (Firefox shows a permission prompt; other browsers decide automatically).
  Whether `persist()` exempts an origin from Safari's 7-day rule is **[unverified]**, so the
  fallback behaviour below is what actually protects the user.
- Check `navigator.storage.estimate()` before storing, and refuse with a clear message if there is
  not enough room.
- The origin `riceelijah.github.io` is shared with every other Pages project of the same user, so
  prefix every IndexedDB and Cache name with `coda-`.

**Assigning a sound to a staff.** A staff's sound picker lists the General MIDI instruments, then
"Your sounds", then "Add your own sound…". Choosing a user sound sets `staff.sound` and keeps
`staff.program` as the fallback.

**Failing gracefully.**

| Failure | Behaviour |
|---|---|
| A user sound is missing (evicted, other device, cleared storage) | Play the staff's `program`. Show one status message: "Sound 'X' isn't on this device; using Piano." Keep `staff.sound` so it comes back if the sound is re-added. |
| SF3 Vorbis can't be decoded (older Safari) | Refuse those presets with a message. Use the fallback program. |
| An SFZ `sample=` path is missing from the zip | Skip that region and count it in the report. If no regions are left, refuse the sound. |
| An SF2 is corrupt or truncated | Report "Not a valid SoundFont" without throwing. The current sound stays. |
| The default pack fails to load (offline, first visit) | Use the triangle-wave voice. Status message. |
| The storage quota is exceeded | Refuse to add the sound. Nothing else changes. |

**Security and limits.** These are untrusted binary and text files.
- Every chunk size and record count is checked against the file length, using `DataView` reads
  with bounds checks. Counts are capped (for example ≤ 65,535 presets, zones and samples).
- **Never execute sound files.** Do not accept `.js` instruments (the MIDI.js and webaudiofont
  formats).
- SFZ `sample=` values are only looked up in the in-memory map of zip entries. URLs and absolute
  paths are rejected, and nothing is fetched.
- Names, preset names and warnings are shown with `textContent` only.
- Caps (to be decided, see §8): an SF2/SF3 file up to **256 MB** (larger than the 50 MB cap for
  scores in DESIGN §1); an SFZ zip under its own cap (DESIGN §1 applies 50 MB to the whole file *before* the 200 MB
  per-entry unzip cap, and a zipped VSCO or VCSL instrument can exceed 50 MB); a single audio
  file up to 50 MB; any one sample decoded to at most 60 s; at most about 200 MB of decoded PCM
  per sound.

---

## 5. Model and UI

### 5.1 Model (needs sign-off: DESIGN §3)

```js
staff = { name, clef, brace, bars,
  program: 0,        // optional. General MIDI program, 0-based 0..127. Absent = 0 (piano).
  sound: "u:abc123"  // optional. ID of a user sound in IndexedDB. Absent = use `program`.
}
```
- Both fields are optional, so old autosaves and pasted score JSON still load. When restoring,
  check `program` is an integer from 0 to 127 and drop it otherwise; check `sound` is a short
  string that matches `^u:[a-z0-9]{1,32}$`.
- A braced pair is exported as one `<part>`, so **both staves share one program**. The UI sets
  both, and import gives both staves the part's program.
- `src/model.js` stays pure. It only gets an `edit()`-able command such as
  `setStaffSound(score, i, {program, sound})`. A braced pair is changed in one undo step.
- `play.js`: `schedule()` adds `staff` to each note. `voice()` takes the staff's loaded sampler.
  `audition()` needs the staff index too.

### 5.2 Importers

| Source | Mapping |
|---|---|
| MusicXML import | `score-part > midi-instrument > midi-program` is **1-based (1–128)** [verified, MusicXML 4.0 `midi-128`], so `program = value − 1`. Out-of-range values are counted and become 0. `midi-channel` 10 or `<midi-unpitched>` counts as "Percussion part: played as piano" in the report. Several `score-instrument`s in one part: use the first and count the rest. |
| MIDI import | `midi.js` already parses `Cn` (program change) and ignores it. Use the first program change on the channel(s) a track uses; count later changes in the report ("Instrument changes mid-track: n, first one used"). Bank select (CC 0/32) is ignored and counted. Channel 10 is already skipped and reported. |
| MuseScore import | `Part > Instrument > Channel > program@value` (0-based) [unverified; confirm against a real `.mscx`]. |
| `.musx` import | Leave unset. The mapping is unknown; check it on a real file later. |

### 5.3 MusicXML export

In each `<score-part>`, write
`<score-instrument id="Pn-I1"><instrument-name>{name}</instrument-name></score-instrument>` and
`<midi-instrument id="Pn-I1"><midi-channel>{n}</midi-channel><midi-program>{program+1}</midi-program></midi-instrument>`.
Channels are assigned 1, 2, … and skip 10. **The user sound ID does not round-trip.** Only the
fallback program is exported; the export report or Help says so. The program survives a
save-and-reopen.

### 5.4 Where the user picks

- **Setup dialog (New):** each preset gets a sensible program (Piano → 0, SATB → Choir Aahs 52,
  Treble → 0). Add one "Sound" `<select>` for single-staff presets. Multi-staff presets keep
  their defaults and are changed per staff afterwards.
- **Per staff:** click a staff's name at the left of the first system to open a small native
  `<dialog>` with Name and Sound. The Sound `<select>` uses `<optgroup>`s for the 16 GM families
  (128 options), then "Your sounds", then "Add your own sound…". Coda's own list of GM names
  goes in `src/` (plain text, not taken from MIDI.js).

### 5.5 Out of scope (noted)

- **Percussion (channel 10):** this needs a percussion staff, unpitched note mapping and a drum
  kit sample set (VCSL is CC0). ROADMAP §4 lists it as L.
- **Transposing instruments:** written versus sounding pitch (MusicXML `<transpose>`) and a
  concert-pitch toggle. Picking "Trumpet" here changes only the timbre, not the notation.
- Dynamics and velocity layers, expression, articulations, reverb, pan.

---

## 6. Recommendation

**Default:** FluidR3_GM, MIT. Copy the pre-rendered MP3 notes from gleitz (minor-third spacing,
range-limited) into `sounds/gm/<program>/<midi>.mp3`, with `sounds/CREDITS.txt`. No new library,
no build step, no parser. It decodes in every browser, and the starter set is about 3 MB.
The accepted ceiling is notes longer than about 3 s, handled by the loop region in §3.2.

**Why not an SF2 default now:** FluidR3_GM.sf2 is over GitHub's 100 MiB file limit. GeneralUser
GS has a provenance caveat and depends on modulators. SF3 files depend on Safari decoding
Vorbis. The SF2 reader is still worth writing, for user files. Once it exists, switching the
default to an SF2 (for real loops) is a small follow-up (open question 3).

---

## 7. Phased plan (PLAN.md style, numbered after Phase 9)

### Phase 10 — Design note + instrument field (no new sound yet)
- [ ] Add DESIGN.md §12 "Instruments" from this file. Move "sampled instrument sounds" out of §8.
- [ ] Model: optional `program` and `sound` on staves, validated on restore; `setStaffSound` through `edit()`.
- [ ] MusicXML import and export of `midi-program` (±1), with report counts; MIDI import program changes; MuseScore `program`.
- [ ] Tests: a MusicXML round-trip keeps `program`; a MIDI file with two programs and a mid-track change produces the right fields and report count; an old autosave without the fields still loads.

**Done when:** a MusicXML file with a violin part reopens with `program: 40` after a Coda save,
and all existing tests pass.

### Phase 11 — Sampler + default GM sounds
- [ ] `sounds/gm/` starter set (the 9 programs in §3.3), `sounds/CREDITS.txt`, README credit line.
- [ ] `play.js`: per-staff sampler (`playbackRate` repitch, loop region for sustained families, mono mixdown), lazy load, Cache API, triangle-wave fallback.
- [ ] A Sound picker in the setup dialog and the per-staff dialog. Audition uses the staff's sound.
- [ ] `ponytail:` comments on the loop-region and fixed-length-note ceilings.

**Done when:** the demo score plays piano on the grand staff and strings on another staff in
Chrome, Firefox and Safari; a whole note at ♩=60 holds for its full length; with the network off
after the first play, the sounds still play; with the sound folder missing, the triangle-wave
voice plays and the status bar says why.

### Phase 12 — User sounds: one file to a range
- [ ] "Add your own sound…": pick a file, set root, low and high notes, name it; store it in IndexedDB; call `persist()`; check the quota.
- [ ] A missing sound falls back to `program` with a status message.

**Done when:** a WAV is assigned to a staff, survives a reload, and plays repitched across its
range; deleting it from storage makes the staff fall back to piano with a message.

### Phase 13 — SF2 / SF3 reader
- [ ] `src/sf2.js`: bounds-checked RIFF and preset-table reader, zones, loops, release; test with a tiny hand-built SF2 in `samples/`.
- [ ] Preset chooser; decode only the presets used; SF3 through `decodeAudioData` with a refusal message where unsupported.

**Done when:** GeneralUser GS (32 MB) loads, its "Strings" preset plays a 6 s note without
cutting off, and a truncated SF2 gives a message rather than an exception.

### Phase 14 — SFZ (zip)
- [ ] `src/sfz.js`: the opcode subset in §4; samples come only from the zip; skipped opcodes and regions are counted in a report.

**Done when:** a VSCO 2 CE instrument, zipped, loads and plays; unknown opcodes show in the report.

---

## 8. Open questions for the user

1. **Model and format change:** OK to add optional `staff.program` and `staff.sound`, and to
   write `<score-instrument>`/`<midi-instrument>` in MusicXML export? (PLAN.md requires sign-off.)
2. **Assets in the repo:** OK to commit about 3 MB of MP3 now (about 45 MB if all 128 programs
   are added later) under `sounds/`, with FluidR3 credited as both MIT and CC BY 3.0?
3. **SF2 default later?** After Phase 13, switch the default to an SF2 for real sustain loops?
   Options: GeneralUser GS (32 MB, provenance caveat), or a FluidR3 or MuseScore_General subset
   made with an offline tool (for example Polyphone).
4. **Offline asset tooling:** may a maintainer use FluidSynth, ffmpeg or Polyphone *once*, outside
   the site, to render or re-encode sounds (mono, longer notes, a drum kit)? The output would be
   committed and the site would still have no build step. Or should only ready-made files be
   copied?
5. **Size cap for user sound files:** raise it above the 50 MB score cap (proposal: 256 MB for
   SF2 and for SFZ zips; keep 200 MB per unzipped entry)? DESIGN §1's 50 MB whole-file cap
   would otherwise refuse most real SoundFonts and many zipped SFZ instruments.
6. **No new library is proposed.** fflate (already vendored) covers zips. If you'd rather not
   write the SF2 reader, the alternative is a library such as a SoundFont parser. Each needs your
   approval; I don't recommend one.

---

## Sources

- gleitz/midi-js-soundfonts: <https://github.com/gleitz/midi-js-soundfonts> (README, LICENSE.txt, `gh-pages` tree; one C4 note probed for duration and bitrate)
- FluidR3 licence (Debian copyright): <https://sources.debian.org/src/fluid-soundfont/3.1-5.3/debian/copyright/>
- MuseScore sound files and licences: <https://github.com/musescore/MuseScore/tree/master/share/sound> (`MS Basic_License.md`, `MS Basic_Readme.md`, `FluidR3Mono_License.md`)
- MuseScore handbook, SoundFonts: <https://musescore.org/en/handbook/soundfonts-and-sfz-files>
- GeneralUser GS: <https://github.com/mrbumpy409/GeneralUser-GS> (`documentation/LICENSE.txt`), <https://www.schristiancollins.com/generaluser>
- Salamander Grand Piano (SFZ): <https://github.com/sfzinstruments/SalamanderGrandPiano> (LICENSE: CC BY 3.0); original: <https://archive.org/details/SalamanderGrandPianoV3>
- VSCO 2 CE: <https://github.com/sgossner/VSCO-2-CE> (LICENSE: CC0; Readme.txt terms)
- VCSL: <https://github.com/sgossner/VCSL> (CC0)
- Sonatina Symphonic Orchestra: <https://github.com/peastman/sso> (LICENSE: CC Sampling Plus 1.0, <https://creativecommons.org/licenses/sampling+/1.0/>)
- Philharmonia samples: <https://philharmonia.co.uk/audio-sound-samples/>
- surikov/webaudiofont: <https://github.com/surikov/webaudiofont> (LICENSE.md: GPL-3.0)
- GitHub Pages limits: <https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits>
- GitHub large files: <https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github>
- CC Sampling Plus 1.0 deed: <https://creativecommons.org/licenses/sampling+/1.0/>
- MDN storage quotas and eviction: <https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria>
- MusicXML `midi-128` (1-based program): <https://www.w3.org/2021/06/musicxml40/musicxml-reference/data-types/midi-128>
- Safari Ogg Vorbis/Opus in Web Audio (unverified, 18.4+): <https://bugs.webkit.org/show_bug.cgi?id=226922>, MDN PR <https://github.com/mdn/content/pull/39592>
- SoundFont 2.04 specification (for the reader): <https://www.synthfont.com/sfspec24.pdf> [unverified link]
