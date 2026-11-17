// MusicXML import/export and MXL unzip. See docs/DESIGN.md §9.2–9.3.
import {
  attrsAt, barCapacity, barTicks, eventTicks, splitTicks, durFromTicks, nearestDur, tupletOk,
  tupletRuns, padBars, noteCount, PPQ, BASE, partGroups,
} from "../model.js";
import { decodeText, parseXml, Report, unzip } from "./util.js";

const TYPE_OF = { w: "whole", h: "half", q: "quarter", 8: "eighth", 16: "16th", 32: "32nd" };
const DUR_OF = { whole: "w", half: "h", quarter: "q", eighth: "8", "16th": "16", "32nd": "32" };
const LONGER = new Set(["breve", "long", "maxima"]);
const SHORTER = new Set(["64th", "128th", "256th", "512th", "1024th"]);
const CLEF_OUT = { treble: ["G", 2], bass: ["F", 4], alto: ["C", 3], tenor: ["C", 4] };

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------- export ----------

function noteXml(ev, p, { chord, staffNo, voice, tieStop, tupStart, tupStop }) {
  const x = ["<note>"];
  if (chord) x.push("<chord/>");
  if (p) {
    x.push(`<pitch><step>${"CDEFGAB"[p.step]}</step>${p.alter ? `<alter>${p.alter}</alter>` : ""}<octave>${p.oct}</octave></pitch>`);
  } else x.push("<rest/>");
  x.push(`<duration>${eventTicks(ev)}</duration>`);
  const tieStart = p && ev.tie;
  if (tieStop) x.push('<tie type="stop"/>');
  if (tieStart) x.push('<tie type="start"/>');
  x.push(`<voice>${voice}</voice>`, `<type>${TYPE_OF[ev.dur]}</type>`);
  for (let i = 0; i < (ev.dots || 0); i++) x.push("<dot/>");
  if (ev.tup) x.push(`<time-modification><actual-notes>${ev.tup[0]}</actual-notes><normal-notes>${ev.tup[1]}</normal-notes></time-modification>`);
  if (staffNo) x.push(`<staff>${staffNo}</staff>`);
  const nots = [];
  if (tieStop) nots.push('<tied type="stop"/>');
  if (tieStart) nots.push('<tied type="start"/>');
  if (!chord && tupStart) nots.push('<tuplet type="start" bracket="yes"/>');
  if (!chord && tupStop) nots.push('<tuplet type="stop"/>');
  if (nots.length) x.push(`<notations>${nots.join("")}</notations>`);
  x.push("</note>");
  return x.join("");
}

function restXml(ticks, staffNo, voice, whole) {
  if (whole) {
    return `<note><rest measure="yes"/><duration>${ticks}</duration><voice>${voice}</voice>${staffNo ? `<staff>${staffNo}</staff>` : ""}</note>`;
  }
  return splitTicks(ticks).map((d) => noteXml({ dur: d.dur, dots: d.dots, pitches: [] }, null, { staffNo, voice })).join("");
}

// A bar ending part-way through a tuplet group gets tuplet rests to finish the group, so the
// padding after it is in whole ticks (DESIGN §11.6).
function completeTuplet(bar, cap) {
  const runs = tupletRuns(bar), run = runs[runs.length - 1];
  if (!run || run.idx[run.idx.length - 1] !== bar.length - 1 || run.ticks % run.unit === 0) return bar;
  const first = bar[run.idx[0]];
  const one = (BASE[first.dur] * run.tup[1]) / run.tup[0], missing = run.unit - (run.ticks % run.unit);
  if (missing % one || barTicks(bar) + missing > cap) return bar;
  const rests = Array.from({ length: missing / one }, () => ({ dur: first.dur, dots: 0, pitches: [], tie: false, tup: [...run.tup] }));
  return [...bar, ...rests];
}

