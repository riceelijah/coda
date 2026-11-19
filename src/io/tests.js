// File-format checks, loaded by test.html. Each phase adds its checks here.
import { exportMusicXML, importMusicXML, exportMXL, importMXL } from "./musicxml.js";
import { exportMIDI, importMIDI } from "./midi.js";
import { importBytes, sniff, LEGACY_MUS } from "./open.js";
import { renderAudio, wavBytes, schedule, beatsOf, clicks, noteName, rootFor, needed, fetchSample, sampledVoice, sustained, output, BASES, DRUM_BASES, bendOf } from "../play.js";
import { GM, gmByName } from "../gm.js";
import * as M from "../model.js";
import { drumPitch } from "../drums.js";
import * as store from "../store.js";
import { markOf, importMSCX, exportMSCX } from "./mscz.js";
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
  // lyrics by verse: "syl-" is a syllable with a hyphen after it, null no syllable in that verse
  ...(o.lyrics ? { lyrics: o.lyrics.map((t) => t && (/.-$/.test(t) ? { text: t.slice(0, -1), hyph: true } : { text: t })) } : {}),
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
        [ev("q", "D5", { dots: 1, lyrics: ["Hal-", "Ah"] }), ev("8", "C#5", { lyrics: ["le-", null, "three"], grace: "E5 Eb5" }), ev("16", "B4", { lyrics: ["lu"] }), ev("16", "A4", { lyrics: ["<you> & me", "men-"] }), ev("8", "G4", { lyrics: [null, "tion"] })],
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
  await check("drums round-trip: MusicXML, MuseScore and MIDI keep every drum; MuseScore's export imports (DESIGN §27)", async () => {
    const { score: ms, report } = await importBytes(await fetchBytes("samples/drums.musicxml"), "drums.musicxml");
    const drums = (sc) => JSON.stringify(sc.staves.find(M.isPerc).bars.map((b) => b.filter((e) => e.pitches.length).map((e) => [e.dur, e.pitches])));
    const want = '[[["8",[{"step":3,"oct":4,"alter":0,"drum":36},{"step":4,"oct":5,"alter":0,"drum":42}]],["8",[{"step":4,"oct":5,"alter":0,"drum":42}]],' +
      '["8",[{"step":0,"oct":5,"alter":0,"drum":38},{"step":4,"oct":5,"alter":0,"drum":42}]],["8",[{"step":4,"oct":5,"alter":0,"drum":46}]],' +
      '["q",[{"step":3,"oct":4,"alter":0,"drum":36},{"step":5,"oct":5,"alter":0,"drum":49}]],["q",[{"step":0,"oct":5,"alter":0,"drum":37},{"step":3,"oct":5,"alter":0,"drum":51}]]],' +
      '[["q",[{"step":4,"oct":4,"alter":0,"drum":41}]],["q",[{"step":1,"oct":5,"alter":0,"drum":47},{"step":3,"oct":5,"alter":0,"drum":53}]],' +
      '["q",[{"step":2,"oct":5,"alter":0,"drum":50},{"step":0,"oct":6,"alter":0,"drum":55}]],["q",[{"step":1,"oct":4,"alter":0,"drum":44},{"step":6,"oct":5,"alter":0,"drum":57}]]]]';
    if (drums(ms) !== want) return "MuseScore's file: " + drums(ms);
    if (report.warnings.length || ms.measures[0].key !== -3) return report.warnings.join("; ") || "key " + ms.measures[0].key;
    const viaXml = importMusicXML(exportMusicXML(ms), "x.musicxml").score;
    const viaMs = importMSCX(exportMSCX(ms), "x.mscx").score;
    const viaMidi = importMIDI(exportMIDI(ms), "x.mid").score;
    for (const [k, sc] of [["MusicXML", viaXml], ["MuseScore", viaMs], ["MIDI", viaMidi]]) if (drums(sc) !== want || !M.isValidScore(sc)) return k + ": " + drums(sc);
    return true;
  });
  await check("drum staves: entry snaps to the kit, arrows step drums, no accidentals or clef changes (DESIGN §27)", () => {
    const sc = M.newScore({ preset: "drums", bars: 2, key: -3 }), st = sc.staves[0];
    const snare = M.fitPitch(st, { step: 0, oct: 5, alter: 1 }); // C♯5: the snare, with no sharp
    if (snare.drum !== 38 || snare.alter !== 0) return "snap " + JSON.stringify(snare);
    st.bars[0] = [{ dur: "q", dots: 0, tie: false, pitches: [snare] }];
    if (M.transpose(sc, 0, 0, 0, 1) || st.bars[0][0].pitches[0].drum !== 47) return "up a drum " + JSON.stringify(st.bars[0][0].pitches);
    if (!M.setAlter(sc, 0, 0, 0, 1) || !M.setClef(sc, 0, 1, "bass") || !M.setStaffProgram(sc, 0, 5)) return "should refuse";
    if (M.setDrum(sc, 0, 0, 0, 46) || st.bars[0][0].pitches[0].step !== 4 || M.pitchName(st.bars[0][0].pitches[0]) !== "Open Hi-Hat") return "setDrum";
    if (!M.isValidScore(sc) || st.program !== undefined) return "valid drum score";
    const bad = JSON.parse(JSON.stringify(sc)); bad.staves[0].clef = "treble";
    const bad2 = JSON.parse(JSON.stringify(sc)); delete bad2.staves[0].bars[0][0].pitches[0].drum;
    if (M.isValidScore(bad) || M.isValidScore(bad2)) return "drum on a pitched staff, or a drum note without a drum, passed";
    // a chord at the end of the kit doesn't move, rather than losing a note
    st.bars[0][0].pitches = [drumPitch(44), drumPitch(35)];
    if (!M.transpose(sc, 0, 0, 0, -1) || st.bars[0][0].pitches.length !== 2) return "chord at the bottom: " + JSON.stringify(st.bars[0][0].pitches);
    const braced = M.newScore({ preset: "piano", bars: 2 });
    braced.staves.splice(1, 1, sc.staves[0]);
    if (M.isValidScore(braced)) return "a brace onto a drum staff passed";
    // importers: drums snapped by position merge in a chord and are counted, with the staff's clef changes and transposition
    const im = { clef: "treble", transpose: [-2, -1], clefs: { 1: "bass" }, bars: [[{ dur: "w", dots: 0, tie: false, pitches: [{ step: 0, oct: 4, alter: 0 }, { step: 1, oct: 4, alter: 0 }] }], []] };
    const r = M.toDrumStaff(im, null, true);
    return (eq(r, { guessed: 2, merged: 1, clefs: 1, transposed: true }) && im.bars[0][0].pitches.length === 1 && M.isPerc(im) && !im.clefs && !im.transpose) || JSON.stringify([r, im]);
  });
  await check("instrument sound from a part name", () => {
    const got = ["Trumpet in B♭ 2", "Alto Saxophone", "Horn in F", "Violin I", "Piano", "Kazoo"].map((n) => gmByName(n)?.name ?? null);
    return eq(got, ["Trumpet", "Alto Sax", "French Horn", "Violin", null, null]) || JSON.stringify(got);
  });
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
    s.staves[0].bars[0] = [{ ...ev("w", "C4"), marks: ["wobble"] }];
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

  await check("spans: a new slur keeps its neighbour; MusicXML single-note hairpin and voice-numbered slurs (review fixes)", () => {
    const s = M.newScore({ preset: "treble", bars: 1 });
    s.staves[0].bars[0] = [ev("q", "C5"), ev("q", "D5"), ev("q", "E5"), ev("q", "F5")];
    const e = s.staves[0].bars[0];
    M.toggleSpan(e.slice(0, 3), "slur"); M.toggleSpan(e.slice(2), "slur");
    if (M.clearBrokenSpans(s) || !e[0].slur || !e[2].slurEnd || !e[2].slur || !e[3].slurEnd) return JSON.stringify(e);
    const N = (x, o = "") => `<note><pitch><step>${x}</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type>${o}</note>`;
    const W = (t) => `<direction><direction-type><wedge type="${t}"/></direction-type></direction>`;
    const sl = (t, n) => `<notations><slur type="${t}" number="${n}"/></notations>`;
    const xml = `<score-partwise><part-list><score-part id="P1"><part-name>V</part-name></score-part></part-list><part id="P1"><measure number="1">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      ${W("crescendo")}${N("C", sl("start", 3))}${W("stop")}${N("D")}${N("E", sl("start", 2))}${N("F", sl("stop", 3))}</measure></part></score-partwise>`;
    const { score: g, report } = importMusicXML(xml, "s.musicxml"), w = report.warnings.join("; "), b = g.staves[0].bars[0];
    if (b[0].hp || b[0].hpEnd || !b[0].slur || !b[3].slurEnd || b[2].slur) return JSON.stringify(b);
    return w === "Hairpins over a single note (not imported): 1; Unfinished or overlapping slurs and lines (not imported): 1" || w; // slur 2 opens inside 3 and never closes
  });

  await check("hairpins in playback: ramp to the next dynamic, else 16 steps that hold (DESIGN §23)", () => {
    const s = M.newScore({ preset: "treble", bars: 3 });
    s.staves[0].bars[0] = [ev("q", "C5", { dyn: "p", hp: "<" }), ev("q", "D5"), ev("q", "E5"), ev("q", "F5", { hpEnd: true })];
    s.staves[0].bars[1] = [ev("q", "G5", { dyn: "f", hp: ">" }), ev("q", "F5", { hpEnd: true }), ev("h", "E5")];
    s.staves[0].bars[2] = [ev("w", "C5", { dyn: "sfz" })];
    const vel = (sc) => schedule(sc).notes.map((n) => n.vel).join(" ");
    let v = vel(s);
    if (v !== "50 62 73 85 96 88 80 112") return v;
    s.staves[0].bars[0][3].dyn = "f"; // a dynamic on the hairpin's last note is where it arrives
    if ((v = vel(s)) !== "50 65 81 96 96 88 80 112") return "dyn on last note: " + v;
    s.staves[0].bars[0] = [ev("q", "C5", { dyn: "p", hp: "<" }), ev("q", "D5"), ev("q", "E5", { hpEnd: true, hp: ">" }), ev("q", "F5")];
    s.staves[0].bars[1] = [ev("q", "G5", { hpEnd: true }), ev("q", "F5"), ev("h", "E5")];
    s.staves[0].bars[2] = [ev("w", "C5")];
    return (v = vel(s)) === "50 58 66 61 55 50 50 50" || "swell: " + v; // peak on the shared note, back to p
  });

  await check("lyrics: verses, setLyric, syllabics per verse, validation, old saves upgraded, import (DESIGN §24)", () => {
    const s = M.newScore({ preset: "treble", bars: 1 });
    s.staves[0].bars[0] = [ev("q", "C4"), ev("q", "D4"), ev("q", "E4"), ev("q", null)];
    const [a, b, c, r] = s.staves[0].bars[0];
    M.setLyric(a, "  Hap ", true); M.setLyric(b, "py"); M.setLyric(c, "x".repeat(50), true); M.setLyric(r, "rest");
    M.setLyric(b, "two", false, 2); M.setLyric(c, "y", true, 2); M.setLyric(a, "no", false, M.MAX_VERSES);
    if (!eq(a.lyrics, [{ text: "Hap", hyph: true }]) || c.lyrics[0].text.length !== M.MAX_LYRIC || r.lyrics) return JSON.stringify(s.staves[0].bars[0]);
    if (!eq(b.lyrics, [{ text: "py" }, null, { text: "two" }])) return "verse 3: " + JSON.stringify(b.lyrics);
    const syl = M.syllabics(s);
    if ([a, b, c].map((e) => JSON.stringify(syl.get(e))).join() !== '["begin"],["end",null,"single"],["begin",null,"begin"]') return [...syl.values()].map((x) => JSON.stringify(x)).join();
    if (!M.isValidScore(JSON.parse(JSON.stringify(s)))) return "JSON round trip";
    M.setLyric(b, "", false, 2);
    if (!eq(b.lyrics, [{ text: "py" }])) return "trailing verse cleared: " + JSON.stringify(b.lyrics);
    M.setLyric(b, "");
    if ("lyrics" in b || !M.isValidScore(s)) return "clear";
    const bad = (e) => M.isValidScore({ ...s, staves: [{ ...s.staves[0], bars: [[{ ...ev("w", "C4"), ...e }]] }] });
    if (bad({ lyrics: [{ text: "a" }, null] }) || bad({ lyrics: [] }) || bad({ lyrics: [{ text: "" }] }) || bad({ pitches: [], lyrics: [{ text: "a" }] })) return "validation";
    // a score saved before verses: ev.lyric/lyricHyph, one on a rest
    const old = M.newScore({ preset: "treble", bars: 1 });
    old.staves[0].bars[0] = [{ ...ev("h", "C4"), lyric: "la", lyricHyph: true }, { ...ev("h"), lyric: "x" }];
    if (!M.isValidScore(M.upgradeScore(old)) || !eq(old.staves[0].bars[0][0].lyrics, [{ text: "la", hyph: true }]) || "lyric" in old.staves[0].bars[0][1]) return "upgrade " + JSON.stringify(old.staves[0].bars[0]);
    const saved = M.newScore({ preset: "treble", bars: 1 });
    saved.staves[0].bars[0] = [{ ...ev("w", "C4"), lyric: "old" }];
    const raw = JSON.stringify({ modified: 1, score: saved });
    if (!eq(store.load({ getItem: () => raw }, "t.", "x")?.staves[0].bars[0][0].lyrics, [{ text: "old" }])) return "store doesn't upgrade an old save";
    const xml = `<score-partwise><part-list><score-part id="P1"><part-name>V</part-name></score-part></part-list><part id="P1"><measure number="1">
      <attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type>
        <lyric number="1"><syllabic>begin</syllabic><text>la</text></lyric><lyric number="2"><text>two</text></lyric><lyric number="9"><text>nine</text></lyric><lyric number="chorus"><text>c</text></lyric></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type>
        <lyric><syllabic>end</syllabic><text>di</text><extend/></lyric></note></measure></part></score-partwise>`;
    const { score: got, report } = importMusicXML(xml, "l.musicxml");
    const e = got.staves[0].bars[0], msg = JSON.stringify(report);
    if (!eq(e[0].lyrics, [{ text: "la", hyph: true }, { text: "two" }]) || !eq(e[1].lyrics, [{ text: "di", ext: true }])) return JSON.stringify(e);
    return (/beyond verse 5.*: 2/.test(msg) && !/extender/.test(msg)) || msg;
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

  await check("brass effects and slides: rules, playback bends, MusicXML and MuseScore round trips (DESIGN §31)", () => {
    const s = M.newScore({ preset: "treble", bars: 2 });
    Object.assign(s.staves[0], { name: "Trombone", program: 57 });
    s.staves[0].bars[0] = [ev("q", "C5"), ev("q", "C5"), ev("q"), ev("q", "C5 E5")];
    s.staves[0].bars[1] = [ev("h", "G4"), ev("h", "D5", { marks: ["fall"] })];
    const at = (b, i) => s.staves[0].bars[b][i];
    if (!M.toggleGliss(s, 0, 0, 0) || !M.toggleGliss(s, 0, 0, 1) || !M.toggleGliss(s, 0, 0, 3)) return "same note, before a rest, chord to one note: refused";
    if (M.toggleGliss(s, 0, 1, 0) || !at(1, 0).gliss) return "slide G4 to D5";
    M.setMark(at(1, 1), "doit", true);
    if (!eq(at(1, 1).marks, ["doit"])) return "fall and doit exclusive: " + at(1, 1).marks;
    M.setMark(at(1, 1), "fall", true); M.setMark(at(0, 0), "scoop", true);
    if (!M.isValidScore(s)) return "valid";
    // playback: the G4 voice glides to D5 over the last beat and falls; D5 itself is for MIDI only
    const sn = schedule(s).notes, g = sn.find((n) => n.midi === 67), d = sn.find((n) => n.midi === 74);
    if (!g.glide || g.glide[0].to !== 7 || d.root !== g || g.fall !== -1 || !sn.find((n) => n.midi === 72).scoop) return "schedule " + JSON.stringify(g, (k, v) => (k === "note" || k === "root" ? undefined : v));
    const fx = bendOf(g, 2, (t) => t * 0.5 / 480); // 2 s: G4 0–1, D5 1–2; the slide over 0.5–1, then down a fifth
    if (!eq(fx.segs, [[0.5, 0, 1, 7], [1.7, 7, 2, 0]]) || fx.fade !== 1.7) return "bend " + JSON.stringify(fx);
    // played twice through a repeat: the slide glides the first time into bar 2, and not into bar 1 on the jump back
    const rep = JSON.parse(JSON.stringify(s)); rep.measures[1].repEnd = 2;
    rep.staves[0].bars[1][1].gliss = true; rep.staves[0].bars[1][1].marks = []; // D5 slides on to whatever plays next
    const glides = schedule(rep).notes.filter((n) => n.glide).map((n) => n.glide.length).join();
    if (glides !== "1,1") return "slides through a repeat: " + glides;
    // editing the next note away drops the slide
    const cut = JSON.parse(JSON.stringify(s)); cut.staves[0].bars[1][1].pitches = [P("G4")];
    if (M.clearBrokenSlides(cut) !== 1) return "broken slide";
    for (const [k, b] of [["MusicXML", importMusicXML(exportMusicXML(s), "x.musicxml")], ["MuseScore", importMSCX(exportMSCX(s), "x.mscx")]]) {
      if (b.report.warnings.length) return k + ": " + b.report.warnings.join("; ");
      const bars = b.score.staves[0].bars;
      if (!bars[1][0].gliss || !eq(bars[1][1].marks, ["fall"]) || !eq(bars[0][0].marks, ["scoop"])) return k + ": " + brief(b.score.staves[0]);
    }
    return true;
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

  await check("drum samples: one per drum, read out of the kit's script, needed by a drum score (DESIGN §27)", async () => {
    const cacheName = "codatest-drums", seen = [];
    try {
      const js = async (url) => { seen.push(url); return new Response("var _drum_38_0={zones:[{originalPitch:3800,file:'" + btoa("mp3!") + "'}]}"); };
      const buf = await fetchSample(-1, 38, { fetchFn: js, cacheName });
      if (new TextDecoder().decode(buf) !== "mp3!") return "bytes";
      if (seen[0] !== DRUM_BASES[0] + "/12838_0_FluidR3_GM_sf2_file.js") return "url " + seen[0];
      let failed = false; // a page with no sample in it is not a sound
      try { await fetchSample(-1, 40, { fetchFn: async () => new Response("<html>"), cacheName }); } catch { failed = true; }
      if (!failed) return "bad file accepted";
    } finally { await caches.delete(cacheName).catch(() => {}); }
    const s = M.newScore({ preset: "drums", bars: 1 });
    s.staves[0].bars[0] = [ev("w", null, {})];
    s.staves[0].bars[0][0].pitches = [drumPitch(38), drumPitch(42)];
    const got = [...needed(s)].sort().join();
    return got === "-1:38,-1:42" || got;
  });
  await check("tracks: a part turns off whole, plays and exports without it, Save keeps it (DESIGN §32)", () => {
    const s = M.newScore({ preset: "piano", bars: 2 });
    M.arrangeParts(s, [{ from: 0, name: "Piano" }, { from: null, kind: "treble", name: "Flute", program: 73 }]);
    s.staves[0].bars[0] = [ev("w", "C5")]; s.staves[1].bars[0] = [ev("w", "C3")]; s.staves[2].bars[1] = [ev("w", "G5")];
    s.measures[1].repEnd = 2;
    const before = exportMusicXML(s);
    if (M.setTrackOn(s, 1, false) || !s.staves[0].off || !s.staves[1].off || s.staves[2].off) return "the lower staff turns off the pair";
    if (!M.isValidScore(s) || exportMusicXML(s) !== before) return "Save changed by a track being off";
    const t = M.tracks(s);
    if (!eq(t.map((x) => [x.staves, x.name, x.on]), [[[0, 1], "Piano", false], [[2], "Flute", true]])) return JSON.stringify(t);
    const sub = M.tracksOn(s);
    if (!M.isValidScore(sub) || sub.staves.length !== 1 || sub.staves[0].name !== "Flute" || s.staves.length !== 3) return "sub-score";
    if (schedule(sub).total !== schedule(s).total || schedule(sub).notes.some((n) => n.midi !== 79)) return "playback";
    const mid = importMIDI(exportMIDI(sub), "x.mid").score;
    if (mid.staves.length !== 1) return "MIDI tracks " + mid.staves.length;
    M.setTrackOn(s, 2, false);
    return M.tracksOn(s) === null || "all off";
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

  await check("no import-only values: any time, tuplet and transposition a file holds can be typed (DESIGN §28)", () => {
    const bad = [];
    for (const [v, want] of [["7/8", [7, 8]], [" 5 / 4 ", [5, 4]], ["3/2", [3, 2]], ["C", [4, 4]], ["15/16", [15, 16]]])
      if (!eq(M.parseTime(v)?.time, want)) bad.push(v);
    for (const v of ["7/6", "0/4", "4/", "x", "100/4"]) if (M.parseTime(v)) bad.push("accepted " + v);
    if (!eq(M.parseTuplet("7:4"), [7, 4]) || !eq(M.parseTuplet("9,8"), [9, 8])) bad.push("tuplet");
    for (const v of ["3:3", "0:2", "7", "100:4"]) if (M.parseTuplet(v)) bad.push("accepted tuplet " + v);
    if (!eq(M.parseTranspose("-2, -1"), [-2, -1]) || !eq(M.parseTranspose("+5,3"), [5, 3]) || M.parseTranspose("40,1")) bad.push("transpose");
    // a 7/8 bar takes seven eighths
    const s = M.newScore({ bars: 1, ...M.parseTime("7/8") });
    for (let i = 0; i < 7; i++) M.appendEvent(s, 0, 0, { dur: "8", dots: 0, tie: false, pitches: [] });
    if (M.appendEvent(s, 0, 0, { dur: "8", dots: 0, tie: false, pitches: [] }) !== "Bar is full") bad.push("7/8 capacity");
    if (!M.tupletOk("8", 0, M.parseTuplet("5:3"))) bad.push("5:3 on eighths");
    return bad.join("; ") || true;
  });

  // A score with every repeat mark (DESIGN §28): |: 2 [1. 3 :|] [2. 4] 5 segno-6 7(To Coda) 8 9 10(D.S. al Coda) coda-11 12(Fine)
  const repeatScore = () => {
    const s = M.newScore({ bars: 12 });
    for (let b = 0; b < 12; b++) s.staves[0].bars[b] = [ev("w", "C5")];
    for (const [b, k, v] of [[1, "repStart", true], [2, "repEnd", 2], [5, "segno", true], [6, "toCoda", true], [9, "jump", "dsCoda"], [10, "coda", true], [11, "fine", true]])
      if (M.setBarMark(s, b, k, v)) throw new Error("setBarMark " + k);
    M.setVolta(s, 2, 2, [1]); M.setVolta(s, 3, 3, [2]);
    return s;
  };

  await check("repeats: marks, endings, validation, playing order (DESIGN §28)", () => {
    const bad = [], s = repeatScore();
    if (!M.isValidScore(s)) bad.push("valid score refused");
    for (const m of [{ repEnd: 1 }, { repEnd: 11 }, { volta: [2, 1] }, { volta: [] }, { jump: "dcx" }, { segno: 1 }, { repStart: false }])
      if (M.isValidScore({ ...s, measures: [{ ...s.measures[0], ...m }, ...s.measures.slice(1)] })) bad.push("accepted " + JSON.stringify(m));
    if (!M.setBarMark(s, 0, "repEnd", 1) || !M.setBarMark(s, 0, "jump", "x") || !M.setVolta(s, 0, 0, [0])) bad.push("bad marks taken");
    if (!eq(M.parseVolta("1, 2"), [1, 2]) || !eq(M.parseVolta("1-3."), [1, 2, 3]) || M.parseVolta("a") || M.parseVolta("0")) bad.push("parseVolta");
    const order = (sc) => M.playOrder(sc).map((b) => b + 1).join(" ");
    if (order(s) !== "1 2 3 2 4 5 6 7 8 9 10 6 7 11 12") bad.push("D.S. al Coda: " + order(s));
    // plain :| goes back to bar 1; three passes; Fine after D.C.; endings 1-2 and 3 with three passes
    const t = M.newScore({ bars: 6 });
    M.setBarMark(t, 1, "repEnd", 3);
    if (order(t) !== "1 2 1 2 1 2 3 4 5 6") bad.push(":| x3 " + order(t));
    const u = M.newScore({ bars: 4 });
    M.setBarMark(u, 1, "fine", true); M.setBarMark(u, 3, "jump", "dcFine"); M.setBarMark(u, 0, "repEnd", 2);
    if (order(u) !== "1 1 2 3 4 1 2") bad.push("D.C. al Fine, no repeat after the jump: " + order(u));
    const v = M.newScore({ bars: 4 });
    M.setVolta(v, 1, 1, [1, 2]); M.setBarMark(v, 1, "repEnd", 3); M.setVolta(v, 2, 2, [3]);
    if (order(v) !== "1 2 1 2 1 3 4") bad.push("endings 1,2 / 3: " + order(v));
    // plain :| in the 1st and 2nd endings still reaches the 3rd
    const e3 = M.newScore({ bars: 5 });
    M.setVolta(e3, 1, 1, [1]); M.setBarMark(e3, 1, "repEnd", 2); M.setVolta(e3, 2, 2, [2]); M.setBarMark(e3, 2, "repEnd", 2); M.setVolta(e3, 3, 3, [3]);
    if (order(e3) !== "1 2 1 3 1 4 5") bad.push("endings 1 / 2 / 3: " + order(e3));
    // D.C. after endings plays only the last ending; a missing coda sign ignores To Coda
    M.setBarMark(v, 3, "jump", "dcCoda"); M.setBarMark(v, 0, "toCoda", true);
    if (order(v) !== "1 2 1 2 1 3 4 1 3 4") bad.push("D.C. al Coda, last ending, no coda: " + order(v));
    // a broken file can't loop forever
    const w = M.newScore({ bars: 2 });
    for (const m of w.measures) { m.repStart = true; m.repEnd = 10; }
    if (M.playOrder(w).length > 200) bad.push("unbounded");
    return bad.join("; ") || true;
  });

  await check("repeats in playback: bars play in order, from a bar inside, ties and dynamics follow (DESIGN §28)", () => {
    const s = repeatScore();
    s.staves[0].bars[1] = [ev("w", "C5", { tie: true, dyn: "p" })];
    s.staves[0].bars[0] = [ev("w", "C5", { dyn: "f" })];
    const { barStart, notes, total } = schedule(s);
    if (barStart.map((x) => x.bar + 1).join(" ") !== "1 2 3 2 4 5 6 7 8 9 10 6 7 11 12") return "order " + barStart.map((x) => x.bar + 1).join(" ");
    if (total !== 15 * 1920) return "total " + total;
    // bar 2 ties into bar 3; after the jump back its tie doesn't reach into the 2nd ending (bar 4), which
    // strikes again, still p: dynamics follow the bars as written
    const c5 = notes.filter((n) => n.midi === 72).map((n) => [n.start / 1920, n.end / 1920, n.vel]);
    if (!eq(c5.slice(0, 4), [[0, 1, 96], [1, 3, 50], [3, 4, 50], [4, 5, 50]])) return "ties/dynamics " + JSON.stringify(c5.slice(0, 4));
    const from = schedule(s, 3).barStart.map((x) => x.bar + 1).join(" ");
    if (from !== "4 5 6 7 8 9 10 6 7 11 12") return "from bar 4: " + from;
    const mid = importMIDI(exportMIDI(s), "x.mid").score;
    return mid.measures.length === 15 || "MIDI plays unrolled: " + mid.measures.length + " bars";
  });

  await check("repeats in files: MusicXML and MuseScore round trips; words and <sound> read (DESIGN §28)", () => {
    const s = repeatScore();
    M.setBarMark(s, 2, "repEnd", 3); M.setVolta(s, 3, 4, [2, 3]);
    const marks = (sc) => JSON.stringify(sc.measures.map(({ key, time, sym, ...r }) => Object.fromEntries(Object.entries(r).sort())));
    const x = importMusicXML(exportMusicXML(s), "r.musicxml");
    if (marks(x.score) !== marks(s)) return "MusicXML " + marks(x.score);
    const ms = importMSCX(exportMSCX(s), "r.mscx");
    if (marks(ms.score) !== marks(s)) return "MuseScore " + marks(ms.score);
    if (JSON.stringify(x.report).includes("not imported") || JSON.stringify(ms.report).includes("not imported")) return "reported lost: " + JSON.stringify([x.report, ms.report]);
    // another program's words: D.S. al Fine with no <sound>; unknown words still counted
    const xml = `<score-partwise><part-list><score-part id="P1"><part-name>A</part-name></score-part></part-list><part id="P1">
      <measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <direction><direction-type><segno/></direction-type></direction><note><rest/><duration>4</duration></note></measure>
      <measure number="2"><note><rest/><duration>4</duration></note><direction><direction-type><words>Fine</words></direction-type></direction>
      <direction><direction-type><words>dolce</words></direction-type></direction></measure>
      <measure number="3"><note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note><direction><direction-type><words>D.S. al Fine</words></direction-type></direction>
      <barline location="right"><ending number="1" type="stop"/></barline></measure></part></score-partwise>`;
    const y = importMusicXML(xml, "w.xml");
    if (marks(y.score) !== JSON.stringify([{ segno: true }, { fine: true }, { jump: "dsFine", volta: [1] }].map((r) => Object.fromEntries(Object.entries(r).sort())))) return "words " + marks(y.score);
    return y.score.staves[0].bars[2][0].text === "dolce" || "other words become text on the next note: " + JSON.stringify(y.score.staves[0].bars);
  });

  await check("importers count markings they don't read instead of dropping them (CLAUDE.md)", () => {
    const xml = `<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>A</part-name></score-part></part-list>
      <part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <figured-bass><figure><figure-number>6</figure-number></figure></figured-bass><print new-system="yes"/>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>whole</type><notations><ornaments><schleifer/></ornaments></notations></note></measure></part></score-partwise>`;
    const a = importMusicXML(xml, "u.xml").report.warnings.join("; ");
    if (!/Figured bass/.test(a) || !/Ornaments/.test(a) || /print/.test(a)) return "MusicXML: " + a;
    const s = M.newScore({ bars: 1 });
    s.staves[0].bars[0] = [{ dur: "w", dots: 0, tie: false, pitches: [{ step: 0, oct: 5, alter: 0 }] }];
    const ms = exportMSCX(s).replace("<Chord>", "<FiguredBass><text>6</text></FiguredBass><Chord><Ornament><subtype>ornamentPrecompSlide</subtype></Ornament>");
    const b = importMSCX(ms, "u.mscx").report.warnings.join("; ");
    return (/Figured bass/.test(b) && /ornaments/.test(b)) || "MuseScore: " + b;
  });

  await check("short bars: a pickup holds its length, plays short, numbers from 0, round trips MusicXML and MuseScore (DESIGN §33)", () => {
    const s = M.newScore({ bars: 3, time: [3, 4] });
    const q = (st) => ({ dur: "q", dots: 0, tie: false, pitches: [{ step: st, oct: 4, alter: 0 }] });
    if (M.setBarLen(s, 0, 480) || M.barLen(s, 0) !== 480 || M.barNumber(s, 1) !== 1) return "set";
    if (M.appendEvent(s, 0, 0, q(4)) || !M.appendEvent(s, 0, 0, q(4))) return "a one-beat bar took two beats";
    if (!M.setBarLen(s, 0, 240)) return "shortened below its notes";
    M.setBarLen(s, 2, 960);
    if (M.setAttrs(s, 0, { time: [2, 4] }) || s.measures[2].len !== undefined || s.measures[0].len !== 480) return "time change: " + JSON.stringify(s.measures);
    M.setAttrs(s, 0, { time: [3, 4] });
    const t = schedule(s).barStart.map((x) => x.tick);
    if (t.join() !== "0,480,1920") return "starts " + t;
    s.staves[0].bars[2] = [q(3), q(0)]; M.setBarLen(s, 2, 960);
    const x = exportMusicXML(s);
    if (!x.includes('<measure number="0" implicit="yes">') || !x.includes('<measure number="2">')) return "MusicXML numbers";
    if (importMusicXML(x).score.measures[2].len !== 960) return "MusicXML short last bar";
    if (importMusicXML(x).score.measures[0].len !== 480 || importMSCX(exportMSCX(s), "p.mscx").score.measures[0].len !== 480) return "round trip";
    s.staves[0].bars[1] = [q(0), q(1), q(2)];
    const mid = importMIDI(exportMIDI(s), "p.mid").score;
    if (mid.measures[0].len !== 480 || mid.measures[0].time.join() !== "3,4" || mid.staves[0].bars[0].length !== 1 || mid.staves[0].bars[1].length !== 3) return "MIDI " + JSON.stringify([mid.measures[0], mid.staves[0].bars.map((b) => b.length)]);
    s.measures[2].len = 2880; // a bar deleted with its time change can leave a length too long: it reads as full
    if (M.barLen(s, 2) !== 1440 || !M.isValidScore(s)) return "clamp";
    const old = M.newScore({ bars: 1 }); s.measures[1].len = 30;
    return (M.isValidScore(old) && !M.isValidScore(s)) || "validation";
  });

  await check("ornaments, tremolo, arpeggio, breath marks: one ornament a note, MusicXML and MuseScore round trips, drawn (DESIGN §34)", () => {
    const s = M.newScore({ bars: 1 });
    const n = (st, more) => ({ dur: "q", dots: 0, tie: false, pitches: [{ step: st, oct: 4, alter: 0 }, ...(more ? [{ step: st + 2, oct: 4, alter: 0 }] : [])] });
    s.staves[0].bars[0] = [n(0), n(1), n(2, true), n(3)];
    const [a, b, c, d] = s.staves[0].bars[0];
    M.setMark(a, "trill", true); M.setMark(a, "turn", true);
    if (a.marks.join() !== "turn") return "one ornament: " + a.marks;
    M.setMark(b, "mordent", true); M.setMark(b, "breath", true);
    M.setMark(c, "arpeggio", true); M.setMark(c, "tremolo", true);
    M.setMark(d, "invMordent", true); M.setMark(d, "caesura", true);
    const want = JSON.stringify(s.staves[0].bars[0].map((e) => e.marks));
    const x = importMusicXML(exportMusicXML(s), "o.musicxml"), m = importMSCX(exportMSCX(s), "o.mscx");
    for (const [k, r] of [["MusicXML", x], ["MuseScore", m]]) {
      const got = JSON.stringify(r.score.staves[0].bars[0].map((e) => e.marks));
      const w = r.report.warnings.filter((x) => !/instrument sound/.test(x));
      if (got !== want || w.length) return `${k}: ${got} ${w}`;
    }
    return M.isValidScore(s) || "validation";
  });

  await check("marks in playback: accents louder, ornaments from the key, tremolo and trill in 32nds, arpeggio rolled, breath shortens (DESIGN §34)", () => {
    const s = M.newScore({ bars: 1, key: 2 }); // D major: the note above E is F♯
    const n = (st, mark, more) => { const e = { dur: "q", dots: 0, tie: false, pitches: [{ step: st, oct: 4, alter: st === 3 ? 1 : 0 }, ...(more ? [{ step: st + 2, oct: 4, alter: 0 }] : [])] }; M.setMark(e, mark, true); return e; };
    s.staves[0].bars[0] = [n(2, "invMordent"), n(2, "accent"), n(0, "arpeggio", true), n(2, "turn")];
    const ns = schedule(s).notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
    const at = (t) => ns.filter((x) => x.start >= t && x.start < t + 480).map((x) => x.midi);
    if (at(0).join() !== "64,66,64") return "upper mordent " + at(0); // E F♯ E
    const acc = ns.find((x) => x.start === 480), plain = ns.find((x) => x.start === 0);
    if (!(acc.vel > plain.vel)) return "accent";
    const arp = ns.filter((x) => x.start >= 960 && x.start < 1440);
    if (arp.length !== 2 || arp[1].start <= arp[0].start) return "arpeggio " + JSON.stringify(arp);
    if (at(1440).join() !== "66,64,62,64") return "turn " + at(1440); // F♯ E D E
    s.staves[0].bars[0] = [n(0, "trill"), n(0, "tremolo"), n(0, "breath"), n(0, "staccato")];
    const t = schedule(s).notes;
    if (t.filter((x) => x.start < 480).length !== 8 || t.filter((x) => x.start >= 480 && x.start < 960).length !== 8) return "trill/tremolo counts";
    const br = t.find((x) => x.start === 960);
    return br.end < 1440 || "breath";
  });

  await check("fermatas hold twice as long in every part, again on a repeat; MIDI halves the tempo and reads back as held (DESIGN §34)", () => {
    const s = M.newScore({ bars: 1, tempo: 100, preset: "trebleBass" });
    const q = (st) => ({ dur: "q", dots: 0, tie: false, pitches: [{ step: st, oct: 4, alter: 0 }] });
    s.staves[0].bars[0] = [q(0), q(1), q(2), q(3)];
    M.setMark(s.staves[0].bars[0][2], "fermata", true);
    const sch = schedule(s), beat = 0.6;
    if (Math.abs(sch.timeOf(1920) - 5 * beat) > 1e-9 || Math.abs(sch.timeOf(960) - 2 * beat) > 1e-9) return "timing " + sch.timeOf(1920);
    s.measures[0].repStart = true; s.measures[0].repEnd = 2;
    const r = schedule(s);
    if (Math.abs(r.timeOf(3840) - 10 * beat) > 1e-9) return "repeat " + r.timeOf(3840);
    delete s.measures[0].repStart; delete s.measures[0].repEnd;
    // overlapping fermatas in two parts hold once; a downbeat fermata still reads back as held
    s.staves[1].bars[0] = [{ dur: "w", dots: 0, tie: false, pitches: [{ step: 0, oct: 3, alter: 0 }], marks: ["fermata"] }];
    const o = schedule(s);
    if (Math.abs(o.timeOf(1920) - 8 * beat) > 1e-9) return "overlap " + o.timeOf(1920);
    const down = importMIDI(exportMIDI(s), "d.mid");
    if (down.score.measures.some((m) => m.tempo) || down.score.tempo !== 100 || down.report.warnings.some((w) => /Tempo/.test(w))) return "downbeat tempo " + JSON.stringify([down.score.tempo, down.score.measures, down.report.warnings]);
    s.staves[1].bars[0] = [];
    // ornaments on short notes stay inside them
    const t = M.newScore({ bars: 1 });
    t.staves[0].bars[0] = [{ dur: "32", dots: 0, tie: false, pitches: [{ step: 0, oct: 5, alter: 0 }], marks: ["mordent", "staccato"] }];
    if (schedule(t).notes.some((x) => !(x.end > x.start) || x.end > 60)) return "short mordent " + JSON.stringify(schedule(t).notes);
    const back = importMIDI(exportMIDI(s), "f.mid");
    if (back.score.measures.some((m) => m.tempo) || back.score.tempo !== 100) return "tempo read " + JSON.stringify(back.score.measures);
    return back.report.warnings.some((w) => /Held notes/.test(w)) || "not counted: " + back.report.warnings;
  });

  await check("fingering: one per chord note, low to high, checked, MusicXML and MuseScore round trips (DESIGN §34)", () => {
    const s = M.newScore({ bars: 1 });
    s.staves[0].bars[0] = [{ dur: "w", dots: 0, tie: false, pitches: [{ step: 0, oct: 4, alter: 0 }, { step: 2, oct: 4, alter: 0 }, { step: 4, oct: 4, alter: 0 }] }];
    const ev = s.staves[0].bars[0][0];
    if (!M.setFingers(ev, "1 3 5 2") || !M.setFingers(ev, "7")) return "bad input accepted";
    if (M.setFingers(ev, "1 - 3-1") || ev.pitches.map((p) => p.finger).join() !== "1,,3-1") return "set " + JSON.stringify(ev.pitches);
    const want = JSON.stringify(ev.pitches);
    for (const [k, r] of [["MusicXML", importMusicXML(exportMusicXML(s), "f.musicxml")], ["MuseScore", importMSCX(exportMSCX(s), "f.mscx")]]) {
      if (JSON.stringify(r.score.staves[0].bars[0][0].pitches) !== want) return k + " " + JSON.stringify(r.score.staves[0].bars[0][0].pitches);
    }
    M.transpose(s, 0, 0, 0, 7);
    if (s.staves[0].bars[0][0].pitches.map((p) => p.finger).join() !== "1,,3-1") return "lost on an octave move";
    M.setFingers(s.staves[0].bars[0][0], "");
    return (M.isValidScore(s) && s.staves[0].bars[0][0].pitches.every((p) => !p.finger)) || "clear";
  });

  await check("drum notes move a line keeping their drum, as a file's own drum map has them (DESIGN §28)", () => {
    const s = M.newScore({ preset: "drums", bars: 1 });
    s.staves[0].bars[0] = [{ dur: "q", dots: 0, tie: false, pitches: [{ step: 0, oct: 5, alter: 0, drum: 38 }] }]; // snare, at its kit position
    const was = s.staves[0].bars[0][0].pitches[0];
    if (M.moveDrumNote(s, 0, 0, 0, 1)) return "refused";
    const p = s.staves[0].bars[0][0].pitches[0];
    if (p.drum !== 38 || M.diatonic(p) !== M.diatonic(was) + 1 || !M.isValidScore(s)) return JSON.stringify(p);
    if (!M.moveDrumNote(s, 0, 0, 0, 40)) return "moved off the staff";
    const t = M.newScore({ bars: 1 });
    t.staves[0].bars[0] = [{ dur: "q", dots: 0, tie: false, pitches: [{ step: 0, oct: 5, alter: 0 }] }];
    return !!M.moveDrumNote(t, 0, 0, 0, 1) || "moved a pitched note";
  });

  await check("tempo changes: model, timing, and MIDI, MusicXML and MuseScore round trips (DESIGN §29)", () => {
    const s = M.newScore({ bars: 4, tempo: 120 });
    s.staves[0].bars = s.staves[0].bars.map(() => [ev("w", "C5")]);
    if (M.setTempo(s, 2, 60) || M.setTempo(s, 3, 60) || s.measures[3].tempo) return "same tempo stored as a change";
    if (M.tempoAt(s, 1) !== 120 || M.tempoAt(s, 3) !== 60 || !M.isValidScore(s)) return "tempoAt";
    if (!M.setTempo(s, 1, 500) || M.isValidScore({ ...s, measures: [{ ...s.measures[0], tempo: 90 }, ...s.measures.slice(1)] })) return "bad tempo allowed";
    const { timeOf, total } = schedule(s); // two bars at 120 (2 s each), two at 60 (4 s each)
    if (timeOf(1920) !== 2 || timeOf(2 * 1920) !== 4 || timeOf(total) !== 12) return "timeOf " + [timeOf(1920), timeOf(3840), timeOf(total)];
    const t = (sc) => [sc.tempo, ...sc.measures.map((m) => m.tempo || 0)].join();
    const want = t(s);
    const mid = importMIDI(exportMIDI(s), "t.mid").score, xml = importMusicXML(exportMusicXML(s), "t.musicxml").score, ms = importMSCX(exportMSCX(s), "t.mscx").score;
    for (const [n, sc] of [["MIDI", mid], ["MusicXML", xml], ["MuseScore", ms]]) if (t(sc) !== want) return n + " " + t(sc);
    // a change on a deleted bar moves on; deleting bar 1 makes bar 2's tempo the score's
    M.deleteMeasure(s, 2);
    if (t(s) !== "120,0,0,60") return "delete " + t(s);
    const u = M.newScore({ bars: 3, tempo: 120 }); M.setTempo(u, 1, 60); M.setTempo(u, 2, 120); M.deleteMeasure(u, 1);
    if (t(u) !== "120,0,0") return "redundant after delete " + t(u);
    const rep = [importMusicXML(exportMusicXML(s), "t.musicxml").report, importMSCX(exportMSCX(s), "t.mscx").report];
    if (/tempo|metronome/i.test(JSON.stringify(rep))) return "tempo reported " + JSON.stringify(rep);
    M.setTempo(s, 1, 90); M.deleteMeasure(s, 0);
    if (t(s) !== "90,0,60") return "delete bar 1 " + t(s);
    // another program's metronome in dotted quarters, mid-bar
    const x = importMusicXML(`<score-partwise><part-list><score-part id="P1"><part-name>A</part-name></score-part></part-list><part id="P1">
      <measure number="1"><attributes><divisions>1</divisions><time><beats>6</beats><beat-type>8</beat-type></time></attributes>
      <note><rest/><duration>3</duration></note></measure>
      <measure number="2"><note><rest/><duration>1</duration></note><direction><direction-type><metronome><beat-unit>quarter</beat-unit><beat-unit-dot/><per-minute>80</per-minute></metronome></direction-type></direction>
      <note><rest/><duration>2</duration></note></measure></part></score-partwise>`, "m.xml");
    if (t(x.score) !== "120,0,0" || !JSON.stringify(x.report).includes("moved to the bar")) return "metronome " + t(x.score) + JSON.stringify(x.report);
    return true;
  });

  await check("text above notes and rehearsal marks: model, MusicXML and MuseScore round trips (DESIGN §30)", () => {
    const s = M.newScore({ bars: 3 });
    s.staves[0].bars = [[ev("h", "C5"), ev("h", "D5")], [ev("w", "E5")], [ev("w", "F5")]];
    const e = s.staves[0].bars[0][1];
    if (M.setText(e, "  a < b \n & \"c\"  ") || e.text !== 'a < b & "c"') return "setText " + e.text;
    if (!M.setText(e, "D.C. al Fine") || !M.setText(e, "fine") || e.text !== 'a < b & "c"') return "nav words allowed as text";
    if (M.setText(s.staves[0].bars[1][0], "x".repeat(99)) || s.staves[0].bars[1][0].text.length !== M.MAX_TEXT) return "not cut";
    if (M.nextRehearsal(s, 1) !== "A") return "first letter";
    M.setRehearsal(s, 1, "A");
    if (M.nextRehearsal(s, 2) !== "B" || M.setRehearsal(s, 2, "B") || !M.isValidScore(s)) return "rehearsal";
    if (M.isValidScore({ ...s, measures: [{ ...s.measures[0], rehearsal: "Fine" }, ...s.measures.slice(1)] })) return "nav rehearsal valid";
    const sig = (sc) => JSON.stringify([sc.measures.map((m) => m.rehearsal || ""), sc.staves[0].bars.map((b) => b.map((x) => x.text || ""))]);
    const x = importMusicXML(exportMusicXML(s), "t.musicxml"), ms = importMSCX(exportMSCX(s), "t.mscx");
    for (const [n, r] of [["MusicXML", x], ["MuseScore", ms]]) {
      if (sig(r.score) !== sig(s)) return n + " " + sig(r.score);
      if (/not imported|cut/.test(JSON.stringify(r.report))) return n + " reported " + JSON.stringify(r.report);
    }
    // text on a lone rest, and on a whole-bar rest: kept, or moved and counted
    const r = M.newScore({ bars: 3 });
    r.staves[0].bars = [[ev("h", "C5"), { dur: "h", dots: 0, tie: false, pitches: [], text: "lunga" }], [{ dur: "w", dots: 0, tie: false, pitches: [], text: "tacet" }], [ev("w", "E5")]];
    for (const [n, f] of [["MusicXML", (z) => importMusicXML(exportMusicXML(z), "r.musicxml")], ["MuseScore", (z) => importMSCX(exportMSCX(z), "r.mscx")]]) {
      const o = f(r), b = o.score.staves[0].bars, rep = JSON.stringify(o.report);
      if (b[0][1]?.text !== "lunga") return n + " rest text " + JSON.stringify(b[0]);
      if (b[1][0]?.text !== "tacet" && !(b[2][0]?.text === "tacet" && /moved/.test(rep))) return n + " whole-bar rest text " + JSON.stringify(b) + rep;
    }
    // MuseScore text with inline markup; a rehearsal mark too long to show is counted
    const raw = exportMSCX(s).replace("<StaffText><text>a &lt; b", "<StaffText><text><i>a</i> &lt; b").replace("<RehearsalMark><text>B<", "<RehearsalMark><text>Letter B and more<");
    const y = importMSCX(raw, "u.mscx");
    if (y.score.staves[0].bars[0][1].text !== 'a < b & "c"' || y.score.measures[2].rehearsal) return "markup " + sig(y.score);
    return JSON.stringify(y.report).includes("Rehearsal marks Coda can't show") || JSON.stringify(y.report);
  });

  await check("octave lines, pedal, extenders, nested slurs: model, playback, MusicXML, MuseScore, MIDI (DESIGN §37)", () => {
    const s = M.newScore({ preset: "treble", bars: 2 });
    s.staves[0].bars[0] = [ev("q", "C5", { lyrics: ["la"] }), ev("q", "D5"), ev("q", "E5"), ev("q", "F5", { lyrics: ["di"] })];
    s.staves[0].bars[1] = [ev("q", "G5"), ev("q", "A5"), ev("h", "B5")];
    const [a, b2, c, d] = s.staves[0].bars[0], [e, f, g] = s.staves[0].bars[1];
    a.lyrics[0].ext = true;
    if (M.toggleSpan([g], "ott", "8va") || M.toggleSpan([a, b2], "ped") || M.toggleSpan([c], "ped")) return "toggle";
    if (M.toggleSpan([b2, c], "ped") !== "That would overlap another pedal mark") return "overlap allowed";
    if (M.toggleSlur(s.staves[0].bars.flat(), [a, b2, c, d, e]) || M.toggleSlur(s.staves[0].bars.flat(), [b2, c]) || !b2.slur2 || !c.slur2End) return "nested " + JSON.stringify(s.staves[0].bars[0]);
    if (M.toggleSlur(s.staves[0].bars.flat(), [b2, c, d]) !== "Two slurs at most over a note") return "third slur";
    if (M.clearBrokenSpans(s) || !M.isValidScore(s)) return "valid";
    if (M.isValidScore({ ...s, staves: [{ ...s.staves[0], bars: [[{ ...ev("w", "C4"), ott: "toString" }], []] }] })) return "bad ott valid";
    if (M.melismas(s).get(a)?.[0].last !== c || M.melismas(s).get(a)[0].ticks !== 960) return "melisma";
    // playback: the 8va sounds an octave up; the pedal rings each note to the end of its last note
    const { notes, pedals } = schedule(s);
    if (notes.map((n) => n.midi).join() !== "72,74,76,77,79,81,95") return "midi " + notes.map((n) => n.midi);
    if (notes[0].ring !== 960 || notes[1].ring || notes[2].ring !== undefined || pedals[0].join("|") !== "0,960|960,1440") return "pedal " + JSON.stringify(notes.slice(0, 3)) + JSON.stringify(pedals);
    const mid = exportMIDI(s), cc = [...mid].filter((x, i) => x === 0xb0 && mid[i + 1] === 64).length;
    if (cc !== 4 || !/Sustain pedal \(not imported\): 2/.test(importMIDI(mid, "p.mid").report.warnings.join())) return "MIDI pedal " + cc + importMIDI(mid, "p.mid").report.warnings;
    const sig = (sc) => sc.staves[0].bars.flat().map((x) => ["slur", "slurEnd", "slur2", "slur2End", "ped", "pedEnd", "ott", "ottEnd"].filter((k) => x[k]).map((k) => k + (k === "ott" ? x.ott : "")).join("+") + (x.lyrics?.[0]?.ext ? "_" : "")).join(" ") + " " + brief(sc.staves[0]);
    const xml = exportMusicXML(s);
    if (!xml.includes('<octave-shift type="down" size="8"/>') || !/<step>B<\/step><octave>6/.test(xml) || !xml.includes('<slur type="start" number="9"/>')) return "MusicXML out";
    for (const [n, r] of [["MusicXML", importMusicXML(xml, "o.musicxml")], ["MuseScore", importMSCX(exportMSCX(s), "o.mscx")]]) {
      if (sig(r.score) !== sig(s)) return n + " " + sig(r.score) + " vs " + sig(s);
      const w = r.report.warnings.filter((x) => !/instrument sound/.test(x));
      if (w.length) return n + " " + w;
    }
    // an octave line in layer 1 moves layer 2's notes under it too, across the barline (review fix)
    const two = M.newScore({ preset: "treble", bars: 2 });
    two.staves[0].bars = [[ev("q", "C5"), ev("q", "D5"), ev("q", "E5"), ev("q", "F5")], [ev("q", "G5"), ev("q", "A5"), ev("h", "B5")]];
    two.staves[0].layers = [[[ev("h", "G4"), ev("h", "A4")], [ev("w", "B4")]]];
    M.toggleSpan([two.staves[0].bars[0][2], two.staves[0].bars[0][3], two.staves[0].bars[1][0]], "ott", "8va");
    const all = (sc) => M.allLayers(sc.staves[0]).map((bars) => bars.map((bar) => bar.map((x) => x.pitches.map((p) => "CDEFGAB"[p.step] + p.oct).join("+")).join(" ")).join(" | ")).join(" / ");
    const tx = exportMusicXML(two);
    if ((tx.match(/<octave>5<\/octave>/g) || []).length !== 6 || (tx.match(/<step>A<\/step><octave>5/g) || []).length !== 2) return "layer 2 not sounding in the file";
    const back = importMusicXML(tx, "two.musicxml").score;
    if (all(back) !== all(two)) return "two layers: " + all(back) + " vs " + all(two);
    const N = (x, o) => `<note><pitch><step>${x}</step><octave>${o}</octave></pitch><duration>1</duration><type>quarter</type></note>`;
    // review fixes: a third slur around a second-level one; the pedal lifts at a repeat; an extender stops at a rest;
    // crossing MuseScore slurs keep their ends; a MusicXML pedal ends in its own layer
    const t3 = M.newScore({ preset: "treble", bars: 2 }), L3 = t3.staves[0].bars;
    L3[0] = [ev("q", "C5"), ev("q", "D5"), ev("q", "E5"), ev("q", "F5")]; L3[1] = [ev("q", "G5"), ev("q", "A5"), ev("q", "B5"), ev("q", "C6")];
    const f3 = L3.flat();
    M.toggleSlur(f3, f3.slice(0, 8)); M.toggleSlur(f3, f3.slice(1, 7));
    if (M.toggleSlur(f3, f3.slice(2, 4)) !== "Two slurs at most over a note") return "third slur inside a slur2 allowed";
    const rp = M.newScore({ preset: "treble", bars: 3 });
    rp.staves[0].bars = [[ev("w", "C5")], [ev("w", "D5")], [ev("w", "E5")]];
    rp.measures[1].repEnd = 2;
    M.toggleSpan([rp.staves[0].bars[1][0], rp.staves[0].bars[2][0]], "ped");
    const sr = schedule(rp);
    if (JSON.stringify(sr.pedals[0]) !== "[[1920,3840],[5760,9600]]" || sr.notes[1].ring) return "repeat pedal " + JSON.stringify(sr.pedals[0]) + " " + sr.notes[1].ring;
    const mr = M.newScore({ preset: "treble", bars: 1 });
    mr.staves[0].bars[0] = [ev("q", "C5", { lyrics: ["la"] }), ev("q", "D5"), ev("q", null), ev("q", "E5")];
    mr.staves[0].bars[0][0].lyrics[0].ext = true;
    if (M.melismas(mr).get(mr.staves[0].bars[0][0])[0].last !== mr.staves[0].bars[0][1]) return "extender over a rest";
    const cr = JSON.parse(JSON.stringify(t3)), C = cr.staves[0].bars;
    for (const e of C.flat()) for (const k of ["slur", "slurEnd", "slur2", "slur2End"]) delete e[k];
    C[0][0].slur = true; C[1][0].slurEnd = true; C[0][3].slur2 = true; C[1][3].slur2End = true;
    const cb = importMSCX(exportMSCX(cr), "x.mscx").score.staves[0].bars;
    if (!cb[1][0].slurEnd || !cb[1][3].slur2End) return "crossing slurs swapped";
    const pv = `<score-partwise><part-list><score-part id="P1"><part-name>V</part-name></score-part></part-list><part id="P1">
      <measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes>
      <direction><direction-type><pedal type="start"/></direction-type></direction>${N("C", 5).replace("<duration>", "<voice>1</voice><duration>")}${N("D", 5).replace("<duration>", "<voice>1</voice><duration>")}
      <backup><duration>2</duration></backup><note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>2</voice><type>half</type></note></measure>
      <measure number="2"><direction><direction-type><pedal type="stop"/></direction-type></direction><note><rest/><duration>2</duration><voice>1</voice><type>half</type></note></measure></part></score-partwise>`;
    const pr = importMusicXML(pv, "pv.musicxml");
    if (!pr.score.staves[0].bars[0][1].pedEnd || pr.report.warnings.length) return "pedal across layers " + JSON.stringify(pr.score.staves[0].bars[0]) + pr.report.warnings;
    // a file's octave shift: notes in the file sound; Coda keeps them written. 22ma is counted.
    const D = (t) => `<direction><direction-type>${t}</direction-type></direction>`;
    const raw = `<score-partwise><part-list><score-part id="P1"><part-name>V</part-name></score-part></part-list><part id="P1"><measure number="1">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      ${D('<octave-shift type="up" size="8"/>')}${N("C", 3)}${N("D", 3)}${D('<octave-shift type="stop" size="8"/>')}${D('<pedal type="start"/>')}${N("E", 4)}${D('<pedal type="change"/>')}${D('<octave-shift type="down" size="22"/>')}${N("F", 6)}${D('<pedal type="stop"/>')}</measure></part></score-partwise>`;
    const r = importMusicXML(raw, "r.musicxml"), got = sig(r.score);
    if (got !== "ott8vb ottEnd ped+pedEnd ped+pedEnd C4:q D4:q E4:q F6:q") return got;
    return /Octave lines Coda can't show.*: 1/.test(r.report.warnings.join()) || r.report.warnings.join();
  });

  await check("chord symbols: parse, show, transpose with the part, MusicXML and MuseScore, import counts (DESIGN §38)", () => {
    const pc = (t) => JSON.stringify(M.parseChord(t));
    if (pc("Bbm7/F") !== '{"root":{"step":6,"alter":-1},"kind":"m7","bass":{"step":3,"alter":0}}' || pc("c") !== '{"root":{"step":0,"alter":0},"kind":""}') return pc("Bbm7/F");
    if (M.parseChord("H7") || M.parseChord("") || M.parseChord("Cthirteenflat9") || M.chordText(M.parseChord("F#m7b5/C#")) !== "F♯m7b5/C♯") return "parse edges";
    const s = M.newScore({ preset: "treble", bars: 1 });
    s.staves[0].bars[0] = [ev("h", "C5"), ev("q", "E5"), ev("q", null)];
    const [a, b, r] = s.staves[0].bars[0];
    a.harm = M.parseChord("C7"); b.harm = M.parseChord("Ebmaj7/Bb"); r.harm = M.parseChord("G7(b9)");
    if (!M.isValidScore(s) || M.isValidScore({ ...s, staves: [{ ...s.staves[0], bars: [[{ ...ev("w", "C4"), harm: { root: { step: 9, alter: 0 }, kind: "" } }]] }] })) return "validation";
    const sig = (sc) => sc.staves[0].bars.flat().map((x) => (x.harm ? M.chordText(x.harm) : "-")).join(" ");
    for (const [n, f] of [["MusicXML", (z) => importMusicXML(exportMusicXML(z), "c.musicxml")], ["MuseScore", (z) => importMSCX(exportMSCX(z), "c.mscx")]]) {
      const o = f(s), w = o.report.warnings.filter((x) => !/instrument sound/.test(x));
      if (sig(o.score) !== sig(s) || w.length) return n + " " + sig(o.score) + " " + w;
    }
    // a B♭ trumpet part: the symbols are written a tone up, like the notes
    const t = JSON.parse(JSON.stringify(s));
    if (M.setStaffTranspose(t, 0, [-2, -1]) || sig(t) !== "D7 Fmaj7/C A7(b9)") return "transposed " + sig(t);
    if (sig(importMSCX(exportMSCX(t), "t.mscx").score) !== sig(t)) return "MuseScore transposed " + sig(importMSCX(exportMSCX(t), "t.mscx").score);
    // MusicXML: N.C., degrees, a symbol halfway through a note, two on one note
    const H = (root, kind, more = "") => `<harmony><root><root-step>${root}</root-step></root><kind>${kind}</kind>${more}</harmony>`;
    const N = (x, d, ty) => `<note><pitch><step>${x}</step><octave>5</octave></pitch><duration>${d}</duration><type>${ty}</type></note>`;
    const xml = `<score-partwise><part-list><score-part id="P1"><part-name>V</part-name></score-part></part-list><part id="P1"><measure number="1">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      ${H("D", "minor-seventh", "<degree><degree-value>9</degree-value><degree-alter>0</degree-alter><degree-type>add</degree-type></degree>")}${H("C", "none")}${N("C", 2, "half")}
      ${H("G", "dominant", "<offset>0.5</offset>")}${N("D", 1, "quarter")}${N("E", 1, "quarter")}${H("A", "major")}${H("F", "major")}</measure></part></score-partwise>`;
    const o = importMusicXML(xml, "h.musicxml"), w = o.report.warnings.join("; ");
    if (sig(o.score) !== "Dm7 - G7") return sig(o.score) + " " + w;
    return ["Added or altered notes", "N.C.", "moved to the next note", "already has one", "after the last note"].every((k) => w.includes(k)) || w;
  });

  await check("transpose the score, respell, concert-pitch view (DESIGN §38)", () => {
    const s = M.newScore({ preset: "treble", bars: 2 });
    s.measures[0].key = 7; // C♯ major
    s.staves[0].bars[0] = [ev("h", "C#5 E#5", { tie: true }), ev("h", "C#5 E#5")];
    s.staves[0].bars[1] = [ev("w", "G#4")];
    s.staves[0].bars[0][0].harm = M.parseChord("C#maj7");
    s.measures[1].key = 0;
    const t = JSON.parse(JSON.stringify(s));
    if (M.transposeScore(t, 7, 4) || t.measures[0].key !== -4 || t.measures[1].key !== 1) return "keys " + t.measures.map((m) => m.key);
    if (brief(t.staves[0]) !== "Ab5+C6:h~ Ab5+C6:h | Eb5:w" || M.chordText(t.staves[0].bars[0][0].harm) !== "A♭maj7") return brief(t.staves[0]);
    const u = M.newScore({ preset: "treble", bars: 1 });
    u.staves[0].bars[0] = [ev("w", "C5")];
    if (M.transposeScore(u, 2, 1) || u.measures[0].key !== 2 || brief(u.staves[0]) !== "D5:w") return "up a tone " + brief(u.staves[0]);
    if (M.transposeScore(u, 120, 70) !== "Some notes would go off the keyboard") return "range";
    // respell: the tie partner follows; a chord can't end up with two notes on one line
    const r = JSON.parse(JSON.stringify(s));
    if (M.respell(r, 0, [{ bar: 0, idx: 0 }]) || brief(r.staves[0]) !== "Db5+F5:h~ Db5+F5:h | G#4:w") return "respell " + brief(r.staves[0]);
    if (M.respell(r, 0, [{ bar: 0, idx: 0 }]) || brief(r.staves[0]) !== "C#5+E#5:h~ C#5+E#5:h | G#4:w") return "respell back " + brief(r.staves[0]);
    const cl = M.newScore({ preset: "treble", bars: 1 });
    cl.staves[0].bars[0] = [ev("w", "Db5 C#5")];
    if (!M.respell(cl, 0, [{ bar: 0, idx: 0 }])) return "clash allowed";
    // concert view: a B♭ trumpet's written D shows as C; the score itself is untouched
    const v = M.newScore({ preset: "treble", bars: 1 });
    v.staves[0].bars[0] = [ev("w", "D5")];
    v.staves[0].bars[0][0].harm = M.parseChord("D7");
    v.staves[0].transpose = [-2, -1];
    const cv = M.concertView(v);
    if (brief(cv.staves[0]) !== "C5:w" || cv.staves[0].transpose || M.chordText(cv.staves[0].bars[0][0].harm) !== "C7" || brief(v.staves[0]) !== "D5:w" || !v.staves[0].transpose) return "concert " + brief(cv.staves[0]);
    return M.concertView(u) === u || "copy without transposing parts";
  });

  await check("Metronome beats and count-in: compound time, pickups (DESIGN §39)", () => {
    const s = M.newScore({ bars: 2, time: [6, 8] });
    if (!eq(beatsOf(s, 0).ticks, [0, 720])) return "6/8 " + beatsOf(s, 0).ticks;
    const p = M.newScore({ bars: 2 });
    M.setBarLen(p, 0, 240); // an eighth pickup in 4/4
    if (!eq(beatsOf(p, 0).ticks, []) || !eq(beatsOf(p, 1).ticks, [0, 480, 960, 1440])) return "pickup beats " + beatsOf(p, 0).ticks;
    const { barStart, total } = schedule(p);
    const c = clicks(p, barStart, total, { click: true, countIn: true });
    const pre = c.filter((n) => n.start < 0).map((n) => n.start), on = c.filter((n) => n.start >= 0).map((n) => n.start);
    if (!eq(pre, [-1680, -1200, -720, -240])) return "count-in " + pre; // three and a half beats: the pickup is the "and" of 4
    if (!eq(on, [240, 720, 1200, 1680]) || c.find((n) => n.start === 240).midi !== 76) return "clicks " + on;
    return true;
  });

  // Later phases: MIDI, MuseScore, musx.
  for (const path of ["./tests-midi.js", "./tests-mscz.js", "./tests-musx.js"]) {
    let mod = null;
    try { mod = await import(path); } catch (e) { await check(`load ${path}`, () => e.message); continue; }
    await mod.run({ check, eq, brief, fetchBytes, importBytes });
  }
}
