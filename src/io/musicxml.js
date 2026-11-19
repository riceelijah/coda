// MusicXML import/export and MXL unzip. See docs/DESIGN.md §9.2–9.3.
import {
  attrsAt, barCapacity, barLen, setBarLen, barTicks, eventTicks, splitTicks, durFromTicks, nearestDur, tupletOk,
  tupletRuns, padBars, noteCount, PPQ, BASE, partGroups, layerBars, allLayers, MAX_LAYERS, setMark, TIME_SYMS, measuresFrom, keyAt, wrapKey, fifthsOf, clearBrokenSpans, syllabics, setLyric, MAX_LYRIC, MAX_VERSES, finishClefs, MAX_GRACE, isPerc, toDrumStaff, drumReport, clearBrokenSlides,
} from "../model.js";
import { sameVolta, voltaLabel, parseVolta, JUMPS, MAX_REPEAT, setTempo, clampBpm, setText, setRehearsal, cleanText, MAX_TEXT, MAX_REHEARSAL } from "../model.js";
import { DRUMS, drumName, drumPitch, isDrum } from "../drums.js";
import { decodeText, parseXml, Report, unzip, countUnread } from "./util.js";

const TYPE_OF = { w: "whole", h: "half", q: "quarter", 8: "eighth", 16: "16th", 32: "32nd" };
const DUR_OF = { whole: "w", half: "h", quarter: "q", eighth: "8", "16th": "16", "32nd": "32" };
const LONGER = new Set(["breve", "long", "maxima"]);
const SHORTER = new Set(["64th", "128th", "256th", "512th", "1024th"]);
const CLEF_OUT = { treble: ["G", 2], bass: ["F", 4], alto: ["C", 3], tenor: ["C", 4], percussion: ["percussion", 0] };

// Marks (DESIGN §16): MusicXML <articulations> children <-> Coda mark names.
const ARTIC_OUT = { staccato: "<staccato/>", accent: "<accent/>", tenuto: "<tenuto/>", marcato: '<strong-accent type="up"/>', scoop: "<scoop/>", fall: "<falloff/>", doit: "<doit/>" };
const ARTIC_IN = { staccato: "staccato", accent: "accent", tenuto: "tenuto", "strong-accent": "marcato", scoop: "scoop", falloff: "fall", doit: "doit" };

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------- export ----------

// Slur and wedge numbers: one per voice, so slurs in two hands or layers that overlap stay apart.
// a pitch, or for a drum (DESIGN §27) its staff position as <unpitched>
const pitchXml = (p) => (p.drum
  ? `<unpitched><display-step>${"CDEFGAB"[p.step]}</display-step><display-octave>${p.oct}</display-octave></unpitched>`
  : `<pitch><step>${"CDEFGAB"[p.step]}</step>${p.alter ? `<alter>${p.alter}</alter>` : ""}<octave>${p.oct}</octave></pitch>`);
const HEAD_OUT = { x: "x", cx: "circle-x", d: "diamond", t: "triangle" };
const drumInst = (pid, n) => `<instrument id="${pid}-I${n}"/>`;
const headXml = (p) => (p.drum && HEAD_OUT[DRUMS.get(p.drum)?.head] ? `<notehead>${HEAD_OUT[DRUMS.get(p.drum).head]}</notehead>` : "");

function noteXml(ev, p, { chord, staffNo, voice, tieStop, tupStart, tupStop, syl, pid, slideStop, k = 0 }) {
  const x = ["<note>"];
  if (chord) x.push("<chord/>");
  if (p) {
    x.push(pitchXml(p));
  } else x.push("<rest/>");
  x.push(`<duration>${eventTicks(ev)}</duration>`);
  const tieStart = p && ev.tie;
  if (tieStop) x.push('<tie type="stop"/>');
  if (tieStart) x.push('<tie type="start"/>');
  if (p?.drum) x.push(drumInst(pid, p.drum));
  x.push(`<voice>${voice}</voice>`, `<type>${TYPE_OF[ev.dur]}</type>`);
  for (let i = 0; i < (ev.dots || 0); i++) x.push("<dot/>");
  if (ev.tup) x.push(`<time-modification><actual-notes>${ev.tup[0]}</actual-notes><normal-notes>${ev.tup[1]}</normal-notes></time-modification>`);
  if (p) x.push(headXml(p));
  if (staffNo) x.push(`<staff>${staffNo}</staff>`);
  const nots = [];
  if (tieStop) nots.push('<tied type="stop"/>');
  if (tieStart) nots.push('<tied type="start"/>');
  if (slideStop) nots.push(`<slide type="stop" line-type="solid" number="${k + 1}"/>`); // DESIGN §31, numbered per chord note
  if (p && ev.gliss) nots.push(`<slide type="start" line-type="solid" number="${k + 1}"/>`);
  if (!chord && tupStart) nots.push('<tuplet type="start" bracket="yes"/>');
  if (!chord && tupStop) nots.push('<tuplet type="stop"/>');
  if (!chord && ev.slurEnd) nots.push(`<slur type="stop" number="${voice}"/>`); // DESIGN §23
  if (!chord && ev.slur) nots.push(`<slur type="start" number="${voice}"/>`);
  if (!chord && ev.marks) {
    if (ev.marks.includes("fermata")) nots.push('<fermata type="upright"/>');
    const arts = p ? ev.marks.filter((m) => ARTIC_OUT[m]) : [];
    if (arts.length) nots.push(`<articulations>${arts.map((m) => ARTIC_OUT[m]).join("")}</articulations>`);
  }
  if (nots.length) x.push(`<notations>${nots.join("")}</notations>`);
  if (!chord && syl) syl.forEach((s, v) => s && x.push(`<lyric number="${v + 1}"><syllabic>${s}</syllabic><text>${esc(ev.lyrics[v].text)}</text></lyric>`));
  x.push("</note>");
  return x.join("");
}