// Notes for one staff in one bar. Returns {xml, ticks written}.
function barXml(score, s, b, staffNo, voice) {
  const cap = barCapacity(attrsAt(score, b).time);
  const bar = completeTuplet(score.staves[s].bars[b], cap);
  if (!bar.length) return { xml: restXml(cap, staffNo, voice, true), ticks: cap };
  // last event of the previous bar, for tie stops on this bar's first event
  const pbar = b > 0 ? score.staves[s].bars[b - 1] : [];
  const prev = pbar.length ? pbar[pbar.length - 1] : null;
  const runs = tupletRuns(bar);
  const starts = new Set(runs.map((r) => r.idx[0])), stops = new Set(runs.map((r) => r.idx[r.idx.length - 1]));
  const out = [];
  bar.forEach((ev, i) => {
    const before = i > 0 ? bar[i - 1] : prev;
    const tied = (p) => !!(before && before.tie && before.pitches.some((q) => q.step === p.step && q.oct === p.oct));
    const flags = { staffNo, voice, tupStart: starts.has(i), tupStop: stops.has(i) };
    if (!ev.pitches.length) out.push(noteXml(ev, null, flags));
    else ev.pitches.forEach((p, k) => out.push(noteXml(ev, p, { ...flags, chord: k > 0, tieStop: tied(p) })));
  });
  let ticks = barTicks(bar);
  if (ticks < cap) { out.push(restXml(cap - ticks, staffNo, voice, false)); ticks = cap; }
  return { xml: out.join(""), ticks };
}

export function exportMusicXML(score) {
  const groups = partGroups(score);
  const x = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
    '<score-partwise version="4.0">',
    `<work><work-title>${esc(score.title || "")}</work-title></work>`,
    "<identification>",
    score.composer ? `<creator type="composer">${esc(score.composer)}</creator>` : "",
    "<encoding><software>Coda</software></encoding></identification>",
    "<part-list>",
  ];
  groups.forEach((g, i) => {
    const prog = score.staves[g[0]].program, id = `P${i + 1}`;
    // instrument only when set, so scores without one round-trip unchanged (DESIGN §13.2)
    const inst = Number.isInteger(prog)
      ? `<score-instrument id="${id}-I1"><instrument-name>${esc(score.staves[g[0]].name || "")}</instrument-name></score-instrument>` +
        `<midi-instrument id="${id}-I1"><midi-channel>${i < 9 ? i + 1 : Math.min(i + 2, 16)}</midi-channel><midi-program>${prog + 1}</midi-program></midi-instrument>`
      : "";
    x.push(`<score-part id="${id}"><part-name>${esc(score.staves[g[0]].name || "")}</part-name>${inst}</score-part>`);
  });
  x.push("</part-list>");
  groups.forEach((g, gi) => {
    x.push(`<part id="P${gi + 1}">`);
    score.measures.forEach((m, b) => {
      x.push(`<measure number="${b + 1}">`);
      const a = attrsAt(score, b);
      const attrs = [];
      if (b === 0) attrs.push(`<divisions>${PPQ}</divisions>`);
      if (b === 0 || m.key !== undefined) attrs.push(`<key><fifths>${a.key}</fifths></key>`);
      if (b === 0 || m.time) attrs.push(`<time><beats>${a.time[0]}</beats><beat-type>${a.time[1]}</beat-type></time>`);
      if (b === 0) {
        if (g.length > 1) attrs.push(`<staves>${g.length}</staves>`);
        g.forEach((s, k) => {
          const [sign, line] = CLEF_OUT[score.staves[s].clef];
          attrs.push(`<clef${g.length > 1 ? ` number="${k + 1}"` : ""}><sign>${sign}</sign><line>${line}</line></clef>`);
        });
      }
      if (attrs.length) x.push(`<attributes>${attrs.join("")}</attributes>`);
      if (b === 0 && gi === 0) {
        x.push(`<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${score.tempo}</per-minute></metronome></direction-type><sound tempo="${score.tempo}"/></direction>`);
      }
      g.forEach((s, k) => {
        const r = barXml(score, s, b, g.length > 1 ? k + 1 : 0, k + 1);
        x.push(r.xml);
        if (k < g.length - 1) x.push(`<backup><duration>${r.ticks}</duration></backup>`);
      });
      if (b === score.measures.length - 1) x.push('<barline location="right"><bar-style>light-heavy</bar-style></barline>');
      x.push("</measure>");
    });
    x.push("</part>");
  });
  x.push("</score-partwise>");
  return x.filter(Boolean).join("\n");
}

