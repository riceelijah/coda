// MuseScore .mscz / .mscx import (versions 3.x and 4.x). See docs/DESIGN.md §9.7.
// Written from the file format as MuseScore saves it; no MuseScore source code is used.
import { padBars, noteCount, tupletOk, spellMidi, midi, splitTicks, MAX_LAYERS, eventTicks, barTicks, barCapacity, setMark, TIME_SYMS, measuresFrom, attrsAt, partGroups, allLayers, BASE, keyAt, shiftPitch, wrapKey, fifthsOf, DYN_VEL, ACCENT_VEL, SPAN_KINDS, clearBrokenSpans, syllabics, setLyric, MAX_LYRIC, finishClefs } from "../model.js";
import { completeTuplet, DYN_IN } from "./musicxml.js";
import { decodeText, parseXml, Report, unzip } from "./util.js";
import { GM } from "../gm.js";

const DUR = { whole: "w", half: "h", quarter: "q", eighth: "8", "16th": "16", "32nd": "32" };
const LONGER = new Set(["breve", "long"]);
const SHORTER = new Set(["64th", "128th", "256th", "512th", "1024th"]);
// MuseScore articulation subtype -> Coda marks (DESIGN §16). Combined ones ("articAccentStaccatoAbove")
// give two; MuseScore 2 calls an accent "sforzato". Staccatissimo and the rest give none.
export function markOf(sub) {
  if (/staccatissimo/i.test(sub)) return [];
  if (/^fermata/i.test(sub)) return ["fermata"];
  return [["staccato", /staccato/i], ["accent", /accent|sforzato/i], ["tenuto", /tenuto/i], ["marcato", /marcato/i]]
    .filter(([, re]) => re.test(sub)).map(([m]) => m);
}

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
    // written → sounding, same sign as Coda (DESIGN §21)
    const inst = kid(part, "Instrument");
    const tc = parseInt(txt(inst, "transposeChromatic"), 10) || 0, td = parseInt(txt(inst, "transposeDiatonic"), 10) || 0;
    let transpose;
    if (tc || td) {
      if (Math.abs(tc) <= 36 && Math.abs(td) <= 21) transpose = [tc, td];
      else report.count("Transpositions out of range (ignored)");
    }
    for (let k = 0; k < n; k++) decl.push({ name, brace: n === 2 && k === 0, program, transpose });
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
    const staff = { name: d.name, clef: null, brace: d.brace, bars: [], ...(d.program !== undefined ? { program: d.program } : {}),
      ...(d.transpose ? { transpose: [...d.transpose] } : {}) };
    const [tc, td] = d.transpose || [0, 0];
    let key = 0, time = [4, 4], sym;
    const tuplets = {}; // MuseScore 3: id -> ratio
    const pendDyn = []; // per voice: dynamic waiting for its chord or rest (DESIGN §22)
    const pendHp = [], lastEv = []; // per voice: hairpin waiting for its first note; last event (DESIGN §23)
    kids(stEl, "Measure").forEach((meas, mi) => {
      const voices = kids(meas, "voice");
      for (const L of staff.layers || []) L.push([]);
      // MuseScore 2 files have no <voice> wrapper. Voices become layers 1–4 (DESIGN §15).
      (voices.length ? voices : [meas]).forEach((vEl, vi) => {
      if (vi >= MAX_LAYERS) { report.count(`Notes in voices beyond ${MAX_LAYERS} per staff skipped`, kids(vEl, "Chord").length); return; }
      const bar = [];
      let tup = null, cur = 0, fermata = false; // cur: time cursor in ticks; <location> moves it either way
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
            let at = mi;
            if (cur >= barCapacity(time)) at = mi + 1;
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
            if (!score.tempo) score.tempo = Math.round(parseFloat(txt(el, "tempo")) * 60) || 0;
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
            } else if (kid(el, "next")) report.count(`Lines (${type}) not imported`);
            break;
          }
          case "Dynamic": {
            const d = DYN_IN[txt(el, "subtype")];
            if (d) pendDyn[vi] = d; else report.count("Unusual dynamics (not imported)");
            break;
          }
          case "Fermata": fermata = true; break; // MuseScore 3+: before the chord or rest it belongs to
          case "Chord":
          case "Rest": {
            const isRest = el.localName === "Rest";
            if (GRACE.some((g) => kid(el, g))) { report.count("Grace notes skipped"); break; }
            const dt = txt(el, "durationType");
            const marks = fermata ? ["fermata"] : [];
            fermata = false;
            for (const a of kids(el, "Articulation")) {
              const got = markOf(txt(a, "subtype") || "");
              if (got.length) marks.push(...got); else report.count("Other articulations (not imported)");
            }
            if (dt === "measure") { // whole-bar rest = empty bar
              if (marks.length) report.count("Fermatas on whole-bar rests (not imported)");
              cur += barCapacity(time); break;
            }
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
                const tpc = parseInt(txt(n, "tpc"), 10), tpc2 = parseInt(txt(n, "tpc2"), 10);
                if (!Number.isFinite(pm)) continue;
                // pitch and tpc are concert; Coda keeps the written note (tpc2)
                const wm = pm - tc;
                let p = Number.isFinite(tpc2) && tc ? tpcToPitch(tpc2, wm)
                  : Number.isFinite(tpc) ? (tc || td ? shiftPitch(tpcToPitch(tpc, pm), -tc, -td) : tpcToPitch(tpc, pm)) : null;
                if (!p || p.alter < -2 || p.alter > 2 || midi(p) !== wm) {
                  p = spellMidi(wm, wrapKey(key - fifthsOf(tc, td)));
                  report.count("Note spellings guessed from pitch");
                }
                if (!ev.pitches.some((q) => q.step === p.step && q.oct === p.oct)) ev.pitches.push(p);
                const tieSp = kids(n, "Spanner").find((s) => s.getAttribute("type") === "Tie" && kid(s, "next"));
                if (tieSp || kid(n, "Tie")) ev.tie = true;
              }
              if (!ev.pitches.length) break;
              ev.pitches.sort((a, b) => a.oct * 7 + a.step - (b.oct * 7 + b.step));
            }
            for (const m of marks) if (!isRest || m === "fermata") setMark(ev, m, true);
            if (pendDyn[vi]) { ev.dyn = pendDyn[vi]; pendDyn[vi] = null; }
            if (pendHp[vi]) { ev.hp = pendHp[vi]; pendHp[vi] = null; }
            for (const sp of kids(el, "Spanner")) {
              if (sp.getAttribute("type") === "Slur") { if (kid(sp, "next")) ev.slur = true; else if (kid(sp, "prev")) ev.slurEnd = true; }
              else if (kid(sp, "next")) report.count(`Lines (${sp.getAttribute("type")}) not imported`);
            }
            lyricIn(el, ev, report);
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
      if (si === 0) firstAttrs.push({ key, time: [...time], sym });
    });
    if (pendDyn.some(Boolean)) report.count("Dynamics after the last note (not imported)");
    if (!staff.clef) staff.clef = "treble";
    score.staves.push(staff);
  });
  if (!score.staves.length) throw new Error("This MuseScore file has no staves.");

  score.measures.push(...measuresFrom(firstAttrs));
  const broken = clearBrokenSpans(score);
  if (broken) report.count("Unfinished or overlapping slurs and hairpins (not imported)", broken);
  score.tempo = Math.max(20, Math.min(400, score.tempo || 100));
  padBars(score);
  const lostClefs = finishClefs(score);
  if (lostClefs) report.count("Clef changes after the last bar (not imported)", lostClefs);
  report.notes = noteCount(score);
  return { score, report: report.done() };
}