// Grace notes (DESIGN §26): one is a slashed eighth, more are sixteenths, before their note.
function graceXml(grace, staffNo, voice, pid) {
  const one = grace.length === 1;
  return grace.map((p) => `<note><grace${one ? ' slash="yes"' : ""}/>${pitchXml(p)}${p.drum ? drumInst(pid, p.drum) : ""}` +
    `<voice>${voice}</voice><type>${one ? "eighth" : "16th"}</type>${headXml(p)}${staffNo ? `<staff>${staffNo}</staff>` : ""}</note>`).join("");
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
function barXml(score, s, b, staffNo, voice, v, syl, pid) {
  const cap = barLen(score, b);
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
    const tied = (p) => !!(before && before.tie && before.pitches.some((q) => q.step === p.step && q.oct === p.oct && q.drum === p.drum));
    const flags = { staffNo, voice, tupStart: starts.has(i), tupStop: stops.has(i), syl: syl.get(ev), pid };
    const dir = (body) => `<direction placement="below"><direction-type>${body}</direction-type><voice>${voice}</voice>${staffNo ? `<staff>${staffNo}</staff>` : ""}</direction>`;
    if (ev.dyn) out.push(dir(`<dynamics><${ev.dyn}/></dynamics>`));
    if (ev.text) out.push(dir(`<words>${esc(ev.text)}</words>`).replace('placement="below"', 'placement="above"')); // DESIGN §30
    if (ev.hp) out.push(dir(`<wedge type="${ev.hp === "<" ? "crescendo" : "diminuendo"}" number="${voice}"/>`));
    if (ev.grace) out.push(graceXml(ev.grace, staffNo, voice, pid));
    if (!ev.pitches.length) out.push(noteXml(ev, null, flags));
    else ev.pitches.forEach((p, k) => out.push(noteXml(ev, p, { ...flags, chord: k > 0, tieStop: tied(p), slideStop: !!before?.gliss, k })));
    if (ev.hpEnd) out.push(dir(`<wedge type="stop" number="${voice}"/>`)); // after the note it ends on
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
    if (isPerc(score.staves[g[0]])) { // every drum the part uses, on channel 10 (DESIGN §27)
      const used = [...new Set(allLayers(score.staves[g[0]]).flat(2).flatMap((e) => [...e.pitches, ...(e.grace || [])]).map((p) => p.drum))].sort((a, b) => a - b);
      x.push(`<score-part id="${id}"><part-name>${esc(score.staves[g[0]].name || "")}</part-name>` +
        used.map((n) => `<score-instrument id="${id}-I${n}"><instrument-name>${esc(drumName(n))}</instrument-name></score-instrument>`).join("") +
        used.map((n) => `<midi-instrument id="${id}-I${n}"><midi-channel>10</midi-channel><midi-unpitched>${n + 1}</midi-unpitched></midi-instrument>`).join("") +
        "</score-part>");
      return;
    }
    // instrument only when set, so scores without one round-trip unchanged (DESIGN §13.2)
    const inst = Number.isInteger(prog)
      ? `<score-instrument id="${id}-I1"><instrument-name>${esc(score.staves[g[0]].name || "")}</instrument-name></score-instrument>` +
        `<midi-instrument id="${id}-I1"><midi-channel>${i < 9 ? i + 1 : Math.min(i + 2, 16)}</midi-channel><midi-program>${prog + 1}</midi-program></midi-instrument>`
      : "";
    x.push(`<score-part id="${id}"><part-name>${esc(score.staves[g[0]].name || "")}</part-name>${inst}</score-part>`);
  });
  x.push("</part-list>");
  const pick = !!score.measures[0].len;
  groups.forEach((g, gi) => {
    x.push(`<part id="P${gi + 1}">`);
    score.measures.forEach((m, b) => {
      x.push(pick && !b ? `<measure number="0" implicit="yes">` : `<measure number="${pick ? b : b + 1}">`);
      x.push(leftBarline(score.measures, b));
      const a = attrsAt(score, b);
      const attrs = [];
      if (b === 0) attrs.push(`<divisions>${PPQ}</divisions>`);
      // the written key; <transpose> says how it sounds (DESIGN §21)
      if (b === 0 || m.key !== undefined) attrs.push(isPerc(score.staves[g[0]]) ? `<key print-object="no"><fifths>${a.key}</fifths></key>` : `<key><fifths>${keyAt(score, g[0], b)}</fifths></key>`);
      if (b === 0 || m.time) attrs.push(`<time${a.sym ? ` symbol="${a.sym}"` : ""}><beats>${a.time[0]}</beats><beat-type>${a.time[1]}</beat-type></time>`);
      if (b === 0 && g.length > 1) attrs.push(`<staves>${g.length}</staves>`);
      g.forEach((s, k) => {
        const clef = b === 0 ? score.staves[s].clef : score.staves[s].clefs?.[b];
        if (!clef) return;
        const [sign, line] = CLEF_OUT[clef];
        attrs.push(`<clef${g.length > 1 ? ` number="${k + 1}"` : ""}><sign>${sign}</sign>${line ? `<line>${line}</line>` : ""}</clef>`);
      });
      if (b === 0) {
        const t = score.staves[g[0]].transpose;
        if (t) {
          const oc = Math.trunc(t[1] / 7);
          attrs.push(`<transpose><diatonic>${t[1] - 7 * oc}</diatonic><chromatic>${t[0] - 12 * oc}</chromatic>${oc ? `<octave-change>${oc}</octave-change>` : ""}</transpose>`);
        }
      }
      if (attrs.length) x.push(`<attributes>${attrs.join("")}</attributes>`);
      const bpm = b === 0 ? score.tempo : score.measures[b].tempo; // tempo changes (DESIGN §29)
      if (bpm && gi === 0) {
        x.push(`<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type><sound tempo="${bpm}"/></direction>`);
      }
      if (gi === 0 && score.measures[b].rehearsal) x.push(`<direction placement="above"><direction-type><rehearsal>${esc(score.measures[b].rehearsal)}</rehearsal></direction-type></direction>`);
      if (gi === 0) x.push(...navXml(score.measures[b], true));
      // every layer bar with notes, as voice staff×4 + layer + 1, separated by <backup> (DESIGN §15)
      const chunks = [];
      g.forEach((s, k) => allLayers(score.staves[s]).forEach((bars, v) => {
        if (v === 0 || bars[b].length) chunks.push(barXml(score, s, b, g.length > 1 ? k + 1 : 0, k * MAX_LAYERS + v + 1, v, syl, `P${gi + 1}`));
      }));
      chunks.forEach((r, i) => {
        x.push(r.xml);
        if (i < chunks.length - 1) x.push(`<backup><duration>${r.ticks}</duration></backup>`);
      });
      if (gi === 0) x.push(...navXml(score.measures[b], false));
      x.push(rightBarline(score.measures, b));
      x.push("</measure>");
    });
    x.push("</part>");
  });
  x.push("</score-partwise>");
  return x.filter(Boolean).join("\n");
}

