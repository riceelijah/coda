// Shared helpers for importers. Files are untrusted input (DESIGN §1.6).

export const MAX_FILE = 50 * 1024 * 1024;
export const MAX_ENTRY = 200 * 1024 * 1024;

// Decode XML bytes: honour a UTF-16/UTF-8 BOM, then an encoding="" declaration, else UTF-8.
export function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
  const m = /encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head);
  let label = m ? m[1].toLowerCase() : "utf-8";
  try { return new TextDecoder(label).decode(bytes); }
  catch { return new TextDecoder("utf-8").decode(bytes); }
}

export function parseXml(text) {
  // Strip a DOCTYPE so the parser never tries to resolve external DTDs or entities.
  const clean = text.replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/i, "");
  const doc = new DOMParser().parseFromString(clean, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("The file isn't valid XML (it may be damaged).");
  return doc;
}

// Unzip only the entries `want(name)` accepts, refusing oversized ones.
export function unzip(bytes, want) {
  let tooBig = false;
  const files = fflate.unzipSync(bytes, {
    filter: (f) => {
      if (!want(f.name)) return false;
      if (f.originalSize > MAX_ENTRY) { tooBig = true; return false; }
      return true;
    },
  });
  if (tooBig) throw new Error("A file inside this archive is too large to open.");
  return files;
}

export function zipNames(bytes) {
  const names = [];
  fflate.unzipSync(bytes, { filter: (f) => { names.push(f.name); return false; } });
  return names;
}

// Collects warnings; repeated kinds are counted ("Grace notes skipped: 12").
// Count the children of `el` an importer neither reads nor skips on purpose, so nothing in a file is
// dropped silently (CLAUDE.md). `read`: names handled elsewhere or recomputed by Coda (layout,
// stems, beams…). `names`: report labels for the ones users would recognise; others by tag name.
export function countUnread(report, el, read, names = {}) {
  for (const c of el?.children || []) {
    const t = c.localName;
    if (!read.has(t)) report.count(names[t] || `Other markings ("${t}") not imported`);
  }
}

export class Report {
  constructor(format) { this.format = format; this.counts = new Map(); this.lines = []; this.notes = 0; }
  count(label, n = 1) { this.counts.set(label, (this.counts.get(label) || 0) + n); }
  add(line) { if (!this.lines.includes(line)) this.lines.push(line); }
  done() {
    const warnings = [...this.lines];
    for (const [label, n] of this.counts) warnings.push(`${label}: ${n}`);
    return { format: this.format, notes: this.notes, warnings };
  }
}
