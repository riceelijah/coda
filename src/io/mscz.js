// MuseScore .mscz / .mscx import (versions 3.x and 4.x). See docs/DESIGN.md §9.7.
// Written from the file format as MuseScore saves it; no MuseScore source code is used.
import { padBars, noteCount, tupletOk, spellMidi, midi, splitTicks, MAX_LAYERS, eventTicks, barTicks, barCapacity } from "../model.js";
import { decodeText, parseXml, Report, unzip } from "./util.js";
import { GM } from "../gm.js";

const DUR = { whole: "w", half: "h", quarter: "q", eighth: "8", "16th": "16", "32nd": "32" };
const LONGER = new Set(["breve", "long"]);
const SHORTER = new Set(["64th", "128th", "256th", "512th", "1024th"]);
const GRACE = ["acciaccatura", "appoggiatura", "grace4", "grace16", "grace32", "grace8after", "grace16after", "grace32after"];

const kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el, name) => kids(el, name)[0] || null;
const txt = (el, name) => { const k = kid(el, name); return k ? k.textContent.trim() : null; };

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

const CLEF = { G: "treble", F: "bass", C3: "alto", C4: "tenor" };

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
    if (program === undefined && name) {
      const byName = GM.find((g) => g.name.toLowerCase() === name.trim().toLowerCase());
      if (byName) program = byName.program;
      else if (!/piano/i.test(name)) report.count("Parts with no instrument sound found (played as piano)");
    }
    for (let k = 0; k < n; k++) decl.push({ name, brace: n === 2 && k === 0, program });
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
  kids(sc, "Staff").forEach((stEl, si) => {
    const d = decl[si] || { name: "", brace: false };
    const staff = { name: d.name, clef: null, brace: d.brace, bars: [], ...(d.program !== undefined ? { program: d.program } : {}) };
    let key = 0, time = [4, 4];
    const tuplets = {}; // MuseScore 3: id -> ratio
    kids(stEl, "Measure").forEach((meas, mi) => {
      const voices = kids(meas, "voice");
      for (const L of staff.layers || []) L.push([]);
      // MuseScore 2 files have no <voice> wrapper. Voices become layers 1–4 (DESIGN §15).
      (voices.length ? voices : [meas]).forEach((vEl, vi) => {
      if (vi >= MAX_LAYERS) { report.count(`Notes in voices beyond ${MAX_LAYERS} per staff skipped`, kids(vEl, "Chord").length); return; }
      const bar = [];
      let tup = null, cur = 0; // cur: time cursor in ticks; <location> moves it either way
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
            if (staff.clef === null) staff.clef = clef || "treble";
            else if (mi > 0 || bar.length) report.count("Clef changes ignored");
            break;
          }
          case "KeySig": {
            const k = txt(el, "concertKey") ?? txt(el, "accidental");
            if (k !== null) key = Math.max(-7, Math.min(7, parseInt(k, 10) || 0));
            break;
          }
          case "TimeSig": {
            const n = +txt(el, "sigN"), dd = +txt(el, "sigD");
            if (n > 0 && [1, 2, 4, 8, 16, 32].includes(dd)) time = [n, dd];
            break;
          }
          case "Tempo":
            if (!score.tempo) score.tempo = Math.round(parseFloat(txt(el, "tempo")) * 60) || 0;
            break;
          case "Tuplet": {
            const ratio = [+txt(el, "actualNotes"), +txt(el, "normalNotes")];
            if (el.getAttribute("id")) tuplets[el.getAttribute("id")] = ratio;
            else tup = ratio;
            break;
          }
          case "endTuplet": tup = null; break;
          case "Chord":
          case "Rest": {
            const isRest = el.localName === "Rest";
            if (GRACE.some((g) => kid(el, g))) { report.count("Grace notes skipped"); break; }
            const dt = txt(el, "durationType");
            if (dt === "measure") { cur += barCapacity(time); break; } // whole-bar rest = empty bar
            let dur = DUR[dt];
            if (!dur && LONGER.has(dt)) { dur = "w"; report.count("Notes longer than a whole note shortened"); }
            if (!dur && SHORTER.has(dt)) { dur = "32"; report.count("Notes shorter than a 32nd lengthened"); }
            if (!dur) { report.count("Notes with unknown lengths skipped"); break; }
            const dots = Math.min(2, +(txt(el, "dots") || 0));
            const ev = { dur, dots, tie: false, pitches: [] };
            const ratio = txt(el, "Tuplet") ? tuplets[txt(el, "Tuplet")] : tup;
            if (ratio && ratio[0] > 0 && ratio[1] > 0 && ratio[0] !== ratio[1]) {
              if (tupletOk(dur, dots, ratio)) ev.tup = ratio;
              else report.count("Notes in unsupported tuplets (kept written lengths)");
            }
            if (!isRest) {
              for (const n of kids(el, "Note")) {
                const pm = parseInt(txt(n, "pitch"), 10);
                const tpc = parseInt(txt(n, "tpc"), 10);
                if (!Number.isFinite(pm)) continue;
                let p = Number.isFinite(tpc) ? tpcToPitch(tpc, pm) : null;
                if (!p || p.alter < -2 || p.alter > 2 || midi(p) !== pm) {
                  p = spellMidi(pm, key);
                  report.count("Note spellings guessed from pitch");
                }
                if (!ev.pitches.some((q) => q.step === p.step && q.oct === p.oct)) ev.pitches.push(p);
                const tieSp = kids(n, "Spanner").find((s) => s.getAttribute("type") === "Tie" && kid(s, "next"));
                if (tieSp || kid(n, "Tie")) ev.tie = true;
              }
              if (!ev.pitches.length) break;
              ev.pitches.sort((a, b) => a.oct * 7 + a.step - (b.oct * 7 + b.step));
            }
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
          default: break;
        }
      }
      if (vi === 0) staff.bars.push(bar);
      else if (bar.length) {
        staff.layers ||= [];
        while (staff.layers.length < vi) staff.layers.push(staff.bars.map(() => []).concat(staff.bars.length === mi ? [[]] : []));
        staff.layers[vi - 1][mi] = bar;
      }
      });
      if (si === 0) firstAttrs.push({ key, time: [...time] });
    });
    if (!staff.clef) staff.clef = "treble";
    score.staves.push(staff);
  });
  if (!score.staves.length) throw new Error("This MuseScore file has no staves.");

  firstAttrs.forEach((a, i) => {
    const prev = i ? firstAttrs[i - 1] : null;
    const m = {};
    if (!prev || prev.key !== a.key) m.key = a.key;
    if (!prev || prev.time[0] !== a.time[0] || prev.time[1] !== a.time[1]) m.time = a.time;
    score.measures.push(m);
  });
  score.tempo = Math.max(20, Math.min(400, score.tempo || 100));
  padBars(score);
  report.notes = noteCount(score);
  return { score, report: report.done() };
}