// ---------- repeats and navigation (DESIGN §28) ----------
// Barlines carry repeats and endings in every part; segno, coda and the jumps are directions in the
// first part, with <sound> saying how they play.
function leftBarline(ms, b) {
  const m = ms[b], start = m.volta && !sameVolta(ms[b - 1]?.volta, m.volta);
  if (!m.repStart && !start) return "";
  return `<barline location="left">${m.repStart ? "<bar-style>heavy-light</bar-style>" : ""}${start ? `<ending number="${m.volta.join(", ")}" type="start">${voltaLabel(m.volta)}</ending>` : ""}${m.repStart ? '<repeat direction="forward"/>' : ""}</barline>`;
}
function rightBarline(ms, b) {
  const m = ms[b], last = b === ms.length - 1, stop = m.volta && !sameVolta(ms[b + 1]?.volta, m.volta);
  if (!m.repEnd && !stop && !last) return "";
  // an ending that is followed by more music and not by a repeat is left open ("discontinue")
  const end = stop ? `<ending number="${m.volta.join(", ")}" type="${m.repEnd || last ? "stop" : "discontinue"}"/>` : "";
  return `<barline location="right">${m.repEnd || last ? "<bar-style>light-heavy</bar-style>" : ""}${end}${m.repEnd ? `<repeat direction="backward"${m.repEnd > 2 ? ` times="${m.repEnd}"` : ""}/>` : ""}</barline>`;
}
const JUMP_SOUND = { dc: 'dacapo="yes"', dcFine: 'dacapo="yes"', dcCoda: 'dacapo="yes"', ds: 'dalsegno="segno"', dsFine: 'dalsegno="segno"', dsCoda: 'dalsegno="segno"' };
function navXml(m, atStart) {
  const d = (type, sound) => `<direction placement="above"><direction-type>${type}</direction-type><sound ${sound}/></direction>`;
  if (atStart) return [m.segno && d("<segno/>", 'segno="segno"'), m.coda && d("<coda/>", 'coda="coda"')];
  return [m.toCoda && d("<words>To Coda</words>", 'tocoda="coda"'), m.fine && d("<words>Fine</words>", 'fine="yes"'),
    m.jump && d(`<words>${JUMPS[m.jump]}</words>`, JUMP_SOUND[m.jump])];
}
// What a <direction> (or a lone <sound>) means for playback order, from its <sound> attributes,
// else its words: {segno|coda|toCoda|fine: true} or {jump}, or null.
function navOf(el) {
  const snd = el.localName === "sound" ? el : kid(el, "sound"), a = (n) => snd?.getAttribute(n);
  const types = kids(el, "direction-type").flatMap((dt) => [...dt.children]);
  const w = types.filter((c) => c.localName === "words").map((c) => c.textContent).join(" ").trim().toLowerCase().replace(/\s+/g, " ");
  const al = /al\s*fine/.test(w) ? "Fine" : /al\s*coda/.test(w) ? "Coda" : "";
  if (a("dacapo") === "yes" || /^(d\.\s?c\.?|da capo)(\s|$)/.test(w)) return { jump: "dc" + al };
  if (a("dalsegno") || /^(d\.\s?s\.?|dal segno)(\s|$)/.test(w)) return { jump: "ds" + al };
  if (a("tocoda") || /^to coda/.test(w)) return { toCoda: true };
  if (a("fine") || w === "fine") return { fine: true };
  if (types.some((c) => c.localName === "segno") || a("segno")) return { segno: true };
  if (types.some((c) => c.localName === "coda") || a("coda")) return { coda: true };
  return null;
}

