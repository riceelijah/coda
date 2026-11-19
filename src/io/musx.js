// Finale .musx / EnigmaXML import. See docs/DESIGN.md §9.5.
//
// Container: unzip -> decrypt score.dat -> gunzip -> EnigmaXML. Notation mapping follows the
// EnigmaXML structure as checked against real files and the MIT-licensed musxdom library
// (key/pitch rules ported from its KeySignature::calcPitch).
import { padBars, noteCount, tupletOk, durFromTicks, nearestDur, measuresFrom, setMark, splitTicks, barTicks, barCapacity, allLayers, shiftPitch, midi, MAX_LAYERS,
  eventTicks, clearBrokenSpans, setLyric, MAX_LYRIC, MAX_VERSES, finishClefs, MAX_GRACE, DYNS, toDrumStaff, drumReport, isPerc } from "../model.js";
import { DYN_IN, readTempo, applyTempi } from "./musicxml.js";
import { gmByName } from "../gm.js";
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
const plain = (s) => s.replace(/\^(flat|sharp|natural)\(\)/g, (_, a) => ({ flat: "♭", sharp: "♯", natural: "♮" })[a]).replace(/\^\w+\([^)]*\)/g, "").replace(/\^\^/g, "^").trim();

// Articulation symbols -> Coda marks (DESIGN §16). SMuFL fonts use code points U+E4A0…; the older
// Finale music fonts (Maestro and its look-alikes) use plain character codes.
const SMUFL_MARKS = {
  0xe4a0: ["accent"], 0xe4a2: ["staccato"], 0xe4a4: ["tenuto"], 0xe4ac: ["marcato"], 0xe4ae: ["marcato", "staccato"],
  0xe4b0: ["accent", "staccato"], 0xe4b2: ["tenuto", "staccato"], 0xe4b4: ["tenuto", "accent"],
};
const smuflMarks = (c) => (c >= 0xe4c0 && c <= 0xe4cb ? ["fermata"] : SMUFL_MARKS[c & ~1] || null); // even = above, odd = below
// The codes all five fonts share, checked against openmusx/smufl-mapping's legacy glyph tables
// (46 and 62 also seen in a real file). Font-specific codes (tenuto+accent) are counted.
const LEGACY_MARKS = {
  45: ["tenuto"], 46: ["staccato"], 62: ["accent"], 94: ["marcato"], 118: ["marcato"], 85: ["fermata"], 117: ["fermata"],
  60: ["tenuto", "staccato"], 248: ["tenuto", "staccato"], 223: ["accent", "staccato"], 249: ["accent", "staccato"],
  172: ["marcato", "staccato"], 232: ["marcato", "staccato"],
};
const LEGACY_FONTS = /^(Maestro|Petrucci|Jazz|Broadway Copyist|Engraver Font Set)$/i;
// Legacy fonts are keyed by Mac Roman byte; the file stores the character those bytes decode to
// (pp is "π", byte 185). Back to the byte; plain codes under 256 when no Mac Roman character matches.
const MAC_BYTE = (() => {
  const m = new Map();
  try { [...new TextDecoder("macintosh").decode(Uint8Array.from({ length: 128 }, (_, i) => 128 + i))].forEach((c, i) => m.set(c.codePointAt(0), 128 + i)); }
  catch { /* no Mac Roman decoder: plain codes only */ }
  return m;
})();
const legacyCode = (cp) => (cp < 128 ? cp : MAC_BYTE.get(cp) ?? (cp < 256 ? cp : null));
// Files saved on Windows store the Windows character instead (fff is "ì", 236): try that second.
const legacy = (table, cp) => table[legacyCode(cp)] ?? (cp < 256 ? table[cp] : undefined);

