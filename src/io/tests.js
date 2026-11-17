// File-format checks, loaded by test.html. Each phase adds its checks here.
import { exportMusicXML, importMusicXML, exportMXL, importMXL } from "./musicxml.js";
import { exportMIDI, importMIDI } from "./midi.js";
import { importBytes, sniff, LEGACY_MUS } from "./open.js";
import { renderAudio, wavBytes, schedule, noteName, rootFor, needed, fetchSample, sampledVoice, sustained, output, BASES } from "../play.js";
import { GM } from "../gm.js";
import * as M from "../model.js";
import * as store from "../store.js";
import { markOf } from "./mscz.js";
import * as usnd from "../usersounds.js";

const P = (name) => {
  const m = /^([A-G])(#{1,2}|b{1,2})?(-?\d)$/.exec(name);
  const alter = !m[2] ? 0 : m[2][0] === "#" ? m[2].length : -m[2].length;
  return { step: "CDEFGAB".indexOf(m[1]), oct: +m[3], alter };
};
const ev = (dur, names, o = {}) => ({
  dur, dots: o.dots || 0, tie: !!o.tie, pitches: names ? names.split(" ").map(P) : [],
  ...(o.tup ? { tup: o.tup } : {}),
  ...(o.marks ? { marks: o.marks } : {}),
  ...(o.dyn ? { dyn: o.dyn } : {}),
  ...(o.slur ? { slur: true } : {}), ...(o.slurEnd ? { slurEnd: true } : {}),
  ...(o.hp ? { hp: o.hp } : {}), ...(o.hpEnd ? { hpEnd: true } : {}),
  ...(o.lyric ? { lyric: o.lyric } : {}), ...(o.lyricHyph ? { lyricHyph: true } : {}),
  ...(o.grace ? { grace: o.grace.split(" ").map(P) } : {}),
});

// Compact text form of a staff's bars, for readable expected values.
export function brief(staff) {
  return staff.bars.map((bar) => bar.map((e) =>
    (e.pitches.length ? e.pitches.map((p) => "CDEFGAB"[p.step] + ["bb", "b", "", "#", "##"][p.alter + 2] + p.oct).join("+") : "r") +
    ":" + e.dur + ".".repeat(e.dots) + (e.tup ? `/${e.tup[0]}:${e.tup[1]}` : "") + (e.tie ? "~" : "")).join(" ")).join(" | ");
}

async function fetchBytes(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

export function roundTripFixture() {
  // Every bar exactly full or empty; braced pair shares a name; tuplets obey the integer rule.
  return {
    title: "Round & Trip <test>", composer: "Tester \"Q\"", tempo: 84,
    measures: [{ key: -3, time: [4, 4], sym: "common" }, {}, { key: 2 }, { time: [6, 8] }, {}],
    staves: [
      { name: "Keys", clef: "treble", brace: true, program: 4, bars: [
        [ev("q", "C4 E4 G4", { marks: ["staccato", "accent"], dyn: "p" }), ev("8", "D5", { dots: 1, slur: true, grace: "C5" }), ev("16", "E5"), ev("h", "F#5", { tie: true })],
        [ev("q", "F#5", { slurEnd: true }), ev("8", "G5", { tup: [3, 2] }), ev("8", "A5", { tup: [3, 2] }), ev("8", "Bb5", { tup: [3, 2] }), ev("h", null, { marks: ["fermata"], dyn: "mf" })],
        [],
        [ev("q", "D5", { dots: 1, lyric: "Hal", lyricHyph: true }), ev("8", "C#5", { lyric: "le", lyricHyph: true, grace: "E5 Eb5" }), ev("16", "B4", { lyric: "lu" }), ev("16", "A4", { lyric: "<you> & me" }), ev("8", "G4")],
        [ev("h", "D4 F#4 A4", { dots: 1 })],
      ] },
      { name: "Keys", clef: "bass", brace: false, program: 4, bars: [
        [ev("w", "C3")],
        [ev("h", "F2", { dots: 2 }), ev("8", "Ab2")],
        [ev("h", "D3", { tie: true }), ev("h", "D3")],
        [],
        [ev("h", "D2 A2", { dots: 1, marks: ["fermata", "tenuto"] })],
      ], layers: [[ // layer 2 (DESIGN §15): bar 1 and a tie into bar 3
        [ev("h", "G2"), ev("h", "A2", { dyn: "sfz" })], [], [ev("w", "E2", { tie: true })], [ev("h", "E2", { dots: 1 })], [],
      ]], clefs: { 3: "tenor" } },
      { name: "Viola", clef: "alto", brace: false, bars: [
        [ev("w", "C4", { hp: ">" })],
        [ev("16", "C4", { tup: [5, 4] }), ev("16", "D4", { tup: [5, 4] }), ev("16", "E4", { tup: [5, 4] }), ev("16", "F4", { tup: [5, 4] }), ev("16", "G4", { tup: [5, 4] }), ev("h", "A4", { marks: ["marcato"], hpEnd: true }), ev("q", "B4")],
        [ev("w", "D4")], [ev("q", "A3", { dots: 1 }), ev("q", "B3", { dots: 1 })], [],
      ], clefs: { 1: "treble", 4: "alto" } },
    ],
  };
}

export async function run({ check, eq }) {
  await check("MusicXML round trip (deep equal)", () => {
    const a = roundTripFixture();
    const { score: b } = importMusicXML(exportMusicXML(a), "x.musicxml");
    if (eq(a, b)) return true;
    for (const k of ["title", "composer", "tempo", "measures"]) if (!eq(a[k], b[k])) return `${k}: ${JSON.stringify(b[k])}`;
    for (let s = 0; s < a.staves.length; s++) {
      if (!eq(a.staves[s], b.staves[s])) return `staff ${s}\n  want ${brief(a.staves[s])}\n  got  ${brief(b.staves[s])}\n  ${JSON.stringify({ ...b.staves[s], bars: undefined })}`;
    }
    return `staff count ${b.staves.length}`;
  });

  await check("marks: toggle over a selection, rests take only a fermata, validation; MusicXML whole-bar fermata counted; MuseScore subtypes (DESIGN §16)", () => {
    const a = ev("q", "C4"), r = ev("q"), b = ev("q", "D4", { marks: ["accent"] });
    if (M.toggleMark([a, r], "staccato") !== 1 || r.marks || !eq(a.marks, ["staccato"])) return "staccato";
    M.toggleMark([a, b], "accent");
    if (!eq(a.marks, ["staccato", "accent"])) return "accent added in order: " + a.marks;
    M.toggleMark([a, b], "accent");
    if (a.marks.includes("accent") || b.marks) return "accent removed from both";
    M.toggleMark([r], "fermata");
    if (!eq(r.marks, ["fermata"])) return "fermata on a rest";
    const s = M.newScore({ bars: 1 });
    s.staves[0].bars[0] = [{ ...ev("w", "C4"), marks: ["trill"] }];
    if (M.isValidScore(s)) return "unknown mark accepted";
    s.staves[0].bars[0] = [ev("h", "C4", { marks: ["staccato"] }), ev("h", "D4")];
    const sn = schedule(s).notes;
    if (sn[0].end - sn[0].start !== 480 || sn[1].end - sn[1].start !== 960) return "staccato plays half length";
    const xml = `<score-partwise><part-list><score-part id="P1"/></part-list><part id="P1"><measure number="1">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><rest measure="yes"/><duration>4</duration><notations><fermata/></notations></note></measure></part></score-partwise>`;
    const { report } = importMusicXML(xml, "f.xml");
    if (!JSON.stringify(report).includes("Fermatas on whole-bar rests")) return "whole-bar fermata not counted";
    const got = ["fermataAbove", "articAccentStaccatoBelow", "sforzato", "articStaccatissimoAbove", "articMarcatoAbove"].map((x) => markOf(x).join("+"));
    return eq(got, ["fermata", "staccato+accent", "accent", "", "marcato"]) || got.join(",");
  });

  await check("time symbols: parse, set, clear, carried when bar 1 is deleted, validation (DESIGN §17)", () => {
    if (!eq(M.parseTime("C|"), { time: [2, 2], sym: "cut" }) || !eq(M.parseTime("6/8"), { time: [6, 8] })) return "parseTime";
    const s = M.newScore({ bars: 3, ...M.parseTime("C") });
    if (M.timeLabel(M.attrsAt(s, 2)) !== "C") return "newScore sym";
    M.setAttrs(s, 1, { time: [4, 4] });
    if (!eq(s.measures[1], { time: [4, 4] })) return "4/4 after C is a change: " + JSON.stringify(s.measures[1]);
    M.setAttrs(s, 1, { time: [4, 4], sym: "common" });
    if (s.measures[1].time) return "C after C is no change";
    M.setAttrs(s, 2, { time: [3, 4], sym: "cut" });
    if (s.measures[2].sym) return "cut kept on 3/4";
    M.deleteMeasure(s, 0);
    if (s.measures[0].sym !== "common") return "sym not carried to the new bar 1";
    s.measures[0].sym = "cut";
    return !M.isValidScore(s) || "cut on 4/4 accepted";
  });

  await check("your sounds: store, list, read back, delete; a part's sound reaches playback (DESIGN §18)", async () => {
    // a 0.1 s 440 Hz mono 16-bit WAV
    const n = 800, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const str = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVEfmt "); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / 8000 * 2 * Math.PI * 440) * 8000, true);
    await usnd.checkAudio(buf);
    let bad = false;
    try { await usnd.checkAudio(new Uint8Array([1, 2, 3]).buffer); } catch { bad = true; }
    if (!bad) return "garbage decoded";
    const cacheName = "coda-test-user-sounds";
    await caches.delete(cacheName);
    const id = await usnd.addSound(buf, "audio/wav", { name: "Bell <b>& co</b>", root: 69, low: 80, high: 50 }, { cacheName });
    const list = await usnd.listSounds({ cacheName });
    if (list.length !== 1 || !eq(list[0], { id, name: "Bell <b>& co</b>", root: 69, low: 50, high: 80 })) return JSON.stringify(list);
    const got = await usnd.getSound(id, { cacheName });
    if (got?.bytes.byteLength !== buf.byteLength) return "bytes";
    await usnd.removeSound(id, { cacheName });
    const gone = !(await usnd.listSounds({ cacheName })).length && !(await usnd.getSound(id, { cacheName }));
    await caches.delete(cacheName);
    if (!gone) return "not removed";
    const s = M.newScore({ preset: "piano", bars: 1 });
    s.staves[1].bars[0] = [ev("w", "C3")];
    if (M.setStaffSound(s, 0, "abc") || s.staves[1].sound !== "abc" || !M.isValidScore(s)) return "setStaffSound pair";
    if (schedule(s).notes[0].sound !== "abc") return "schedule";
    M.setStaffSound(s, 1, null);
    if (s.staves[0].sound || s.staves[1].sound) return "cleared";
    s.staves[0].sound = 5;
    return !M.isValidScore(s) || "a non-string sound accepted";
  });

  await check("export: .mxl opens back equal; MIDI keeps notes, programs, tempo, key and time (DESIGN §19)", () => {
    const a = roundTripFixture();
    const m = importMXL(exportMXL(a), "x.mxl").score;
    if (!eq(m, a)) return "mxl round trip";
    const s = M.newScore({ preset: "piano", bars: 3, tempo: 90, key: -2, time: [3, 4], program: 40 });
    s.staves[0].bars[0] = [ev("q", "C5"), ev("q", "D5 F5"), ev("q", "Bb4", { tie: true })];
    s.staves[0].bars[1] = [ev("h", "Bb4", { dots: 1 })];
    s.staves[1].bars[0] = [ev("h", "C3", { dots: 1 })];
    s.staves[1].bars[2] = [ev("8", "G2"), ev("8", "A2"), ev("h", "Bb2")];
    const { score: b } = importMIDI(exportMIDI(s), "x.mid");
    const want = schedule(s).notes.map((n) => [n.start, n.end, n.midi, n.staff]).sort().join(";");
    const got = schedule(b).notes.map((n) => [n.start, n.end, n.midi, n.staff]).sort().join(";");
    if (want !== got) return `notes\n  want ${want}\n  got  ${got}`;
    if (b.tempo !== 90 || b.staves.some((st) => st.program !== 40)) return `tempo ${b.tempo} / programs ${b.staves.map((st) => st.program)}`;
    return eq(b.measures, s.measures) || JSON.stringify(b.measures); // the reader takes only the first time and key
  });

  await check("export: WAV renders the score offline, with a valid header (DESIGN §19)", async () => {
    const s = M.newScore({ bars: 1, tempo: 240 });
    s.staves[0].bars[0] = [ev("q", "A4"), ev("q", "C5"), ev("h")];
    const { buffer } = await renderAudio(s, () => {}, 8000, 0); // don't wait for samples: no network in tests
    const want = Math.ceil((1 + 2.5) * 8000);
    if (buffer.length !== want) return `length ${buffer.length}, want ${want}`;
    const d = buffer.getChannelData(0);
    let peak = 0;
    for (const x of d) peak = Math.max(peak, Math.abs(x));
    if (!(peak > 0.01 && peak < 1)) return "peak " + peak;
    const w = wavBytes(buffer), v = new DataView(w.buffer);
    const tag = (o) => String.fromCharCode(...w.subarray(o, o + 4));
    return (tag(0) === "RIFF" && tag(8) === "WAVE" && v.getUint32(24, true) === 8000 && v.getUint16(22, true) === 2 && w.length === 44 + want * 4) || "header";
  });

  await check("parts: add a grand staff mid-score, move, rename a pair, remove, refuse none; layers survive; MusicXML (DESIGN §20)", () => {
    const s = M.newScore({ preset: "satb", bars: 2 });
    s.staves[1].bars[0] = [ev("w", "E4")];
    s.staves[1].layers = [[[ev("w", "C4")], []]];
    s.staves[3].sound = "x";
    // order: Bass, new grand staff "Keys", Alto (renamed "Alto 1"); Soprano and Tenor removed
    let e = M.arrangeParts(s, [{ from: 3, name: "Bass" }, { from: null, kind: "grand", name: " Keys ", program: 4 }, { from: 1, name: "Alto 1" }]);
    if (e) return e;
    const names = s.staves.map((st) => `${st.name}/${st.clef}/${st.brace}`).join(" ");
    if (names !== "Bass/bass/false Keys/treble/true Keys/bass/false Alto 1/treble/false") return names;
    if (s.staves[0].sound !== "x" || s.staves[1].program !== 4 || s.staves[1].bars.length !== 2) return "kept fields";
    if (!eq(s.staves[3].layers, [[[ev("w", "C4")], []]]) || brief(s.staves[3]) !== "E4:w | ") return "layers moved with their part";
    if (!M.isValidScore(s)) return "invalid";
    M.arrangeParts(s, [{ from: 1, name: "Piano" }, { from: 0, name: "Bass" }, { from: 3, name: "Alto 1" }]);
    if (s.staves[0].name !== "Piano" || s.staves[1].name !== "Piano" || !s.staves[0].brace) return "rename pair / move";
    if (M.arrangeParts(s, []) === null || M.arrangeParts(s, [{ from: 0 }, { from: 0 }]) === null) return "refusals";
    const b = importMusicXML(exportMusicXML(s), "x.musicxml").score;
    return b.staves.map((st) => st.name + "/" + st.clef).join(" ") === "Piano/treble Piano/bass Bass/bass Alto 1/treble" || b.staves.map((st) => st.name).join();
  });

  await check("transposition: written key and notes move, sound stays; braced pair; clear; validation (DESIGN §21)", () => {
    const s = M.newScore({ preset: "treble", bars: 1 });
    M.setAttrs(s, 0, { key: -1 }); // concert F major
    s.staves[0].bars[0] = [ev("h", "C4 Bb4"), ev("h", "F#4")];
    const before = s.staves[0].bars[0].map((e) => e.pitches.map((p) => M.midi(p)));
    const heard = () => schedule(s).notes.map((n) => n.midi).join();
    const heard0 = heard();
    if (M.setStaffTranspose(s, 0, [-2, -1])) return "B♭ refused";
    if (heard() !== heard0) return "playback changed " + heard();
    if (M.keyAt(s, 0, 0) !== 1) return "written key " + M.keyAt(s, 0, 0); // G major for B♭ clarinet
    if (brief(s.staves[0]) !== "D4+C5:h G#4:h") return brief(s.staves[0]);
    const sounding = s.staves[0].bars[0].map((e) => e.pitches.map((p) => M.soundingMidi(s.staves[0], p)));
    if (!eq(sounding, before)) return "sound changed";
    if (M.setStaffTranspose(s, 0, [-7, -4]) || M.keyAt(s, 0, 0) !== 0 || brief(s.staves[0]) !== "G4+F5:h C#5:h") return "F horn " + brief(s.staves[0]);
    if (M.setStaffTranspose(s, 0, null) || s.staves[0].transpose || brief(s.staves[0]) !== "C4+Bb4:h F#4:h") return "clear";
    const hi = M.newScore({ preset: "treble", bars: 1 });
    hi.staves[0].bars[0] = [ev("w", "F9")];
    if (!M.setStaffTranspose(hi, 0, [-21, -12]) || hi.staves[0].transpose || brief(hi.staves[0]) !== "F9:w") return "too high not refused";
    if (M.keyAt(s, 0, 0) !== -1) return "concert key";
    const p = M.newScore({ preset: "piano", bars: 1 });
    M.setStaffTranspose(p, 1, [-12, -7]);
    if (!eq(p.staves[0].transpose, [-12, -7]) || !eq(p.staves[1].transpose, [-12, -7])) return "pair";
    if (!M.setStaffTranspose(s, 0, [1.5, 0]) || !M.isValidScore(p) || M.isValidScore({ ...p, staves: [{ ...p.staves[0], transpose: [99, 0] }] })) return "validation";
    return M.wrapKey(M.keyAt({ ...s, staves: [{ ...s.staves[0], transpose: [-9, -5] }] }, 0, 0)) === 2 || "E♭ alto key"; // F major concert → D major written
  });

  await check("transposition in files: MusicXML written key → concert, round trips through MusicXML and MuseScore (DESIGN §21)", async () => {
    const att = (k, t) => `<attributes><divisions>1</divisions><key><fifths>${k}</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef>${t}</attributes>`;
    const xml = `<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Clarinet</part-name></score-part><score-part id="P2"><part-name>Tenor Sax</part-name></score-part><score-part id="P3"><part-name>Flute</part-name></score-part></part-list>` +
      `<part id="P1"><measure number="1">${att(2, "<transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose>")}<note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><type>half</type></note><note><pitch><step>C</step><alter>1</alter><octave>5</octave></pitch><duration>2</duration><type>half</type></note></measure></part>` +
      `<part id="P2"><measure number="1">${att(2, "<transpose><diatonic>-1</diatonic><chromatic>-2</chromatic><octave-change>-1</octave-change></transpose>")}<note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part>` +
      `<part id="P3"><measure number="1">${att(0, "")}<note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note></measure></part></score-partwise>`;
    const a = importMusicXML(xml, "x.musicxml").score;
    const noDia = importMusicXML(xml.replace("<diatonic>-1</diatonic><chromatic>-2</chromatic></transpose>", "<chromatic>-2</chromatic></transpose>"), "x.musicxml").score;
    if (!eq(noDia.staves[0].transpose, [-2, -1])) return "diatonic not inferred " + noDia.staves[0].transpose;
    if (a.measures[0].key !== 0) return "concert key " + a.measures[0].key; // B♭ clarinet in D = concert C
    if (!eq(a.staves.map((st) => st.transpose || null), [[-2, -1], [-14, -8], null])) return JSON.stringify(a.staves.map((st) => st.transpose));
    if (brief(a.staves[0]) !== "E4:h C#5:h" || M.keyAt(a, 1, 0) !== 2 || M.keyAt(a, 2, 0) !== 0) return brief(a.staves[0]);
    if (M.soundingMidi(a.staves[1], a.staves[1].bars[0][0].pitches[0]) !== 50) return "tenor sounds D3";
    const b = importMusicXML(exportMusicXML(a), "x.musicxml").score;
    if (!eq(b, a)) return "MusicXML round trip";
    const { exportMSCX, importMSCX } = await import("./mscz.js");
    const c = importMSCX(exportMSCX(a), "x.mscx").score;
    return eq(c.staves.map((st) => [st.transpose, brief(st)]), a.staves.map((st) => [st.transpose, brief(st)])) && c.measures[0].key === 0 ||
      JSON.stringify(c.staves.map((st) => [st.transpose, brief(st)]));
  });

  await check("dynamics: velocity per part, accents one note, fp then soft; MIDI velocity; validation (DESIGN §22)", () => {
    const s = M.newScore({ preset: "piano", bars: 2 });
    s.staves[0].bars[0] = [ev("q", "C5", { dyn: "p" }), ev("q", "D5"), ev("q", "E5", { dyn: "sfz" }), ev("q", "F5")];
    s.staves[0].bars[1] = [ev("h", "G5", { dyn: "fp" }), ev("h", "A5")];
    s.staves[1].bars[0] = [ev("w", "C3")]; // same part: takes the p from the top staff
    s.staves[1].bars[1] = [ev("w", "C3")];
    const v = (st, at) => schedule(s).notes.find((n) => n.staff === st && n.start === at).vel;
    const got = [v(0, 0), v(0, 480), v(0, 960), v(0, 1440), v(0, 1920), v(0, 2880), v(1, 0)].join();
    if (got !== "50,50,112,50,100,50,50") return got;
    if (schedule(s, 1).notes.find((n) => n.staff === 0).vel !== 100) return "from bar 2";
    if (!M.isValidScore(s) || M.isValidScore({ ...s, staves: [{ ...s.staves[0], bars: [[{ ...ev("w", "C4"), dyn: "loud" }], []] }, s.staves[1]] })) return "validation";
    const e = { ...ev("q", "C4") };
    M.toggleDyn(e, "f"); M.toggleDyn(e, "f");
    if (e.dyn) return "toggle off";
    const mid = exportMIDI(s);
    return [...mid].join(",").includes([0x90, 72, 50].join(",")) || "MIDI velocity";
  });

  await check("slurs and hairpins: toggle over a range, refuse one note, broken ones cleared, validation (DESIGN §23)", () => {
    const evs = [ev("q", "C4"), ev("q", "D4"), ev("q", "E4")];
    if (!M.toggleSpan([evs[0]], "slur")) return "one note accepted";
    M.toggleSpan(evs, "slur");
    if (!evs[0].slur || !evs[2].slurEnd) return "set";
    M.toggleSpan(evs, "slur");
    if (evs[0].slur || evs[2].slurEnd) return "toggle off";
    M.toggleSpan(evs.slice(0, 2), "hp", "<"); M.toggleSpan(evs, "hp", ">"); // replaces the inner one
    if (evs[0].hp !== ">" || evs[1].hpEnd || !evs[2].hpEnd) return JSON.stringify(evs);
    const s = M.newScore({ preset: "treble", bars: 2 });
    s.staves[0].bars[0] = [ev("q", "C4", { slur: true }), ev("q", "D4", { slurEnd: true, slur: true }), ev("h", "E4")]; // second never ends
    s.staves[0].bars[1] = [ev("q", "F4", { hpEnd: true }), ev("q", "G4", { hp: "<" }), ev("q", "A4", { hp: ">" }), ev("q", "B4", { hpEnd: true })];
    const n = M.clearBrokenSpans(s);
    const flags = s.staves[0].bars.flat().map((e) => ["slur", "slurEnd", "hp", "hpEnd"].filter((k) => e[k]).map((k) => k + (k === "hp" ? e.hp : "")).join("+") || "-").join(" ");
    if (n !== 3 || flags !== "slur slurEnd - - - hp> hpEnd") return n + " " + flags;
    return M.isValidScore(s) && !M.isValidScore({ ...s, staves: [{ ...s.staves[0], bars: [[{ ...ev("w", "C4"), hp: "x" }], []] }] }) || "validation";
  });

  await check("lyrics: setLyric, syllabics, validation, import counts (DESIGN §24)", () => {
    const s = M.newScore({ preset: "treble", bars: 1 });
    s.staves[0].bars[0] = [ev("q", "C4"), ev("q", "D4"), ev("q", "E4"), ev("q", null)];
    const [a, b, c, r] = s.staves[0].bars[0];
    M.setLyric(a, "  Hap ", true); M.setLyric(b, "py"); M.setLyric(c, "x".repeat(50), true); M.setLyric(r, "rest");
    if (a.lyric !== "Hap" || c.lyric.length !== M.MAX_LYRIC || r.lyric) return JSON.stringify(s.staves[0].bars[0]);
    const syl = M.syllabics(s);
    if ([a, b, c].map((e) => syl.get(e)).join() !== "begin,end,begin") return [...syl.values()].join();
    M.setLyric(b, "");
    if ("lyric" in b || !M.isValidScore(s)) return "clear";
    if (M.isValidScore({ ...s, staves: [{ ...s.staves[0], bars: [[{ ...ev("w", "C4"), lyricHyph: true }]] }] })) return "hyphen without lyric";
    const xml = `<score-partwise><part-list><score-part id="P1"><part-name>V</part-name></score-part></part-list><part id="P1"><measure number="1">
      <attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type>
        <lyric number="1"><syllabic>begin</syllabic><text>la</text></lyric><lyric number="2"><text>two</text></lyric></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type>
        <lyric><syllabic>end</syllabic><text>di</text><extend/></lyric></note></measure></part></score-partwise>`;
    const { score: got, report } = importMusicXML(xml, "l.musicxml");
    const e = got.staves[0].bars[0], msg = JSON.stringify(report);
    if (e[0].lyric !== "la" || !e[0].lyricHyph || e[1].lyric !== "di" || e[1].lyricHyph) return JSON.stringify(e);
    return (/first verse.*1/.test(msg) && /extender.*1/.test(msg)) || msg;
  });

  await check("clef changes: setClef tidies, bars added and deleted keep them, validation, import placement (DESIGN §25)", () => {
    const s = M.newScore({ preset: "treble", bars: 6 }), st = s.staves[0];
    M.setClef(s, 0, 2, "bass"); M.setClef(s, 0, 4, "treble"); M.setClef(s, 0, 5, "treble");
    if (!eq(st.clefs, { 2: "bass", 4: "treble" }) || [0, 1, 2, 3, 4, 5].map((b) => M.clefAt(st, b)).join() !== "treble,treble,bass,bass,treble,treble") return JSON.stringify(st.clefs);
    M.addMeasure(s, 0);
    if (!eq(st.clefs, { 3: "bass", 5: "treble" })) return "add " + JSON.stringify(st.clefs);
    M.deleteMeasure(s, 3); // the bass change moves on to the bar after
    if (!eq(st.clefs, { 3: "bass", 4: "treble" })) return "delete " + JSON.stringify(st.clefs);
    M.setClef(s, 0, 3, "treble");
    if ("clefs" in st || !M.isValidScore(s)) return "tidy " + JSON.stringify(st.clefs);
    M.setClef(s, 0, 1, "alto"); M.deleteMeasure(s, 0);
    if (st.clef !== "alto" || "clefs" in st) return "first bar " + st.clef;
    if (M.isValidScore({ ...s, staves: [{ ...st, clefs: { 0: "bass" } }] }) || M.isValidScore({ ...s, staves: [{ ...st, clefs: { 9: "bass" } }] })) return "validation";
    const N = '<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>';
    const C = (sign, line) => `<attributes><clef><sign>${sign}</sign><line>${line}</line></clef></attributes>`;
    const xml = `<score-partwise><part-list><score-part id="P1"><part-name>V</part-name></score-part></part-list><part id="P1">
      <measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes>${C("G", 2)}${N}${N}${C("F", 4)}</measure>
      <measure number="2">${N}${C("C", 3)}${N}</measure><measure number="3">${C("C", 4)}${N}${N}${C("G", 2)}</measure></part></score-partwise>`;
    const { score: got, report } = importMusicXML(xml, "c.musicxml"), r = JSON.stringify(report);
    if (!eq(got.staves[0].clefs, { 1: "alto", 2: "tenor" }) || got.staves[0].clef !== "treble") return JSON.stringify(got.staves[0]);
    return (/inside a bar moved to its start: 1/.test(r) && /after the last bar \(not imported\): 1/.test(r)) || r;
  });

  await check("grace notes: add, limit, rest refused, transposition, play on the beat, import counts (DESIGN §26)", () => {
    const s = M.newScore({ preset: "treble", bars: 1 });
    s.staves[0].bars[0] = [ev("q", "C5"), ev("q"), ev("h", "E5")];
    const [a, r, c] = s.staves[0].bars[0];
    if (M.addGrace(a, P("D5")) || !M.addGrace(r, P("D5")) || r.grace) return "rest";
    for (let i = 0; i < M.MAX_GRACE; i++) M.addGrace(c, P("F5"));
    if (!M.addGrace(c, P("G5")) || c.grace.length !== M.MAX_GRACE) return "limit";
    c.grace = [P("F#5"), P("G5")];
    M.transpose(s, 0, 0, 0, 1); // the note and its grace move together
    if (a.pitches[0].step !== 1 || a.grace[0].step !== 2) return "transpose " + JSON.stringify(a);
    // a quarter (480) with one grace: grace 0–60, note 60–480; a half with two: 0–60, 60–120, note 120–1920/2
    const got = schedule(s).notes.map((n) => [n.start, n.end, n.midi].join(":")).join(" ");
    if (got !== "0:60:76 60:480:74 960:1020:78 1020:1080:79 1080:1920:76") return got;
    if (M.setStaffTranspose(s, 0, [-2, -1]) || c.grace[0].step !== 4 || c.grace[0].oct !== 5 || c.grace[0].alter !== 1) return "part transposition " + JSON.stringify(c.grace);
    if (!M.isValidScore(s) || M.isValidScore({ ...s, staves: [{ ...s.staves[0], bars: [[{ ...ev("w"), grace: [P("C4")] }]] }] })) return "validation";
    M.toggleChordPitch(s, 0, 0, 0, a.pitches[0]);
    if ("grace" in a) return "grace left on a rest";
    const N = (x, extra = "") => `<note>${extra}<pitch><step>${x}</step><octave>5</octave></pitch>${extra ? "" : "<duration>1</duration>"}<type>${extra ? "16th" : "quarter"}</type></note>`;
    const xml = `<score-partwise><part-list><score-part id="P1"><part-name>V</part-name></score-part></part-list><part id="P1"><measure number="1">
      <attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes>
      ${N("D", "<grace/>")}${N("E", "<grace/>")}<note><grace/><chord/><pitch><step>G</step><octave>5</octave></pitch><type>16th</type></note>${N("C")}
      ${N("F", "<grace/>")}<note><rest/><duration>1</duration><type>quarter</type></note>${N("A", "<grace/>")}</measure></part></score-partwise>`;
    const { score: g, report } = importMusicXML(xml, "g.musicxml"), w = report.warnings.join("; ");
    if (!eq(g.staves[0].bars[0][0].grace, [P("D5"), P("E5")]) || g.staves[0].bars[0].length !== 2) return JSON.stringify(g.staves[0].bars[0]);
    return w === "Grace-note chords reduced to their first note: 1; Grace notes before rests (not imported): 1; Grace notes with no note after them in the bar (not imported): 1" || w;
  });

  await check("instruments: setStaffProgram changes a braced pair, validation, MIDI program change (DESIGN §13.2)", () => {
    const s = M.newScore({ preset: "piano", bars: 1 });
    if (M.setStaffProgram(s, 1, 40) || s.staves[0].program !== 40 || s.staves[1].program !== 40) return "pair";
    if (!M.setStaffProgram(s, 0, 128)) return "accepted 128";
    if (!M.isValidScore(s) || M.isValidScore({ ...s, staves: [{ ...s.staves[0], program: 200 }, s.staves[1]] })) return "validation";
    // format 0, one channel: program 73 (flute), then a later change that must be counted, one quarter C5
    const trk = [0x00, 0xc0, 73, 0x00, 0x90, 72, 100, 0x83, 0x60, 0x80, 72, 0, 0x00, 0xc0, 10, 0x00, 0xff, 0x2f, 0x00];
    const bytes = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0,
      0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, trk.length, ...trk]);
    return import("./midi.js").then(({ importMIDI }) => {
      const r = importMIDI(bytes, "x.mid");
      return (r.score.staves[0].program === 73 && /Instrument changes/.test(JSON.stringify(r.report))) ||
        `program ${r.score.staves[0].program}, report ${JSON.stringify(r.report)}`;
    });
  });

  await check("sounds: note names, roots, the samples a score needs (DESIGN §13.3)", () => {
    if ([21, 60, 61, 63, 70, 108].map(noteName).join() !== "A0,C4,Db4,Eb4,Bb4,C8") return "noteName";
    if (rootFor(10) !== 21 || rootFor(61) !== 60 || rootFor(62) !== 63 || rootFor(127) !== 108) return "rootFor";
    if (GM.length !== 128 || GM[52].slug !== "choir_aahs" || !sustained(52) || sustained(0)) return "GM table";
    const sc = M.newScore({ preset: "piano", bars: 1 });
    M.setStaffProgram(sc, 0, 40);
    sc.staves[0].bars[0] = [ev("w", "C4 D4")]; // C4 -> root 60, D4 (62) -> root 63
    sc.staves[1].bars[0] = [ev("w", "C3")];
    return [...needed(sc)].sort().join() === "40:48,40:60,40:63" || [...needed(sc)].join();
  });

  await check("sounds: fetch falls back to the second host, gives up cleanly when both fail", async () => {
    const cacheName = "codatest-sounds", seen = [];
    try {
      const flaky = async (url) => { seen.push(url); return url.startsWith(BASES[0]) ? new Response("", { status: 404 }) : new Response("mp3"); };
      const buf = await fetchSample(0, 60, { fetchFn: flaky, cacheName });
      if (new TextDecoder().decode(buf) !== "mp3") return "bytes";
      if (seen[1] !== BASES[1] + "/acoustic_grand_piano-mp3/C4.mp3") return "url " + seen[1];
      // now cached: no fetch at all
      await fetchSample(0, 60, { fetchFn: () => { throw new Error("fetched"); }, cacheName });
      let failed = false;
      try { await fetchSample(0, 63, { fetchFn: () => Promise.reject(new TypeError("offline")), cacheName }); } catch { failed = true; }
      return failed || "did not reject";
    } finally { await caches.delete(cacheName).catch(() => {}); }
  });

  await check("sounds: a looped sustained note still sounds at 5 s and doesn't clip", async () => {
    const rate = 8000, c = new OfflineAudioContext(1, rate * 6.5, rate);
    const buf = c.createBuffer(1, rate * 3.16, rate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = 0.9 * Math.sin((2 * Math.PI * 262 * i) / rate);
    // a six-note chord through the playback output chain
    const out = output(c);
    for (const m of [60, 64, 67, 72, 76, 79]) sampledVoice(c, out, buf, m, rootFor(m), 0, 6, true);
    const res = (await c.startRendering()).getChannelData(0);
    let peak = 0, late = 0;
    for (let i = 0; i < res.length; i++) { peak = Math.max(peak, Math.abs(res[i])); if (i > rate * 5 && i < rate * 5.1) late = Math.max(late, Math.abs(res[i])); }
    return (late > 0.1 && peak < 1 && peak > 0.1) || `peak ${peak.toFixed(2)}, at 5 s ${late.toFixed(2)}`;
  });

  await check("tuplets: setTuplet any ratio, refused when it can't be whole ticks; partial 5:4 export completes (DESIGN §14.4)", () => {
    const s = M.newScore({ bars: 1 });
    for (let i = 0; i < 2; i++) M.appendEvent(s, 0, 0, ev("16", "C5"));
    if (M.setTuplet(s, 0, 0, 0, [5, 4]) || M.setTuplet(s, 0, 0, 1, [5, 4])) return "set 5:4";
    if (!M.setTuplet(s, 0, 0, 0, [7, 4])) return "7:4 accepted";
    const back = importMusicXML(exportMusicXML(s)).score.staves[0].bars[0];
    const runs = back.filter((e) => e.tup && e.tup[0] === 5);
    if (runs.length !== 5) return `5:4 group has ${runs.length}`;
    if (M.setTuplet(s, 0, 0, 0, null) || s.staves[0].bars[0][0].tup) return "remove";
    return true;
  });

  await check("layers: MusicXML voice entering mid-bar gets rests; a forward-only bar stays empty (DESIGN §15)", () => {
    const note = (step, type, dur, voice) => `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>${dur}</duration><voice>${voice}</voice><type>${type}</type></note>`;
    const xml = `<score-partwise><part-list><score-part id="P1"><part-name>x</part-name></score-part></part-list><part id="P1">
      <measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
        ${note("C", "whole", 4, 1)}<backup><duration>4</duration></backup><forward><duration>2</duration></forward>${note("E", "half", 2, 2)}</measure>
      <measure number="2">${note("D", "whole", 4, 1)}<backup><duration>4</duration></backup><forward><duration>4</duration><voice>2</voice></forward></measure>
    </part></score-partwise>`;
    const st = importMusicXML(xml).score.staves[0];
    const l2 = brief({ bars: st.layers[0] });
    return (brief(st) === "C4:w | D4:w" && l2 === "r:h E4:h | ") || `${brief(st)} / ${l2}`;
  });

  await check("layers: withLayer edits layer 2 only, creates it on demand and prunes it when empty (DESIGN §15)", () => {
    const s = M.newScore({ bars: 2 });
    s.staves[0].bars[0] = [ev("w", "C5")];
    M.withLayer(s, 1, () => { s.staves[0].bars[1] = [ev("w", "E4")]; });
    if (JSON.stringify(s.staves[0].bars[0]) !== JSON.stringify([ev("w", "C5")])) return "layer 1 changed";
    if (s.staves[0].layers?.[0]?.[1]?.length !== 1) return "layer 2 not written";
    M.withLayer(s, 1, () => { s.staves[0].bars[1] = []; });
    if (s.staves[0].layers) return "empty layer kept";
    M.withLayer(s, 1, () => { s.staves = [M.newScore({ bars: 2 }).staves[0]]; });
    return M.isValidScore(s) || "invalid";
  });
  await check("layers: bar walkers cover every layer (add/delete bar, time check, counts, playback, validation)", () => {
    const s = M.newScore({ bars: 2 });
    s.staves[0].bars[0] = [ev("w", "C5")];
    s.staves[0].layers = [[[ev("h", "C4"), ev("h", "D4")], [ev("w", "E4")]]];
    if (!M.isValidScore(s)) return "valid";
    if (M.noteCount(s) !== 4 || schedule(s).notes.length !== 4) return "counts";
    M.addMeasure(s, 0);
    if (s.staves[0].layers[0].length !== 3 || s.staves[0].layers[0][1].length) return "addMeasure";
    M.deleteMeasure(s, 1);
    if (s.staves[0].layers[0].length !== 2 || brief({ bars: s.staves[0].layers[0] }) !== "C4:h D4:h | E4:w") return "deleteMeasure";
    s.staves[0].bars[1] = []; // only layer 2 is too long for 2/4 in bar 2
    if (!M.setAttrs(s, 1, { time: [2, 4] })) return "time change allowed an overflowing layer";
    const short = JSON.parse(JSON.stringify(s)); short.staves[0].layers[0].pop();
    const four = JSON.parse(JSON.stringify(s)); four.staves[0].layers = [0, 1, 2, 3].map(() => s.staves[0].layers[0]);
    return (!M.isValidScore(short) && !M.isValidScore(four)) || "validation accepted a short layer or a fifth";
  });

  await check("layers: an empty layer 2 under a used layer 3 survives MusicXML save and open (DESIGN §15)", () => {
    const s = M.newScore({ bars: 2 });
    s.staves[0].bars[0] = [ev("w", "C5")];
    s.staves[0].layers = [[[], []], [[ev("w", "E4")], []]];
    const { score: b } = importMusicXML(exportMusicXML(s), "x.musicxml");
    return eq(b.staves[0].layers, s.staves[0].layers) || JSON.stringify(b.staves[0].layers);
  });

  await check("MusicXML export pads an underfull bar to capacity", () => {
    const sc = { title: "", composer: "", tempo: 100, measures: [{ key: 0, time: [3, 4] }],
      staves: [{ name: "", clef: "treble", brace: false, bars: [[ev("8", "C5")]] }] };
    const xml = exportMusicXML(sc);
    const doc = new DOMParser().parseFromString(xml.replace(/<!DOCTYPE[^>]*>/, ""), "application/xml");
    const total = [...doc.querySelectorAll("note > duration")].reduce((s, d) => s + +d.textContent, 0);
    const back = importMusicXML(xml).score.staves[0].bars[0];
    // greedy padding per DESIGN §9.2: 1200 remaining ticks -> half + eighth
    return (total === 1440 && brief({ bars: [back] }) === "C5:8 r:h r:8") ||
      `total ${total}, back ${brief({ bars: [back] })}`;
  });

  await check("sample: simple.musicxml", async () => {
    const { score, report } = await importBytes(await fetchBytes("samples/simple.musicxml"), "simple.musicxml");
    const want = "G4:q A4:q B4:q. C5:8 | D5:h~ D5:q r:q | F#5:8 F5:8 Eb5:q G4:h | ";
    const got = brief(score.staves[0]);
    if (got !== want) return "got " + got;
    return (score.title === "Simple Sample" && score.composer === "Coda Tests" && score.tempo === 90 &&
      eq(score.measures[0], { key: 1, time: [4, 4] }) && score.staves[0].name === "Flute" && report.warnings.length === 0) ||
      JSON.stringify({ t: score.title, c: score.composer, tempo: score.tempo, m: score.measures[0], w: report.warnings });
  });

  await check("sample: simple.mxl matches simple.musicxml", async () => {
    const a = await importBytes(await fetchBytes("samples/simple.musicxml"), "simple.musicxml");
    const b = await importBytes(await fetchBytes("samples/simple.mxl"), "simple.mxl");
    return (eq(a.score, b.score) && b.report.format === "MusicXML (compressed)") || brief(b.score.staves[0]);
  });

  await check("sample: piano.musicxml (grand staff, voices, grace, triplet)", async () => {
    const { score, report } = await importBytes(await fetchBytes("samples/piano.musicxml"), "piano.musicxml");
    const rh = brief(score.staves[0]), lh = brief(score.staves[1]);
    if (rh !== "Bb4+D5:q C5:8/3:2 D5:8/3:2 Eb5:8/3:2 F5:q~ | F5:h r:q") return "rh " + rh;
    if (lh !== "Bb2+F3:h. | ") return "lh " + lh;
    if (!score.staves[0].brace || score.staves[1].brace || score.staves[1].clef !== "bass") return "staves";
    if (!eq(score.measures[0], { key: -2, time: [3, 4] }) || score.title !== "Piano Sample") return "attrs";
    const l2 = (score.staves[0].layers || []).map((L) => brief({ bars: L })).join();
    if (l2 !== "F4:h. | " || score.staves[1].layers) return "layer 2: " + l2; // voice 2 kept as layer 2 (DESIGN §15)
    if (!eq(score.staves[0].bars[0][0].grace, [{ step: 5, oct: 4, alter: 0 }])) return "grace " + JSON.stringify(score.staves[0].bars[0][0]);
    const w = report.warnings.join("; "); // an unslashed grace eighth is drawn slashed (DESIGN §26)
    return w === "Grace notes redrawn: one as a slashed eighth, more as sixteenths: 1" || "warnings: " + w;
  });

  await check("sniffing", () => {
    const enc = (s) => new TextEncoder().encode(s);
    const k = (b, n) => sniff(b, n).kind;
    const cases = [
      [k(enc('<?xml version="1.0"?>\n<!-- hi --><!DOCTYPE score-partwise><score-partwise>'), "a.xml"), "musicxml"],
      [k(enc('﻿<museScore version="4.20">'), "a.mscx"), "mscx"],
      [k(enc('<?xml version="1.0"?><finale version="27.4">'), "a.xml"), "enigmaxml"],
      [k(new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6]), "a.bin"), "midi"],
      [k(new Uint8Array([1, 2, 3, 4, 5]), "old.MUS"), "mus"],
      [k(new Uint8Array([1, 2, 3, 4, 5]), "x.bin"), "unknown"],
      [k(enc("<html><body>"), "x.xml"), "xml-other"],
    ];
    const bad = cases.filter(([g, w]) => g !== w);
    return !bad.length || JSON.stringify(bad);
  });

  await check("legacy .mus gives the guidance message", async () => {
    try { await importBytes(new Uint8Array([0, 1, 2, 3, 250, 251]), "old.mus"); return "no error"; }
    catch (e) { return e.message === LEGACY_MUS || e.message; }
  });

  await check("timewise and garbage XML give messages, not crashes", async () => {
    const enc = (s) => new TextEncoder().encode(s);
    const msgs = [];
    for (const s of ['<score-timewise version="4.0"></score-timewise>', "<score-partwise><part><measure>"]) {
      try { await importBytes(enc(s), "x.xml"); msgs.push("no error"); } catch (e) { msgs.push(e.message); }
    }
    return (msgs[0].includes("timewise") && msgs[1].includes("valid XML")) || msgs.join(" / ");
  });

  await check("playback: ties extend, not re-strike", () => {
    const sc = roundTripFixture();
    const { notes } = schedule(sc, 0);
    const fsharp = notes.filter((n) => n.midi === 78); // F#5 h tied to F#5 q
    return (fsharp.length === 1 && fsharp[0].end - fsharp[0].start === 1440) || JSON.stringify(fsharp);
  });

  await check("triplets: three triplet eighths fill a quarter; a partial group exports cleanly (DESIGN §11.6)", async () => {
    const t = { dur: "8", dots: 0, tie: false, tup: [3, 2], pitches: [{ step: 0, oct: 5, alter: 0 }] };
    if (M.eventTicks(t) * 3 !== 480) return "ticks";
    const s = M.newScore({ time: [4, 4], bars: 1 });
    M.appendEvent(s, 0, 0, { ...t });
    const back = importMusicXML(exportMusicXML(s)).score.staves[0].bars[0];
    const total = back.reduce((n, e) => n + M.eventTicks(e), 0);
    return (total === 1920 && back.slice(0, 3).every((e) => e.tup)) || `total ${total}: ${JSON.stringify(back.map((e) => e.dur + (e.tup ? "/3" : "")))}`;
  });

  await check("score library: save, list order, unreadable entry, migrate, full storage (DESIGN §12)", async () => {
    const P = "codatest.", ls = localStorage;
    const clean = () => { for (const k of Object.keys(ls)) if (k.startsWith(P)) ls.removeItem(k); };
    clean();
    try {
      const a = M.newScore({ title: "A", bars: 2 }), b = M.newScore({ title: "B", bars: 3 });
      if (!store.save(ls, P, "a", a)) return "save failed";
      await new Promise((r) => setTimeout(r, 5));
      store.save(ls, P, "b", b);
      ls.setItem(P + "doc.bad", "{not json");
      const l = store.list(ls, P);
      if (l.map((e) => e.id).join() !== "b,a,bad" || l[2].ok) return "list " + JSON.stringify(l);
      if (store.load(ls, P, "a").title !== "A" || store.load(ls, P, "bad") !== null) return "load";
      ls.setItem(P + "legacy", JSON.stringify(M.newScore({ title: "Old" })));
      const id = store.migrate(ls, P, P + "legacy");
      if (!id || ls.getItem(P + "legacy") !== null || store.load(ls, P, id).title !== "Old") return "migrate";
      store.remove(ls, P, "a");
      if (store.load(ls, P, "a")) return "remove";
      const full = { setItem() { throw new Error("QuotaExceededError"); } };
      return store.save(full, P, "x", a) === false || "save on full storage did not return false";
    } finally { clean(); }
  });

  // Later phases: MIDI, MuseScore, musx.
  for (const path of ["./tests-midi.js", "./tests-mscz.js", "./tests-musx.js"]) {
    let mod = null;
    try { mod = await import(path); } catch (e) { await check(`load ${path}`, () => e.message); continue; }
    await mod.run({ check, eq, brief, fetchBytes, importBytes });
  }
}