// ---------- import ----------

const kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el, name) => kids(el, name)[0] || null;
const txt = (el, name) => { const k = kid(el, name); return k ? k.textContent.trim() : null; };

const clefAtImport = (st, mi) => { let c = st.clef; for (const k in st.clefs) if (+k <= mi) c = st.clefs[k]; return c; };

function clefFrom(el, report) {
  const sign = txt(el, "sign"), line = +txt(el, "line");
  const oct = txt(el, "clef-octave-change");
  if (oct && +oct !== 0) report.count("Octave clefs shown as plain clefs");
  if (sign === "percussion") return "percussion";
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

  const names = {}, programs = {}, drumMaps = {}; // drumMaps: part -> {instrument id: GM drum} (DESIGN §27)
  for (const sp of root.querySelectorAll("part-list > score-part")) {
    const id = sp.getAttribute("id");
    names[id] = txt(sp, "part-name") || "";
    const mis = kids(sp, "midi-instrument");
    const un = mis.filter((m) => kid(m, "midi-unpitched"));
    if (un.length) {
      drumMaps[id] = Object.fromEntries(un.map((m) => [m.getAttribute("id"), parseInt(txt(m, "midi-unpitched"), 10) - 1]));
      continue;
    }
    if (mis.length > 1) report.count("Extra instruments in a part (first one used)", mis.length - 1);
    const pr = mis.length ? parseInt(txt(mis[0], "midi-program"), 10) : NaN; // 1-based in MusicXML
    if (Number.isInteger(pr)) {
      if (pr >= 1 && pr <= 128) programs[id] = pr - 1; else report.count("Instrument numbers out of range (ignored)");
    }
  }

  const score = { title: "", composer: "", tempo: 0, measures: [], staves: [] };
  const partAttrs = []; // per part, per bar: {key, time}; the key comes from the first part that isn't drums
  const rep = []; // per bar: repeat and navigation marks (DESIGN §28)
  const tempi = []; // per bar: the tempo from its start, in quarters per minute (DESIGN §29)
  let ending = null; // numbers of the ending open in the first part
  const short = []; // per bar: the length of a bar marked implicit (DESIGN §33)
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
    const attrs = [], drums = drumMaps[part.getAttribute("id")] || null;
    const pend = {}; // staff -> dynamic waiting for its note
    const pendText = {}; // staff -> text waiting for its note (DESIGN §30)
    const pendHp = {}, lastAny = {}; // staff -> hairpin waiting for its note; last event read
    const openHp = {}, openSlur = {}; // staff -> {ev: where the open hairpin starts, prev: one still open before it}; staff:layer -> open slur number
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
      if (ending && pi === 0) (rep[mi] ||= {}).volta = ending; // inside an ending begun earlier
      staves.forEach((st) => allLayers(st).forEach((bars) => bars.push([])));
      const lastEvent = {}; // staff:layer -> last kept event in this bar
      const pendGrace = {}; // staff:layer -> grace notes waiting for their note (DESIGN §26)
      const pos = { t: 0 }; // time cursor in ticks: notes advance it, <backup> and <forward> move it
      for (const el of meas.children) {
        const tag = el.localName;
        if (tag === "attributes") {
          countUnread(report, el, ATTR_READ, { directive: "Text directions in key and time (not imported)" });
          for (const ms of kids(el, "measure-style")) countUnread(report, ms, new Set(["multiple-rest"]), { slash: "Slash notation (not imported)", "beat-repeat": "Repeat-beat signs (not imported)", "measure-repeat": "Repeat-bar signs (not imported)" });
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
            if ((clef === "percussion") !== (clefAtImport(st, mi) === "percussion")) { report.count("Changes to or from the percussion clef mid-part (not imported)"); continue; }
            let at = mi;
            if (pos.t >= barCapacity(time)) at = mi + 1;
            else if (pos.t > 0) report.count("Clef changes inside a bar moved to its start");
            if (at === 0) st.clef = clef; else (st.clefs ||= {})[at] = clef;
          }
        } else if (tag === "barline") {
          if (pi > 0) continue; // every part repeats the same barlines: the first part's are used
          const right = el.getAttribute("location") !== "left" && el.getAttribute("location") !== "middle";
          const r = kid(el, "repeat"), e = kid(el, "ending");
          countUnread(report, el, BARLINE_READ, { fermata: "Fermatas on barlines (not imported)", "wavy-line": "Trill lines (not imported)", segno: "Segno and coda signs on barlines (not imported)", coda: "Segno and coda signs on barlines (not imported)" });
          if (!["regular", "light-heavy", "heavy-light", null].includes(txt(el, "bar-style"))) report.count("Double and special barlines (shown as plain)");
          if (r?.getAttribute("direction") === "forward") (rep[right ? mi + 1 : mi] ||= {}).repStart = true;
          else if (r?.getAttribute("direction") === "backward" && (right || mi > 0)) {
            const times = parseInt(r.getAttribute("times"), 10) || 2;
            if (times > MAX_REPEAT) report.count(`Repeats played more than ${MAX_REPEAT} times (play ${MAX_REPEAT})`);
            (rep[right ? mi : mi - 1] ||= {}).repEnd = Math.max(2, Math.min(MAX_REPEAT, times));
          }
          if (e) {
            const nums = parseVolta(e.getAttribute("number") || "");
            if (!nums) report.count("Endings with unusual numbers (not imported)");
            else if (e.getAttribute("type") === "start") { ending = nums; (rep[mi] ||= {}).volta = nums; }
            else { if (ending || !rep[mi]?.volta) (rep[mi] ||= {}).volta = ending || nums; ending = null; }
          }
        } else if (tag === "direction" || tag === "sound") {
          const nav = navOf(el);
          if (nav) { // DESIGN §28: signs at a bar's start, the rest at its end
            let at = mi;
            if (nav.segno || nav.coda) {
              if (pos.t >= barCapacity(time)) at = mi + 1;
              else if (pos.t > 0) report.count("Segno and coda signs inside a bar moved to its start");
            }
            Object.assign(rep[at] ||= {}, nav);
          }
          for (const dt of tag === "direction" ? kids(el, "direction-type") : []) {
            for (const c of dt.children) {
              if (nav && ["words", "segno", "coda"].includes(c.localName)) continue;
              if (c.localName === "words") { // text above the staff's next note or rest (DESIGN §30)
                const sn = +(txt(el, "staff") || 1), t = cleanText(c.textContent, 1e4);
                if (t) pendText[sn] = { text: cleanText([pendText[sn]?.text, t].filter(Boolean).join(" "), 1e4), at: pos.t, mi };
                continue;
              }
              if (c.localName === "rehearsal") { // on the bar, from the first part (DESIGN §30)
                const t = cleanText(c.textContent, 1e4);
                if (pi > 0) { if (t && t !== rep[mi]?.rehearsal) report.count("Rehearsal marks in later parts (not imported)"); continue; }
                const at = pos.t >= barCapacity(time) ? mi + 1 : mi;
                if (at === mi && pos.t > 0) report.count("Rehearsal marks inside a bar moved to its start");
                const r = { measures: [{}] };
                if (t.length > MAX_REHEARSAL || setRehearsal(r, 0, t)) report.count("Rehearsal marks Coda can't show (not imported)");
                else if (r.measures[0].rehearsal) (rep[at] ||= {}).rehearsal = r.measures[0].rehearsal;
                continue;
              }
              if (c.localName === "wedge") { // hairpins (DESIGN §23): start on the next note, stop on the last one
                const t = c.getAttribute("type"), sn = +(txt(el, "staff") || 1);
                if (t === "crescendo" || t === "diminuendo") pendHp[sn] = { hp: t === "crescendo" ? "<" : ">", at: pos.t, mi };
                else if (t === "stop") {
                  const last = lastAny[sn];
                  if (pendHp[sn] && (!last || pendHp[sn].mi === mi && pos.t <= pendHp[sn].at)) { report.count("Hairpins with no notes (not imported)"); pendHp[sn] = null; }
                  else if (last) {
                    const o = openHp[sn];
                    if (o?.prev) { last.hpEnd = true; o.prev = null; } // closes the one before; the newer stays open
                    else if (o && o.ev === last) { delete last.hp; openHp[sn] = null; report.count("Hairpins over a single note (not imported)"); }
                    else { last.hpEnd = true; openHp[sn] = null; }
                  }
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
              if (label) { if (c.getAttribute("type") !== "stop" && c.getAttribute("type") !== "continue") report.count(label); }
              else countUnread(report, { children: [c] }, DIRTYPE_READ);
            }
          }
          const snd = tag === "sound" ? el : kid(el, "sound");
          let bpm = parseFloat(snd?.getAttribute("tempo")); // <sound tempo> is in quarters already
          const mt = !(bpm > 0) && tag === "direction" && el.querySelector("metronome");
          if (mt) { // a metronome mark in its own beat unit
            const pm = parseFloat(txt(mt, "per-minute")), u = BEAT_Q[txt(mt, "beat-unit")];
            if (pm > 0 && u) bpm = pm * u * (kid(mt, "beat-unit-dot") ? 1.5 : 1);
            else report.count("Metronome marks Coda can't read (not imported)");
          }
          readTempo(tempi, mi, pos.t, bpm, report);
        } else if (tag === "backup" || tag === "forward") {
          const d = Math.round((+txt(el, "duration") * PPQ) / divisions) || 0;
          pos.t = Math.max(0, pos.t + (tag === "backup" ? -d : d));
        } else if (tag === "print") { // layout is Coda's own
          // ponytail: breaks are skipped, not counted: MuseScore writes one for every line it laid out, so
          // a file can't tell placed breaks from its own layout.
        } else if (tag !== "note") countUnread(report, { children: [el] }, MEASURE_READ, MEASURE_NAMES);
        if (tag === "note") {
          const start = pos.t;
          readNote(el, { staves, voiceOf, lastEvent, divisions, time, report, start, pend, pendText, mi, pendHp, lastAny, pendGrace, openHp, openSlur, drums });
          if (!kid(el, "chord") && !kid(el, "grace")) pos.t += Math.round((+txt(el, "duration") * PPQ) / divisions) || 0;
        }
      }
      for (const k in pendGrace) report.count("Grace notes with no note after them in the bar (not imported)", pendGrace[k].notes.length);
      if (meas.getAttribute("implicit") === "yes") // a pickup or a split bar: as long as its longest staff (DESIGN §33)
        short[mi] = Math.max(short[mi] || 0, ...staves.flatMap((st) => allLayers(st).map((bars) => barTicks(bars[mi] || []))));
      // the file's key is written; the score keeps concert pitch
      attrs.push({ key: tr ? wrapKey(key + fifthsOf(tr[0], tr[1])) : key, time: [...time], sym });
    });
    for (const k in pend) if (pend[k]) report.count("Dynamics after the last note (not imported)");
    for (const k in pendText) if (pendText[k]) report.count("Text after the last note (not imported)");
    for (const k in pendHp) if (pendHp[k]) report.count("Hairpins with no notes (not imported)");
    staves.forEach((st) => { if (!st.clef) st.clef = "treble"; });
    finishDrums(staves, report);
    partAttrs.push({ attrs, perc: staves.every(isPerc) });
    score.staves.push(...staves);
  });
  if (!score.staves.length) throw new Error("This MusicXML file has no parts.");

  score.measures.push(...measuresFrom((partAttrs.find((a) => !a.perc) || partAttrs[0]).attrs));
  const broken = clearBrokenSpans(score), slides = clearBrokenSlides(score);
  if (broken) report.count("Unfinished or overlapping slurs and hairpins (not imported)", broken);
  if (slides) report.count("Slides not to the very next note, or between chords of different sizes (not imported)", slides);

  score.title = (root.querySelector("work > work-title")?.textContent || txt(root, "movement-title") ||
    fileName.replace(/\.[^.]+$/, "") || "Untitled").trim();
  const comp = [...root.querySelectorAll("identification > creator")].find((c) => c.getAttribute("type") === "composer");
  score.composer = comp ? comp.textContent.trim() : "";
  padBars(score);
  applyTempi(score, tempi, report);
  rep.forEach((r, b) => { if (b < score.measures.length) Object.assign(score.measures[b], r); else report.count("Repeat marks after the last bar (not imported)"); });
  short.forEach((len, b) => { if (len && setBarLen(score, b, len)) report.count("Short bars Coda can't show (shown full length)"); });
  const lostClefs = finishClefs(score);
  if (lostClefs) report.count("Clef changes after the last bar (not imported)", lostClefs);
  report.notes = noteCount(score);
  return { score, report: report.done() };
}

