// Finale .musx / EnigmaXML import. See docs/DESIGN.md §9.5.
//
// Container: unzip -> decrypt score.dat -> gunzip -> EnigmaXML. Notation mapping follows the
// EnigmaXML structure as checked against real files and the MIT-licensed musxdom library
// (key/pitch rules ported from its KeySignature::calcPitch).
import { padBars, noteCount, tupletOk, durFromTicks, nearestDur, measuresFrom, setMark, splitTicks, barTicks, barCapacity, allLayers, shiftPitch, midi, MAX_LAYERS } from "../model.js";
import { GM } from "../gm.js";
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
const str = (el, name) => kid(el, name)?.textContent.trim() || "";
// strip Enigma text codes like ^font(Times,4096)^size(12)
const plain = (s) => s.replace(/\^\w+\([^)]*\)/g, "").replace(/\^\^/g, "^").trim();

// entry flags for attached markings Coda doesn't import
const DETAILS = [["lyricDetail", "Notes with lyrics (not imported)"], ["smartShapeDetail", "Notes with slurs or lines (not imported)"]];

// Articulation symbols -> Coda marks (DESIGN §16). SMuFL fonts use code points U+E4A0…; the older
// Finale music fonts (Maestro and its look-alikes) use plain character codes.
const SMUFL_MARKS = {
  0xe4a0: ["accent"], 0xe4a2: ["staccato"], 0xe4a4: ["tenuto"], 0xe4ac: ["marcato"], 0xe4ae: ["marcato", "staccato"],
  0xe4b0: ["accent", "staccato"], 0xe4b2: ["tenuto", "staccato"], 0xe4b4: ["tenuto", "accent"],
};
const smuflMarks = (c) => (c >= 0xe4c0 && c <= 0xe4cb ? ["fermata"] : SMUFL_MARKS[c & ~1] || null); // even = above, odd = below
// ponytail: 46/62/45 seen in real files; 94, 85, 117 from the Maestro character map, not yet seen in a file
const LEGACY_MARKS = { 46: ["staccato"], 62: ["accent"], 45: ["tenuto"], 94: ["marcato"], 85: ["fermata"], 117: ["fermata"] };
const LEGACY_FONTS = /^(Maestro|Petrucci|Jazz|Broadway Copyist|Engraver Font Set)$/i;

// Key change (fifths) of a diatonic interval plus chromatic alteration, as musxdom's
// calcKeySigChangeFromInterval: second +2, third +4, fourth −1, fifth +1, sixth +3, seventh +5.
function keyChangeOf(d, alt) {
  let e = [0, 2, 4, -1, 1, 3, 5][((d % 7) + 7) % 7];
  if (d < 0 && Math.abs(e) > 1) e -= 7;
  return e + 7 * alt;
}

// clef shape (char, y offset) -> Coda clef
const CLEF = { "38,-6": "treble", "66,-4": "alto", "66,-2": "tenor", "63,-2": "bass" };

