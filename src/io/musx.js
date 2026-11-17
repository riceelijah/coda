// Finale .musx / EnigmaXML import. See docs/DESIGN.md §9.5.
//
// Container: unzip -> decrypt score.dat -> gunzip -> EnigmaXML. Notation mapping follows the
// EnigmaXML structure as checked against real files and the MIT-licensed musxdom library
// (key/pitch rules ported from its KeySignature::calcPitch).
import { padBars, noteCount, tupletOk, durFromTicks, nearestDur } from "../model.js";
import { decodeText, parseXml, Report, unzip } from "./util.js";

// Symmetric XOR keystream used for score.dat. Ported from the CC0 routine in
// finale-lua/lua-scripts src/library/enigmaxml.lua.
export function crypt(buf) {
  const INITIAL = 0x28006d45;
  let state = INITIAL;
  const out = new Uint8Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    if (i % 0x20000 === 0) state = INITIAL; // reset every 128 KiB
    state = (Math.imul(state, 0x41c64e6d) + 0x3039) >>> 0; // 32-bit LCG
    const upper = state >>> 16;
    out[i] = buf[i] ^ ((upper + Math.floor(upper / 255)) & 0xff);
  }
  return out;
}

// .musx bytes -> EnigmaXML text.
export function decodeMusx(bytes) {
  const files = unzip(bytes, (n) => n === "score.dat");
  const dat = files["score.dat"];
  if (!dat) throw new Error("This .musx file has no score data in it.");
  let raw = crypt(dat);
  if (raw[0] === 0x1f && raw[1] === 0x8b) {
    try { raw = fflate.gunzipSync(raw); }
    catch { throw new Error("This .musx file's score data is damaged."); }
  }
  const text = decodeText(raw);
  if (!/^\s*(<\?xml|<finale)/.test(text.replace(/^﻿/, ""))) throw new Error("This .musx file's score data couldn't be decoded.");
  return text;
}

export function importMUSX(bytes, fileName = "") {
  return importEnigmaXML(decodeMusx(bytes), fileName, ".musx");
}

const kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el, name) => kids(el, name)[0] || null;
const has = (el, name) => !!kid(el, name);
const num = (el, name, def = 0) => { const k = kid(el, name); const v = k ? parseInt(k.textContent, 10) : NaN; return Number.isFinite(v) ? v : def; };
const nums = (el) => (el ? [...el.children].map((c) => parseInt(c.textContent, 10) || 0) : null);
const attr = (el, a) => parseInt(el.getAttribute(a), 10);
// strip Enigma text codes like ^font(Times,4096)^size(12)
const plain = (s) => s.replace(/\^\w+\([^)]*\)/g, "").replace(/\^\^/g, "^").trim();

// clef shape (char, y offset) -> Coda clef
// entry flags for attached markings Coda doesn't import
const DETAILS = [["articDetail", "Notes with articulations (not imported)"], ["lyricDetail", "Notes with lyrics (not imported)"],
  ["smartShapeDetail", "Notes with slurs or lines (not imported)"]];

const CLEF = { "38,-6": "treble", "66,-4": "alto", "66,-2": "tenor", "63,-2": "bass" };

