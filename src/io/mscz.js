// MuseScore .mscz / .mscx import (versions 3.x and 4.x). See docs/DESIGN.md §9.7.
// Written from the file format as MuseScore saves it; no MuseScore source code is used.
import { okDur, padBars, noteCount, tupletOk, spellMidi, midi, splitTicks, MAX_LAYERS, eventTicks, barTicks, barCapacity, barLen, setBarLen, setMark, TIME_SYMS, measuresFrom, attrsAt, partGroups, allLayers, BASE, keyAt, shiftPitch, wrapKey, fifthsOf, DYN_VEL, ACCENT_VEL, SPAN_KINDS, clearBrokenSpans, syllabics, setLyric, MAX_LYRIC, MAX_VERSES, finishClefs, MAX_GRACE, fromDiatonic, isPerc, toDrumStaff, drumReport, clearBrokenSlides, melismas, ONE_NOTE, OTT_SHIFT, MAX_KIND } from "../model.js";
import { FINGER, ORNAMENTS, parseVolta, voltaLabel, sameVolta, MAX_REPEAT, JUMPS, RAMPS, rampOf, swingOf, setText, setRehearsal, cleanText, MAX_TEXT, MAX_REHEARSAL } from "../model.js";
import { isDrum, drumPitch, drumNear, DRUMS } from "../drums.js";
import { completeTuplet, DYN_IN, readTempo, applyTempi } from "./musicxml.js";
import { decodeText, parseXml, Report, unzip, countUnread } from "./util.js";
import { gmByName } from "../gm.js";

const DUR = { whole: "w", half: "h", quarter: "q", eighth: "8", "16th": "16", "32nd": "32", "64th": "64" };
const LONGER = new Set(["breve", "long"]);
const SHORTER = new Set(["128th", "256th", "512th", "1024th"]);
// MuseScore articulation subtype -> Coda marks (DESIGN §16). Combined ones ("articAccentStaccatoAbove")
// give two; MuseScore 2 calls an accent "sforzato". Staccatissimo and the rest give none.
const CHORDLINE_IN = { 1: "fall", 2: "doit", 4: "scoop" }, CHORDLINE_OUT = { fall: 1, doit: 2, scoop: 4 };
// ornaments as MuseScore 3 and 4 write them (DESIGN §34): ornamentMordent has the stroke, ornamentShortTrill doesn't
const ORN_MS_OUT = { trill: "ornamentTrill", mordent: "ornamentMordent", invMordent: "ornamentShortTrill", turn: "ornamentTurn" };
const ORN_MS_IN = { ...Object.fromEntries(Object.entries(ORN_MS_OUT).map(([k, v]) => [v, k])), trill: "trill", prall: "invMordent", mordent: "mordent", turn: "turn" };
export function markOf(sub) {
  if (ORN_MS_IN[sub]) return [ORN_MS_IN[sub]]; // MuseScore 3 writes ornaments as articulations
  if (/staccatissimo/i.test(sub)) return [];
  if (/^fermata/i.test(sub)) return ["fermata"];
  return [["staccato", /staccato/i], ["accent", /accent|sforzato/i], ["tenuto", /tenuto/i], ["marcato", /marcato/i]]
    .filter(([, re]) => re.test(sub)).map(([m]) => m);
}

const GRACE = ["acciaccatura", "appoggiatura", "grace4", "grace16", "grace32", "grace8after", "grace16after", "grace32after"];

const kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el, name) => kids(el, name)[0] || null;
const txt = (el, name) => { const k = kid(el, name); return k ? k.textContent.trim() : null; };

// What the importer reads, or can pass over because it is layout, ids or playback detail; anything
// else is counted (CLAUDE.md: never drop silently). Names give the labels for common losses.
const LAYOUT = ["eid", "linkedTo", "linkedMain", "visible", "offset", "color", "placement", "track", "Beam", "BeamMode", "StemDirection", "Stem", "Hook", "NoteDot", "noStem", "stemDirection", "mirror", "dotPosition", "headType", "fixed", "fixedLine", "line", "Events", "veloType", "velocity", "veloOffset", "endSpanner", "tuning", "Accidental", "duration", "autoplace", "minDistance", "userOff", "pos"];
// Measure-level: repeats are read above; the rest is layout. LayoutBreak passes silently: MuseScore writes one per system.
const MEASURE_ONLY = ["voice", "startRepeat", "endRepeat", "irregular", "LayoutBreak", "multiMeasureRest", "breakMultiMeasureRest", "vspacer", "vspacerUp", "vspacerDown", "vspacerFixed", "noOffset", "measureNumberMode", "stretch", "MeasureNumber", "MMRest"];
const VOICE_READ = new Set([...LAYOUT, ...MEASURE_ONLY, "location", "Clef", "KeySig", "TimeSig", "Tempo", "Tuplet", "endTuplet", "Spanner", "Marker", "Jump", "StaffText", "SystemText", "Expression", "PlayTechAnnotation", "Harmony", "RehearsalMark", "Dynamic", "Fermata", "Chord", "Rest", "BarLine", "StaffState", "Breath"]);
const VOICE_NAMES = { Breath: "Breath marks and caesuras (not imported)", FiguredBass: "Figured bass (not imported)", Tremolo: "Tremolos (not imported)", TremoloTwoChord: "Tremolos (not imported)", FretDiagram: "Fret diagrams (not imported)", InstrumentChange: "Instrument changes (not imported)", tick: "Positions in MuseScore 2 voices (notes may be misplaced)", Image: "Images (not imported)" };
const MEASURE_READ = new Set([...LAYOUT, ...MEASURE_ONLY]);
const CHORD_READ = new Set([...LAYOUT, ...GRACE, "durationType", "dots", "Note", "Articulation", "ChordLine", "Lyrics", "Spanner", "Tuplet", "Ornament", "Arpeggio", "TremoloSingleChord", "Tremolo"]);
const CHORD_NAMES = { Ornament: "Ornaments (trills, mordents, turns) (not imported)", Arpeggio: "Arpeggios (not imported)", TremoloSingleChord: "Tremolos (not imported)", Tremolo: "Tremolos (not imported)", small: "Cue notes (shown and played as normal notes)", staffMove: "Cross-staff notes (shown on their own staff)" };
const NOTE_READ = new Set([...LAYOUT, "pitch", "tpc", "tpc2", "Spanner", "Tie", "play", "small", "Fingering"]);
const DRUM_NOTE_READ = new Set([...NOTE_READ, "head"]); // a drum's notehead comes from the kit (DESIGN §27)
const NOTE_NAMES = { Fingering: "Fingering (not imported)", headGroup: "Special noteheads (shown as normal)", head: "Special noteheads (shown as normal)", Bend: "Bends (not imported)", fret: "Tablature frets and strings (not imported)", string: "Tablature frets and strings (not imported)" };