// ---------- export (DESIGN §19) ----------
// MuseScore 4 format, modelled on what MuseScore writes. Layers are voices; ties are Tie spanners
// pointing at the next note; marks are Fermata/Articulation elements.

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const TYPE_NAME = { w: "whole", h: "half", q: "quarter", 8: "eighth", 16: "16th", 32: "32nd" };
const CLEF_OUT = { treble: "G", bass: "F", alto: "C3", tenor: "C4" };
const ARTIC_OUT = { staccato: "articStaccatoAbove", accent: "articAccentAbove", tenuto: "articTenutoAbove", marcato: "articMarcatoAbove" };
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const frac = (ticks) => { const g = gcd(Math.abs(ticks), 1920) || 1; return `${ticks / g}/${1920 / g}`; };
const tpcOf = (p) => [14, 16, 18, 13, 15, 17, 19][p.step] + 7 * p.alter;
const loc = (dm, dt) => `<location>${dm ? `<measures>${dm}</measures>` : ""}${dt ? `<fractions>${frac(dt)}</fractions>` : ""}</location>`;

// The first verse of a chord's <Lyrics> onto `ev` (DESIGN §24); other verses and extender lines are counted.
function lyricIn(el, ev, report) {
  const ls = kids(el, "Lyrics").filter((l) => txt(l, "text"));
  if (!ls.length) return;
  if (!ev.pitches.length) { report.count("Lyrics on rests (not imported)"); return; }
  const l = ls.find((x) => !+(txt(x, "no") || 0)) || ls[0];
  if (ls.length > 1) report.count("Lyrics beyond the first verse (not imported)", ls.length - 1);
  if (kid(l, "ticks_f") || kid(l, "ticks")) report.count("Lyric extender lines (not imported)");
  if (txt(l, "text").length > MAX_LYRIC) report.count("Long lyrics shortened");
  setLyric(ev, txt(l, "text"), ["begin", "middle"].includes(txt(l, "syllabic")));
}