export function importEnigmaXML(text, fileName = "", format = "EnigmaXML") {
  const report = new Report(format);
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
  const tso = kid(kid(root, "options"), "timeSignatureOptions");
  const symFor = (t, on) => (t[0] === 2 && t[1] === 2 && on.cut ? "cut" : t[0] === 4 && t[1] === 4 && on.common ? "common" : undefined);
  const timeOf = (beats, div) => {
    if (div > 0 && Number.isInteger(4096 / div)) return [beats, 4096 / div];
    if (div % 3 === 0 && Number.isInteger(4096 / (div / 3))) return [beats * 3, 4096 / (div / 3)];
    return null;
  };
  const measures = measEls.map((m) => {
    const keyVal = num(kid(m, "keySig"), "key", 0);
    const k = keyInfo(keyVal);
    mKeys.push(k);
    if (k.odd) { report.add("Non-standard key signatures are shown as their nearest standard key or no key signature"); }
    const beats = num(m, "beats", 4), div = num(m, "divbeat", 1024);
    let time = [4, 4];
    if (has(m, "altNumTsig") || has(m, "altDenTsig")) report.count("Composite time signatures shown as 4/4");
    else time = timeOf(beats, div) || (report.count("Unusual time signatures shown as 4/4"), [4, 4]);
    if (!time.every((v) => v >= 1 && v <= 64) || ![1, 2, 4, 8, 16, 32].includes(time[1])) { time = [4, 4]; report.count("Unusual time signatures shown as 4/4"); }
    // C and ¢ (DESIGN §17), as musxdom's TimeSignature::getAbbreviatedSymbol: a display signature
    // decides with its own flag, otherwise the document options do
    let sym;
    if (has(m, "useDisplayTimesig")) {
      const shown = timeOf(num(m, "dispBeats", beats), num(m, "dispDivbeat", div));
      if (!shown || shown[0] !== time[0] || shown[1] !== time[1]) report.count("Time signatures shown differently from the real meter (real meter used)");
      else sym = symFor(time, { cut: has(m, "abbrvTime"), common: has(m, "abbrvTime") });
    } else sym = symFor(time, { cut: has(tso, "timeSigDoAbrvCut"), common: has(tso, "timeSigDoAbrvCommon") });
    return { cmper: m.getAttribute("cmper"), attrs: { key: Math.max(-7, Math.min(7, k.fifths)), time, sym } };
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
    measures: measuresFrom(measures.map((m) => m.attrs)),
    staves: [],
  };

  // articulations: details articAssign per entry -> others articDef (DESIGN §16)
  const articDefs = byCmper(others("articDef"));
  const fontNames = new Map(others("fontName").map((f) => [f.getAttribute("cmper"), str(f, "name")]));
  const artics = new Map();
  for (const a of details("articAssign")) {
    const id = a.getAttribute("entnum");
    if (!artics.has(id)) artics.set(id, []);
    artics.get(id).push(String(num(a, "articDef", -1)));
  }
  const marksOf = (defId) => {
    const d = articDefs.get(defId);
    const c = num(d, "charMain", -1);
    if (c >= 0xe000) return smuflMarks(c);
    return LEGACY_FONTS.test(fontNames.get(String(num(d, "fontMain", 0))) || "") ? LEGACY_MARKS[c] || null : null;
  };

  // Transpositions (DESIGN §21). Finale gives the interval from concert to written: a diatonic step
  // count plus either a key change in fifths or a chromatic alteration. Coda keeps written → sounding.
  const transposeOf = (x) => {
    if (!x) return null;
    let d, k;
    if (has(x, "keysig")) { d = num(kid(x, "keysig"), "interval"); k = num(kid(x, "keysig"), "adjust"); }
    else if (has(x, "chromatic")) {
      d = num(kid(x, "chromatic"), "diatonic"); k = keyChangeOf(d, num(kid(x, "chromatic"), "alteration"));
    } else return null;
    if (!d && !k) return null;
    const c = (k + 12 * d) / 7;
    if (!Number.isInteger(c) || Math.abs(c) > 36 || Math.abs(d) > 21) { report.count("Unusual transpositions (shown at concert pitch)"); return null; }
    if (has(x, "chromatic")) report.count("Chromatic transpositions (key signature shown transposed)");
    return [-c || 0, -d || 0];
  };
  const trs = staffIds.map((sid) => transposeOf(kid(staffSpecs.get(sid), "transposition")));
  for (const si of braces) if (JSON.stringify(trs[si]) !== JSON.stringify(trs[si + 1])) {
    trs[si] = trs[si + 1] = null; report.count("Braced staves with different transpositions (shown at concert pitch)");
  }
  if (mKeys.some((k) => k.semis !== 12) && trs.some(Boolean)) { trs.fill(null); report.count("Transpositions in microtonal keys (shown at concert pitch)"); }
  const trStyles = new Set(others("staffStyle").filter((st) => kid(st, "transposition")?.children.length).map((st) => st.getAttribute("cmper")));
  const styled = others("staffStyleAssign").filter((a) => trStyles.has(String(num(a, "style", -1)))).length;
  if (styled) report.count("Transposition changes from staff styles (not imported)", styled);

  staffIds.forEach((sid, si) => {
    const spec = staffSpecs.get(sid);
    let clefId = num(spec, "defaultClef", 0);
    const staff = { name: textOf(num(spec, "fullName", -1)), clef: null, brace: braces.has(si), bars: [] };
    const gm = staff.name && GM.find((g) => g.name.toLowerCase() === staff.name.trim().toLowerCase());
    if (gm) staff.program = gm.program;
    else if (!/piano/i.test(staff.name) && !(si > 0 && braces.has(si - 1))) report.count("Parts with no instrument sound found (played as piano)");
    const layerBar = (l, mi) => {
      if (l === 1) return staff.bars[mi];
      staff.layers ||= [];
      while (staff.layers.length < l - 1) staff.layers.push([]);
      const L = staff.layers[l - 2];
      while (L.length <= mi) L.push([]);
      return L[mi];
    };
    // one entry -> event, or null when skipped; ts is the voice's tuplet state
    const readEntry = (e, id, mi, ts) => {
      const skip = (label) => { report.count(label, Math.max(1, num(e, "numNotes", 0))); return null; };
      if (has(e, "graceNote")) return skip("Grace notes skipped");
      if (has(e, "ignore")) { report.count("Hidden placeholder entries skipped"); return null; }
      for (const [flag, label] of DETAILS) if (has(e, flag)) report.count(label);
      const dura = num(e, "dura", 0);
      if (has(e, "tupletStart") && tupletDefs.has(id)) {
        const t = tupletDefs.get(id);
        const a = num(t, "symbolicNum") * num(t, "symbolicDur"), b = num(t, "refNum") * num(t, "refDur");
        const gcd = (x, y) => (y ? gcd(y, x % y) : x), d = gcd(a, b) || 1;
        if (a > 0 && b > 0 && num(t, "symbolicDur") === num(t, "refDur")) { ts.tup = [num(t, "symbolicNum"), num(t, "refNum")]; ts.left = a; }
        else if (a > 0 && b > 0) { ts.tup = [a / d, b / d]; ts.left = a; }
      }
      const ticks = (dura * 480) / 1024;
      let dd = durFromTicks(ticks);
      if (!dd) { dd = nearestDur(ticks); report.count("Note lengths rounded"); }
      const ev = { dur: dd.dur, dots: dd.dots, pitches: [] };
      if (ts.tup) {
        if (tupletOk(dd.dur, dd.dots, ts.tup)) ev.tup = ts.tup;
        else report.count("Notes in unsupported tuplets (kept written lengths)");
        ts.left -= dura;
        if (ts.left <= 0) ts.tup = null;
      }
      if (has(e, "isNote")) {
        for (const n of kids(e, "note")) {
          const p = pitchOf(mKeys[mi], num(n, "harmLev"), num(n, "harmAlt"));
          if (!ev.pitches.some((q) => q.step === p.step && q.oct === p.oct)) ev.pitches.push(p);
          else report.count("Unison chord notes merged");
          if (has(n, "tieStart")) ev.tie = true;
        }
        ev.pitches.sort((a, b) => a.oct * 7 + a.step - (b.oct * 7 + b.step));
      }
      const defs = artics.get(id) || [];
      if (has(e, "articDetail") && !defs.length) report.count("Notes with articulations (not imported)");
      for (const def of defs) {
        const ms = marksOf(def);
        if (!ms) { report.count("Other articulations (not imported)"); continue; }
        for (const m of ms) {
          if (!ev.pitches.length && m !== "fermata") report.count("Articulations on rests (not imported)");
          else setMark(ev, m, true);
        }
      }
      return ev;
    };

    measures.forEach((m, mi) => {
      const g = gf.get(`${sid}/${m.cmper}`);
      staff.bars.push([]);
      if (!g) return;
      if (has(g, "clefListID")) report.count("Clef changes ignored");
      else if (has(g, "clefID")) {
        if (mi === 0) clefId = num(g, "clefID");
        else if (num(g, "clefID") !== clefId) report.count("Clef changes ignored");
      }
      // each frame (layer 1–4) becomes a layer of the staff (DESIGN §15); voice-2 runs start where
      // their launching voice-1 entry starts and go to a layer no frame uses in this bar
      const used = new Set(), runs = [];
      for (const l of [1, 2, 3, 4]) {
        if (!has(g, `frame${l}`)) continue;
        const frame = frames.get(String(num(g, `frame${l}`)));
        if (!frame) { report.count("Measures with missing note data"); continue; }
        used.add(l);
        const bar = layerBar(l, mi), v1 = { tup: null, left: 0 }, v2 = { tup: null, left: 0 };
        const end = String(num(frame, "endEntry", -1));
        let id = String(num(frame, "startEntry", -1)), guard = 0, run = null;
        while (id !== "0" && entries.has(id) && guard++ < 10000) {
          const e = entries.get(id);
          if (has(e, "v2") || has(e, "voice2")) {
            const ev = readEntry(e, id, mi, v2);
            if (ev && run) run.events.push(ev);
            else if (ev) report.count("Second-voice notes with no start skipped", Math.max(1, ev.pitches.length));
          } else {
            const start = barTicks(bar), ev = readEntry(e, id, mi, v1);
            if (ev) bar.push(ev);
            run = has(e, "controller") ? { src: l, start, events: [] } : null;
            if (run) { runs.push(run); Object.assign(v2, { tup: null, left: 0 }); }
          }
          if (id === end) break;
          id = e.getAttribute("next") || "0";
        }
      }
      const target = {};
      for (const run of runs) {
        if (!run.events.length) continue;
        target[run.src] ||= [1, 2, 3, 4].find((L) => !used.has(L) && L <= MAX_LAYERS);
        const L = target[run.src];
        const lost = () => report.count("Notes in second voices skipped", run.events.reduce((n, e) => n + Math.max(1, e.pitches.length), 0));
        if (!L) { lost(); continue; }
        used.add(L);
        const bar = layerBar(L, mi), at = barTicks(bar), rests = splitTicks(run.start - at).map((d) => ({ dur: d.dur, dots: d.dots, pitches: [] }));
        // starts before the layer's end, can't be reached with plain rests, or overfills the bar
        if (run.start < at || barTicks(rests) !== run.start - at || run.start + barTicks(run.events) > barCapacity(m.attrs.time)) { lost(); continue; }
        bar.push(...rests, ...run.events);
      }
    });
    staff.clef = clefFor(clefId);
    if (!staff.clef) { staff.clef = "treble"; report.count("Unsupported clefs shown as treble"); }

    // a tie needs the same pitch next in its layer; ties into another voice are dropped
    for (const bars of allLayers(staff)) {
      const seq = bars.flat();
      seq.forEach((ev, i) => {
        if (ev.tie && !seq[i + 1]?.pitches.some((q) => ev.pitches.some((p) => midi(p) === midi(q)))) {
          delete ev.tie; report.count("Ties with no matching next note dropped");
        }
      });
    }
    // notes are stored at concert pitch; Coda keeps them written
    const t = trs[si];
    if (t) {
      const all = allLayers(staff).flat(2);
      if (all.every((ev) => ev.pitches.every((p) => midi(p) - t[0] >= 0 && midi(p) - t[0] <= 127))) {
        for (const ev of all) ev.pitches = ev.pitches.map((p) => shiftPitch(p, -t[0], -t[1]));
        staff.transpose = [...t];
      } else report.count("Transposed notes out of range (shown at concert pitch)");
    }
    score.staves.push(staff);
  });

  // tempo: a tempo mark at the very start of bar 1
  const exprDefs = byCmper(others("textExprDef"));
  const assigns = others("measExprAssign");
  const t0 = assigns.find((a) => a.getAttribute("cmper") === measures[0].cmper && !num(a, "horzEduOff", 0) &&
    str(exprDefs.get(String(num(a, "textExprID", -1))), "playType") === "time" && has(exprDefs.get(String(num(a, "textExprID", -1))), "useAuxData"));
  if (t0) {
    const d = exprDefs.get(String(num(t0, "textExprID", -1)));
    const bpm = Math.round((num(d, "value", 0) * num(d, "auxdata1", 1024)) / 1024);
    if (bpm > 0) score.tempo = Math.max(20, Math.min(400, bpm));
  }
  const expr = assigns.length - (t0 ? 1 : 0);
  if (expr) report.count("Expressions (dynamics, tempo and text marks) skipped", expr);
  padBars(score);
  report.notes = noteCount(score);
  return { score, report: report.done() };
}
