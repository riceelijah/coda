// .musx checks (Phase 6). Only the container decode is testable without real Finale files.
import { crypt, decodeMusx, NOT_YET } from "./musx.js";

export async function run({ check, importBytes }) {
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

  await check("musx: opening says conversion isn't finished (until Phase 6 is done)", async () => {
    try { await importBytes(fake(), "x.musx"); return "no error"; }
    catch (e) { return e.message === NOT_YET || e.message; }
  });

  await check("musx: damaged score.dat gives a message", async () => {
    const bad = fflate.zipSync({ "score.dat": new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) });
    try { await importBytes(bad, "bad.musx"); return "no error"; }
    catch (e) { return /damaged|decoded|valid/.test(e.message) || e.message; }
  });
}
