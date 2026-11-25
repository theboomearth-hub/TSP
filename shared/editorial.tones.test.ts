import { describe, expect, it } from "vitest";
import { CLASSIC_EDITORIAL_TONES, EDITORIAL_TONES, TONE_CATALOG, TONE_VALUES } from "./editorial";

describe("writing tones", () => {
  it("lists every tone once, with a unique stored name and label", () => {
    expect(TONE_CATALOG.map(tone => tone.key)).toEqual([...EDITORIAL_TONES]);
    expect(new Set(TONE_VALUES).size).toBe(EDITORIAL_TONES.length);
    expect(new Set(TONE_CATALOG.map(tone => tone.label)).size).toBe(EDITORIAL_TONES.length);
    expect(EDITORIAL_TONES).toHaveLength(11);
  });

  it("keeps the original four tones' stored names, so existing drafts and profiles still match", () => {
    expect(TONE_CATALOG.slice(0, 4).map(tone => [tone.key, tone.value])).toEqual([
      ["thoughtLeader", "professional"], ["industryInsider", "authoritative"], ["provocateur", "contrarian"], ["dataDriven", "ai-recommended"],
    ]);
    expect(CLASSIC_EDITORIAL_TONES).toEqual(["thoughtLeader", "industryInsider", "provocateur", "dataDriven"]);
  });

  it("adds the seven new tones", () => {
    expect(TONE_CATALOG.slice(4).map(tone => tone.label)).toEqual(["Storyteller", "Educator", "Conversational", "Executive Brief", "Balanced Analyst", "Optimist", "Witty"]);
  });
});
