import { beforeEach, describe, expect, it, vi } from "vitest";

// Topic posts, opinion posts and post shapes change the writer's rules; ordinary stories don't.
const { provider } = vi.hoisted(() => ({ provider: vi.fn() }));
vi.mock("../lib/redis", () => ({ redis: undefined }));
vi.mock("./openRouter", async original => ({ ...await original<typeof import("./openRouter")>(), generateTextWithMetadata: provider }));
import { generatePlatformReviewsDetailed } from "./punditBrain";

const metadata = (content: string, extra: object = {}) => ({ extractionMethod: "headlines" as const, originalLength: content.length, retainedLength: content.length, truncated: false, ...extra });
const topicContent = "Source: Campaign\nTitle: Vistar launches DOOH marketplace\nURL: https://campaign.test/x\nCampaign reported: Vistar launches a programmatic DOOH marketplace in India";
const opinionContent = "programmatic DOOH\n\nBuyers will not scale it until measurement is shared across sellers.";

async function systemPromptFor(article: Parameters<typeof generatePlatformReviewsDetailed>[0], options: Parameters<typeof generatePlatformReviewsDetailed>[2] = {}) {
  await generatePlatformReviewsDetailed(article, ["linkedin"], { tones: ["thoughtLeader"], ...options }).catch(() => undefined);
  return provider.mock.calls[0][1].systemPrompt as string;
}

beforeEach(() => {
  provider.mockReset().mockResolvedValue({ text: "INSUFFICIENT_SOURCE_CONTENT", provider: "gemini", model: "test", usage: { inputTokens: 1, outputTokens: 1 }, fallbackUsed: false });
});

describe("writer rules for topic-first posts", () => {
  it("a topic post credits each outlet and links only the main story, in the chosen shape", async () => {
    const prompt = await systemPromptFor({ title: "programmatic DOOH", content: topicContent, source: "Campaign", url: "https://campaign.test/x",
      contentMetadata: metadata(topicContent, { topic: true }) }, { shape: "roundup" });
    expect(prompt).toContain("TOPIC POST");
    expect(prompt).toContain("HEADLINES-ONLY SOURCE");
    expect(prompt).toContain("SHAPE: Write a roundup");
    expect(prompt).not.toContain("OPINION POST");
  });

  it("an opinion post states the author's view and no external facts", async () => {
    const prompt = await systemPromptFor({ title: "programmatic DOOH", content: opinionContent, source: "Your view", url: "",
      contentMetadata: { ...metadata(opinionContent, { opinion: true }), extractionMethod: "manual" } });
    expect(prompt).toContain("OPINION POST");
    expect(prompt).not.toContain("TOPIC POST");
  });

  it("an ordinary story, or the plain post shape, adds none of these rules", async () => {
    const content = "Campaign reported that Vistar launched a programmatic DOOH marketplace in India with 40,000 screens across 12 cities.";
    const prompt = await systemPromptFor({ title: "Vistar launches", content, source: "Campaign", url: "https://campaign.test/x",
      contentMetadata: { ...metadata(content), extractionMethod: "article" } }, { shape: "post" });
    for (const rule of ["TOPIC POST", "OPINION POST", "SHAPE:", "HEADLINES-ONLY SOURCE"]) expect(prompt).not.toContain(rule);
  });

  it("rejects an unknown shape before calling the AI", async () => {
    await expect(generatePlatformReviewsDetailed({ title: "t", content: topicContent, source: "Campaign", url: "https://campaign.test/x", contentMetadata: metadata(topicContent) },
      ["linkedin"], { shape: "essay" as never })).rejects.toMatchObject({ code: "ai_invalid_input" });
    expect(provider).not.toHaveBeenCalled();
  });
});
