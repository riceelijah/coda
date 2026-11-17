// Finale .musx import. See docs/DESIGN.md §9.5.
//
// Status: the container decode (unzip -> decrypt score.dat -> gunzip -> EnigmaXML) is done.
// Mapping EnigmaXML to the score model is NOT written yet: docs/PLAN.md Phase 6 requires real
// .musx files to confirm element names before that code is written.
import { decodeText, parseXml, unzip } from "./util.js";

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

export const NOT_YET =
  "Coda can unpack this Finale file, but converting its notation isn't finished yet. " +
  "Until it is, open the file in Finale or Finale NotePad and export it as MusicXML, then open that here.";

export function importMUSX(bytes) {
  const text = decodeMusx(bytes);
  parseXml(text); // confirms the decoded data is intact
  throw new Error(NOT_YET);
}

export function importEnigmaXML(text) {
  const doc = parseXml(text);
  if (doc.documentElement.localName !== "finale") throw new Error("This isn't an EnigmaXML file.");
  throw new Error(NOT_YET);
}