// A tempo read at tick `at` of bar b into tempi[] (quarters per minute): one per bar, at its start.
export function readTempo(tempi, b, at, bpm, report) {
  if (!(bpm > 0)) return;
  if (tempi[b] === undefined) { tempi[b] = bpm; if (at) report.count("Tempo changes inside a bar moved to the bar's start"); }
  else if (Math.round(bpm) !== Math.round(tempi[b])) report.count("Tempo changes skipped (one per bar is kept)");
}
// tempi[] into the score (after padBars). No tempo at bar 1: the first one found.
export function applyTempi(score, tempi, report) {
  score.tempo = clampBpm(tempi.find((t) => t) || 100);
  tempi.forEach((t, b) => {
    if (b >= score.measures.length) report.count("Tempo changes after the last bar (not imported)");
    else if (b) setTempo(score, b, clampBpm(t));
    if (Math.round(t) !== clampBpm(t)) report.count("Tempos outside 20–400 set to the nearest");
  });
}

// a metronome beat unit in quarter notes
const BEAT_Q = { whole: 4, half: 2, quarter: 1, eighth: 0.5, "16th": 0.25, "32nd": 0.125 };

// MusicXML dynamics -> Coda's set; rarer ones go to the nearest (DESIGN §22)
export const DYN_IN = { ppp: "ppp", pp: "pp", p: "p", mp: "mp", mf: "mf", f: "f", ff: "ff", fff: "fff", fp: "fp", sf: "sf", sfz: "sfz", fz: "fz",
  pppp: "ppp", ppppp: "ppp", pppppp: "ppp", ffff: "fff", fffff: "fff", ffffff: "fff", sfp: "fp", sfpp: "fp", sffz: "sfz", rfz: "sfz", rf: "sf", sfzp: "fp" };
