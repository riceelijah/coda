// MusicXML import/export and MXL unzip. See docs/DESIGN.md §9.2–9.3.
import {
  attrsAt, barCapacity, barTicks, eventTicks, splitTicks, durFromTicks, nearestDur, tupletOk,
  tupletRuns, padBars, noteCount, PPQ, BASE, partGroups, layerBars, allLayers, MAX_LAYERS, setMark, TIME_SYMS, measuresFrom, keyAt, wrapKey, fifthsOf, clearBrokenSpans, syllabics, setLyric, MAX_LYRIC, finishClefs, MAX_GRACE,
} from "../model.js";
import { decodeText, parseXml, Report, unzip } from "./util.js";

const TYPE_OF = { w: "whole", h: "half", q: "quarter", 8: "eighth", 16: "16th", 32: "32nd" };
const DUR_OF = { whole: "w", half: "h", quarter: "q", eighth: "8", "16th": "16", "32nd": "32" };
const LONGER = new Set(["breve", "long", "maxima"]);
const SHORTER = new Set(["64th", "128th", "256th", "512th", "1024th"]);
const CLEF_OUT = { treble: ["G", 2], bass: ["F", 4], alto: ["C", 3], tenor: ["C", 4] };

// Marks (DESIGN §16): MusicXML <articulations> children <-> Coda mark names.
const ARTIC_OUT = { staccato: "<staccato/>", accent: "<accent/>", tenuto: "<tenuto/>", marcato: '<strong-accent type="up"/>' };
const ARTIC_IN = { staccato: "staccato", accent: "accent", tenuto: "tenuto", "strong-accent": "marcato" };

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------- export ----------

function noteXml(ev, p, { chord, staffNo, voice, tieStop, tupStart, tupStop, syl }) {
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
  if (!chord && ev.slurEnd) nots.push('<slur type="stop" number="1"/>'); // DESIGN §23
  if (!chord && ev.slur) nots.push('<slur type="start" number="1"/>');
  if (!chord && ev.marks) {
    if (ev.marks.includes("fermata")) nots.push('<fermata type="upright"/>');
    const arts = p ? ev.marks.filter((m) => ARTIC_OUT[m]) : [];
    if (arts.length) nots.push(`<articulations>${arts.map((m) => ARTIC_OUT[m]).join("")}</articulations>`);
  }
  if (nots.length) x.push(`<notations>${nots.join("")}</notations>`);
  if (!chord && syl) x.push(`<lyric number="1"><syllabic>${syl}</syllabic><text>${esc(ev.lyric)}</text></lyric>`);
  x.push("</note>");
  return x.join("");
}

// Grace notes (DESIGN §26): one is a slashed eighth, more are sixteenths, before their note.
function graceXml(grace, staffNo, voice) {
  const one = grace.length === 1;
  return grace.map((p) => `<note><grace${one ? ' slash="yes"' : ""}/><pitch><step>${"CDEFGAB"[p.step]}</step>${p.alter ? `<alter>${p.alter}</alter>` : ""}<octave>${p.oct}</octave></pitch>` +
    `<voice>${voice}</voice><type>${one ? "eighth" : "16th"}</type>${staffNo ? `<staff>${staffNo}</staff>` : ""}</note>`).join("");
}

function restXml(ticks, staffNo, voice, whole) {
  if (whole) {
    return `<note><rest measure="yes"/><duration>${ticks}</duration><voice>${voice}</voice>${staffNo ? `<staff>${staffNo}</staff>` : ""}</note>`;
  }
  return splitTicks(ticks).map((d) => noteXml({ dur: d.dur, dots: d.dots, pitches: [] }, null, { staffNo, voice })).join("");
}

// A bar ending part-way through a tuplet group gets tuplet rests to finish the group, so the
// padding after it is in whole ticks (DESIGN §11.6).
export function completeTuplet(bar, cap) {
  const runs = tupletRuns(bar), run = runs[runs.length - 1];
  if (!run || run.idx[run.idx.length - 1] !== bar.length - 1 || run.ticks % run.unit === 0) return bar;
  const first = bar[run.idx[0]];
  const one = (BASE[first.dur] * run.tup[1]) / run.tup[0], missing = run.unit - (run.ticks % run.unit);
  if (missing % one || barTicks(bar) + missing > cap) return bar;
  const rests = Array.from({ length: missing / one }, () => ({ dur: first.dur, dots: 0, pitches: [], tie: false, tup: [...run.tup] }));
  return [...bar, ...rests];
}