// ---------- import ----------

const kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el, name) => kids(el, name)[0] || null;
const txt = (el, name) => { const k = kid(el, name); return k ? k.textContent.trim() : null; };

function clefFrom(el, report) {
  const sign = txt(el, "sign"), line = +txt(el, "line");
  const oct = txt(el, "clef-octave-change");
  if (oct && +oct !== 0) report.count("Octave clefs shown as plain clefs");
  if (sign === "G") return "treble";
  if (sign === "F") return "bass";
  if (sign === "C" && line === 4) return "tenor";
  if (sign === "C") return "alto";
  report.count(`Unsupported clefs (${sign || "none"}) shown as treble`);
  return "treble";
}

export function importMusicXML(text, fileName = "", format = "MusicXML") {
  const report = new Report(format);
  const doc = parseXml(text);
  const root = doc.documentElement;
  if (root.localName === "score-timewise") throw new Error("This is a 'timewise' MusicXML file, which Coda can't read yet. Most programs can re-export it as standard (partwise) MusicXML.");
  if (root.localName !== "score-partwise") throw new Error("This XML file isn't a MusicXML score.");

  const names = {}, programs = {};
  for (const sp of root.querySelectorAll("part-list > score-part")) {
    const id = sp.getAttribute("id");
    names[id] = txt(sp, "part-name") || "";
    const mis = kids(sp, "midi-instrument");
    if (mis.length > 1) report.count("Extra instruments in a part (first one used)", mis.length - 1);
    const pr = mis.length ? parseInt(txt(mis[0], "midi-program"), 10) : NaN; // 1-based in MusicXML
    if (Number.isInteger(pr)) {
      if (pr >= 1 && pr <= 128) programs[id] = pr - 1; else report.count("Instrument numbers out of range (ignored)");
    }
    if (mis.some((m) => txt(m, "midi-channel") === "10" || kid(m, "midi-unpitched"))) report.count("Percussion parts (played as pitched notes)");
  }

  const score = { title: "", composer: "", tempo: 0, measures: [], staves: [] };
  const firstPartAttrs = []; // per bar: {key, time}
  kids(root, "part").forEach((part, pi) => {
    const measures = kids(part, "measure");
    let nStaves = 1;
    for (const st of part.querySelectorAll("attributes > staves")) nStaves = Math.max(nStaves, +st.textContent || 1);
    const staves = Array.from({ length: nStaves }, (_, k) => ({
      name: names[part.getAttribute("id")] || `Part ${pi + 1}`, clef: null, brace: nStaves === 2 && k === 0,
      ...(programs[part.getAttribute("id")] !== undefined ? { program: programs[part.getAttribute("id")] } : {}),
      bars: [],
    }));
    if (nStaves > 2) report.add(`A part with ${nStaves} staves was split into separate staves without a brace`);
    let divisions = 1, key = 0, time = [4, 4];
    const voiceOf = {}; // staff -> kept voice

    measures.forEach((meas, mi) => {
      staves.forEach((st) => st.bars.push([]));
      const lastEvent = {}; // staff -> last kept event in this bar
      for (const el of meas.children) {
        const tag = el.localName;
        if (tag === "attributes") {
          const d = txt(el, "divisions");
          if (d) divisions = +d || 1;
          const k = kid(el, "key");
          if (k && txt(k, "fifths") !== null) key = Math.max(-7, Math.min(7, parseInt(txt(k, "fifths"), 10) || 0));
          const t = kid(el, "time");
          if (t && ["common", "cut"].includes(t.getAttribute("symbol"))) report.add("Common and cut time symbols are shown as 4/4 and 2/2.");
          if (t && txt(t, "beats")) {
            const beats = txt(t, "beats"), bt = +txt(t, "beat-type");
            if (/^\d+$/.test(beats) && [1, 2, 4, 8, 16, 32].includes(bt)) time = [+beats, bt];
            else report.count("Unusual time signatures replaced");
          }
          for (const c of kids(el, "clef")) {
            const n = +(c.getAttribute("number") || 1);
            const st = staves[n - 1];
            if (!st) continue;
            if (st.clef === null) st.clef = clefFrom(c, report);
            else if (mi > 0) report.count("Clef changes ignored");
          }
        } else if (tag === "barline") {
          if (kid(el, "repeat") || kid(el, "ending")) report.count("Repeat signs and endings (not imported)");
        } else if (tag === "direction" || tag === "sound") {
          for (const dt of tag === "direction" ? kids(el, "direction-type") : []) {
            for (const c of dt.children) {
              const label = DIRECTIONS[c.localName];
              if (label && c.getAttribute("type") !== "stop" && c.getAttribute("type") !== "continue") report.count(label);
            }
          }
          const snd = tag === "sound" ? el : kid(el, "sound");
          if (!score.tempo && snd && snd.getAttribute("tempo")) score.tempo = Math.round(+snd.getAttribute("tempo")) || 0;
          const pm = el.querySelector && el.querySelector("metronome > per-minute");
          if (!score.tempo && pm) score.tempo = Math.round(parseFloat(pm.textContent)) || 0;
        } else if (tag === "note") {
          readNote(el, { staves, voiceOf, lastEvent, divisions, time, report });
        }
      }
      if (pi === 0) firstPartAttrs.push({ key, time: [...time] });
    });
    staves.forEach((st) => { if (!st.clef) st.clef = "treble"; });
    score.staves.push(...staves);
  });
  if (!score.staves.length) throw new Error("This MusicXML file has no parts.");

  firstPartAttrs.forEach((a, i) => {
    const prev = i ? firstPartAttrs[i - 1] : null;
    const m = {};
    if (!prev || prev.key !== a.key) m.key = a.key;
    if (!prev || prev.time[0] !== a.time[0] || prev.time[1] !== a.time[1]) m.time = a.time;
    score.measures.push(m);
  });

  score.title = (root.querySelector("work > work-title")?.textContent || txt(root, "movement-title") ||
    fileName.replace(/\.[^.]+$/, "") || "Untitled").trim();
  const comp = [...root.querySelectorAll("identification > creator")].find((c) => c.getAttribute("type") === "composer");
  score.composer = comp ? comp.textContent.trim() : "";
  if (!score.tempo) score.tempo = 100;
  score.tempo = Math.max(20, Math.min(400, score.tempo));
  padBars(score);
  report.notes = noteCount(score);
  return { score, report: report.done() };
}