const DIRECTIONS = {
  segno: "Segno and coda signs (not imported)", coda: "Segno and coda signs (not imported)",
  pedal: "Pedal marks (not imported)", "octave-shift": "Octave lines (not imported)",
  dashes: "Dashed lines after text (not imported)", bracket: "Bracket lines (not imported)", "other-direction": "Other directions (not imported)",
};
// What each level of a MusicXML file holds that Coda reads, or skips on purpose (layout, stems,
// beams, sound hints Coda works out itself). Anything else is counted (countUnread).
const MEASURE_READ = new Set(["attributes", "barline", "direction", "sound", "backup", "forward", "note", "print", "bookmark", "link", "grouping", "listening"]);
const MEASURE_NAMES = { harmony: "Chord symbols (not imported)", "figured-bass": "Figured bass (not imported)" };
const ATTR_READ = new Set(["divisions", "key", "time", "clef", "transpose", "staves", "part-symbol", "instruments", "staff-details", "measure-style", "footnote", "level", "for-part"]);
const BARLINE_READ = new Set(["bar-style", "repeat", "ending", "footnote", "level"]);
const DIRTYPE_READ = new Set(["words", "rehearsal", "wedge", "dynamics", "segno", "coda", "metronome"]);
const NOTATIONS_READ = new Set(["fermata", "articulations", "ornaments", "technical", "slur", "slide", "glissando", "tied", "tuplet", "arpeggiate", "footnote", "level"]);
const NOTE_READ = new Set(["chord", "grace", "pitch", "unpitched", "rest", "duration", "tie", "voice", "type", "dot", "accidental", "time-modification",
  "stem", "notehead", "notehead-text", "staff", "beam", "notations", "lyric", "instrument", "play", "listen", "footnote", "level"]);