// Notes for one staff in one bar. Returns {xml, ticks written}.
function barXml(score, s, b, staffNo, voice, v, syl) {
  const cap = barCapacity(attrsAt(score, b).time);
  const bars = layerBars(score.staves[s], v);
  const bar = completeTuplet(bars[b], cap);
  if (!bar.length) return { xml: restXml(cap, staffNo, voice, true), ticks: cap };
  // last event of the previous bar, for tie stops on this bar's first event
  const pbar = b > 0 ? bars[b - 1] : [];
  const prev = pbar.length ? pbar[pbar.length - 1] : null;
  const runs = tupletRuns(bar);
  const starts = new Set(runs.map((r) => r.idx[0])), stops = new Set(runs.map((r) => r.idx[r.idx.length - 1]));
  const out = [];
  bar.forEach((ev, i) => {
    const before = i > 0 ? bar[i - 1] : prev;
    const tied = (p) => !!(before && before.tie && before.pitches.some((q) => q.step === p.step && q.oct === p.oct));
    const flags = { staffNo, voice, tupStart: starts.has(i), tupStop: stops.has(i), syl: syl.get(ev) };
    const dir = (body) => `<direction placement="below"><direction-type>${body}</direction-type><voice>${voice}</voice>${staffNo ? `<staff>${staffNo}</staff>` : ""}</direction>`;
    if (ev.dyn) out.push(dir(`<dynamics><${ev.dyn}/></dynamics>`));
    if (ev.hp) out.push(dir(`<wedge type="${ev.hp === "<" ? "crescendo" : "diminuendo"}"/>`));
    if (ev.grace) out.push(graceXml(ev.grace, staffNo, voice));
    if (!ev.pitches.length) out.push(noteXml(ev, null, flags));
    else ev.pitches.forEach((p, k) => out.push(noteXml(ev, p, { ...flags, chord: k > 0, tieStop: tied(p) })));
    if (ev.hpEnd) out.push(dir('<wedge type="stop"/>')); // after the note it ends on
  });
  let ticks = barTicks(bar);
  if (ticks < cap) { out.push(restXml(cap - ticks, staffNo, voice, false)); ticks = cap; }
  return { xml: out.join(""), ticks };
}

