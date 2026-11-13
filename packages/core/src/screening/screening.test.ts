import { describe, expect, it } from "vitest";
import { topCandidates } from "./match.js";
import { diffEntities, parseCsv, parseEntities } from "./sdn.js";
import { nameScore, normalizeName } from "./similarity.js";

describe("nameScore", () => {
  it("ignores legal forms, punctuation, and spacing", () => {
    expect(normalizeName("Coprova, S.A.R.L.")).toEqual(["COPROVA", "S", "A", "R", "L"]);
    expect(nameScore("Quill Mark Trading House, Inc.", "QUILLMARK TRADING HOUSE")).toBe(1);
    expect(nameScore("Orlenka Freight LLC", "ORLENKA FREIGHT")).toBe(1);
  });
  it("keeps unrelated names below the model threshold", () => {
    expect(nameScore("Brindlecove Ceramics LLC", "QUILLMARK TRADING HOUSE")).toBeLessThan(0.82);
  });
  it("ranks aliases with the entity", () => {
    const entities = [
      {
        ent_num: 36,
        name: "AEROCARIBBEAN AIRLINES",
        program: "CUBA",
        remarks: null,
        aliases: ["AERO-CARIBBEAN"],
      },
      { ent_num: 555, name: "COPROVA", program: "CUBA", remarks: null, aliases: [] },
    ];
    const [top] = topCandidates("Aero-Caribbean", entities, 1);
    expect(top!.entity.ent_num).toBe(36);
    expect(top!.matchedName).toBe("AERO-CARIBBEAN");
  });
});

describe("OFAC CSV", () => {
  const sdn = [
    '36,"AEROCARIBBEAN AIRLINES",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"Havana, Cuba."',
    '7,"DOE, John",individual,"SDGT",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ',
    "\u001a",
  ].join("\r\n");
  const alt = '36,12,"aka","AERO-CARIBBEAN",-0- \r\n7,13,"aka","JD",-0- ';

  it("keeps entities, drops individuals, and attaches aliases", () => {
    expect(parseEntities(sdn, alt)).toEqual([
      {
        ent_num: 36,
        name: "AEROCARIBBEAN AIRLINES",
        program: "CUBA",
        remarks: "Havana, Cuba.",
        aliases: ["AERO-CARIBBEAN"],
      },
    ]);
  });
  it("handles quoted commas and doubled quotes", () => {
    expect(parseCsv('1,"a, ""b""",c\n')).toEqual([["1", 'a, "b"', "c"]]);
  });
  it("diffs by entity number", () => {
    const next = parseEntities(sdn, alt);
    expect(diffEntities(new Set([36, 99]), next)).toEqual({ added: [], removed: [99] });
    expect(diffEntities(new Set(), next).added).toEqual([36]);
  });
});