export function importEnigmaXML(text, fileName = "", format = "EnigmaXML") {
  const report = new Report(format);
  report.add("Instrument sounds aren't read from this format; every part plays as piano until you pick one (Score ▸ Instruments…).");
  const root = parseXml(text).documentElement;
  if (root.localName !== "finale") throw new Error("This isn't an EnigmaXML file.");

  // Score-only records (records with a part attribute belong to linked parts).
  const index = (sect) => {
    const map = new Map();
    for (const el of kid(root, sect)?.children || []) {
      if (el.hasAttribute("part")) continue;
      if (!map.has(el.localName)) map.set(el.localName, []);
      map.get(el.localName).push(el);
    }
    return (name) => map.get(name) || [];
  };
  const others = index("others"), details = index("details");
  const byCmper = (list) => new Map(list.map((e) => [e.getAttribute("cmper"), e]));
  const entries = new Map(kids(kid(root, "entries"), "entry").map((e) => [e.getAttribute("entnum"), e]));
  const textsEl = kid(root, "texts");
  const blockText = new Map(kids(textsEl, "blockText").map((e) => [e.getAttribute("number"), plain(e.textContent)]));
  const fileInfo = (type) => plain(kids(textsEl, "fileInfo").find((e) => e.getAttribute("type") === type)?.textContent || "");
  const textBlocks = byCmper(others("textBlock"));
  const textOf = (blockId) => blockText.get(String(num(textBlocks.get(String(blockId)), "textID", -1))) || "";

  // key tables
  const tables = {};
  for (const n of ["fstKeySharps", "fstKeyFlats", "acciAmountSharps", "acciAmountFlats", "acciOrderSharps", "acciOrderFlats"])
    tables[n] = new Map(others(n).map((e) => [attr(e, "cmper"), nums(e)]));
  const keyFormat = byCmper(others("keyFormat"));
  const keyCache = new Map();
  const keyInfo = (key) => {
    if (keyCache.has(key)) return keyCache.get(key);
    const linear = (key & 0xc000) === 0;
    const mode = linear ? key >> 8 : key;
    const alter = linear ? ((key & 0xff) << 24) >> 24 : 0;
    const builtIn = linear && mode <= 1, minor = mode === 1;
    const sharps = alter >= 0;
    const custom = (n) => (!builtIn && tables[n].get(mode)) || null;
    const centers = minor ? (sharps ? [5, 2, 6, 3, 0, 4, 1, 5] : [5, 1, 4, 0, 3, 6, 2, 5])
      : custom(sharps ? "fstKeySharps" : "fstKeyFlats") || (sharps ? [0, 4, 1, 5, 2, 6, 3, 0] : [0, 3, 6, 2, 5, 1, 4, 0]);
    const amounts = custom(sharps ? "acciAmountSharps" : "acciAmountFlats") || Array(7).fill(sharps ? 1 : -1);
    const order = custom(sharps ? "acciOrderSharps" : "acciOrderFlats") || (sharps ? [3, 0, 4, 1, 5, 2, 6] : [6, 2, 5, 1, 4, 0, 3]);
    const onStep = Array(7).fill(0);
    if (linear) for (let i = 0; i < Math.abs(alter) && i < amounts.length && i < order.length; i++) onStep[order[i]] += amounts[i];
    else for (let i = 0; i < amounts.length && i < order.length && amounts[i]; i++) onStep[order[i]] += amounts[i];
    const semis = num(keyFormat.get(String(mode)), "semitones", 12);
    const k = { tonic: centers[Math.abs(alter) % centers.length], onStep, semis, fifths: linear ? alter : 0, odd: !linear || semis !== 12 };
    keyCache.set(key, k);
    return k;
  };
  // KeySignature::calcPitch with displacement = harmLev, alteration = harmAlt
  const pitchOf = (k, lev, alt) => {
    const l = k.tonic + lev;
    const step = ((l % 7) + 7) % 7;
    let alter = alt + k.onStep[step];
    if (k.semis !== 12) { alter = Math.round((alter * 12) / k.semis); report.count("Notes in microtonal keys (accidentals approximated)"); }
    if (alter < -2 || alter > 2) { alter = Math.max(-2, Math.min(2, alter)); report.count("Accidentals beyond double sharp/flat approximated"); }
    return { step, oct: Math.floor(l / 7) + 4, alter };
  };

  // measures, key and time
  const measEls = others("measSpec").sort((a, b) => attr(a, "cmper") - attr(b, "cmper"));
  if (!measEls.length) throw new Error("This file has no measures.");
  const mKeys = [];
  let prevKey = null, prevTime = null;
  const measures = measEls.map((m) => {
    const keyVal = num(kid(m, "keySig"), "key", 0);
    const k = keyInfo(keyVal);
    mKeys.push(k);
    if (k.odd) { report.add("Non-standard key signatures are shown as their nearest standard key or no key signature"); }
    const beats = num(m, "beats", 4), div = num(m, "divbeat", 1024);
    let time = [4, 4];
    if (has(m, "altNumTsig") || has(m, "altDenTsig")) report.count("Composite time signatures shown as 4/4");
    else if (div > 0 && Number.isInteger(4096 / div)) time = [beats, 4096 / div];
    else if (div % 3 === 0 && Number.isInteger(4096 / (div / 3))) time = [beats * 3, 4096 / (div / 3)];
    else report.count("Unusual time signatures shown as 4/4");
    if (!time.every((v) => v >= 1 && v <= 64) || ![1, 2, 4, 8, 16, 32].includes(time[1])) { time = [4, 4]; report.count("Unusual time signatures shown as 4/4"); }
    const out = {};
    if (k.fifths !== prevKey) out.key = prevKey = Math.max(-7, Math.min(7, k.fifths));
    if (!prevTime || prevTime[0] !== time[0] || prevTime[1] !== time[1]) out.time = prevTime = time;
    return { cmper: m.getAttribute("cmper"), out };
  });

  // staff order from the score's instrument list
  const order = others("instUsed").filter((e) => e.getAttribute("cmper") === "0")
    .sort((a, b) => attr(a, "inci") - attr(b, "inci")).map((e) => String(num(e, "inst", -1)));
  const staffSpecs = byCmper(others("staffSpec"));
  const staffIds = order.filter((id) => staffSpecs.has(id) && id !== "32767");
  if (!staffIds.length) throw new Error("This file has no staves.");
  const braces = new Set();
  for (const g of details("staffGroup")) {
    const s = staffIds.indexOf(String(num(g, "startInst", -1))), e = staffIds.indexOf(String(num(g, "endInst", -1)));
    if (s >= 0 && e === s + 1) braces.add(s);
  }

  const gf = new Map(details("gfhold").map((g) => [`${g.getAttribute("cmper1")}/${g.getAttribute("cmper2")}`, g]));
  const frames = new Map(others("frameSpec").filter((f) => (f.getAttribute("inci") || "0") === "0").map((f) => [f.getAttribute("cmper"), f]));
  const tupletDefs = new Map(details("tupletDef").filter((t) => t.getAttribute("inci") === "0").map((t) => [t.getAttribute("entnum"), t]));
  const otherTups = details("tupletDef").filter((t) => t.getAttribute("inci") !== "0").length;
  if (otherTups) report.count("Nested tuplets kept as plain notes", otherTups);

  const clefFor = (id) => {
    const def = kids(kid(kid(root, "options"), "clefOptions"), "clefDef").find((d) => d.getAttribute("index") === String(id));
    return def ? CLEF[`${num(def, "clefChar")},${num(def, "clefYDisp")}`] : null;
  };

  const score = {
    title: fileInfo("title") || fileName.replace(/\.[^.]+$/, "") || "Untitled",
    composer: fileInfo("composer"),
    tempo: 100,
    measures: measures.map((m) => m.out),
    staves: [],
  };

  staffIds.forEach((sid, si) => {
    const spec = staffSpecs.get(sid);
    if (num(kid(kid(spec, "transposition"), "keysig"), "interval", 0) || has(kid(spec, "transposition"), "chromatic"))
      report.add("Transposing staves are shown at concert pitch");
    let clefId = num(spec, "defaultClef", 0);
    const staff = { name: textOf(num(spec, "fullName", -1)), clef: null, brace: braces.has(si), bars: [] };
    measures.forEach((m, mi) => {
      const g = gf.get(`${sid}/${m.cmper}`);
      const bar = [];
      staff.bars.push(bar);
      if (!g) return;
      if (has(g, "clefListID")) report.count("Clef changes ignored");
      else if (has(g, "clefID")) {
        if (mi === 0) clefId = num(g, "clefID");
        else if (num(g, "clefID") !== clefId) report.count("Clef changes ignored");
      }
      // each frame (layer 1–4) becomes a layer of the staff (DESIGN §15)
      for (const l of [1, 2, 3, 4]) {
      if (!has(g, `frame${l}`)) continue;
      const frame = frames.get(String(num(g, `frame${l}`)));
      if (!frame) { report.count("Measures with missing note data"); continue; }
      let bar = staff.bars[mi];
      if (l > 1) {
        staff.layers ||= [];
        while (staff.layers.length < l - 1) staff.layers.push([]);
        const L = staff.layers[l - 2];
        while (L.length <= mi) L.push([]);
        bar = L[mi];
      }
      const end = String(num(frame, "endEntry", -1));
      let id = String(num(frame, "startEntry", -1)), guard = 0, tup = null, tupLeft = 0;
      while (id !== "0" && entries.has(id) && guard++ < 10000) {
        const e = entries.get(id);
        const skip = (label) => { report.count(label, Math.max(1, num(e, "numNotes", 0))); };
        if (has(e, "graceNote")) skip("Grace notes skipped");
        else if (has(e, "voice2") || has(e, "v2")) skip("Notes in second voices skipped");
        else if (has(e, "ignore")) report.count("Hidden placeholder entries skipped");
        else {
          for (const [flag, label] of DETAILS) if (has(e, flag)) report.count(label);
          const dura = num(e, "dura", 0);
          if (has(e, "tupletStart") && tupletDefs.has(id)) {
            const t = tupletDefs.get(id);
            const a = num(t, "symbolicNum") * num(t, "symbolicDur"), b = num(t, "refNum") * num(t, "refDur");
            const gcd = (x, y) => (y ? gcd(y, x % y) : x), d = gcd(a, b) || 1;
            if (a > 0 && b > 0 && num(t, "symbolicDur") === num(t, "refDur")) { tup = [num(t, "symbolicNum"), num(t, "refNum")]; tupLeft = a; }
            else if (a > 0 && b > 0) { tup = [a / d, b / d]; tupLeft = a; }
          }
          const ticks = (dura * 480) / 1024;
          let dd = durFromTicks(ticks);
          if (!dd) { dd = nearestDur(ticks); report.count("Note lengths rounded"); }
          const ev = { dur: dd.dur, dots: dd.dots, pitches: [] };
          if (tup) {
            if (tupletOk(dd.dur, dd.dots, tup)) ev.tup = tup;
            else report.count("Notes in unsupported tuplets (kept written lengths)");
            tupLeft -= dura;
            if (tupLeft <= 0) tup = null;
          }
          if (has(e, "isNote")) {
            const k = mKeys[mi];
            for (const n of kids(e, "note")) {
              const p = pitchOf(k, num(n, "harmLev"), num(n, "harmAlt"));
              if (!ev.pitches.some((q) => q.step === p.step && q.oct === p.oct)) ev.pitches.push(p);
              else report.count("Unison chord notes merged");
              if (has(n, "tieStart")) ev.tie = true;
            }
            ev.pitches.sort((a, b) => a.oct * 7 + a.step - (b.oct * 7 + b.step));
          }
          bar.push(ev);
        }
        if (id === end) break;
        id = e.getAttribute("next") || "0";
      }
      }
    });
    staff.clef = clefFor(clefId);
    if (!staff.clef) { staff.clef = "treble"; report.count("Unsupported clefs shown as treble"); }
    score.staves.push(staff);
  });

  const expr = others("measExprAssign").length;
  if (expr) report.count("Expressions (dynamics, tempo and text marks) skipped", expr);
  padBars(score);
  report.notes = noteCount(score);
  return { score, report: report.done() };
}