export function exportMusicXML(score) {
  const syl = syllabics(score);
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
      // the written key; <transpose> says how it sounds (DESIGN §21)
      if (b === 0 || m.key !== undefined) attrs.push(`<key><fifths>${keyAt(score, g[0], b)}</fifths></key>`);
      if (b === 0 || m.time) attrs.push(`<time${a.sym ? ` symbol="${a.sym}"` : ""}><beats>${a.time[0]}</beats><beat-type>${a.time[1]}</beat-type></time>`);
      if (b === 0 && g.length > 1) attrs.push(`<staves>${g.length}</staves>`);
      g.forEach((s, k) => {
        const clef = b === 0 ? score.staves[s].clef : score.staves[s].clefs?.[b];
        if (!clef) return;
        const [sign, line] = CLEF_OUT[clef];
        attrs.push(`<clef${g.length > 1 ? ` number="${k + 1}"` : ""}><sign>${sign}</sign><line>${line}</line></clef>`);
      });
      if (b === 0) {
        const t = score.staves[g[0]].transpose;
        if (t) {
          const oc = Math.trunc(t[1] / 7);
          attrs.push(`<transpose><diatonic>${t[1] - 7 * oc}</diatonic><chromatic>${t[0] - 12 * oc}</chromatic>${oc ? `<octave-change>${oc}</octave-change>` : ""}</transpose>`);
        }
      }
      if (attrs.length) x.push(`<attributes>${attrs.join("")}</attributes>`);
      if (b === 0 && gi === 0) {
        x.push(`<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${score.tempo}</per-minute></metronome></direction-type><sound tempo="${score.tempo}"/></direction>`);
      }
      // every layer bar with notes, as voice staff×4 + layer + 1, separated by <backup> (DESIGN §15)
      const chunks = [];
      g.forEach((s, k) => allLayers(score.staves[s]).forEach((bars, v) => {
        if (v === 0 || bars[b].length) chunks.push(barXml(score, s, b, g.length > 1 ? k + 1 : 0, k * MAX_LAYERS + v + 1, v, syl));
      }));
      chunks.forEach((r, i) => {
        x.push(r.xml);
        if (i < chunks.length - 1) x.push(`<backup><duration>${r.ticks}</duration></backup>`);
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
    let divisions = 1, key = 0, time = [4, 4], sym, tr = null;
    const pend = {}; // staff -> dynamic waiting for its note
    const pendHp = {}, lastAny = {}; // staff -> hairpin waiting for its note; last event read
    // staff -> MusicXML voice ids in layer order: numeric order, so voice 1 is always layer 1
    const voiceOf = {};
    for (const n of part.querySelectorAll("note")) {
      const sn = +(txt(n, "staff") || 1), v = txt(n, "voice") || "1";
      if (!(voiceOf[sn] ||= []).includes(v)) voiceOf[sn].push(v);
    }
    for (const k in voiceOf) {
      // Voices numbered staff×4 + layer (Coda, MuseScore): the layer comes from the number, so an
      // empty layer 2 under a used layer 3 survives. Otherwise layers follow numeric voice order.
      const lo = (k - 1) * MAX_LAYERS;
      if (voiceOf[k].every((v) => /^\d+$/.test(v) && +v > lo && +v <= lo + MAX_LAYERS)) {
        const slots = [];
        for (const v of voiceOf[k]) slots[+v - lo - 1] = v;
        voiceOf[k] = slots;
      } else voiceOf[k].sort((a, b) => (parseFloat(a) || 0) - (parseFloat(b) || 0) || a.localeCompare(b));
    }

    measures.forEach((meas, mi) => {
      staves.forEach((st) => allLayers(st).forEach((bars) => bars.push([])));
      const lastEvent = {}; // staff:layer -> last kept event in this bar
      const pendGrace = {}; // staff:layer -> grace notes waiting for their note (DESIGN §26)
      const pos = { t: 0 }; // time cursor in ticks: notes advance it, <backup> and <forward> move it
      for (const el of meas.children) {
        const tag = el.localName;
        if (tag === "attributes") {
          const d = txt(el, "divisions");
          if (d) divisions = +d || 1;
          const k = kid(el, "key");
          if (k && txt(k, "fifths") !== null) key = Math.max(-7, Math.min(7, parseInt(txt(k, "fifths"), 10) || 0));
          const t = kid(el, "time");
          if (t && txt(t, "beats")) {
            const beats = txt(t, "beats"), bt = +txt(t, "beat-type");
            if (/^\d+$/.test(beats) && [1, 2, 4, 8, 16, 32].includes(bt)) time = [+beats, bt];
            else report.count("Unusual time signatures replaced");
            const s = t.getAttribute("symbol");
            sym = TIME_SYMS[s] && TIME_SYMS[s][0] === time[0] && TIME_SYMS[s][1] === time[1] ? s : undefined;
            if (TIME_SYMS[s] && !sym) report.count("Common/cut time symbols on other meters shown as numbers");
          }
          const tx = kid(el, "transpose"); // written → sounding (DESIGN §21)
          if (tx) {
            const oc = parseInt(txt(tx, "octave-change"), 10) || 0;
            const c = parseInt(txt(tx, "chromatic"), 10) || 0, dia = parseInt(txt(tx, "diatonic"), 10);
            // <diatonic> is optional: take the nearest step for the semitones
            const t = [c + 12 * oc, (Number.isInteger(dia) ? dia : Math.round((c * 7) / 12)) + 7 * oc];
            if (kids(el, "transpose").length > 1) report.count("Different transpositions on staves of one part (first one used)");
            if (tr === null && t.every(Number.isInteger) && Math.abs(t[0]) <= 36 && Math.abs(t[1]) <= 21) {
              tr = t[0] || t[1] ? t : [0, 0];
              if (t[0] || t[1]) staves.forEach((st) => { st.transpose = [...t]; });
            } else if (tr === null) { tr = [0, 0]; report.count("Transpositions out of range (ignored)"); }
            else if (tr[0] !== t[0] || tr[1] !== t[1]) report.count("Transposition changes mid-part (first one kept)");
          }
          // clef changes (DESIGN §25) go at a barline: one at the end of a bar starts the next bar
          for (const c of kids(el, "clef")) {
            const n = +(c.getAttribute("number") || 1);
            const st = staves[n - 1];
            if (!st) continue;
            const clef = clefFrom(c, report);
            if (st.clef === null) { st.clef = clef; continue; }
            let at = mi;
            if (pos.t >= barCapacity(time)) at = mi + 1;
            else if (pos.t > 0) report.count("Clef changes inside a bar moved to its start");
            if (at === 0) st.clef = clef; else (st.clefs ||= {})[at] = clef;
          }
        } else if (tag === "barline") {
          if (kid(el, "repeat") || kid(el, "ending")) report.count("Repeat signs and endings (not imported)");
        } else if (tag === "direction" || tag === "sound") {
          for (const dt of tag === "direction" ? kids(el, "direction-type") : []) {
            for (const c of dt.children) {
              if (c.localName === "wedge") { // hairpins (DESIGN §23): start on the next note, stop on the last one
                const t = c.getAttribute("type"), sn = +(txt(el, "staff") || 1);
                if (t === "crescendo" || t === "diminuendo") pendHp[sn] = { hp: t === "crescendo" ? "<" : ">", at: pos.t, mi };
                else if (t === "stop") {
                  const last = lastAny[sn];
                  if (pendHp[sn] && (!last || pendHp[sn].mi === mi && pos.t <= pendHp[sn].at)) { report.count("Hairpins with no notes (not imported)"); pendHp[sn] = null; }
                  else if (last) last.hpEnd = true;
                }
                continue;
              }
              if (c.localName === "dynamics") { // goes on the staff's next note or rest (DESIGN §22)
                const d = DYN_IN[c.firstElementChild?.localName];
                if (d) pend[+(txt(el, "staff") || 1)] = { dyn: d, at: pos.t, mi };
                else report.count("Unusual dynamics (not imported)");
                continue;
              }
              const label = DIRECTIONS[c.localName];
              if (label && c.getAttribute("type") !== "stop" && c.getAttribute("type") !== "continue") report.count(label);
            }
          }
          const snd = tag === "sound" ? el : kid(el, "sound");
          if (!score.tempo && snd && snd.getAttribute("tempo")) score.tempo = Math.round(+snd.getAttribute("tempo")) || 0;
          const pm = el.querySelector && el.querySelector("metronome > per-minute");
          if (!score.tempo && pm) score.tempo = Math.round(parseFloat(pm.textContent)) || 0;
        } else if (tag === "backup" || tag === "forward") {
          const d = Math.round((+txt(el, "duration") * PPQ) / divisions) || 0;
          pos.t = Math.max(0, pos.t + (tag === "backup" ? -d : d));
        } else if (tag === "note") {
          const start = pos.t;
          readNote(el, { staves, voiceOf, lastEvent, divisions, time, report, start, pend, mi, pendHp, lastAny, pendGrace });
          if (!kid(el, "chord") && !kid(el, "grace")) pos.t += Math.round((+txt(el, "duration") * PPQ) / divisions) || 0;
        }
      }
      for (const k in pendGrace) report.count("Grace notes with no note after them in the bar (not imported)", pendGrace[k].notes.length);
      // the file's key is written; the score keeps concert pitch
      if (pi === 0) firstPartAttrs.push({ key: tr ? wrapKey(key + fifthsOf(tr[0], tr[1])) : key, time: [...time], sym });
    });
    for (const k in pend) if (pend[k]) report.count("Dynamics after the last note (not imported)");
    for (const k in pendHp) if (pendHp[k]) report.count("Hairpins with no notes (not imported)");
    staves.forEach((st) => { if (!st.clef) st.clef = "treble"; });
    score.staves.push(...staves);
  });
  if (!score.staves.length) throw new Error("This MusicXML file has no parts.");

  score.measures.push(...measuresFrom(firstPartAttrs));
  const broken = clearBrokenSpans(score);
  if (broken) report.count("Unfinished or overlapping slurs and hairpins (not imported)", broken);

  score.title = (root.querySelector("work > work-title")?.textContent || txt(root, "movement-title") ||
    fileName.replace(/\.[^.]+$/, "") || "Untitled").trim();
  const comp = [...root.querySelectorAll("identification > creator")].find((c) => c.getAttribute("type") === "composer");
  score.composer = comp ? comp.textContent.trim() : "";
  if (!score.tempo) score.tempo = 100;
  score.tempo = Math.max(20, Math.min(400, score.tempo));
  padBars(score);
  const lostClefs = finishClefs(score);
  if (lostClefs) report.count("Clef changes after the last bar (not imported)", lostClefs);
  report.notes = noteCount(score);
  return { score, report: report.done() };
}