// Dynamic glyphs -> letters (DESIGN §22): SMuFL U+E520…, and the codes the five legacy fonts share
// in openmusx/smufl-mapping. The joined letters go through MusicXML's table (pppp -> ppp, sfp -> fp…).
const SMUFL_DYN = {
  0xe520: "p", 0xe521: "m", 0xe522: "f", 0xe523: "r", 0xe524: "s", 0xe525: "z", 0xe526: "n", 0xe527: "pppppp", 0xe528: "ppppp",
  0xe529: "pppp", 0xe52a: "ppp", 0xe52b: "pp", 0xe52c: "mp", 0xe52d: "mf", 0xe52e: "pf", 0xe52f: "ff", 0xe530: "fff", 0xe531: "ffff",
  0xe532: "fffff", 0xe533: "ffffff", 0xe534: "fp", 0xe535: "fz", 0xe536: "sf", 0xe537: "sfp", 0xe538: "sfpp", 0xe539: "sfz",
  0xe53a: "sfzp", 0xe53b: "sffz", 0xe53c: "rf", 0xe53d: "rfz",
};
const LEGACY_DYN = {
  70: "mf", 80: "mp", 83: "sf", 90: "fz", 102: "f", 112: "p", 115: "s", 122: "z", 130: "sfp", 141: "sffz", 167: "sfz",
  175: "pppp", 182: "sfpp", 184: "ppp", 185: "pp", 189: "m", 196: "ff", 234: "fp", 235: "ffff", 236: "fff",
};

