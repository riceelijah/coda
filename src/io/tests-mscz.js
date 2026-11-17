// MuseScore import checks (Phase 5). Samples were made by converting the MusicXML samples
// with MuseScore 4 (`mscore -o samples/x.mscz samples/x.musicxml`).
import { tpcToPitch, importMSCX } from "./mscz.js";

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
        const lay = (st) => (st.layers || []).map((L) => brief({ bars: L })).join(" / ");
        if (lay(a.score.staves[s]) !== lay(b.score.staves[s])) return `staff ${s} layers\n  want ${lay(a.score.staves[s])}\n  got  ${lay(b.score.staves[s])}`;
      }
      for (const k of ["title", "tempo", "measures"]) if (!eq(a.score[k], b.score[k])) return `${k}: ${JSON.stringify(b.score[k])}`;
      if (name === "simple" && b.score.composer !== "Coda Tests") return "composer " + b.score.composer;
      const wa = [...a.report.warnings].sort().join("; "), wb = [...b.report.warnings].sort().join("; ");
      return wa === wb || `warnings differ: "${wa}" vs "${wb}"`;
    });
  }

  await check("MuseScore instruments: program from the file, else the part name (DESIGN §13.2)", async () => {
    const b = await importBytes(await fetchBytes("samples/simple.mscz"), "simple.mscz");
    if (b.score.staves[0].program !== 73) return "flute by name: " + b.score.staves[0].program;
    const files = fflate.unzipSync(await fetchBytes("samples/simple.mscz"));
    const path = Object.keys(files).find((k) => k.endsWith(".mscx"));
    const text = new TextDecoder().decode(files[path]).replace('<program value="0"/>', '<program value="41"/>');
    const p = importMSCX(text, "x.mscx").score.staves[0].program;
    return p === 41 || "program " + p;
  });

  await check("MuseScore voices become layers; <location> moves a cursor, gaps become rests (DESIGN §15)", () => {
    const chord = (dt, p, tpc) => `<Chord><durationType>${dt}</durationType><Note><pitch>${p}</pitch><tpc>${tpc}</tpc></Note></Chord>`;
    const loc = (f) => `<location><fractions>${f}</fractions></location>`;
    const x = `<museScore version="4.20"><Score><Part><Staff id="1"/><trackName>P</trackName></Part>
      <Staff id="1"><Measure><voice><TimeSig><sigN>4</sigN><sigD>4</sigD></TimeSig>${loc("1/2")}<Dynamic><subtype>p</subtype></Dynamic>${loc("-1/2")}${chord("whole", 60, 14)}</voice>
      <voice>${loc("1/2")}${chord("half", 64, 18)}</voice></Measure></Staff></Score></museScore>`;
    const st = importMSCX(x, "x.mscx").score.staves[0];
    const l2 = st.layers ? brief({ bars: st.layers[0] }) : "";
    return (brief(st) === "C4:w" && l2 === "r:h E4:h") || `${brief(st)} / ${l2}`;
  });

  await check("MuseScore fermata, articulations and cut time (DESIGN §16, §17)", () => {
    const x = `<museScore version="4.20"><Score><Part><Staff id="1"/><trackName>P</trackName></Part>
      <Staff id="1"><Measure><voice><TimeSig><subtype>2</subtype><sigN>2</sigN><sigD>2</sigD></TimeSig>
      <Fermata><subtype>fermataAbove</subtype></Fermata><Chord><durationType>half</durationType><Articulation><subtype>articStaccatoBelow</subtype></Articulation><Note><pitch>60</pitch><tpc>14</tpc></Note></Chord>
      <Rest><durationType>half</durationType></Rest></voice></Measure>
      <Measure><voice><Fermata><subtype>fermataAbove</subtype></Fermata><Rest><durationType>measure</durationType></Rest></voice></Measure></Staff></Score></museScore>`;
    const { score, report } = importMSCX(x, "x.mscx");
    const b = score.staves[0].bars[0];
    if (!eq(score.measures[0], { key: 0, time: [2, 2], sym: "cut" })) return JSON.stringify(score.measures[0]);
    if (!eq(b[0].marks, ["fermata", "staccato"]) || b[1].marks) return JSON.stringify(b);
    return JSON.stringify(report).includes("Fermatas on whole-bar rests") || "whole-bar fermata not counted";
  });

  await check("MuseScore archive without a score gives a message", async () => {
    const zip = fflate.zipSync({ "META-INF/container.xml": new TextEncoder().encode("<container/>"), "a.mscx": new Uint8Array(0) });
    const files = fflate.unzipSync(zip);
    delete files["a.mscx"];
    const noScore = fflate.zipSync({ ...files, "notes.mscx.txt": new Uint8Array(1) });
    try { await importBytes(noScore, "broken.mscz"); return "no error"; }
    catch (e) { return /score|archive|recognise|valid/i.test(e.message) || e.message; }
  });
}