export function exportMSCX(score) {
  const syl = syllabics(score);
  const x = ['<?xml version="1.0" encoding="UTF-8"?>', '<museScore version="4.20">', "<Score>", "<Division>480</Division>"];
  x.push(`<metaTag name="workTitle">${esc(score.title || "")}</metaTag>`, `<metaTag name="composer">${esc(score.composer || "")}</metaTag>`);
  let id = 0;
  for (const g of partGroups(score)) {
    const st = score.staves[g[0]];
    x.push("<Part>");
    g.forEach((s, k) => x.push(`<Staff id="${++id}"><StaffType group="pitched"><name>stdNormal</name></StaffType>` +
      (g.length > 1 && k === 0 ? '<bracket type="1" span="2" col="0"/><barLineSpan>1</barLineSpan>' : "") + "</Staff>"));
    x.push(`<trackName>${esc(st.name || "")}</trackName><Instrument><longName>${esc(st.name || "")}</longName>` +
      `<trackName>${esc(st.name || "")}</trackName>${g.map((s, k) => `<clef staff="${k + 1}">${CLEF_OUT[score.staves[s].clef]}</clef>`).join("")}${st.transpose ? `<transposeDiatonic>${st.transpose[1]}</transposeDiatonic><transposeChromatic>${st.transpose[0]}</transposeChromatic>` : ""}` +
      `<Channel><program value="${st.program ?? 0}"/></Channel></Instrument></Part>`);
  }
  score.staves.forEach((st, s) => {
    x.push(`<Staff id="${s + 1}">`);
    if (s === 0) x.push(`<VBox><height>10</height><Text><style>title</style><text>${esc(score.title || "")}</text></Text>` +
      (score.composer ? `<Text><style>composer</style><text>${esc(score.composer)}</text></Text>` : "") + "</VBox>");
    const layers = allLayers(st);
    const ties = layers.map((bars) => tieMap(bars)); // per layer: "b:i" -> {next, prev} locations by midi
    const spans = layers.map((bars) => spanMap(bars));
    score.measures.forEach((m, b) => {
      const a = attrsAt(score, b), cap = barCapacity(a.time);
      x.push("<Measure>");
      const last = Math.max(0, ...layers.map((bars, v) => (bars[b].length ? v : 0)));
      for (let v = 0; v <= last; v++) {
        x.push("<voice>");
        if (v === 0) {
          if (b === 0) x.push(`<Clef><concertClefType>${CLEF_OUT[st.clef]}</concertClefType><transposingClefType>${CLEF_OUT[st.clef]}</transposingClefType><isHeader>1</isHeader></Clef>`);
          if (b === 0 || m.key !== undefined) x.push(`<KeySig><concertKey>${a.key}</concertKey>${st.transpose ? `<actualKey>${keyAt(score, s, b)}</actualKey>` : ""}</KeySig>`);
          if (b === 0 || m.time) x.push(`<TimeSig>${a.sym ? `<subtype>${a.sym === "common" ? 1 : 2}</subtype>` : ""}<sigN>${a.time[0]}</sigN><sigD>${a.time[1]}</sigD></TimeSig>`);
          if (b === 0 && s === 0) x.push(`<Tempo><tempo>${score.tempo / 60}</tempo><followText>1</followText><text><sym>metNoteQuarterUp</sym> = ${score.tempo}</text></Tempo>`);
        }
        const bar = layers[v][b];
        if (v === 0 && !bar.length) x.push(`<Rest><durationType>measure</durationType><duration>${frac(cap)}</duration></Rest>`);
        else x.push(voiceXml(v === 0 ? completeTuplet(bar, cap) : bar, ties[v], b, v === 0 ? cap : 0, st, spans[v], syl));
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

// Where each tied note's partner is: for event b:i, {next: {midi: loc}, prev: {midi: loc}}.
function tieMap(bars) {
  const pos = [];
  bars.forEach((bar, b) => { let t = 0; bar.forEach((e, i) => { pos.push({ b, i, t, e }); t += eventTicks(e); }); });
  const map = {};
  const at = (p) => (map[p.b + ":" + p.i] ||= { next: {}, prev: {} });
  pos.forEach((p, k) => {
    const q = pos[k + 1];
    if (!p.e.tie || !q || q.b > p.b + 1) return;
    for (const pi of p.e.pitches) {
      const mm = midi(pi);
      if (!q.e.pitches.some((r) => midi(r) === mm)) continue;
      at(p).next[mm] = loc(q.b - p.b, q.t - p.t);
      at(q).prev[mm] = loc(p.b - q.b, p.t - q.t);
    }
  });
  return map;
}

// Slurs and hairpins (DESIGN §23): "b:i" -> {slurNext, slurPrev, hpNext, hpPrev} locations. A slur
// runs onset to onset; a hairpin from its first onset to the end of its last note.
function spanMap(bars) {
  const pos = [];
  bars.forEach((bar, b) => { let t = 0; bar.forEach((e, i) => { pos.push({ b, i, t, e }); t += eventTicks(e); }); });
  const map = {}, at = (p) => (map[p.b + ":" + p.i] ||= {});
  for (const [k, ke] of SPAN_KINDS) {
    let a = null;
    for (const p of pos) {
      if (p.e[ke] && a) {
        const zt = k === "slur" ? p.t : p.t + eventTicks(p.e);
        at(a)[k + "Next"] = loc(p.b - a.b, zt - a.t);
        at(p)[k + "Prev"] = loc(a.b - p.b, a.t - zt);
        a = null;
      }
      if (p.e[k]) a = p;
    }
  }
  return map;
}

// One voice's events; a first voice is padded with rests to `cap`.
function voiceXml(bar, ties, b, cap, st, spans = {}, syl = new Map()) {
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
    if (e.dyn) x.push(`<Dynamic><subtype>${e.dyn}</subtype><velocity>${DYN_VEL[e.dyn] || ACCENT_VEL[e.dyn]}</velocity></Dynamic>`);
    const sp = spans[b + ":" + i] || {};
    if (sp.hpNext) x.push(`<Spanner type="HairPin"><HairPin><subtype>${e.hp === ">" ? 1 : 0}</subtype></HairPin><next>${sp.hpNext}</next></Spanner>`);
    const head = `${e.dots ? `<dots>${e.dots}</dots>` : ""}<durationType>${TYPE_NAME[e.dur]}</durationType>`;
    if (!e.pitches.length) x.push(`<Rest>${head}</Rest>`);
    else {
      const t = ties[b + ":" + i] || { next: {}, prev: {} };
      const arts = (e.marks || []).filter((m) => ARTIC_OUT[m]).map((m) => `<Articulation><subtype>${ARTIC_OUT[m]}</subtype></Articulation>`).join("");
      const notes = e.pitches.map((p) => {
        const mm = midi(p), [tc, td] = st.transpose || [0, 0]; // pitch and tpc concert, tpc2 written
        const sp = (t.next[mm] ? `<Spanner type="Tie"><Tie/><next>${t.next[mm]}</next></Spanner>` : "") +
          (t.prev[mm] ? `<Spanner type="Tie"><prev>${t.prev[mm]}</prev></Spanner>` : "");
        return `<Note>${sp}<pitch>${mm + tc}</pitch><tpc>${tpcOf(tc || td ? shiftPitch(p, tc, td) : p)}</tpc>${tc || td ? `<tpc2>${tpcOf(p)}</tpc2>` : ""}</Note>`;
      }).join("");
      // ponytail: MuseScore slurs need chords at both ends; one on a rest is left out of this file
      const slurs = (sp.slurNext ? `<Spanner type="Slur"><Slur/><next>${sp.slurNext}</next></Spanner>` : "") +
        (sp.slurPrev ? `<Spanner type="Slur"><prev>${sp.slurPrev}</prev></Spanner>` : "");
      const s = syl.get(e), lyr = s ? `<Lyrics>${s === "single" ? "" : `<syllabic>${s}</syllabic>`}<text>${esc(e.lyric)}</text></Lyrics>` : "";
      x.push(`<Chord>${head}${lyr}${arts}${slurs}${notes}</Chord>`);
    }
    if (sp.hpPrev) x.push(`<Spanner type="HairPin"><prev>${sp.hpPrev}</prev></Spanner>`);
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