export function importMSCZ(bytes, fileName = "") {
  const files = unzip(bytes, (n) => /\.mscx$/i.test(n) || n === "META-INF/container.xml");
  const names = Object.keys(files).filter((n) => /\.mscx$/i.test(n) && !/^Excerpts\//i.test(n));
  const path = names.find((n) => !n.includes("/")) || names[0];
  if (!path) throw new Error("This MuseScore file doesn't contain a score.");
  return importMSCX(decodeText(files[path]), fileName, "MuseScore");
}

// tpc: position on the line of fifths, 14 = C, 13 = F, 15 = G.
export function tpcToPitch(tpc, midiNum) {
  const step = [3, 0, 4, 1, 5, 2, 6][(((tpc + 1) % 7) + 7) % 7];
  const alter = Math.floor((tpc + 1) / 7) - 2;
  const oct = Math.floor((midiNum - alter - [0, 2, 4, 5, 7, 9, 11][step]) / 12) - 1;
  return { step, oct, alter };
}

const CLEF = { G: "treble", F: "bass", C3: "alto", C4: "tenor", PERC: "percussion", PERC2: "percussion" };

export function importMSCX(text, fileName = "", format = "MuseScore (uncompressed)") {
  const report = new Report(format);
  const doc = parseXml(text);
  const root = doc.documentElement;
  if (root.localName !== "museScore") throw new Error("This isn't a MuseScore file.");
  const version = parseFloat(root.getAttribute("version") || "0");
  if (version < 3) report.add("This file is from an old MuseScore version (before 3.0); some content may be missing.");
  const sc = kid(root, "Score");
  if (!sc) throw new Error("This MuseScore file has no score in it.");

  // staff declarations, in order, grouped by Part
  const decl = [];
  kids(sc, "Part").forEach((part) => {
    const n = Math.max(1, kids(part, "Staff").length);
    const name = txt(part, "trackName") || txt(kid(part, "Instrument"), "longName") || "";
    // MuseScore 4 often writes program 0 for every instrument, so 0 means "not set": then try the
    // part name against the General MIDI names (Flute, Violin, Trumpet…).
    const prog = parseInt(kid(kid(kid(part, "Instrument"), "Channel"), "program")?.getAttribute("value"), 10);
    let program = prog > 0 && prog <= 127 ? prog : undefined;
    // a drum part (DESIGN §27): <Drum pitch> -> its <line> (half-spaces down from the top line)
    const drums = txt(kid(part, "Instrument"), "useDrumset") === "1"
      ? new Map(kids(kid(part, "Instrument"), "Drum").map((d) => [+d.getAttribute("pitch"), parseInt(txt(d, "line"), 10)])) : null;
    if (drums) program = undefined;
    else if (program === undefined && name) {
      const byName = gmByName(name);
      if (byName) program = byName.program;
      else if (!/piano/i.test(name)) report.count("Parts with no instrument sound found (played as piano)");
    }
    // written → sounding, same sign as Coda (DESIGN §21)
    const inst = kid(part, "Instrument");
    const tc = parseInt(txt(inst, "transposeChromatic"), 10) || 0, td = parseInt(txt(inst, "transposeDiatonic"), 10) || 0;
    let transpose;
    if (tc || td) {
      if (Math.abs(tc) <= 36 && Math.abs(td) <= 21) transpose = [tc, td];
      else report.count("Transpositions out of range (ignored)");
    }
    for (let k = 0; k < n; k++) decl.push(drums ? { name, brace: false, drums } : { name, brace: n === 2 && k === 0, program, transpose });
    if (n > 2) report.add(`A part with ${n} staves was split into separate staves without a brace`);
  });

  const meta = {};
  for (const m of kids(sc, "metaTag")) meta[m.getAttribute("name")] = m.textContent.trim();
  const boxText = (style) => {
    for (const t of sc.querySelectorAll("VBox > Text")) {
      if ((txt(t, "style") || "").toLowerCase() === style) return (kid(t, "text")?.textContent || "").trim();
    }
    return "";
  };

  const score = {
    title: meta.workTitle || meta.movementTitle || boxText("title") || fileName.replace(/\.[^.]+$/, "") || "Untitled",
    composer: meta.composer || boxText("composer") || "",
    tempo: 0, measures: [], staves: [],
  };

  const firstAttrs = [];
  const rep = []; // per bar: repeats and navigation, from the first staff (DESIGN §28)
  const short = []; // per bar: the length a short bar has, from the first staff
  const mark = (b, k, v) => { (rep[b] ||= {})[k] = v; };
  const tempi = []; // per bar: tempo from its start (DESIGN §29)
  let swingSeen; // the first swing read (null: straight)
  kids(sc, "Staff").forEach((stEl, si) => {
    const d = decl[si] || { name: "", brace: false };
    const staff = { name: d.name, clef: null, brace: d.brace, bars: [], ...(d.program !== undefined ? { program: d.program } : {}),
      ...(d.transpose ? { transpose: [...d.transpose] } : {}) };
    const [tc, td] = d.transpose || [0, 0];
    let key = 0, time = [4, 4], sym;
    const tuplets = {}; // MuseScore 3: id -> ratio
    const pendDyn = []; // per voice: dynamic waiting for its chord or rest (DESIGN §22)
    const pendText = []; // per voice: text waiting for its chord or rest (DESIGN §30)
    const pendHarm = []; // per voice: chord symbol waiting for its chord or rest (DESIGN §38)
    const pendLine = [], openLine = [], slurOpen = []; // per voice: {ott, ped} waiting for a note; open (DESIGN §37)
    const pendHp = [], lastEv = []; // per voice: hairpin waiting for its first note; last event (DESIGN §23)
    // a <Note>'s written pitch: pitch and tpc are concert; Coda keeps the written note (tpc2)
    const notePitch = (n) => {
      const pm = parseInt(txt(n, "pitch"), 10);
      if (d.drums && Number.isFinite(pm)) { // the position from the file's drum set, else the kit's
        const line = d.drums.get(pm), at = Number.isInteger(line) ? fromDiatonic(38 - line) : null;
        if (isDrum(pm)) return at ? { ...at, alter: 0, drum: pm } : drumPitch(pm);
        report.count("Drums outside the General MIDI kit (sound from their position)");
        return drumNear(at || { step: 6, oct: 4 });
      }
      const tpc = parseInt(txt(n, "tpc"), 10), tpc2 = parseInt(txt(n, "tpc2"), 10);
      if (!Number.isFinite(pm)) return null;
      const wm = pm - tc;
      let p = Number.isFinite(tpc2) && tc ? tpcToPitch(tpc2, wm)
        : Number.isFinite(tpc) ? (tc || td ? shiftPitch(tpcToPitch(tpc, pm), -tc, -td) : tpcToPitch(tpc, pm)) : null;
      if (!p || p.alter < -2 || p.alter > 2 || midi(p) !== wm) {
        p = spellMidi(wm, wrapKey(key - fifthsOf(tc, td)));
        report.count("Note spellings guessed from pitch");
      }
      return p;
    };
    // a <multiMeasureRest> measure is MuseScore's drawing of the empty bars after it, not a bar of its own
    kids(stEl, "Measure").filter((m) => !kid(m, "multiMeasureRest")).forEach((meas, mi) => {
      const [ln, ld] = (meas.getAttribute("len") || "").split("/").map(Number);
      if (si === 0 && ln > 0 && ld > 0) short[mi] = Math.round((ln / ld) * 1920); // a pickup or a split bar (DESIGN §33)
      const voices = kids(meas, "voice");
      if (si === 0 && kid(meas, "startRepeat")) mark(mi, "repStart", true);
      if (si === 0 && kid(meas, "endRepeat")) {
        const n = parseInt(txt(meas, "endRepeat"), 10) || 2;
        if (n > MAX_REPEAT) report.count(`Repeats played more than ${MAX_REPEAT} times (play ${MAX_REPEAT})`);
        mark(mi, "repEnd", Math.max(2, Math.min(MAX_REPEAT, n)));
      }
      for (const L of staff.layers || []) L.push([]);
      // MuseScore 2 files have no <voice> wrapper. Voices become layers 1–4 (DESIGN §15).
      if (voices.length) countUnread(report, meas, MEASURE_READ); // with no <voice> wrapper (MuseScore 2) the voice loop counts them
      (voices.length ? voices : [meas]).forEach((vEl, vi) => {
      if (vi >= MAX_LAYERS) { report.count(`Notes in voices beyond ${MAX_LAYERS} per staff skipped`, kids(vEl, "Chord").length); return; }
      const bar = [];
      let tup = null, cur = 0, fermata = false; // cur: time cursor in ticks; <location> moves it either way
      const pendG = { notes: [], kinds: [], slurs: 0 }; // grace notes waiting for their note (DESIGN §26); slurs: theirs, ending on it
      for (const el of vEl.children) {
        switch (el.localName) {
          case "location": {
            const [n, dd] = (txt(el, "fractions") || "").split("/").map(Number);
            if (dd) cur = Math.max(0, cur + Math.round((n / dd) * 1920));
            break;
          }
          case "Clef": {
            const t = txt(el, "concertClefType") || txt(el, "subtype") || txt(el, "clefType") || "G";
            const clef = CLEF[t] || (t.startsWith("G") ? "treble" : t.startsWith("F") ? "bass" : null);
            if (!CLEF[t]) report.count(clef ? "Octave clefs shown as plain clefs" : `Unsupported clefs (${t}) shown as treble`);
            // clef changes (DESIGN §25): MuseScore writes one at a barline at the end of the bar before
            if (staff.clef === null) { staff.clef = clef || "treble"; break; }
            if ((clef === "percussion") !== (staff.clef === "percussion")) { report.count("Changes to or from the percussion clef mid-part (not imported)"); break; }
            let at = mi;
            if (cur >= (short[mi] ?? barCapacity(time))) at = mi + 1;
            else if (cur > 0) report.count("Clef changes inside a bar moved to its start");
            if (at === 0) staff.clef = clef || "treble"; else (staff.clefs ||= {})[at] = clef || "treble";
            break;
          }
          case "KeySig": {
            const k = txt(el, "concertKey") ?? txt(el, "accidental");
            if (k !== null) key = Math.max(-7, Math.min(7, parseInt(k, 10) || 0));
            // older files may give only the written key; not checked against a real MuseScore 3 file
            if (si === 0 && (tc || td) && txt(el, "concertKey") === null && k !== null) report.count("Key signatures of a transposing first part that may be written, not concert");
            break;
          }
          case "TimeSig": {
            const n = +txt(el, "sigN"), dd = +txt(el, "sigD");
            if (n > 0 && [1, 2, 4, 8, 16, 32].includes(dd)) time = [n, dd];
            // subtype 1 = common time (4/4), 2 = cut time (2/2)
            const st = { 1: "common", 2: "cut" }[txt(el, "subtype")];
            sym = st && TIME_SYMS[st][0] === time[0] && TIME_SYMS[st][1] === time[1] ? st : undefined;
            break;
          }
          case "Tempo":
            readTempo(tempi, mi, cur, parseFloat(txt(el, "tempo")) * 60, report); // beats per second
            break;
          case "Tuplet": {
            const ratio = [+txt(el, "actualNotes"), +txt(el, "normalNotes")];
            if (el.getAttribute("id")) tuplets[el.getAttribute("id")] = ratio;
            else tup = ratio;
            break;
          }
          case "endTuplet": tup = null; break;
          case "Spanner": { // voice level: hairpins start before their first note and end after their last
            const type = el.getAttribute("type");
            if (type === "HairPin") {
              if (kid(el, "next")) pendHp[vi] = ["<", ">", "<", ">"][+txt(kid(el, "HairPin"), "subtype") || 0] || "<";
              else if (kid(el, "prev") && (bar.length ? bar[bar.length - 1] : lastEv[vi])) (bar.length ? bar[bar.length - 1] : lastEv[vi]).hpEnd = true;
            } else if (type === "Ottava" || type === "Pedal") { // DESIGN §37: MuseScore keeps the written pitch, as Coda does
              const kind = type === "Ottava" ? "ott" : "ped", last = bar.length ? bar[bar.length - 1] : lastEv[vi];
              if (kid(el, "next")) {
                const sub = txt(kid(el, "Ottava"), "subtype") || "0", o = OTT_MS_IN[sub];
                if (kind === "ott" && !o) report.count("Octave lines Coda can't show (not imported; their notes stay where written)");
                else (pendLine[vi] ||= {})[kind] = kind === "ott" ? o : true;
              } else if (kid(el, "prev") && last && openLine[vi]?.[kind]) { last[kind + "End"] = true; openLine[vi][kind] = false; }
            } else if (type === "Volta") { // the first staff's: an ending over the next `measures` bars
              if (si > 0 || !kid(el, "next")) break;
              const nums = parseVolta(txt(kid(el, "Volta"), "endings") || "");
              const len = Math.max(1, parseInt(txt(kid(kid(el, "next"), "location"), "measures"), 10) || 1);
              if (!nums) report.count("Endings with unusual numbers (not imported)");
              else for (let b = mi; b < mi + len; b++) mark(b, "volta", nums);
            } else if (kid(el, "next")) report.count(`Lines (${type}) not imported`);
            break;
          }
          case "Marker": { // signs at the bar's start, To Coda and Fine at its end
            if (si > 0) break;
            const k = MARKER_IN[txt(el, "label") || txt(el, "subtype") || ""];
            if (k) mark(mi, k, true); else report.count("Repeat text (not imported)");
            break;
          }
          case "Jump": {
            if (si > 0) break;
            const to = txt(el, "jumpTo"), until = txt(el, "playUntil") || "";
            const j = (to === "start" ? "dc" : /segno/.test(to || "") ? "ds" : null);
            if (j) mark(mi, "jump", j + (/fine/.test(until) ? "Fine" : /coda/.test(until) ? "Coda" : ""));
            else report.count("Jumps to a named place (not imported)");
            break;
          }
          case "Harmony": { // a chord symbol over the next chord or rest (DESIGN §38): MuseScore 4 in <harmonyInfo>, 3 directly
            const infos = kids(el, "harmonyInfo"), info = infos[0] || el;
            const root = parseInt(txt(info, "root"), 10), bass = parseInt(txt(info, "bass") ?? txt(info, "base"), 10), name = txt(info, "name") || "";
            const note = (tpc) => { const p = tpcToPitch(tpc, 60); return Math.abs(p.alter) <= 2 ? { step: p.step, alter: p.alter } : null; };
            if (infos.length > 1) report.count("Chord symbols over two chords (the first is kept)");
            if (+(txt(el, "harmonyType") || 0)) report.count("Roman numerals and Nashville numbers (not imported)");
            else if (!Number.isFinite(root) || !note(root)) report.count(/^n\.?c\.?$/i.test(name) ? "No-chord symbols (N.C.) (not imported)" : "Chord symbols without a root note (not imported)");
            else {
              if (pendHarm[vi]) { report.count("Chord symbols over a bar or note that already has one (not imported)"); break; }
              if (name.length > MAX_KIND) report.count(`Chord symbols cut to ${MAX_KIND} characters after the root`);
              if (Number.isFinite(bass) && !note(bass)) report.count("Chord symbol bass notes that can't be read (left off)");
              pendHarm[vi] = { root: note(root), kind: cleanText(name, MAX_KIND), ...(Number.isFinite(bass) && note(bass) ? { bass: note(bass) } : {}) };
            }
            break;
          }
          case "StaffText": case "SystemText": case "Expression": case "PlayTechAnnotation": { // text above the next note (DESIGN §30)
            const t = cleanText(kid(el, "text")?.textContent, 1e4), sw = kid(el, "swing"), ramp = rampOf(t);
            if (sw) { // DESIGN §39: <swing unit ratio>, the first for the whole score
              const w = sw.getAttribute("unit") === "eighth" ? swingOf(+sw.getAttribute("ratio")) : null, straight = +sw.getAttribute("ratio") <= 50;
              if (!w && !straight) report.count("Swing Coda can't play (not imported)");
              else if (swingSeen !== undefined) { if (String(w) !== String(swingSeen)) report.count("Swing changes after the start (not imported)"); }
              else { swingSeen = w; if (w) score.swing = w; }
              if (/^swing$/i.test(t || "")) break;
            }
            if (ramp) { // rit., accel. and a tempo play: on the bar
              if (cur > 0) report.count("rit., accel. and a tempo inside a bar moved to its start");
              mark(mi, "ramp", ramp);
              break;
            }
            if (t) pendText[vi] = cleanText([pendText[vi], t].filter(Boolean).join(" "), 1e4);
            break;
          }
          case "RehearsalMark": { // on the bar, from the first staff
            const t = cleanText(kid(el, "text")?.textContent, 1e4);
            if (si > 0) { if (t && t !== rep[mi]?.rehearsal) report.count("Rehearsal marks in later staves (not imported)"); break; }
            if (cur > 0) report.count("Rehearsal marks inside a bar moved to its start");
            const r = { measures: [{}] };
            if (t.length > MAX_REHEARSAL || setRehearsal(r, 0, t)) report.count("Rehearsal marks Coda can't show (not imported)");
            else if (r.measures[0].rehearsal) mark(mi, "rehearsal", r.measures[0].rehearsal);
            break;
          }
          case "Dynamic": {
            const d = DYN_IN[txt(el, "subtype")];
            if (d) pendDyn[vi] = d; else report.count("Unusual dynamics (not imported)");
            break;
          }
          case "Breath": { // after the note it follows (DESIGN §34)
            const m = /caesura/i.test(txt(el, "symbol") || txt(el, "subtype") || "") ? "caesura" : "breath";
            if (lastEv[vi]?.pitches.length) setMark(lastEv[vi], m, true); else report.count("Breath marks after rests (not imported)");
            break;
          }
          case "Fermata": fermata = true; break; // MuseScore 3+: before the chord or rest it belongs to
          case "Chord":
          case "Rest": {
            const isRest = el.localName === "Rest";
            const gk = GRACE.find((g) => kid(el, g));
            if (gk) { // held for the next chord; doesn't move the cursor
              const ns = kids(el, "Note"), p = ns.length && notePitch(ns[0]);
              if (/after$/.test(gk)) { report.count("Grace notes after a note (not imported)"); break; }
              if (isRest || !p) break;
              if (ns.length > 1) report.count("Grace-note chords reduced to their first note");
              if (kids(el, "Articulation").length || kids(el, "Lyrics").length || kids(el, "Spanner").length || ns.some((n) => kid(n, "Spanner") || kid(n, "Tie")))
                report.count("Marks, slurs, ties and lyrics on grace notes (not imported)");
              pendG.notes.push(p); pendG.kinds.push(gk);
              pendG.slurs += kids(el, "Spanner").filter((sp) => sp.getAttribute("type") === "Slur" && kid(sp, "next")).length;
              break;
            }
            const dt = txt(el, "durationType");
            const marks = fermata ? ["fermata"] : [];
            fermata = false;
            for (const a of kids(el, "Articulation")) {
              const got = markOf(txt(a, "subtype") || "");
              if (got.length) marks.push(...got); else report.count("Other articulations (not imported)");
            }
            for (const o of kids(el, "Ornament")) { // DESIGN §34
              const m = ORN_MS_IN[txt(o, "subtype")];
              if (m) marks.push(m); else report.count("Other ornaments (not imported)");
            }
            const arp = kid(el, "Arpeggio");
            if (arp) { marks.push("arpeggio"); if (txt(arp, "subtype") !== "0") report.count("Arpeggios with arrows or brackets (drawn plain)"); }
            for (const tr of [...kids(el, "TremoloSingleChord"), ...kids(el, "Tremolo")]) {
              const sub = txt(tr, "subtype") || "";
              if (!/^r/.test(sub)) report.count("Tremolos between two notes (not imported)");
              else { marks.push("tremolo"); if (sub !== "r32") report.count("Tremolos drawn with three strokes"); }
            }
            for (const cl of kids(el, "ChordLine")) { // brass effects (DESIGN §31): 1 fall, 2 doit, 3 plop, 4 scoop
              const m = CHORDLINE_IN[txt(cl, "subtype")];
              if (m) marks.push(m); else report.count("Plops and other chord lines (not imported)");
            }
            if (dt === "measure") { // whole-bar rest = empty bar
              if (marks.length) report.count("Fermatas on whole-bar rests (not imported)");
              if (pendText[vi]) report.count("Text over a bar with no notes moved to the next note");
              if (pendHarm[vi]) report.count("Chord symbols inside a note or over an empty bar moved to the next note");
              cur += (short[mi] ?? barCapacity(time)); break;
            }
            let dur = DUR[dt];
            if (!dur && LONGER.has(dt)) { dur = "w"; report.count("Notes longer than a whole note shortened"); }
            if (!dur && SHORTER.has(dt)) { dur = "64"; report.count("Notes shorter than a 64th lengthened"); }
            if (!dur) { report.count("Notes with unknown lengths skipped"); break; }
            let dots = Math.min(2, +(txt(el, "dots") || 0));
            if (!okDur(dur, dots)) { dots = 1; report.count("Double-dotted 64th notes given one dot"); }
            const ev = { dur, dots, tie: false, pitches: [] };
            const ratio = txt(el, "Tuplet") ? tuplets[txt(el, "Tuplet")] : tup;
            if (ratio && ratio[0] > 0 && ratio[1] > 0 && ratio[0] !== ratio[1]) {
              if (tupletOk(dur, dots, ratio)) ev.tup = ratio;
              else report.count("Notes in unsupported tuplets (kept written lengths)");
            }
            if (!isRest) {
              for (const n of kids(el, "Note")) {
                const p = notePitch(n);
                if (!p) continue;
                for (const f of kids(n, "Fingering")) { // DESIGN §34
                  const t = cleanText(kid(f, "text")?.textContent, 20);
                  if (FINGER.test(t) && !p.finger && p.drum === undefined) p.finger = t; else report.count("Fingerings Coda can't show (not imported)");
                }
                if (!ev.pitches.some((q) => q.step === p.step && q.oct === p.oct && q.drum === p.drum)) ev.pitches.push(p);
                const tieSp = kids(n, "Spanner").find((s) => s.getAttribute("type") === "Tie" && kid(s, "next"));
                if (tieSp || kid(n, "Tie")) ev.tie = true;
                for (const sp of kids(n, "Spanner")) {
                  const t = sp.getAttribute("type");
                  if (t === "Glissando" && kid(sp, "next")) ev.gliss = true;
                  else if (t !== "Tie" && t !== "Glissando" && kid(sp, "next")) report.count(`Lines (${t}) not imported`);
                }
              }
              if (!ev.pitches.length) break;
              ev.pitches.sort((a, b) => a.oct * 7 + a.step - (b.oct * 7 + b.step));
            }
            if (new Set(marks.filter((m) => ORNAMENTS.includes(m))).size > 1) report.count("Second ornaments on a note (the last is kept)");
            for (const m of marks) if (!isRest || m === "fermata") setMark(ev, m, true);
            if (isRest && marks.some((m) => m !== "fermata")) report.count("Marks on rests (not imported)");
            if (pendDyn[vi]) { ev.dyn = pendDyn[vi]; pendDyn[vi] = null; }
            if (pendText[vi]) {
              if (pendText[vi].length > MAX_TEXT) report.count(`Text cut to ${MAX_TEXT} characters`);
              if (setText(ev, pendText[vi])) report.count("Text directions (not imported)");
              pendText[vi] = null;
            }
            if (pendHp[vi]) { ev.hp = pendHp[vi]; pendHp[vi] = null; }
            if (pendHarm[vi]) { ev.harm = pendHarm[vi]; pendHarm[vi] = null; }
            for (const k in pendLine[vi] || {}) { ev[k] = pendLine[vi][k]; (openLine[vi] ||= {})[k] = true; }
            pendLine[vi] = null;
            let graceSlurs = pendG.slurs; // a grace note's slur ends here too; that end isn't this note's
            pendG.slurs = 0;
            // slurs: two at a time (DESIGN §37). An end pairs with the open slur its <prev> location points
            // back to; failing that, the inner (later) one. Ends before starts. A third is counted.
            const sps = kids(el, "Spanner"), slurs = (slurOpen[vi] ||= [null, null, 0]), here = (dm, dt) => `${mi + dm}:${cur + dt}`;
            const back = (sp) => {
              const l = kid(kid(sp, "prev"), "location"), [n, dd] = (txt(l, "fractions") || "0/1").split("/").map(Number);
              return here(parseInt(txt(l, "measures"), 10) || 0, dd ? Math.round((n / dd) * 1920) : 0);
            };
            for (const sp of sps) {
              if (sp.getAttribute("type") !== "Slur" || !kid(sp, "prev") || kid(sp, "next")) continue;
              if (graceSlurs > 0) { graceSlurs--; continue; }
              let lv = slurs.slice(0, 2).findIndex((o) => o === back(sp));
              if (lv < 0 && slurs[2]) { slurs[2]--; continue; } // a third slur's end
              if (lv < 0) lv = slurs[1] ? 1 : slurs[0] ? 0 : -1;
              if (lv === 1) ev.slur2End = true; else if (lv === 0) ev.slurEnd = true;
              if (lv >= 0) slurs[lv] = null;
            }
            for (const sp of sps) {
              if (sp.getAttribute("type") === "Slur") {
                if (!kid(sp, "next")) continue;
                if (!slurs[0] && !ev.slur) { ev.slur = true; slurs[0] = here(0, 0); }
                else if (!slurs[1] && !ev.slur2) { ev.slur2 = true; slurs[1] = here(0, 0); }
                else { report.count("Third slurs inside two others (not imported)"); slurs[2]++; }
              } else if (kid(sp, "next")) report.count(`Lines (${sp.getAttribute("type")}) not imported`);
            }
            lyricIn(el, ev, report);
            if (pendG.notes.length) {
              const g = pendG.notes.splice(0), kinds = pendG.kinds.splice(0);
              if (isRest) report.count("Grace notes before rests (not imported)", g.length);
              else {
                if (g.length > MAX_GRACE) report.count(`Grace notes beyond ${MAX_GRACE} before a note (not imported)`, g.length - MAX_GRACE);
                ev.grace = g.slice(0, MAX_GRACE);
                if (ev.grace.length === 1 ? kinds[0] !== "acciaccatura" : kinds.some((k) => k !== "grace16")) report.count("Grace notes redrawn: one as a slashed eighth, more as sixteenths");
              }
            }
            lastEv[vi] = ev;
            // a chord or rest that starts past where this voice has got to: rests in front
            const gap = Math.floor((cur - barTicks(bar)) / 60) * 60;
            if (gap > 0) {
              for (const d of splitTicks(gap)) bar.push({ dur: d.dur, dots: d.dots, tie: false, pitches: [] });
              report.count("Gaps in a voice filled with rests");
            }
            bar.push(ev);
            cur = barTicks(bar);
            break;
          }
          case "BarLine":
            if (!["normal", "end", "start-repeat", "end-repeat", null].includes(txt(el, "subtype"))) report.count("Double and special barlines (shown as plain)");
            break;
          default: countUnread(report, { children: [el] }, VOICE_READ, VOICE_NAMES);
        }
        if (el.localName === "Chord" || el.localName === "Rest") {
          countUnread(report, el, CHORD_READ, CHORD_NAMES);
          for (const n of kids(el, "Note")) countUnread(report, n, d.drums || staff.clef === "percussion" ? DRUM_NOTE_READ : NOTE_READ, NOTE_NAMES);
        }
      }
      if (pendG.notes.length) report.count("Grace notes with no note after them in the bar (not imported)", pendG.notes.length);
      if (vi === 0) staff.bars.push(bar);
      else if (bar.length) {
        staff.layers ||= [];
        while (staff.layers.length < vi) staff.layers.push(staff.bars.map(() => []).concat(staff.bars.length === mi ? [[]] : []));
        staff.layers[vi - 1][mi] = bar;
      }
      });
      (firstAttrs[si] ||= []).push({ key, time: [...time], sym });
    });
    if (pendDyn.some(Boolean)) report.count("Dynamics after the last note (not imported)");
    if (pendText.some(Boolean)) report.count("Text after the last note (not imported)");
    if (pendHarm.some(Boolean)) report.count("Chord symbols after the last note (not imported)");
    if (pendHp.some(Boolean)) report.count("Hairpins with no notes (not imported)");
    for (const p of pendLine) for (const k in p || {}) report.count(k === "ott" ? "Octave lines with no notes (not imported)" : "Pedal marks with no notes (not imported)");
    if (!staff.clef) staff.clef = "treble";
    if (d.drums || staff.clef === "percussion") { // DESIGN §27
      // a percussion clef without a drum set: drums by position
      drumReport(report, toDrumStaff(staff, score.staves[score.staves.length - 1], !d.drums), "Drum notes with no instrument (sound from their position)");
    }
    score.staves.push(staff);
  });
  if (!score.staves.length) throw new Error("This MuseScore file has no staves.");

  score.measures.push(...measuresFrom(firstAttrs[score.staves.findIndex((st) => st.clef !== "percussion")] || firstAttrs[0])); // the key from the first staff that isn't drums
  const broken = clearBrokenSpans(score), slides = clearBrokenSlides(score);
  if (broken) report.count("Unfinished or overlapping slurs and lines (not imported)", broken);
  if (slides) report.count("Slides not to the very next note, or between chords of different sizes (not imported)", slides);
  padBars(score);
  applyTempi(score, tempi, report);
  rep.forEach((r, b) => { if (b < score.measures.length) Object.assign(score.measures[b], r); else report.count("Repeat marks after the last bar (not imported)"); });
  short.forEach((len, b) => { if (len && b < score.measures.length && setBarLen(score, b, len)) report.count("Short bars Coda can't show (shown full length)"); });
  const lostClefs = finishClefs(score);
  if (lostClefs) report.count("Clef changes after the last bar (not imported)", lostClefs);
  report.notes = noteCount(score);
  return { score, report: report.done() };
}

// ---------- export (DESIGN §19) ----------
// MuseScore 4 format, modelled on what MuseScore writes. Layers are voices; ties are Tie spanners
// pointing at the next note; marks are Fermata/Articulation elements.

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const TYPE_NAME = { w: "whole", h: "half", q: "quarter", 8: "eighth", 16: "16th", 32: "32nd", 64: "64th" };
const CLEF_OUT = { treble: "G", bass: "F", alto: "C3", tenor: "C4", percussion: "PERC" };
// the kit as a MuseScore drum set (DESIGN §27): line = half-spaces down from the top line
const HEAD_MS = { x: "cross", cx: "xcircle", d: "diamond", t: "triangle-up" };
const drumset = () => [...DRUMS.values()].map((d) => `<Drum pitch="${d.n}"><head>${HEAD_MS[d.head] || "normal"}</head><line>${38 - (d.oct * 7 + d.step)}</line>` +
  `<voice>0</voice><name>${esc(d.name)}</name><stem>1</stem></Drum>`).join("");
const OTT_MS_IN = { "8va": "8va", "8vb": "8vb", "15ma": "15ma", "15mb": "15mb", 0: "8va", 1: "8vb", 2: "15ma", 3: "15mb" };
const ARTIC_OUT = { staccato: "articStaccatoAbove", accent: "articAccentAbove", tenuto: "articTenutoAbove", marcato: "articMarcatoAbove" };
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const frac = (ticks) => { const g = gcd(Math.abs(ticks), 1920) || 1; return `${ticks / g}/${1920 / g}`; };
const tpcOf = (p) => [14, 16, 18, 13, 15, 17, 19][p.step] + 7 * p.alter;
const loc = (dm, dt) => `<location>${dm ? `<measures>${dm}</measures>` : ""}${dt ? `<fractions>${frac(dt)}</fractions>` : ""}</location>`;

// A chord's <Lyrics> onto `ev` by verse (DESIGN §24): <no> is the verse − 1, none for verse 1.
// Verses past the fifth are counted; a held syllable (ticks) gets an extender line.
function lyricIn(el, ev, report) {
  const ls = kids(el, "Lyrics").filter((l) => txt(l, "text"));
  if (!ls.length) return;
  if (!ev.pitches.length) { report.count("Lyrics on rests (not imported)", ls.length); return; }
  for (const l of ls) {
    const v = parseInt(txt(l, "no") || "0", 10);
    if (!(v >= 0 && v < MAX_VERSES)) { report.count(`Lyrics beyond verse ${MAX_VERSES} (not imported)`); continue; }
    if (ev.lyrics?.[v]) { report.count("Second lyrics in the same verse on one note (not imported)"); continue; }
    const hyph = ["begin", "middle"].includes(txt(l, "syllabic")), held = (parseInt(txt(l, "ticks"), 10) || 0) > 0 || /^[1-9]/.test(txt(l, "ticks_f") || "");
    if (txt(l, "text").length > MAX_LYRIC) report.count("Long lyrics shortened");
    setLyric(ev, txt(l, "text"), hyph, v, held && !hyph); // a held syllable: an extender line (DESIGN §37); after a hyphen, the hyphen
  }
}

export function exportMSCX(score) {
  const syl = syllabics(score), mel = melismas(score);
  const x = ['<?xml version="1.0" encoding="UTF-8"?>', '<museScore version="4.20">', "<Score>", "<Division>480</Division>"];
  x.push(`<metaTag name="workTitle">${esc(score.title || "")}</metaTag>`, `<metaTag name="composer">${esc(score.composer || "")}</metaTag>`);
  let id = 0;
  for (const g of partGroups(score)) {
    const st = score.staves[g[0]];
    x.push("<Part>");
    g.forEach((s, k) => x.push(`<Staff id="${++id}">${isPerc(score.staves[s]) ? '<StaffType group="percussion"><name>perc5Line</name><keysig>0</keysig></StaffType>' : '<StaffType group="pitched"><name>stdNormal</name></StaffType>'}` +
      (g.length > 1 && k === 0 ? '<bracket type="1" span="2" col="0"/><barLineSpan>1</barLineSpan>' : "") + "</Staff>"));
    x.push(`<trackName>${esc(st.name || "")}</trackName><Instrument><longName>${esc(st.name || "")}</longName>` +
      `<trackName>${esc(st.name || "")}</trackName>${g.map((s, k) => `<clef staff="${k + 1}">${CLEF_OUT[score.staves[s].clef]}</clef>`).join("")}${st.transpose ? `<transposeDiatonic>${st.transpose[1]}</transposeDiatonic><transposeChromatic>${st.transpose[0]}</transposeChromatic>` : ""}` +
      (isPerc(st) ? `<useDrumset>1</useDrumset>${drumset()}<Channel><program value="0"/></Channel>` : `<Channel><program value="${st.program ?? 0}"/></Channel>`) + "</Instrument></Part>");
  }
  score.staves.forEach((st, s) => {
    x.push(`<Staff id="${s + 1}">`);
    if (s === 0) x.push(`<VBox><height>10</height><Text><style>title</style><text>${esc(score.title || "")}</text></Text>` +
      (score.composer ? `<Text><style>composer</style><text>${esc(score.composer)}</text></Text>` : "") + "</VBox>");
    const layers = allLayers(st);
    const ties = layers.map((bars) => tieMap(bars)); // per layer: "b:i" -> {next, prev} locations by midi (drum number on drum staves)
    const spans = layers.map((bars) => spanMap(bars));
    score.measures.forEach((m, b) => {
      const a = attrsAt(score, b), cap = barLen(score, b);
      const short = cap < barCapacity(a.time); // barLen: a stale len past the time signature reads as full
      x.push(short ? `<Measure len="${frac(cap)}">${b ? "" : "<irregular>1</irregular>"}` : "<Measure>"); // a pickup isn't counted in bar numbers
      if (m.repStart) x.push("<startRepeat/>");
      if (m.repEnd) x.push(`<endRepeat>${m.repEnd}</endRepeat>`);
      const last = Math.max(0, ...layers.map((bars, v) => (bars[b].length ? v : 0)));
      for (let v = 0; v <= last; v++) {
        x.push("<voice>");
        if (v === 0) {
          if (b === 0) x.push(`<Clef><concertClefType>${CLEF_OUT[st.clef]}</concertClefType><transposingClefType>${CLEF_OUT[st.clef]}</transposingClefType><isHeader>1</isHeader></Clef>`);
          if (b === 0 || m.key !== undefined) x.push(`<KeySig><concertKey>${a.key}</concertKey>${st.transpose ? `<actualKey>${keyAt(score, s, b)}</actualKey>` : ""}</KeySig>`);
          if (b === 0 || m.time) x.push(`<TimeSig>${a.sym ? `<subtype>${a.sym === "common" ? 1 : 2}</subtype>` : ""}<sigN>${a.time[0]}</sigN><sigD>${a.time[1]}</sigD></TimeSig>`);
          if (s === 0 && m.rehearsal) x.push(`<RehearsalMark><text>${esc(m.rehearsal)}</text></RehearsalMark>`); // DESIGN §30
          if (s === 0) x.push(...navStart(score.measures, b));
          const bpm = b === 0 ? score.tempo : m.tempo; // tempo changes (DESIGN §29)
          if (s === 0 && b === 0 && score.swing) x.push(`<StaffText><swing unit="eighth" ratio="${Math.round((100 * score.swing[0]) / (score.swing[0] + score.swing[1]))}"/><text>Swing</text></StaffText>`); // DESIGN §39
          if (s === 0 && m.ramp) x.push(`<StaffText><text>${RAMPS[m.ramp]}</text></StaffText>`);
          if (bpm && s === 0) x.push(`<Tempo><tempo>${bpm / 60}</tempo><followText>1</followText><text><sym>metNoteQuarterUp</sym> = ${bpm}</text></Tempo>`);
        }
        const bar = layers[v][b];
        if (v === 0 && !bar.length) x.push(`<Rest><durationType>measure</durationType><duration>${frac(cap)}</duration></Rest>`);
        else x.push(voiceXml(v === 0 ? completeTuplet(bar, cap) : bar, ties[v], b, v === 0 ? cap : 0, st, spans[v], syl, mel));
        if (v === 0 && s === 0) x.push(...navEnd(score.measures, b, cap));
        const nc = v === 0 && st.clefs?.[b + 1]; // a clef change goes at the end of the bar before, as MuseScore writes it
        if (nc) x.push(`<Clef><concertClefType>${CLEF_OUT[nc]}</concertClefType><transposingClefType>${CLEF_OUT[nc]}</transposingClefType></Clef>`);
        x.push("</voice>");
      }
      x.push("</Measure>");
    });
    x.push("</Staff>");
  });
  x.push("</Score>", "</museScore>");
  return x.join("\n");
}

// ---------- repeats and navigation (DESIGN §28) ----------
// Marker labels as MuseScore writes them: "codab" is the coda sign, "coda" the To Coda.
const MARKER_IN = { segno: "segno", varsegno: "segno", codab: "coda", varcoda: "coda", coda: "toCoda", fine: "fine" };
const MARKER_OUT = { segno: ["segno", "Repeat Text Left", "<sym>segno</sym>"], coda: ["codab", "Repeat Text Left", "<sym>coda</sym>"],
  toCoda: ["coda", "Repeat Text Right", "To Coda"], fine: ["fine", "Repeat Text Right", "Fine"] };
const JUMP_OUT = { dc: ["start", "end", ""], dcFine: ["start", "fine", ""], dcCoda: ["start", "coda", "codab"],
  ds: ["segno", "end", ""], dsFine: ["segno", "fine", ""], dsCoda: ["segno", "coda", "codab"] };
const markerXml = (k) => `<Marker><style>${MARKER_OUT[k][1]}</style><text>${MARKER_OUT[k][2]}</text><label>${MARKER_OUT[k][0]}</label></Marker>`;
// At the start of bar b's first voice: segno and coda signs, and an ending that begins here (its end
// is written where the next bar starts, or at the end of the last bar).
function navStart(ms, b) {
  const m = ms[b], out = ["segno", "coda"].filter((k) => m[k]).map(markerXml);
  const endsHere = b > 0 && ms[b - 1].volta && !sameVolta(ms[b - 1].volta, m.volta);
  if (endsHere) { let a = b - 1; while (a > 0 && sameVolta(ms[a - 1].volta, ms[b - 1].volta)) a--; out.unshift(`<Spanner type="Volta"><prev><location><measures>${a - b}</measures></location></prev></Spanner>`); }
  if (m.volta && !sameVolta(ms[b - 1]?.volta, m.volta)) {
    let z = b; while (z + 1 < ms.length && sameVolta(ms[z + 1].volta, m.volta)) z++;
    out.push(`<Spanner type="Volta"><Volta><endHookType>${ms[z].repEnd ? 1 : 0}</endHookType><beginText>${voltaLabel(m.volta)}</beginText><endings>${m.volta.join(", ")}</endings></Volta><next><location><measures>${z - b + 1}</measures></location></next></Spanner>`);
  }
  return out;
}
function navEnd(ms, b, cap) {
  const m = ms[b], out = ["toCoda", "fine"].filter((k) => m[k]).map(markerXml);
  if (m.jump) { const [to, until, at] = JUMP_OUT[m.jump]; out.push(`<Jump><text>${JUMPS[m.jump]}</text><jumpTo>${to}</jumpTo><playUntil>${until}</playUntil><continueAt>${at}</continueAt></Jump>`); }
  if (b === ms.length - 1 && m.volta) { // an ending that runs to the last bar ends after its notes
    let a = b; while (a > 0 && sameVolta(ms[a - 1].volta, m.volta)) a--;
    out.push(`<Spanner type="Volta"><prev><location>${a < b ? `<measures>${a - b}</measures>` : ""}<fractions>-${frac(cap)}</fractions></location></prev></Spanner>`);
  }
  return out;
}

// Where each tied note's partner is: for event b:i, {next: {midi: loc}, prev: {midi: loc}}.
function tieMap(bars) {
  const pos = [];
  bars.forEach((bar, b) => { let t = 0; bar.forEach((e, i) => { pos.push({ b, i, t, e }); t += eventTicks(e); }); });
  const map = {};
  const at = (p) => (map[p.b + ":" + p.i] ||= { next: {}, prev: {}, gnext: {}, gprev: {} });
  pos.forEach((p, k) => {
    const q = pos[k + 1];
    if (!q || q.b > p.b + 1) return;
    if (p.e.gliss) p.e.pitches.forEach((_, n) => { // slides (DESIGN §31), chord note n to note n
      at(p).gnext[n] = loc(q.b - p.b, q.t - p.t);
      at(q).gprev[n] = loc(p.b - q.b, p.t - q.t);
    });
    if (!p.e.tie) return;
    for (const pi of p.e.pitches) {
      const mm = pi.drum ?? midi(pi); // a drum by its number: two drums can share a line
      if (!q.e.pitches.some((r) => (r.drum ?? midi(r)) === mm)) continue;
      at(p).next[mm] = loc(q.b - p.b, q.t - p.t);
      at(q).prev[mm] = loc(p.b - q.b, p.t - q.t);
    }
  });
  return map;
}

// Slurs, hairpins, octave lines and pedal marks (DESIGN §23, §35): "b:i" -> {slurNext, slurPrev,
// hpNext, …} locations. A slur runs onset to onset; the others from the first onset to the end of the last note.
function spanMap(bars) {
  const pos = [];
  bars.forEach((bar, b) => { let t = 0; bar.forEach((e, i) => { pos.push({ b, i, t, e }); t += eventTicks(e); }); });
  const map = {}, at = (p) => (map[p.b + ":" + p.i] ||= {});
  for (const [k, ke] of SPAN_KINDS) {
    let a = null;
    const first = ONE_NOTE.has(k);
    for (const p of pos) {
      if (first && p.e[k]) a = p;
      if (p.e[ke] && a) {
        const zt = k.startsWith("slur") ? p.t : p.t + eventTicks(p.e);
        at(a)[k + "Next"] = loc(p.b - a.b, zt - a.t);
        at(p)[k + "Prev"] = loc(a.b - p.b, a.t - zt);
        a = null;
      }
      if (!first && p.e[k]) a = p;
    }
  }
  return map;
}

// One voice's events; a first voice is padded with rests to `cap`.
function voiceXml(bar, ties, b, cap, st, spans = {}, syl = new Map(), mel = new Map()) {
  const x = [];
  let open = null; // {tup, left: ticks still to fill}
  bar.forEach((e, i) => {
    if (open && (!e.tup || e.tup[0] !== open.tup[0] || e.tup[1] !== open.tup[1])) { x.push("<endTuplet/>"); open = null; }
    if (e.tup && !open) {
      open = { tup: e.tup, left: BASE[e.dur] * e.tup[1] }; // the group's real length: normal × base note
      x.push(`<Tuplet><normalNotes>${e.tup[1]}</normalNotes><actualNotes>${e.tup[0]}</actualNotes><baseNote>${TYPE_NAME[e.dur]}</baseNote>` +
        `<Number><style>tuplet</style><text>${e.tup[0]}</text></Number></Tuplet>`);
    }
    if (e.marks?.includes("fermata")) x.push("<Fermata><subtype>fermataAbove</subtype></Fermata>");
    if (e.text) x.push(`<StaffText><text>${esc(e.text)}</text></StaffText>`); // DESIGN §30
    // DESIGN §38, written like the notes; a 4.20 file has no <harmonyInfo> (later versions do, and are read too)
    if (e.harm) x.push(`<Harmony><root>${tpcOf(e.harm.root)}</root>${e.harm.kind ? `<name>${esc(e.harm.kind)}</name>` : ""}${e.harm.bass ? `<base>${tpcOf(e.harm.bass)}</base>` : ""}</Harmony>`);
    if (e.dyn) x.push(`<Dynamic><subtype>${e.dyn}</subtype><velocity>${DYN_VEL[e.dyn] || ACCENT_VEL[e.dyn]}</velocity></Dynamic>`);
    const sp = spans[b + ":" + i] || {};
    if (sp.hpNext) x.push(`<Spanner type="HairPin"><HairPin><subtype>${e.hp === ">" ? 1 : 0}</subtype></HairPin><next>${sp.hpNext}</next></Spanner>`);
    if (sp.ottNext) x.push(`<Spanner type="Ottava"><Ottava><subtype>${e.ott}</subtype></Ottava><next>${sp.ottNext}</next></Spanner>`);
    if (sp.pedNext) x.push(`<Spanner type="Pedal"><Pedal><beginText>&lt;sym&gt;keyboardPedalPed&lt;/sym&gt;</beginText><endHookType>1</endHookType></Pedal><next>${sp.pedNext}</next></Spanner>`);
    const head = `${e.dots ? `<dots>${e.dots}</dots>` : ""}<durationType>${TYPE_NAME[e.dur]}</durationType>`;
    if (!e.pitches.length) x.push(`<Rest>${head}</Rest>`);
    else {
      const t = ties[b + ":" + i] || { next: {}, prev: {}, gnext: {}, gprev: {} };
      const arts = (e.marks || []).filter((m) => ARTIC_OUT[m]).map((m) => `<Articulation><subtype>${ARTIC_OUT[m]}</subtype></Articulation>`).join("");
      const [tc, td] = st.transpose || [0, 0]; // pitch and tpc concert, tpc2 written
      const pitchXml = (p) => p.drum ? `<pitch>${p.drum}</pitch><tpc>${tpcOf(spellMidi(p.drum, 0))}</tpc>${HEAD_MS[DRUMS.get(p.drum).head] ? `<head>${HEAD_MS[DRUMS.get(p.drum).head]}</head>` : ""}` : `<pitch>${midi(p) + tc}</pitch><tpc>${tpcOf(tc || td ? shiftPitch(p, tc, td) : p)}</tpc>${tc || td ? `<tpc2>${tpcOf(p)}</tpc2>` : ""}`;
      const notes = e.pitches.map((p, n) => {
        const mm = p.drum ?? midi(p);
        const sp = (t.next[mm] ? `<Spanner type="Tie"><Tie/><next>${t.next[mm]}</next></Spanner>` : "") +
          (t.prev[mm] ? `<Spanner type="Tie"><prev>${t.prev[mm]}</prev></Spanner>` : "") +
          (t.gnext[n] ? `<Spanner type="Glissando"><Glissando><subtype>0</subtype></Glissando><next>${t.gnext[n]}</next></Spanner>` : "") +
          (t.gprev[n] ? `<Spanner type="Glissando"><prev>${t.gprev[n]}</prev></Spanner>` : "");
        return `<Note>${sp}${pitchXml(p)}${p.finger ? `<Fingering><text>${p.finger}</text></Fingering>` : ""}</Note>`;
      }).join("");
      // grace notes (DESIGN §26), as MuseScore writes them: one acciaccatura, or grace16s
      const one = e.grace?.length === 1;
      for (const p of e.grace || []) x.push(`<Chord><durationType>${one ? "eighth" : "16th"}</durationType>${one ? "<acciaccatura/>" : "<grace16/>"}<Note>${pitchXml(p)}</Note></Chord>`);
      // ponytail: MuseScore slurs need chords at both ends; one on a rest is left out of this file
      const slurs = (sp.slurNext ? `<Spanner type="Slur"><Slur/><next>${sp.slurNext}</next></Spanner>` : "") +
        (sp.slurPrev ? `<Spanner type="Slur"><prev>${sp.slurPrev}</prev></Spanner>` : "") +
        (sp.slur2Next ? `<Spanner type="Slur"><Slur/><next>${sp.slur2Next}</next></Spanner>` : "") +
        (sp.slur2Prev ? `<Spanner type="Slur"><prev>${sp.slur2Prev}</prev></Spanner>` : "");
      const lyr = (syl.get(e) || []).map((s, v) => s ? `<Lyrics>${v ? `<no>${v}</no>` : ""}${s === "single" ? "" : `<syllabic>${s}</syllabic>`}${mel.get(e)?.[v]?.ticks ? `<ticks_f>${frac(mel.get(e)[v].ticks)}</ticks_f>` : ""}<text>${esc(e.lyrics[v].text)}</text></Lyrics>` : "").join("");
      const lines = (e.marks || []).filter((m) => CHORDLINE_OUT[m]).map((m) => `<ChordLine><subtype>${CHORDLINE_OUT[m]}</subtype></ChordLine>`).join("");
      const has = (m) => e.marks?.includes(m);
      const orn = (e.marks || []).filter((m) => ORN_MS_OUT[m]).map((m) => `<Ornament><subtype>${ORN_MS_OUT[m]}</subtype></Ornament>`).join("") +
        (has("arpeggio") && e.pitches.length > 1 ? "<Arpeggio><subtype>0</subtype></Arpeggio>" : "") +
        (has("tremolo") ? "<TremoloSingleChord><subtype>r32</subtype></TremoloSingleChord>" : "");
      x.push(`<Chord>${head}${lyr}${arts}${orn}${slurs}${notes}${lines}</Chord>`);
      if (has("breath") || has("caesura")) x.push(`<Breath><symbol>${has("caesura") ? "caesura" : "breathMarkComma"}</symbol></Breath>`);
    }
    if (sp.hpPrev) x.push(`<Spanner type="HairPin"><prev>${sp.hpPrev}</prev></Spanner>`);
    if (sp.ottPrev) x.push(`<Spanner type="Ottava"><prev>${sp.ottPrev}</prev></Spanner>`);
    if (sp.pedPrev) x.push(`<Spanner type="Pedal"><prev>${sp.pedPrev}</prev></Spanner>`);
    if (open) { open.left -= eventTicks(e); if (open.left <= 0) { x.push("<endTuplet/>"); open = null; } }
  });
  if (open) x.push("<endTuplet/>");
  if (cap) for (const d of splitTicks(Math.max(0, cap - barTicks(bar)))) x.push(`<Rest>${d.dots ? `<dots>${d.dots}</dots>` : ""}<durationType>${TYPE_NAME[d.dur]}</durationType></Rest>`);
  return x.join("");
}

export function exportMSCZ(score) {
  const enc = (t) => new TextEncoder().encode(t);
  return fflate.zipSync({
    "META-INF/container.xml": enc('<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="score.mscx"/></rootfiles></container>'),
    "score.mscx": enc(exportMSCX(score)),
  });
}