// MusicXML dynamics -> Coda's set; rarer ones go to the nearest (DESIGN §22)
export const DYN_IN = { ppp: "ppp", pp: "pp", p: "p", mp: "mp", mf: "mf", f: "f", ff: "ff", fff: "fff", fp: "fp", sf: "sf", sfz: "sfz", fz: "fz",
  pppp: "ppp", ppppp: "ppp", pppppp: "ppp", ffff: "fff", fffff: "fff", ffffff: "fff", sfp: "fp", sfpp: "fp", sffz: "sfz", rfz: "sfz", rf: "sf", sfzp: "fp" };
const DIRECTIONS = {
  words: "Text directions (not imported)",
  rehearsal: "Rehearsal marks (not imported)", segno: "Segno and coda signs (not imported)", coda: "Segno and coda signs (not imported)",
  pedal: "Pedal marks (not imported)", "octave-shift": "Octave lines (not imported)",
};
const MARKS = {
  articulations: "Other articulations (not imported)",
  ornaments: "Ornaments (not imported)", technical: "Technical markings (not imported)", arpeggiate: "Arpeggios (not imported)",
  glissando: "Glissandos (not imported)", slide: "Glissandos (not imported)",
};

function readNote(el, { staves, voiceOf, lastEvent, divisions, time, report, start, pend, mi, pendHp, lastAny, pendGrace }) {
  const isRest = !!kid(el, "rest");
  const grace = kid(el, "grace");
  if (grace && isRest) { report.count("Grace rests (not imported)"); return; }
  const staffNo = +(txt(el, "staff") || 1);
  const st = staves[staffNo - 1];
  if (!st) return;
  const layer = layerOf(voiceOf, staffNo, txt(el, "voice") || "1");
  if (layer < 0) { if (!isRest) report.count(`Notes in voices beyond ${MAX_LAYERS} per staff skipped`); return; }
  const lk = staffNo + ":" + layer;
  // fermatas and the articulations Coda holds are kept; other markings are counted, not dropped silently
  const marks = [], slur = {};
  for (const n of kids(el, "notations")) {
    for (const c of n.children) {
      if (c.localName === "fermata") marks.push("fermata");
      else if (c.localName === "articulations") {
        for (const a of c.children) {
          if (ARTIC_IN[a.localName] && !isRest) marks.push(ARTIC_IN[a.localName]);
          else report.count(MARKS.articulations);
        }
      } else if (c.localName === "ornaments" || c.localName === "technical") report.count(MARKS[c.localName], c.children.length);
      else if (c.localName === "slur") {
        const t = c.getAttribute("type");
        if ((c.getAttribute("number") || "1") !== "1") { if (t === "start") report.count("Slurs inside other slurs (not imported)"); }
        else if (t === "start") slur.start = true;
        else if (t === "stop") slur.stop = true;
      }
      else if (MARKS[c.localName] && c.getAttribute("type") !== "stop") report.count(MARKS[c.localName]);
    }
  }
  const addMarks = (ev) => { for (const m of marks) setMark(ev, m, true); };
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

  if (grace) { // held until the note it comes before; before the chord branch so it can't join the last note
    if (!pitch) return;
    if (kid(el, "chord")) { report.count("Grace-note chords reduced to their first note"); return; }
    if (marks.length || slur.start || slur.stop || tieStart || kids(el, "lyric").length) report.count("Marks, slurs, ties and lyrics on grace notes (not imported)");
    const g = (pendGrace[lk] ||= { notes: [], types: [] });
    g.notes.push(pitch);
    g.types.push((grace.getAttribute("slash") === "yes" ? "/" : "") + (txt(el, "type") || ""));
    return;
  }

  if (kid(el, "chord") && lastEvent[lk]) {
    const ev = lastEvent[lk];
    if (pitch && !ev.pitches.some((q) => q.step === pitch.step && q.oct === pitch.oct)) {
      ev.pitches.push(pitch);
      ev.pitches.sort((a, b) => a.oct * 7 + a.step - (b.oct * 7 + b.step));
    }
    if (tieStart) ev.tie = true;
    addMarks(ev);
    if (slur.start) ev.slur = true;
    if (slur.stop) ev.slurEnd = true;
    if (!ev.lyric) lyricIn(el, ev, report);
    return;
  }

  const durEl = txt(el, "duration");
  const ticksRaw = durEl !== null ? (+durEl * PPQ) / divisions : null;
  const type = txt(el, "type");
  if (isRest && (kid(el, "rest").getAttribute("measure") === "yes" ||
      (!type && ticksRaw !== null && Math.round(ticksRaw) >= barCapacity(time)))) {
    if (marks.length) report.count("Fermatas on whole-bar rests (not imported)");
    return;
  }

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
  const bar = barOf(st, layer);
  // a voice that starts later than where its layer has got to: fill the gap with rests
  const gap = Math.floor((start - barTicks(bar)) / 60) * 60;
  if (gap > 0) {
    for (const d of splitTicks(gap)) bar.push({ dur: d.dur, dots: d.dots, tie: false, pitches: [] });
    report.count("Gaps in a voice filled with rests");
  }
  addMarks(ev);
  const pd = pend[staffNo];
  if (pd && (pd.mi < mi || start >= pd.at)) { ev.dyn = pd.dyn; pend[staffNo] = null; }
  const ph = pendHp[staffNo];
  if (ph && (ph.mi < mi || start >= ph.at)) { ev.hp = ph.hp; pendHp[staffNo] = null; }
  if (slur.start) ev.slur = true;
  if (slur.stop) ev.slurEnd = true;
  lyricIn(el, ev, report);
  const g = pendGrace[lk];
  if (g) {
    delete pendGrace[lk];
    if (!pitch) report.count("Grace notes before rests (not imported)", g.notes.length);
    else {
      if (g.notes.length > MAX_GRACE) report.count(`Grace notes beyond ${MAX_GRACE} before a note (not imported)`, g.notes.length - MAX_GRACE);
      ev.grace = g.notes.slice(0, MAX_GRACE);
      const want = ev.grace.length === 1 ? ["/eighth"] : ev.grace.map(() => "16th");
      if (g.types.some((t, k) => t !== want[k])) report.count("Grace notes redrawn: one as a slashed eighth, more as sixteenths");
    }
  }
  lastAny[staffNo] = ev;
  bar.push(ev);
  lastEvent[lk] = ev;
}

