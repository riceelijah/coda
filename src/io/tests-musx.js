// .musx checks (Phase 6). Samples in samples/musx are musxdom's test files (MIT, see README there);
// expected pitches for keysigs come from musxdom's own KeySigs test.
import { crypt, decodeMusx } from "./musx.js";

export async function run({ check, brief, fetchBytes, importBytes }) {
  await check("musx: crypt is symmetric and resets every 128 KiB", () => {
    const x = new Uint8Array(0x20000 * 2 + 77);
    for (let i = 0; i < x.length; i++) x[i] = (i * 31) & 0xff;
    const once = crypt(x), twice = crypt(once);
    if (!twice.every((v, i) => v === x[i])) return "not symmetric";
    // the keystream restarts at each 128 KiB block, so block 0 and block 1 use the same key bytes
    const k0 = crypt(new Uint8Array(16)), k1 = crypt(new Uint8Array(0x20000 + 16)).subarray(0x20000);
    return k0.every((v, i) => v === k1[i]) || "no reset";
  });

  // A synthetic .musx built the same way Finale stores one: gzip(EnigmaXML) -> crypt -> zip as score.dat.
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<finale version="27.4" xmlns="http://www.makemusic.com/2012/finale"><header/><others/></finale>';
  const fake = () => fflate.zipSync({ "score.dat": crypt(fflate.gzipSync(new TextEncoder().encode(xml))) });

  await check("musx: decode pipeline (unzip, decrypt, gunzip)", () => {
    const text = decodeMusx(fake());
    return text === xml || text.slice(0, 80);
  });

  await check("musx: file with no measures gives a message", async () => {
    try { await importBytes(fake(), "x.musx"); return "no error"; }
    catch (e) { return /no measures/.test(e.message) || e.message; }
  });

  await check("musx: damaged score.dat gives a message", async () => {
    const bad = fflate.zipSync({ "score.dat": new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) });
    try { await importBytes(bad, "bad.musx"); return "no error"; }
    catch (e) { return /damaged|decoded|valid/.test(e.message) || e.message; }
  });

  const open = async (n) => importBytes(await fetchBytes(`samples/musx/${n}.musx`), `${n}.musx`);
  const bars = (staff, from, to) => brief({ bars: staff.bars.slice(from, to) });
  const warn = (r) => r.report.warnings.join("; ");

  await check("musx sample: keysigs (major, minor, modes, non-linear)", async () => {
    const { score } = await open("keysigs");
    const line = "E4:8 F#4:8 G4:8 Ab4:8 Bb4:8 C5:8 D5:8 Eb5:8";
    const want = Array(5).fill(line).join(" | ");
    const got = bars(score.staves[0], 0, 5);
    if (got !== want) return `got ${got}`;
    const keys = score.measures.slice(0, 5).map((m) => m.key).join(",");
    return keys === "-4,5,-2,3,0" || `keys ${keys}`;
  });

  await check("musx sample: enharmonics", async () => {
    const { score } = await open("enharmonics_test");
    const got = brief(score.staves[0]);
    return got === "A4:q B4:q C#5:q D5:q | E5:q F#5:q G#5:q A5:q | Eb4:q F4:q G4:q Ab4:q | Bb4:q C5:q D5:q Eb5:q" || got;
  });

  await check("musx sample: quintuplet", async () => {
    const { score } = await open("quintuplet");
    const got = brief(score.staves[0]);
    return got === "F4:8/5:4 G4:8/5:4 A4:8/5:4 B4:8/5:4 C5:8/5:4 r:h" || got;
  });

  await check("musx sample: grace notes are reported", async () => {
    const r = await open("grace_notes");
    const got = brief(r.score.staves[0]);
    if (got !== "r:h D5:h") return got;
    return /Grace notes skipped: 8/.test(warn(r)) || warn(r);
  });

  await check("musx sample: layers (first layer used, others reported)", async () => {
    const r = await open("layers");
    const got = r.score.staves.map((s) => brief(s)).join(" / ");
    if (got !== " | C5:w / A4:w | ") return got;
    return /other layers skipped: 1/.test(warn(r)) || warn(r);
  });

  await check("musx: ties, dotted values, chords and skipped markings (inline EnigmaXML)", async () => {
    const x = `<finale xmlns="http://www.makemusic.com/2012/finale"><others>
      <measSpec cmper="1"><beats>4</beats><divbeat>1024</divbeat></measSpec>
      <instUsed cmper="0" inci="0"><inst>1</inst></instUsed><staffSpec cmper="1"/>
      <frameSpec cmper="1" inci="0"><startEntry>1</startEntry><endEntry>3</endEntry></frameSpec></others>
      <details><gfhold cmper1="1" cmper2="1"><frame1>1</frame1></gfhold></details><entries>
      <entry entnum="1" prev="0" next="2"><dura>1536</dura><isNote/><note id="1"><harmLev>0</harmLev><harmAlt>0</harmAlt><tieStart/></note></entry>
      <entry entnum="2" prev="1" next="3"><dura>512</dura><isNote/><articDetail/><note id="1"><harmLev>0</harmLev><harmAlt>0</harmAlt><tieEnd/></note><note id="2"><harmLev>2</harmLev><harmAlt>-1</harmAlt></note></entry>
      <entry entnum="3" prev="2" next="0"><dura>2048</dura><ignore/></entry></entries></finale>`;
    const r = await importBytes(new TextEncoder().encode(x), "inline.xml");
    const got = brief(r.score.staves[0]);
    if (got !== "C4:q.~ C4+Eb4:8") return got;
    return /articulations \(not imported\): 1/.test(warn(r)) && /placeholder entries skipped: 1/.test(warn(r)) || warn(r);
  });

  await check("musx sample: piano staves, clefs, names and brace", async () => {
    const { score } = await open("piano_inst");
    const got = score.staves.map((s) => `${s.name}|${s.clef}|${s.brace}`).join(" ");
    return got === "Piano RH|treble|true Piano LH|bass|false" || got;
  });
}