// Lyric text -> syllables, as musxdom's LyricsTextBase::createSyllableInfo: hyphens and whitespace
// separate; a hyphen counts only right after a syllable, before any space; with smart word
// extensions underscores separate too and mark an extender. Formatting codes go without a trace.
export function syllablesOf(text, smartExt) {
  const raw = text.replace(/\^\w+\([^)]*\)/g, "").replace(/\^\^/g, "^");
  const out = [];
  let cur = "", inSep = false, sawSpace = false, hyph = false, unders = 0;
  for (const c of raw) {
    if (c === "-" || c <= " " || (smartExt && c === "_")) {
      if (!inSep) { inSep = true; sawSpace = false; }
      if (c === "-") { if (!sawSpace && cur) hyph = true; }
      else { if (c === "_") unders++; sawSpace = true; }
    } else {
      if (inSep) {
        if (cur) { out.push({ text: cur, hyph, ext: unders > 0 }); cur = ""; }
        hyph = false; inSep = false; unders = 0;
      }
      cur += c;
    }
  }
  if (cur) out.push({ text: cur, hyph, ext: unders > 0 });
  return out;
}

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
    // repeat barlines (DESIGN §28): the measure's own flags, named as in musxdom's field populators
    // (no sample here has repeats). ponytail: endings (repeatEndingStart) and text repeats
    // (textRepeatAssign) are only counted; read them when a real file with them turns up.
    if (has(m, "barEnding")) report.count("Repeat endings (not read from .musx yet)");
    if (has(m, "txtRepeats")) report.count("D.C., D.S., segno and coda (not read from .musx yet)");
    return { cmper: m.getAttribute("cmper"), rep: { ...(has(m, "forRepBar") ? { repStart: true } : {}), ...(has(m, "bacRepBar") ? { repEnd: 2 } : {}) },
      attrs: { key: Math.max(-7, Math.min(7, k.fifths)), time, sym } };
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
    measures: measuresFrom(measures.map((m) => m.attrs)).map((x, i) => Object.assign(x, measures[i].rep)),
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
    return LEGACY_FONTS.test(fontNames.get(String(num(d, "fontMain", 0))) || "") ? legacy(LEGACY_MARKS, c) || null : null;
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

  // lyrics (DESIGN §24): details lyrDataVerse/Chorus/Section per entry -> texts verse/chorus/section
  const smartExt = has(kid(kid(root, "options"), "lyricOptions"), "useSmartWordExtensions");
  const LYR_KINDS = [["lyrDataVerse", "verse"], ["lyrDataChorus", "chorus"], ["lyrDataSection", "section"]];
  const lyrTexts = new Map(LYR_KINDS.flatMap(([, t]) => kids(textsEl, t).map((e) => [`${t}/${e.getAttribute("number")}`, e.textContent])));
  const sylCache = new Map();
  const syllable = (key, n) => {
    if (!sylCache.has(key)) sylCache.set(key, syllablesOf(lyrTexts.get(key) || "", smartExt));
    return sylCache.get(key)[n - 1] || null;
  };
  const lyrics = new Map(); // entnum -> assignments, first verse first
  LYR_KINDS.forEach(([d, t], k) => {
    for (const a of details(d)) {
      const id = a.getAttribute("entnum");
      if (!lyrics.has(id)) lyrics.set(id, []);
      lyrics.get(id).push({ order: k * 10000 + num(a, "lyricNumber"), key: `${t}/${num(a, "lyricNumber")}`, syll: num(a, "syll") });
    }
  });
  for (const l of lyrics.values()) l.sort((a, b) => a.order - b.order);
  // each verse, chorus and section used becomes one lyric line, verses first
  const lines = [...new Map([...lyrics.values()].flat().sort((a, b) => a.order - b.order).map((a) => [a.key, 0])).keys()];

  const clefLists = new Map();
  for (const c of others("clefList")) {
    const id = c.getAttribute("cmper");
    if (!clefLists.has(id)) clefLists.set(id, []);
    clefLists.get(id).push({ inci: attr(c, "inci") || 0, clef: num(c, "clef"), at: num(c, "xEduPos") });
  }
  for (const l of clefLists.values()) l.sort((a, b) => a.inci - b.inci);

  // where each entry landed: entnum -> {si, L (Coda layer, 1-based), ev} or {grace: true}; startOf: file time in the bar
  const placed = new Map(), startOf = new Map(), v2Layer = new Map(); // v2Layer: "si/mi/src" -> Coda layer
  const graceIds = new Set();

  staffIds.forEach((sid, si) => {
    const spec = staffSpecs.get(sid);
    let clefId = num(spec, "defaultClef", 0);
    const staff = { name: textOf(num(spec, "fullName", -1)), clef: null, brace: braces.has(si), bars: [] };
    const gm = gmByName(staff.name);
    const upper = si > 0 && braces.has(si - 1) && !isPerc(score.staves[si - 1]) ? score.staves[si - 1] : null; // lower staff of a braced pair (a drum staff above has no brace)
    if (upper) { if (upper.program !== undefined) staff.program = upper.program; }
    else if (gm) staff.program = gm.program;
    else if (staff.name && !/piano/i.test(staff.name) && str(spec, "notationStyle") !== "percussion") report.count("Parts with no instrument sound found (played as piano)"); // an unnamed staff has nothing to go on
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
      const lyrLost = () => lyrics.has(id) && report.count("Lyrics on rests (not imported)", lyrics.get(id).length);
      const skip = (label) => { report.count(label, Math.max(1, num(e, "numNotes", 0))); lyrLost(); return null; };
      ts.last = 0; // the entry's real length in ticks, from the file (tuplet ratio applied)
      if (has(e, "graceNote")) return null; // the caller keeps it for the next note
      if (has(e, "ignore")) { ts.last = (num(e, "dura", 0) * 480) / 1024; report.count("Hidden placeholder entries shown as rests"); lyrLost(); return null; }
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
      ts.last = ts.tup ? (ticks * ts.tup[1]) / ts.tup[0] : ticks;
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
      for (const a of lyrics.get(id) || []) {
        const sy = syllable(a.key, a.syll), v = lines.indexOf(a.key);
        if (!sy) report.count("Lyrics with missing text (not imported)");
        else if (!ev.pitches.length) report.count("Lyrics on rests (not imported)");
        else if (v >= MAX_VERSES) report.count(`Lyrics beyond verse ${MAX_VERSES} (not imported)`);
        else if (ev.lyrics?.[v]) report.count("Second lyrics in the same verse on one note (not imported)");
        else {
          if (sy.text.length > MAX_LYRIC) report.count("Long lyrics shortened");
          if (sy.ext) report.count("Lyric extender lines (not imported)");
          setLyric(ev, sy.text, sy.hyph, v);
        }
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

    // grace notes (DESIGN §26): first note of each grace entry, put on the next note of the voice
    const readGrace = (e, id, mi) => {
      graceIds.add(id);
      if (!has(e, "isNote")) { report.count("Grace rests (not imported)"); return null; }
      const ns = kids(e, "note");
      if (ns.length > 1) report.count("Grace-note chords reduced to their first note");
      if (artics.has(id) || lyrics.has(id) || ns.some((n) => has(n, "tieStart"))) report.count("Marks, slurs, ties and lyrics on grace notes (not imported)");
      return ns.length ? { p: pitchOf(mKeys[mi], num(ns[0], "harmLev"), num(ns[0], "harmAlt")), dura: num(e, "dura", 0) } : null;
    };
    const giveGraces = (pend, ev) => {
      if (!pend.length) return;
      const g = pend.splice(0);
      if (!ev || !ev.pitches.length) { report.count("Grace notes before rests (not imported)", g.length); return; }
      if (g.length > MAX_GRACE) report.count(`Grace notes beyond ${MAX_GRACE} before a note (not imported)`, g.length - MAX_GRACE);
      const kept = g.slice(0, MAX_GRACE);
      if (kept.length === 1 ? kept[0].dura !== 512 : kept.some((x) => x.dura !== 256)) report.count("Grace notes redrawn: one as a slashed eighth, more as sixteenths", kept.length);
      ev.grace = kept.map((x) => x.p);
    };
    // a hidden entry still takes time: rests in its place keep later notes where the file has them
    const gapRests = (ticks) => splitTicks(Math.floor(ticks / 60) * 60).map((d) => ({ dur: d.dur, dots: d.dots, tie: false, pitches: [] }));
    measures.forEach((m, mi) => {
      const g = gf.get(`${sid}/${m.cmper}`);
      staff.bars.push([]);
      if (!g) return;
      // clef changes (DESIGN §25): the bar's clef, or the last of its clef list; mid-bar ones move to the bar's start
      let c = null;
      if (has(g, "clefListID")) {
        const list = clefLists.get(String(num(g, "clefListID"))) || [];
        if (list.some((x) => x.at > 0)) report.count("Clef changes inside a bar moved to its start");
        if (list.length) c = list[list.length - 1].clef; else report.count("Unsupported clef changes (not imported)");
      } else if (has(g, "clefID")) c = num(g, "clefID");
      if (c !== null && mi === 0) clefId = c;
      else if (c !== null && c !== (staff.lastClef ?? clefId)) {
        const name = clefFor(c);
        if (name) (staff.clefs ||= {})[mi] = name; else report.count("Unsupported clef changes (not imported)");
      }
      if (c !== null) staff.lastClef = c;
      // each frame (layer 1–4) becomes a layer of the staff (DESIGN §15); voice-2 runs start where
      // their launching voice-1 entry starts and go to a layer no frame uses in this bar
      const used = new Set(), runs = [];
      const extrasLost = (evs) => { // lyrics and grace notes go with the notes they were on
        const ly = evs.reduce((n, e) => n + (e.lyrics || []).filter(Boolean).length, 0), gr = evs.reduce((n, e) => n + (e.grace || []).length, 0);
        if (ly) report.count("Lyrics on skipped notes (not imported)", ly);
        if (gr) report.count("Grace notes before skipped notes (not imported)", gr);
      };
      for (const l of [1, 2, 3, 4]) {
        if (!has(g, `frame${l}`)) continue;
        const frame = frames.get(String(num(g, `frame${l}`)));
        if (!frame) { report.count("Measures with missing note data"); continue; }
        used.add(l);
        const bar = layerBar(l, mi), v1 = { tup: null, left: 0 }, v2 = { tup: null, left: 0 }, g1 = [], g2 = [];
        const at = (ev, t0) => { startOf.set(ev, t0); return ev; };
        const rests = (ticks, t0) => gapRests(ticks).map((r) => { const x = at(r, t0); t0 += eventTicks(r); return x; });
        const end = String(num(frame, "endEntry", -1));
        let id = String(num(frame, "startEntry", -1)), guard = 0, run = null, t = 0; // t: voice-1 time from the file
        while (id !== "0" && entries.has(id) && guard++ < 10000) {
          const e = entries.get(id);
          const voice2 = has(e, "v2") || has(e, "voice2");
          if (has(e, "graceNote")) { const gr = readGrace(e, id, mi); if (gr) (voice2 ? g2 : g1).push(gr); }
          else if (voice2) {
            const t0 = run ? run.t : 0, ev = readEntry(e, id, mi, v2);
            if (run) run.t += v2.last;
            giveGraces(g2, ev);
            if (!ev && run && v2.last > 0) run.events.push(...rests(v2.last, t0));
            else if (ev && run) { run.events.push(at(ev, t0)); run.ids.push([id, ev]); }
            else if (ev) { report.count("Second-voice notes with no start skipped", Math.max(1, ev.pitches.length)); extrasLost([ev]); }
          } else {
            const start = t, ev = readEntry(e, id, mi, v1);
            t += v1.last;
            giveGraces(g1, ev);
            if (ev) { bar.push(at(ev, start)); placed.set(id, { si, L: l, ev }); }
            else if (v1.last > 0) bar.push(...rests(v1.last, start));
            run = has(e, "controller") ? { src: l, start, t: start, events: [], ids: [] } : null;
            if (run) { runs.push(run); Object.assign(v2, { tup: null, left: 0 }); }
          }
          if (id === end) break;
          id = e.getAttribute("next") || "0";
        }
        const left = g1.length + g2.length;
        if (left) report.count("Grace notes with no note after them in the bar (not imported)", left);
      }
      const target = {};
      for (const run of runs) {
        if (!run.events.length) continue;
        target[run.src] ||= [1, 2, 3, 4].find((L) => !used.has(L) && L <= MAX_LAYERS);
        const L = target[run.src];
        const lost = () => { report.count("Notes in second voices skipped", run.events.reduce((n, e) => n + Math.max(1, e.pitches.length), 0)); extrasLost(run.events); };
        if (!L) { lost(); continue; }
        used.add(L);
        v2Layer.set(`${si}/${mi}/${run.src}`, L);
        const bar = layerBar(L, mi), at = barTicks(bar), rests = splitTicks(run.start - at).map((d) => ({ dur: d.dur, dots: d.dots, pitches: [] }));
        // starts before the layer's end, can't be reached with plain rests, or overfills the bar
        if (run.start < at || barTicks(rests) !== run.start - at || run.start + barTicks(run.events) > barCapacity(m.attrs.time)) { lost(); continue; }
        let t0 = at;
        for (const r of rests) { startOf.set(r, t0); t0 += eventTicks(r); }
        bar.push(...rests, ...run.events);
        for (const [id, ev] of run.ids) placed.set(id, { si, L, ev });
      }
    });
    staff.clef = clefFor(clefId);
    delete staff.lastClef;
    // a Finale drum staff (DESIGN §27): its percussion map isn't read yet, so drums come from staff position
    const perc = str(spec, "notationStyle") === "percussion";
    if (perc) {
      drumReport(report, toDrumStaff(staff, score.staves[si - 1], true), "Finale drum maps aren't read yet: drums chosen by staff position");
    } else if (!staff.clef) { staff.clef = "treble"; report.count("Unsupported clefs shown as treble"); }

    // a tie needs the same pitch next in its layer; ties into another voice are dropped
    for (const bars of allLayers(staff)) {
      const seq = bars.flat();
      seq.forEach((ev, i) => {
        if (ev.tie && !seq[i + 1]?.pitches.some((q) => ev.pitches.some((p) => (p.drum ?? midi(p)) === (q.drum ?? midi(q))))) {
          delete ev.tie; report.count("Ties with no matching next note dropped");
        }
      });
    }
    // notes are stored at concert pitch; Coda keeps them written
    const t = !perc && trs[si];
    if (t) {
      const all = allLayers(staff).flat(2);
      const ok = (p) => midi(p) - t[0] >= 0 && midi(p) - t[0] <= 127;
      if (all.every((ev) => ev.pitches.every(ok) && (ev.grace || []).every(ok))) {
        for (const ev of all) {
          ev.pitches = ev.pitches.map((p) => shiftPitch(p, -t[0], -t[1]));
          if (ev.grace) ev.grace = ev.grace.map((p) => shiftPitch(p, -t[0], -t[1]));
        }
        staff.transpose = [...t];
        // "set to clef": Finale writes the whole staff in its transposed clef
        const tx = kid(spec, "transposition");
        if (has(tx, "setToClef")) {
          const tc = clefFor(num(spec, "transposedClef", 0));
          if (tc) {
            if (staff.clefs) { report.count("Clef changes on staves with a transposed clef (not imported)", Object.keys(staff.clefs).length); delete staff.clefs; }
            staff.clef = tc;
          } else report.count("Unsupported clefs shown as treble");
        }
      } else report.count("Transposed notes out of range (shown at concert pitch)");
    }
    score.staves.push(staff);
  });

  // tempo marks (DESIGN §29): expressions that set the playback tempo, value × auxdata1/1024 quarters a minute
  const exprDefs = byCmper(others("textExprDef"));
  const assigns = others("measExprAssign");
  const tempoDef = (a) => { const d = exprDefs.get(String(num(a, "textExprID", -1))); return str(d, "playType") === "time" && has(d, "useAuxData") ? d : null; };
  const tempi = [], tempoMarks = new Set(), mIndex = new Map(measures.map((m, i) => [m.cmper, i]));
  for (const a of assigns) {
    const d = tempoDef(a), mi = mIndex.get(a.getAttribute("cmper"));
    const bpm = d && (num(d, "value", 0) * num(d, "auxdata1", 1024)) / 1024;
    if (!(bpm > 0) || mi === undefined) continue; // not a tempo: counted with the text expressions
    tempoMarks.add(a);
    readTempo(tempi, mi, num(a, "horzEduOff", 0), bpm, report);
  }
  // the event at file time t (ticks) in a layer's bar: one starting within ~4 EDU, else the one covering t
  const bar = (si, L, mi) => (L === 1 ? score.staves[si]?.bars[mi] : score.staves[si]?.layers?.[L - 2]?.[mi]) || [];
  const eventAt = (evs, t) => evs.find((ev) => Math.abs(startOf.get(ev) - t) <= 2) ||
    evs.find((ev) => startOf.get(ev) <= t && t < startOf.get(ev) + eventTicks(ev)) || null;

  // dynamics (DESIGN §22): expressions in the dynamics category, or whose text is a dynamic
  const cats = byCmper(others("markingsCategory"));
  const exprText = new Map(kids(textsEl, "expression").map((e) => [e.getAttribute("number"), e]));
  const dynOf = (def) => {
    const raw = exprText.get(String(num(textBlocks.get(String(num(def, "textIDKey", -1))), "textID", -1)))?.textContent || "";
    const isDyn = str(cats.get(String(num(def, "categoryID", -1))), "categoryType") === "dynamics";
    let font = null;
    const m = /\^font(?:Mus|Txt|Num)?\(([^,)]*)/.exec(raw) || null;
    if (m) font = /^Font(\d+)$/.test(m[1]) ? fontNames.get(m[1].slice(4)) : m[1];
    const id = /\^fontid\((\d+)/.exec(raw);
    if (id) font = fontNames.get(id[1]);
    const body = [...raw.replace(/\^\w+\([^)]*\)/g, "").replace(/\^\^/g, "^").trim()];
    let word;
    if (body.length && body.every((c) => SMUFL_DYN[c.codePointAt(0)])) word = body.map((c) => SMUFL_DYN[c.codePointAt(0)]).join("");
    else if (body.length === 1 && LEGACY_FONTS.test(font || "")) word = legacy(LEGACY_DYN, body[0].codePointAt(0));
    else if (isDyn) word = body.join("").toLowerCase();
    const d = word && (DYNS.includes(word) ? word : DYN_IN[word]);
    return d ? { dyn: d } : isDyn ? { odd: true } : null;
  };
  const dynCache = new Map();
  let expr = 0;
  for (const a of assigns) {
    if (tempoMarks.has(a)) continue;
    const defId = String(num(a, "textExprID", -1));
    if (!dynCache.has(defId)) dynCache.set(defId, dynOf(exprDefs.get(defId)));
    const d = dynCache.get(defId), mi = mIndex.get(a.getAttribute("cmper"));
    if (!d) { expr++; continue; }
    if (d.odd) { report.count("Unusual dynamics (not imported)"); continue; }
    if (has(a, "hidden")) { report.count("Hidden dynamics (not imported)"); continue; }
    if (num(a, "graceNoteIndex", 0)) { report.count("Dynamics on grace notes (not imported)"); continue; }
    const sa = num(a, "staffAssign", 0), si = sa === -1 ? 0 : sa === -2 ? staffIds.length - 1 : staffIds.indexOf(String(sa));
    if (si < 0 || mi === undefined) { report.count("Dynamics on staves or bars not found (not imported)"); continue; }
    const t = (num(a, "horzEduOff", 0) * 480) / 1024, l = num(a, "layer", 0);
    // a layer's voice 2 counts as that layer unless the mark is for voice 2 only
    const v2L = l && v2Layer.get(`${si}/${mi}/${l}`), Ls = !l ? [1, 2, 3, 4] : has(a, "v2") ? [v2L] : [l, v2L];
    let ev = null;
    for (const L of Ls) if (L && (ev = eventAt(bar(si, L, mi).filter((x) => x.pitches.length), t))) break;
    // between notes: the next note, as MusicXML does; a bar with no notes is a whole-bar rest
    const notes = (m) => Ls.flatMap((L) => (L ? bar(si, L, m) : [])).filter((x) => x.pitches.length).sort((x, y) => startOf.get(x) - startOf.get(y));
    if (!ev && !notes(mi).length) { report.count("Dynamics on whole-bar rests (not imported)"); continue; }
    if (!ev) ev = notes(mi).find((x) => startOf.get(x) >= t);
    for (let m = mi + 1; !ev && m < measures.length; m++) ev = notes(m)[0];
    if (!ev) report.count("Dynamics after the last note (not imported)");
    else if (ev.dyn) report.count("Two dynamics on one note (the first kept)");
    else ev.dyn = d.dyn;
  }
  if (expr) report.count("Text expressions (not imported)", expr);

  // slurs and hairpins (DESIGN §23) from smart shapes; the rest are counted
  const SLURS = /^(slur|dashSlur|dashContourSlur)(Up|Down|Auto)$|^$/;
  const endOf = (pt, entryBased) => {
    if (!pt) return null;
    if (entryBased) {
      const id = String(num(pt, "entryNum", -1));
      return placed.get(id) || (graceIds.has(id) ? { grace: true } : null);
    }
    const si = staffIds.indexOf(String(num(pt, "inst", -1))), mi = mIndex.get(String(num(pt, "meas", -1)));
    if (si < 0 || mi === undefined) return null;
    const evs = bar(si, 1, mi), t = (num(pt, "edu", 0) * 480) / 1024;
    const ev = eventAt(evs, t) || (t >= barTicks(evs) ? evs[evs.length - 1] : null);
    return ev ? { si, L: 1, ev } : null;
  };
  const pos = new Map(), spans = {}; // event -> place in its layer; placed [from, to] by staff:layer:kind
  for (const st of score.staves) for (const bars of allLayers(st)) bars.flat().forEach((ev, i) => pos.set(ev, i));
  for (const sh of others("smartShape")) {
    const type = str(sh, "shapeType") || "";
    const kind = SLURS.test(type) ? "slur" : type === "cresc" || type === "decresc" ? "hp" : null;
    if (!kind) {
      if (type === "wordExt") report.count("Lyric extender lines (not imported)");
      else if (type !== "hyphen") report.count("Lines, trills, octave signs and other shapes (not imported)");
      continue;
    }
    const eb = has(sh, "entryBased");
    const a = endOf(kid(kid(sh, "startTermSeg"), "endPt"), eb), b = endOf(kid(kid(sh, "endTermSeg"), "endPt"), eb);
    const label = kind === "slur" ? "Slurs" : "Hairpins";
    if (a?.grace || b?.grace) report.count("Marks, slurs, ties and lyrics on grace notes (not imported)");
    else if (!a || !b) report.count(`${label} on notes not found (not imported)`);
    else if (a.si !== b.si || a.L !== b.L) report.count(`${label} across staves or voices (not imported)`);
    else if (a.ev === b.ev) report.count(kind === "hp" ? "Hairpins over a single note (not imported)" : "Slurs over a single note (not imported)");
    else if (pos.get(a.ev) > pos.get(b.ev) || (spans[`${a.si}:${a.L}:${kind}`] ||= []).some(([x, y]) => pos.get(a.ev) <= y && pos.get(b.ev) >= x))
      report.count("Unfinished or overlapping slurs and hairpins (not imported)");
    else {
      spans[`${a.si}:${a.L}:${kind}`].push([pos.get(a.ev), pos.get(b.ev)]);
      a.ev[kind] = kind === "hp" ? (type === "cresc" ? "<" : ">") : true;
      b.ev[`${kind}End`] = true;
      if (/^dash/.test(type)) report.count("Dashed slurs shown solid");
    }
  }
  padBars(score);
  applyTempi(score, tempi, report);
  const broken = clearBrokenSpans(score);
  if (broken) report.count("Unfinished or overlapping slurs and hairpins (not imported)", broken);
  const lateClefs = finishClefs(score);
  if (lateClefs) report.count("Clef changes after the last bar (not imported)", lateClefs);
  report.notes = noteCount(score);
  return { score, report: report.done() };
}
