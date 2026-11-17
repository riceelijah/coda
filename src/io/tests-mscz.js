// MuseScore import checks (Phase 5). Samples were made by converting the MusicXML samples
// with MuseScore 4 (`mscore -o samples/x.mscz samples/x.musicxml`).
import { tpcToPitch } from "./mscz.js";

export async function run({ check, eq, brief, fetchBytes, importBytes }) {
  await check("MuseScore tpc spelling", () => {
    const n = (tpc, m) => { const p = tpcToPitch(tpc, m); return "CDEFGAB"[p.step] + ["bb", "b", "", "#", "##"][p.alter + 2] + p.oct; };
    const got = [n(14, 60), n(12, 70), n(20, 66), n(7, 59), n(26, 60), n(2, 72)].join(" ");
    return got === "C4 Bb4 F#4 Cb4 B#3 Dbb5" || got;
  });

  for (const name of ["simple", "piano"]) {
    await check(`sample: ${name}.mscz matches ${name}.musicxml`, async () => {
      const a = await importBytes(await fetchBytes(`samples/${name}.musicxml`), `${name}.musicxml`);
      const b = await importBytes(await fetchBytes(`samples/${name}.mscz`), `${name}.mscz`);
      for (let s = 0; s < a.score.staves.length; s++) {
        if (brief(a.score.staves[s]) !== brief(b.score.staves[s])) return `staff ${s}\n  want ${brief(a.score.staves[s])}\n  got  ${brief(b.score.staves[s])}`;
        for (const k of ["clef", "brace", "name"]) if (a.score.staves[s][k] !== b.score.staves[s][k]) return `staff ${s} ${k}: ${b.score.staves[s][k]}`;
      }
      for (const k of ["title", "tempo", "measures"]) if (!eq(a.score[k], b.score[k])) return `${k}: ${JSON.stringify(b.score[k])}`;
      if (name === "simple" && b.score.composer !== "Coda Tests") return "composer " + b.score.composer;
      const wa = [...a.report.warnings].sort().join("; "), wb = [...b.report.warnings].sort().join("; ");
      return wa === wb || `warnings differ: "${wa}" vs "${wb}"`;
    });
  }

  await check("MuseScore archive without a score gives a message", async () => {
    const zip = fflate.zipSync({ "META-INF/container.xml": new TextEncoder().encode("<container/>"), "a.mscx": new Uint8Array(0) });
    const files = fflate.unzipSync(zip);
    delete files["a.mscx"];
    const noScore = fflate.zipSync({ ...files, "notes.mscx.txt": new Uint8Array(1) });
    try { await importBytes(noScore, "broken.mscz"); return "no error"; }
    catch (e) { return /score|archive|recognise|valid/i.test(e.message) || e.message; }
  });
}