// The first verse of a note's lyrics onto `ev` (DESIGN §24); other verses and extender lines are counted.
function lyricIn(el, ev, report) {
  const ls = kids(el, "lyric").filter((l) => kids(l, "text").some((t) => t.textContent.trim()));
  if (!ls.length) return;
  if (!ev.pitches.length) { report.count("Lyrics on rests (not imported)"); return; }
  const l = ls.find((x) => (x.getAttribute("number") || "1") === "1") || ls[0];
  if (ls.length > 1) report.count("Lyrics beyond the first verse (not imported)", ls.length - 1);
  if (kid(l, "extend") && kid(l, "extend").getAttribute("type") !== "stop") report.count("Lyric extender lines (not imported)");
  const text = kids(l, "text").map((t) => t.textContent.trim()).join("‿"); // elided syllables share a note
  if (text.length > MAX_LYRIC) report.count("Long lyrics shortened");
  setLyric(ev, text, ["begin", "middle"].includes(txt(l, "syllabic")));
}

// MusicXML voice -> layer index for a staff (numeric voice order); -1 past the fourth (DESIGN §15).
function layerOf(voiceOf, staffNo, voice) {
  const i = (voiceOf[staffNo] || []).indexOf(voice);
  return i < MAX_LAYERS ? i : -1;
}

// The current (last) bar of a layer, creating the layer with empty bars so far when it's new.
function barOf(st, layer) {
  if (layer > 0) {
    st.layers ||= [];
    while (st.layers.length < layer) st.layers.push(st.bars.map(() => []));
  }
  const bars = layerBars(st, layer);
  return bars[bars.length - 1];
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

// Compressed MusicXML (DESIGN §19): the same export in a zip with the standard container file.
export function exportMXL(score) {
  const enc = (s) => new TextEncoder().encode(s);
  return fflate.zipSync({
    mimetype: [enc("application/vnd.recordare.musicxml"), { level: 0 }],
    "META-INF/container.xml": enc('<?xml version="1.0" encoding="UTF-8"?><container><rootfiles>' +
      '<rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>'),
    "score.musicxml": enc(exportMusicXML(score)),
  });
}