const DIRECTIONS = {
  dynamics: "Dynamics (not imported)", wedge: "Hairpins (not imported)", words: "Text directions (not imported)",
  rehearsal: "Rehearsal marks (not imported)", segno: "Segno and coda signs (not imported)", coda: "Segno and coda signs (not imported)",
  pedal: "Pedal marks (not imported)", "octave-shift": "Octave lines (not imported)",
};
const MARKS = {
  fermata: "Fermatas (not imported)", slur: "Slurs (not imported)", articulations: "Articulations (not imported)",
  ornaments: "Ornaments (not imported)", technical: "Technical markings (not imported)", arpeggiate: "Arpeggios (not imported)",
  glissando: "Glissandos (not imported)", slide: "Glissandos (not imported)",
};

function readNote(el, { staves, voiceOf, lastEvent, divisions, time, report }) {
  const isRest = !!kid(el, "rest");
  if (kid(el, "grace")) { if (!isRest) report.count("Grace notes skipped"); return; }
  const staffNo = +(txt(el, "staff") || 1);
  const st = staves[staffNo - 1];
  if (!st) return;
  const voice = txt(el, "voice") || "1";
  if (voiceOf[staffNo] === undefined) voiceOf[staffNo] = voice;
  if (voice !== voiceOf[staffNo]) { if (!isRest) report.count("Notes in other voices skipped"); return; }
  // markings on kept notes that Coda doesn't hold yet: counted, not dropped silently
  for (const n of kids(el, "notations")) {
    for (const c of n.children) {
      if (c.localName === "articulations" || c.localName === "ornaments" || c.localName === "technical") report.count(MARKS[c.localName], c.children.length);
      else if (MARKS[c.localName] && c.getAttribute("type") !== "stop") report.count(MARKS[c.localName]);
    }
  }
  if (!isRest && kids(el, "lyric").length) report.count("Notes with lyrics (not imported)");
  const bar = st.bars[st.bars.length - 1];
  const tieStart = kids(el, "tie").some((t) => t.getAttribute("type") === "start");

  let pitch = null;
  const p = kid(el, "pitch") || kid(el, "unpitched");
  if (p && !isRest) {
    const step = "CDEFGAB".indexOf(txt(p, "step") || txt(p, "display-step"));
    const oct = parseInt(txt(p, "octave") ?? txt(p, "display-octave"), 10);
    let alter = parseFloat(txt(p, "alter") || "0");
    if (!Number.isInteger(alter)) { report.count("Microtonal alterations rounded"); alter = Math.round(alter); }
    if (step < 0 || !Number.isFinite(oct)) return;
    pitch = { step, oct, alter: Math.max(-2, Math.min(2, alter)) };
    if (p.localName === "unpitched") report.count("Percussion notes shown at their staff position");
  }

  if (kid(el, "chord") && lastEvent[staffNo]) {
    const ev = lastEvent[staffNo];
    if (pitch && !ev.pitches.some((q) => q.step === pitch.step && q.oct === pitch.oct)) {
      ev.pitches.push(pitch);
      ev.pitches.sort((a, b) => a.oct * 7 + a.step - (b.oct * 7 + b.step));
    }
    if (tieStart) ev.tie = true;
    return;
  }

  const durEl = txt(el, "duration");
  const ticksRaw = durEl !== null ? (+durEl * PPQ) / divisions : null;
  const type = txt(el, "type");
  if (isRest && (kid(el, "rest").getAttribute("measure") === "yes" ||
      (!type && ticksRaw !== null && Math.round(ticksRaw) >= barCapacity(time)))) return;

  let dur, dots = kids(el, "dot").length;
  if (type && DUR_OF[type]) dur = DUR_OF[type];
  else if (type && LONGER.has(type)) { dur = "w"; report.count("Notes longer than a whole note shortened"); }
  else if (type && SHORTER.has(type)) { dur = "32"; report.count("Notes shorter than a 32nd lengthened"); }
  else if (ticksRaw !== null) {
    const exact = durFromTicks(ticksRaw);
    const d = exact || nearestDur(ticksRaw);
    if (!exact) report.count("Note lengths approximated");
    dur = d.dur; dots = d.dots;
  } else return;
  dots = Math.min(2, dots);

  const ev = { dur, dots, tie: tieStart && !!pitch, pitches: pitch ? [pitch] : [] };
  const tm = kid(el, "time-modification");
  if (tm) {
    const tup = [+txt(tm, "actual-notes"), +txt(tm, "normal-notes")];
    if (tup[0] > 0 && tup[1] > 0 && !(tup[0] === tup[1])) {
      if (tupletOk(dur, dots, tup)) ev.tup = tup;
      else report.count("Notes in unsupported tuplets (kept written lengths)");
    }
  }
  bar.push(ev);
  lastEvent[staffNo] = ev;
}

// ---------- MXL ----------

export function importMXL(bytes, fileName) {
  const files = unzip(bytes, (name) => name === "META-INF/container.xml" || /\.(xml|musicxml)$/i.test(name));
  let path = null;
  if (files["META-INF/container.xml"]) {
    const doc = parseXml(decodeText(files["META-INF/container.xml"]));
    path = doc.querySelector("rootfile")?.getAttribute("full-path") || null;
  }
  if (!path || !files[path]) path = Object.keys(files).find((n) => !n.startsWith("META-INF/") && /\.(xml|musicxml)$/i.test(n));
  if (!path) throw new Error("This .mxl file doesn't contain a MusicXML score.");
  return importMusicXML(decodeText(files[path]), fileName, "MusicXML (compressed)");
}
