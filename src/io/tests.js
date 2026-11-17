// File-format checks, loaded by test.html. Each phase adds its checks here.
import { exportMusicXML, importMusicXML } from "./musicxml.js";
import { importBytes, sniff, LEGACY_MUS } from "./open.js";
import { schedule } from "../play.js";

const P = (name) => {
  const m = /^([A-G])(#{1,2}|b{1,2})?(-?\d)$/.exec(name);
  const alter = !m[2] ? 0 : m[2][0] === "#" ? m[2].length : -m[2].length;
  return { step: "CDEFGAB".indexOf(m[1]), oct: +m[3], alter };
};
const ev = (dur, names, o = {}) => ({
  dur, dots: o.dots || 0, tie: !!o.tie, pitches: names ? names.split(" ").map(P) : [],
  ...(o.tup ? { tup: o.tup } : {}),
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
    measures: [{ key: -3, time: [4, 4] }, {}, { key: 2 }, { time: [6, 8] }, {}],
    staves: [
      { name: "Keys", clef: "treble", brace: true, bars: [
        [ev("q", "C4 E4 G4"), ev("8", "D5", { dots: 1 }), ev("16", "E5"), ev("h", "F#5", { tie: true })],
        [ev("q", "F#5"), ev("8", "G5", { tup: [3, 2] }), ev("8", "A5", { tup: [3, 2] }), ev("8", "Bb5", { tup: [3, 2] }), ev("h")],
        [],
        [ev("q", "D5", { dots: 1 }), ev("8", "C#5"), ev("16", "B4"), ev("16", "A4"), ev("8", "G4")],
        [ev("h", "D4 F#4 A4", { dots: 1 })],
      ] },
      { name: "Keys", clef: "bass", brace: false, bars: [
        [ev("w", "C3")],
        [ev("h", "F2", { dots: 2 }), ev("8", "Ab2")],
        [ev("h", "D3", { tie: true }), ev("h", "D3")],
        [],
        [ev("h", "D2 A2", { dots: 1 })],
      ] },
      { name: "Viola", clef: "alto", brace: false, bars: [
        [ev("w", "C4")], [], [ev("w", "D4")], [ev("q", "A3", { dots: 1 }), ev("q", "B3", { dots: 1 })], [],
      ] },
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
    const w = report.warnings.join("; ");
    return (w.includes("Grace notes skipped: 1") && w.includes("Notes in other voices skipped: 1")) || "warnings: " + w;
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

  // Later phases: MIDI, MuseScore, musx.
  for (const path of ["./tests-midi.js", "./tests-mscz.js", "./tests-musx.js"]) {
    let mod = null;
    try { mod = await import(path); } catch (e) { await check(`load ${path}`, () => e.message); continue; }
    await mod.run({ check, eq, brief, fetchBytes, importBytes });
  }
}
