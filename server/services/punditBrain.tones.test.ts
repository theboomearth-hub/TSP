import { beforeEach, describe, expect, it, vi } from "vitest";

// New tones reach the writer as their own descriptions; a request naming no tone still writes the original four.
const { provider } = vi.hoisted(() => ({ provider: vi.fn() }));
vi.mock("../lib/redis", () => ({ redis: undefined }));
vi.mock("./openRouter", async original => ({ ...await original<typeof import("./openRouter")>(), generateTextWithMetadata: provider }));
import { generatePlatformReviewsDetailed } from "./punditBrain";

const content = "Campaign reported that Vistar launched a programmatic DOOH marketplace in India with 40,000 screens across 12 cities.";
const article = { title: "Vistar launches", content, source: "Campaign", url: "https://campaign.test/x",
  contentMetadata: { extractionMethod: "article" as const, originalLength: content.length, retainedLength: content.length, truncated: false } };
const tonesSent = () => provider.mock.calls.map(call => JSON.parse(call[0] as string).tone as string);

beforeEach(() => {
  provider.mockReset().mockResolvedValue({ text: JSON.stringify({ segments: [{ text: "Campaign reports Vistar launched a programmatic DOOH marketplace in India.", excerptIds: ["p1"] }, { text: article.url, excerptIds: [] }] }),
    provider: "gemini", model: "test", usage: { inputTokens: 1, outputTokens: 1 }, fallbackUsed: false });
});

describe("writing tones", () => {
  it.each([
    ["storyteller", "Narrative: open with a concrete scene"],
    ["executiveBrief", "the bottom line first"],
    ["witty", "humour never distorts"],
  ] as const)("writes in the %s tone from its own description", async (tone, phrase) => {
    const result = await generatePlatformReviewsDetailed(article, ["linkedin"], { tones: [tone] });
    expect(tonesSent()).toHaveLength(1);
    expect(tonesSent()[0]).toContain(phrase);
    expect(Object.keys(result.posts.linkedin)).toEqual([tone]);
  });

  it("writes only the original four tones when none is named", async () => {
    const result = await generatePlatformReviewsDetailed(article, ["linkedin"]);
    expect(provider).toHaveBeenCalledTimes(4);
    expect(Object.keys(result.posts.linkedin).sort()).toEqual(["dataDriven", "industryInsider", "provocateur", "thoughtLeader"]);
  });
});