const MARKS = {
  articulations: "Other articulations (not imported)",
  ornaments: "Ornaments (not imported)", technical: "Technical markings (not imported)", arpeggiate: "Arpeggios (not imported)",
  glissando: "Slides on rests (not imported)", slide: "Slides on rests (not imported)",
};

// A staff with the percussion clef or drum notes becomes a drum staff (DESIGN §27); notes with no
// drum take the kit drum nearest their position, and a pitched staff's drum notes become drums too.
function finishDrums(staves, report) {
  staves.forEach((st, k) => {
    const all = allLayers(st).flat(2).flatMap((e) => [e.pitches, e.grace || []]);
    if (st.clef !== "percussion" && !all.flat().some((p) => p.drum !== undefined)) return;
    drumReport(report, toDrumStaff(st, staves[k - 1]), "Drum notes with no instrument (sound from their position)");
  });
}

function readNote(el, { staves, voiceOf, lastEvent, divisions, time, report, start, pend, pendText, mi, pendHp, lastAny, pendGrace, openHp, openSlur, drums }) {
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
  let glide = false; // a slide or glissando starts here (DESIGN §31); its stop is the next note
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
        // one slur at a time per staff and layer: the first number opened is followed, others counted
        const num = c.getAttribute("number") || "1";
        if (t === "start" && !openSlur[lk]) { openSlur[lk] = num; slur.start = true; }
        else if (t === "start" && openSlur[lk] === num && kid(el, "chord")) slur.start = true; // the same slur on a chord note
        else if (t === "start") report.count("Slurs inside other slurs (not imported)");
        else if (t === "stop" && openSlur[lk] === num) { delete openSlur[lk]; slur.stop = true; }
      }
      else if ((c.localName === "slide" || c.localName === "glissando") && !isRest) { if (c.getAttribute("type") === "start") glide = true; }
      else if (MARKS[c.localName]) { if (c.getAttribute("type") !== "stop") report.count(MARKS[c.localName]); }
      else countUnread(report, { children: [c] }, NOTATIONS_READ, { dynamics: "Dynamics inside notations (not imported)" });
    }
  }
  countUnread(report, el, NOTE_READ, { cue: "Cue notes (shown and played as normal notes)" });
  const head = txt(el, "notehead");
  if (head && head !== "normal" && !kid(el, "unpitched")) report.count("Special noteheads (shown as normal)");
  const addMarks = (ev) => { for (const m of marks) setMark(ev, m, true); if (glide) ev.gliss = true; };
  const tieStart = kids(el, "tie").some((t) => t.getAttribute("type") === "start");

  let pitch = null;
  const p = kid(el, "pitch") || kid(el, "unpitched");
  if (p && !isRest) {
    let step = "CDEFGAB".indexOf(txt(p, "step") || txt(p, "display-step"));
    let oct = parseInt(txt(p, "octave") ?? txt(p, "display-octave"), 10);
    if (p.localName === "unpitched" && (step < 0 || !Number.isFinite(oct))) { // the position is optional: the drum's own, else the middle line
      const n = drums?.[kid(el, "instrument")?.getAttribute("id")], at = isDrum(n) ? drumPitch(n) : { step: 6, oct: 4 };
      ({ step, oct } = at);
    }
    let alter = parseFloat(txt(p, "alter") || "0");
    if (!Number.isInteger(alter)) { report.count("Microtonal alterations rounded"); alter = Math.round(alter); }
    if (step < 0 || !Number.isFinite(oct)) return;
    pitch = { step, oct, alter: Math.max(-2, Math.min(2, alter)) };
    if (p.localName === "unpitched") { // a drum (DESIGN §27): its instrument's MIDI note; finishDrums fills in the rest
      const n = drums?.[kid(el, "instrument")?.getAttribute("id")];
      pitch = { step, oct, alter: 0, drum: isDrum(n) ? n : 0 }; // 0: not known yet
      if (Number.isInteger(n) && !isDrum(n)) report.count("Drums outside the General MIDI kit (sound from their position)");
    }
  }

  if (grace) { // held until the note it comes before; before the chord branch so it can't join the last note
    if (!pitch) return;
    if (kid(el, "chord")) { report.count("Grace-note chords reduced to their first note"); return; }
    if (marks.length || glide || slur.start || slur.stop || tieStart || kids(el, "lyric").length) report.count("Marks, slurs, ties and lyrics on grace notes (not imported)");
    const g = (pendGrace[lk] ||= { notes: [], types: [] });
    g.notes.push(pitch);
    g.types.push((grace.getAttribute("slash") === "yes" ? "/" : "") + (txt(el, "type") || ""));
    return;
  }

  if (kid(el, "chord") && lastEvent[lk]) {
    const ev = lastEvent[lk];
    if (pitch && !ev.pitches.some((q) => q.step === pitch.step && q.oct === pitch.oct && q.drum === pitch.drum)) {
      ev.pitches.push(pitch);
      ev.pitches.sort((a, b) => a.oct * 7 + a.step - (b.oct * 7 + b.step));
    }
    if (tieStart) ev.tie = true;
    addMarks(ev);
    if (slur.start) ev.slur = true;
    if (slur.stop) ev.slurEnd = true;
    lyricIn(el, ev, report);
    return;
  }

  const durEl = txt(el, "duration");
  const ticksRaw = durEl !== null ? (+durEl * PPQ) / divisions : null;
  const type = txt(el, "type");
  if (isRest && (kid(el, "rest").getAttribute("measure") === "yes" ||
      (!type && ticksRaw !== null && Math.round(ticksRaw) >= barCapacity(time)))) {
    if (marks.length) report.count("Fermatas on whole-bar rests (not imported)");
    // a dynamic or hairpin start just before it would otherwise land in the next bar
    if (pend[staffNo]?.mi === mi) { pend[staffNo] = null; report.count("Dynamics on whole-bar rests (not imported)"); }
    if (pendHp[staffNo]?.mi === mi) { pendHp[staffNo] = null; report.count("Hairpins starting on whole-bar rests (not imported)"); }
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
  const pt = pendText[staffNo];
  if (pt && (pt.mi < mi || start >= pt.at)) {
    if (pt.text.length > MAX_TEXT) report.count(`Text cut to ${MAX_TEXT} characters`);
    if (pt.mi < mi) report.count("Text over a bar with no notes moved to the next note");
    if (setText(ev, pt.text)) report.count("Text directions (not imported)");
    pendText[staffNo] = null;
  }
  const ph = pendHp[staffNo];
  if (ph && (ph.mi < mi || start >= ph.at)) { ev.hp = ph.hp; pendHp[staffNo] = null; openHp[staffNo] = { ev, prev: openHp[staffNo] || null }; }
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

// A note's lyrics onto `ev` by verse (DESIGN §24): number="1"–"5" (none is 1); a verse the event
// already has (a chord's other notes) is kept. Other numbers and extender lines are counted.
function lyricIn(el, ev, report) {
  const ls = kids(el, "lyric").filter((l) => kids(l, "text").some((t) => t.textContent.trim()));
  if (!ls.length) return;
  if (!ev.pitches.length) { report.count("Lyrics on rests (not imported)", ls.length); return; }
  const seen = new Set();
  for (const l of ls) {
    const n = l.getAttribute("number") || "1", v = /^[1-9]\d*$/.test(n) ? +n - 1 : -1;
    if (v < 0 || v >= MAX_VERSES) { report.count(`Lyrics beyond verse ${MAX_VERSES} or not numbered by verse (not imported)`); continue; }
    if (seen.has(v)) { report.count("Second lyrics in the same verse on one note (not imported)"); continue; }
    seen.add(v);
    if (ev.lyrics?.[v]) continue;
    if (kid(l, "extend") && kid(l, "extend").getAttribute("type") !== "stop") report.count("Lyric extender lines (not imported)");
    const text = kids(l, "text").map((t) => t.textContent.trim()).join("‿"); // elided syllables share a note
    if (text.length > MAX_LYRIC) report.count("Long lyrics shortened");
    setLyric(ev, text, ["begin", "middle"].includes(txt(l, "syllabic")), v);
  }
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
