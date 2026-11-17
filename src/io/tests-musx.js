// .musx checks (Phase 6). Samples in samples/musx are musxdom's test files (MIT, see README there);
// expected pitches for keysigs come from musxdom's own KeySigs test.
import { crypt, decodeMusx } from "./musx.js";
import { isValidScore } from "../model.js";

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

  // marks per event in a layer: dyn, ( ) slur, < > | hairpin, lyrics by verse, [grace]
  const P = (p) => "CDEFGAB"[p.step] + ["bb", "b", "", "#", "##"][p.alter + 2] + p.oct;
  const tags = (bars) => bars.map((bar) => bar.map((e) => [e.dyn, e.slur && "(", e.slurEnd && ")", e.hp, e.hpEnd && "|",
    e.lyrics && e.lyrics.map((l) => (l ? l.text + (l.hyph ? "-" : "") : "_")).join("/"), e.grace && `[${e.grace.map(P).join(" ")}]`].filter(Boolean).join("") || ".").join(" ")).join(" | ");

  await check("musx sample: grace notes go on the next note (DESIGN §26)", async () => {
    const r = await open("grace_notes");
    const got = `${brief(r.score.staves[0])} ${tags(r.score.staves[0].bars)}`;
    if (got !== "r:h D5:h . [B4 C5 D5 E5 F5]") return got;
    return (/no note after them in the bar \(not imported\): 3/.test(warn(r)) && /Dynamics on grace notes \(not imported\): 1/.test(warn(r))) || warn(r);
  });

  await check("musx samples: dynamics by layer and position, legacy font characters (DESIGN §22)", async () => {
    const r = await open("exprlayers"), st = r.score.staves[0];
    const got = `${tags(st.bars)} + ${tags(st.layers[0])}`;
    if (got !== "f . pp . + . mp ." || !/Two dynamics on one note \(the first kept\): 1/.test(warn(r))) return `${got} / ${warn(r)}`;
    const v = await open("exprv2");
    // one hidden; one in layer 1 where its second voice starts a note
    const got2 = `${tags(v.score.staves[0].bars)} + ${tags(v.score.staves[0].layers[0])}`;
    return (got2 === ". . + . . f" && /Hidden dynamics \(not imported\): 1/.test(warn(v))) || `${got2} / ${warn(v)}`;
  });

  await check("musx sample: slurs from smart shapes (DESIGN §23)", async () => {
    const r = await open("slur");
    return tags(r.score.staves[0].bars) === "( . ) ." || tags(r.score.staves[0].bars);
  });

  await check("musx sample: lyric verses, hyphens and word extensions (DESIGN §24)", async () => {
    const r = await open("syllables");
    const got = tags(r.score.staves[0].bars);
    const want = "fi@# na le . | _/fi _/na.;— _/le . | _/_/fi- _/_/na- _/_/le . | _/_/_/fi _/_/_/na _/_/_/le . | _/_/_/_/finale _/_/_/_/fi- _/_/_/_/na- _/_/_/_/le";
    if (got !== want) return got;
    const w = await open("wordext");
    return /Lyric extender lines \(not imported\): 5/.test(warn(w)) || warn(w);
  });

  await check("musx sample: layers 1–4 kept as layers (DESIGN §15)", async () => {
    const r = await open("layers");
    const got = r.score.staves.map((s) => [s.bars, ...(s.layers || [])].map((L) => brief({ bars: L })).join(" + ")).join(" / ");
    return got === " | C5:w +  | F4:h r:h /  |  +  |  + A4:w | " || got;
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
    if (got !== "C4:q.~ C4+Eb4:8 r:h") return got; // the hidden entry keeps its time as a rest
    return /articulations \(not imported\): 1/.test(warn(r)) && /placeholder entries shown as rests: 1/.test(warn(r)) || warn(r);
  });

  await check("musx sample: second voices go to a free layer from their launch point; cross-voice ties dropped", async () => {
    const r = await open("v1v2Ties");
    const st = r.score.staves[0];
    const got = [st.bars, ...(st.layers || [])].map((L) => brief({ bars: L })).join(" + ");
    if (got !== "r:h r:q F4+A4:q~ | F4+A4+E5:h r:q F4+A4+E5:q~ | A4+E5:h r:h + r:h. C5:16 D5:16 E5:8 |  | F4:8 E4:8~ E4:q") return got;
    if (!/Ties with no matching next note dropped: 1/.test(warn(r))) return warn(r);
    // the second launch would start inside a triplet and overfill the bar: skipped and counted
    const t = await open("v1v2tuplets");
    const L2 = brief({ bars: t.score.staves[0].layers[0] });
    return (L2 === "A4:8/3:2 C4:8/3:2 C4:8/3:2 C4:8 F4:8" && /Notes in second voices skipped: 4/.test(warn(t))) || `${L2} / ${warn(t)}`;
  });

  await check("musx sample: articulations from a legacy music font", async () => {
    const r = await open("v1v2Ties2");
    const st = r.score.staves[0];
    const marks = [st.bars, ...(st.layers || [])].flat(2).filter((e) => e.marks).map((e) => e.marks.join("+")).join(" ");
    if (marks !== "staccato staccato staccato accent") return marks;
    // voice 2 launches after a septuplet Coda can't keep: placed by the file's time, not the kept lengths
    const L2 = brief({ bars: st.layers[0] }).split(" | ")[0];
    return L2 === "r:h. F#5:16 A5:16 C#6:16 E6:16" || L2;
  });

  await check("musx samples: every one imports to a valid score", async () => {
    const bad = [];
    for (const n of ["keysigs", "enharmonics_test", "quintuplet", "grace_notes", "layers", "piano_inst", "multistaff_inst",
      "v1v2Ties", "v1v2Ties2", "v1v2tuplets", "transpose", "expdef", "timesig-inddisp", "exprlayers", "exprv2", "slur", "syllables", "wordext", "beam_over_graces"]) {
      const r = await open(n);
      if (!isValidScore(r.score)) bad.push(n);
    }
    const t = await open("timesig-inddisp"), s = await open("transpose");
    if (!/real meter used\): 1/.test(warn(t))) return warn(t);
    if (!/staff styles \(not imported\): 4/.test(warn(s))) return warn(s);
    return !bad.length || bad.join();
  });

  await check("musx: transposition (key and chromatic), tempo, common time, sound by name, SMuFL marks (inline EnigmaXML)", async () => {
    const staff = (n, extra) => `<staffSpec cmper="${n}">${extra}</staffSpec><frameSpec cmper="${n}" inci="0"><startEntry>${n * 2 - 1}</startEntry><endEntry>${n * 2 - 1 + (n === 1 ? 1 : 0)}</endEntry></frameSpec>` +
      `<instUsed cmper="0" inci="${n - 1}"><inst>${n}</inst></instUsed>`;
    const x = `<finale xmlns="http://www.makemusic.com/2012/finale"><options><timeSignatureOptions><timeSigDoAbrvCommon/></timeSignatureOptions></options><others>
      <measSpec cmper="1"><beats>4</beats><divbeat>1024</divbeat></measSpec>
      ${staff(1, "<fullName>1</fullName>")}
      ${staff(2, "<transposition><keysig><interval>1</interval><adjust>2</adjust></keysig></transposition>")}
      ${staff(3, "<transposition><chromatic><diatonic>5</diatonic><alteration>0</alteration></chromatic></transposition>")}
      <textBlock cmper="1"><textID>1</textID></textBlock><fontName cmper="0"><name>Maestro</name></fontName>
      <articDef cmper="1"><charMain>58544</charMain></articDef><articDef cmper="2"><charMain>58561</charMain></articDef>
      <articDef cmper="3"><charMain>46</charMain></articDef><articDef cmper="4"><charMain>40</charMain><fontMain>9</fontMain></articDef>
      <textExprDef cmper="1"><value>60</value><auxdata1>1536</auxdata1><useAuxData/><playType>time</playType></textExprDef>
      <measExprAssign cmper="1" inci="0"><textExprID>1</textExprID></measExprAssign><measExprAssign cmper="1" inci="1"><textExprID>2</textExprID><horzEduOff>512</horzEduOff></measExprAssign>
      </others><details>
      ${[1, 2, 3].map((n) => `<gfhold cmper1="${n}" cmper2="1"><frame1>${n}</frame1></gfhold>`).join("")}
      <articAssign entnum="1" inci="0"><articDef>1</articDef></articAssign><articAssign entnum="2" inci="0"><articDef>2</articDef></articAssign>
      <articAssign entnum="2" inci="1"><articDef>3</articDef></articAssign><articAssign entnum="3" inci="0"><articDef>3</articDef></articAssign>
      <articAssign entnum="5" inci="0"><articDef>4</articDef></articAssign></details>
      <entries><entry entnum="1" prev="0" next="2"><dura>2048</dura><isNote/><note id="1"><harmLev>0</harmLev></note></entry>
      <entry entnum="2" prev="1" next="0"><dura>2048</dura></entry>
      <entry entnum="3" prev="0" next="0"><dura>4096</dura><isNote/><note id="1"><harmLev>0</harmLev></note></entry>
      <entry entnum="5" prev="0" next="0"><dura>4096</dura><isNote/><note id="1"><harmLev>0</harmLev></note></entry></entries>
      <texts><blockText number="1">Flute</blockText></texts></finale>`;
    const r = await importBytes(new TextEncoder().encode(x), "inline.xml");
    const sc = r.score, w = warn(r);
    if (sc.tempo !== 90 || sc.measures[0].sym !== "common" || sc.staves[0].program !== 73) return `tempo ${sc.tempo} sym ${sc.measures[0].sym} program ${sc.staves[0].program}`;
    const got = sc.staves.map((st) => `${st.transpose || "-"} ${brief(st)} ${st.bars[0].map((e) => (e.marks || []).join("+")).join(",")}`).join(" / ");
    if (got !== "- C4:h r:h staccato+accent,fermata / -2,-1 D4:w staccato / -9,-5 A4:w ") return got;
    return (/Articulations on rests \(not imported\): 1/.test(w) && /Other articulations \(not imported\): 1/.test(w) &&
      /Chromatic transpositions/.test(w) && /Expressions .* skipped: 1/.test(w)) || w;
  });

  await check("musx: hairpins, clef changes, SMuFL dynamics, lyrics on rests, graces before rests (inline EnigmaXML)", async () => {
    const bar = (n) => `<measSpec cmper="${n}"><beats>4</beats><divbeat>1024</divbeat></measSpec><frameSpec cmper="${n}" inci="0"><startEntry>${n * 10 + 1}</startEntry><endEntry>${n * 10 + 4}</endEntry></frameSpec>`;
    const q = (id, lev, extra = "") => `<entry entnum="${id}" prev="0" next="${id % 10 === 4 ? 0 : id + 1}"><dura>1024</dura>${lev === null ? "" : `<isNote/><note id="1"><harmLev>${lev}</harmLev></note>`}${extra}</entry>`;
    const pt = (m, e) => `<endPt><inst>1</inst><meas>${m}</meas><edu>${e}</edu></endPt>`;
    const shape = (n, type, a, b) => `<smartShape cmper="${n}"><shapeType>${type}</shapeType><startTermSeg>${a}</startTermSeg><endTermSeg>${b}</endTermSeg></smartShape>`;
    const x = `<finale xmlns="http://www.makemusic.com/2012/finale"><options><clefOptions>
      <clefDef index="0"><clefChar>38</clefChar><clefYDisp>-6</clefYDisp></clefDef><clefDef index="3"><clefChar>63</clefChar><clefYDisp>-2</clefYDisp></clefDef>
      <clefDef index="1"><clefChar>66</clefChar><clefYDisp>-4</clefYDisp></clefDef></clefOptions></options><others>
      ${bar(1)}${bar(2)}${bar(3)}<instUsed cmper="0" inci="0"><inst>1</inst></instUsed><staffSpec cmper="1"/>
      <clefList cmper="7" inci="0"><clef>0</clef><xEduPos>0</xEduPos></clefList><clefList cmper="7" inci="1"><clef>1</clef><xEduPos>2048</xEduPos></clefList>
      <fontName cmper="0"><name>Maestro</name></fontName>
      <textBlock cmper="1"><textID>1</textID></textBlock><textBlock cmper="2"><textID>2</textID></textBlock><textBlock cmper="3"><textID>3</textID></textBlock>
      <markingsCategory cmper="1"><categoryType>dynamics</categoryType></markingsCategory>
      <textExprDef cmper="1"><textIDKey>1</textIDKey><categoryID>1</categoryID></textExprDef>
      <textExprDef cmper="2"><textIDKey>2</textIDKey><categoryID>1</categoryID></textExprDef>
      <textExprDef cmper="3"><textIDKey>3</textIDKey><categoryID>1</categoryID></textExprDef>
      <measExprAssign cmper="1" inci="0"><textExprID>1</textExprID><horzEduOff>1024</horzEduOff><staffAssign>1</staffAssign></measExprAssign>
      <measExprAssign cmper="1" inci="1"><textExprID>2</textExprID><horzEduOff>3072</horzEduOff><staffAssign>1</staffAssign></measExprAssign>
      <measExprAssign cmper="2" inci="0"><textExprID>3</textExprID><staffAssign>1</staffAssign></measExprAssign>
      <measExprAssign cmper="3" inci="0"><textExprID>1</textExprID><staffAssign>1</staffAssign></measExprAssign>
      ${shape(1, "cresc", pt(1, 0), pt(1, 2048))}${shape(2, "decresc", pt(2, 1024), pt(2, 4096))}${shape(3, "trill", pt(1, 0), pt(1, 1024))}
      ${shape(4, "slurAuto", pt(2, 0), pt(2, 0))}
      </others><details>
      <gfhold cmper1="1" cmper2="1"><frame1>1</frame1></gfhold><gfhold cmper1="1" cmper2="2"><frame1>2</frame1><clefID>3</clefID></gfhold>
      <gfhold cmper1="1" cmper2="3"><frame1>3</frame1><clefListID>7</clefListID></gfhold>
      <lyrDataVerse entnum="14" inci="0"><lyricNumber>1</lyricNumber><syll>1</syll></lyrDataVerse>
      <lyrDataVerse entnum="31" inci="0"><lyricNumber>1</lyricNumber><syll>2</syll></lyrDataVerse>
      </details><entries>
      ${q(11, 0)}${q(12, 1)}${q(13, 2)}${q(14, null)}
      ${q(21, 0)}${q(22, 1)}${q(23, 2)}${q(24, 3)}
      ${q(31, 0)}<entry entnum="32" prev="31" next="33"><dura>256</dura><isNote/><graceNote/><note id="1"><harmLev>4</harmLev></note></entry>${q(33, null)}${q(34, 3)}
      </entries><texts><expression number="1">^fontMus(Font0,0)\uE52D</expression><expression number="2">^fontMus(Font0,0)ƒ</expression>
      <expression number="3">^fontTxt(Times,0)dolce</expression><verse number="1">la la</verse></texts></finale>`;
    const r = await importBytes(new TextEncoder().encode(x), "inline.xml");
    const st = r.score.staves[0], w = warn(r);
    const got = `${st.clef} ${JSON.stringify(st.clefs)} ${tags(st.bars)}`;
    if (got !== 'treble {"1":"bass","2":"alto"} < mf | . | ff > . | | mfla . .') return `${got} / ${w}`;
    const want = ["Lyrics on rests (not imported): 1", "Clef changes inside a bar moved to its start: 1", "Unusual dynamics (not imported): 1",
      "Slurs over a single note (not imported): 1", "Lines, trills, octave signs and other shapes (not imported): 1",
      "Grace notes before rests (not imported): 1"];
    return want.every((s) => r.report.warnings.includes(s)) || w;
  });

  await check("musx sample: piano staves, clefs, names and brace", async () => {
    const { score } = await open("piano_inst");
    const got = score.staves.map((s) => `${s.name}|${s.clef}|${s.brace}`).join(" ");
    return got === "Piano RH|treble|true Piano LH|bass|false" || got;
  });
}
