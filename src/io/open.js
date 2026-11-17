// Detect a file's format by content (then extension) and import it. See docs/DESIGN.md §9.1.
import { decodeText, MAX_FILE, zipNames } from "./util.js";
import { isValidScore, noteCount } from "../model.js";

export const LEGACY_MUS =
  "This is a legacy Finale file (.mus, 2012 and earlier). The format is closed and undocumented, " +
  "so Coda can't read it directly. If you have a copy of Finale (2014 or later) or Finale NotePad, " +
  "open the file there and export it as MusicXML, or save it as .musx, then open that file here.";

const startsWith = (b, sig) => sig.every((v, i) => b[i] === v);

export function sniff(bytes, name = "") {
  const ext = (name.match(/\.([^.]+)$/) || [, ""])[1].toLowerCase();
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    let names;
    try { names = zipNames(bytes); } catch { return { kind: "bad-zip" }; }
    if (names.includes("score.dat")) return { kind: "musx" };
    if (names.some((n) => /\.mscx$/i.test(n))) return { kind: "mscz" };
    if (names.includes("META-INF/container.xml") || ext === "mxl") return { kind: "mxl" };
    return { kind: "unknown-zip" };
  }
  if (startsWith(bytes, [0x4d, 0x54, 0x68, 0x64])) return { kind: "midi" };
  // RIFF-wrapped MIDI (.rmi)
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x52, 0x4d, 0x49, 0x44])) return { kind: "midi" };
  const head = decodeText(bytes.subarray(0, 4096)).replace(/^﻿/, "");
  if (/^\s*</.test(head)) {
    // root element = first tag that isn't a declaration, comment, or DOCTYPE
    const m = /<(?![?!])([A-Za-z_][\w.-]*)/.exec(head.replace(/<!--[\s\S]*?-->/g, ""));
    const root = m ? m[1] : "";
    if (root === "score-partwise") return { kind: "musicxml" };
    if (root === "score-timewise") return { kind: "musicxml" }; // importer explains
    if (root === "finale") return { kind: "enigmaxml" };
    if (root === "museScore") return { kind: "mscx" };
    return { kind: "xml-other", root };
  }
  if (ext === "mus") return { kind: "mus" };
  if (head.trimStart().startsWith("{")) return { kind: "json" };
  return { kind: "unknown" };
}

export async function importBytes(bytes, name = "") {
  const { kind, root } = sniff(bytes, name);
  switch (kind) {
    case "musicxml": return (await import("./musicxml.js")).importMusicXML(decodeText(bytes), name);
    case "mxl": return (await import("./musicxml.js")).importMXL(bytes, name);
    case "midi": return (await import("./midi.js")).importMIDI(bytes, name);
    case "mscz": return (await import("./mscz.js")).importMSCZ(bytes, name);
    case "mscx": return (await import("./mscz.js")).importMSCX(decodeText(bytes), name);
    case "musx": return (await import("./musx.js")).importMUSX(bytes, name);
    case "enigmaxml": return (await import("./musx.js")).importEnigmaXML(decodeText(bytes), name);
    case "mus": throw new Error(LEGACY_MUS);
    case "json": {
      // A Coda autosave/backup copied to a file.
      let sc = null;
      try { sc = JSON.parse(decodeText(bytes)); } catch { /* fall through */ }
      if (isValidScore(sc)) return { score: sc, report: { format: "Coda backup", notes: noteCount(sc), warnings: [] } };
      throw new Error("Coda doesn't recognise this file.");
    }
    case "bad-zip": throw new Error("This archive is damaged and can't be opened.");
    case "unknown-zip": throw new Error("This archive doesn't contain a score Coda can read.");
    case "xml-other": throw new Error(`This XML file (<${root}>) isn't a score format Coda can read.`);
    default: throw new Error("Coda doesn't recognise this file.");
  }
}

export async function openFile(file) {
  if (file.size > MAX_FILE) throw new Error("This file is too large to open (over 50 MB).");
  const bytes = new Uint8Array(await file.arrayBuffer());
  return importBytes(bytes, file.name);
}
