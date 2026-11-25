import { beforeEach, describe, expect, it, vi } from "vitest";

// Writing from a topic: the server rebuilds the writer's input from its own stored brief.
const { getBrief, markUsed, findTopic, inbox, generate, articles } = vi.hoisted(() => ({
  getBrief: vi.fn(), markUsed: vi.fn(), findTopic: vi.fn(), inbox: vi.fn(), generate: vi.fn(), articles: vi.fn(),
}));
vi.mock("../storage", () => ({ storage: { getInboxItemByUrl: inbox } }));
vi.mock("../middlewares/requireDbUser", () => ({ authedOf: vi.fn() }));
vi.mock("../routes/editorial-context", async importOriginal => ({ ...await importOriginal<typeof import("../routes/editorial-context")>(), editorialContext: vi.fn() }));
vi.mock("./punditBrain", () => ({ generatePlatformReviewsDetailed: generate, generateMainDraftDetailed: vi.fn() }));
vi.mock("./urlFetcher", () => ({ fetchArticleFromUrl: vi.fn() }));
vi.mock("./articlePool", () => ({ findPooledArticle: async () => null }));
vi.mock("./keywordSearch", () => ({ isGoogleNewsArticleUrl: () => false, resolveGoogleNewsArticleUrl: async (url: string) => url }));
vi.mock("./storyBrief", () => ({ storyBriefFor: vi.fn() }));
vi.mock("./topicStories", () => ({ topicStoryArticles: articles }));
vi.mock("../repositories/topicBriefs", () => ({ getTopicBrief: getBrief, markTopicBriefUsed: markUsed, findTopicStory: findTopic }));
import { executeEditorialRequest, manualReviewSchema, TopicBriefUnavailableError } from "./editorial-request";

const scope = { tenantId: "tenant-1", userId: "user-1" };
const briefId = "5d2c4b7e-1f0a-4c6b-9a8e-2b3c4d5e6f70";
const story = (id: string, source: string) => ({ id, title: `${source} story`, source, url: `https://${source.toLowerCase()}.test/${id}`, snippet: "", publishedAt: null, alsoCoveredBy: [], fullText: false, origin: "news" });
const brief = { id: briefId, topic: "programmatic DOOH", stories: [story("s1", "Campaign"), story("s2", "Adgully"), story("s3", "Mint")] };
const article = (source: string) => {
  const content = `${source} reported: ${source} story`;
  return { title: `${source} story`, content, source, url: `https://${source.toLowerCase()}.test`, domain: `${source.toLowerCase()}.test`,
    contentMetadata: { extractionMethod: "headlines", originalLength: content.length, retainedLength: content.length, truncated: false },
    references: [{ title: `${source} story`, source, url: `https://${source.toLowerCase()}.test` }] };
};
const signal = new AbortController().signal;
const manual = (fields: Record<string, unknown>, options: object = { voiceScope: scope }) =>
  ({ input: { title: "programmatic DOOH", content: "", media: [], selectedPlatforms: ["linkedin"], format: "short-post", ...fields }, options }) as unknown as Parameters<typeof executeEditorialRequest>[0];

beforeEach(() => {
  vi.resetAllMocks();
  generate.mockResolvedValue({ posts: { linkedin: { thoughtLeader: "Post" } }, details: {} });
  getBrief.mockResolvedValue(brief);
  markUsed.mockResolvedValue(undefined);
  articles.mockImplementation(async (stories: Array<{ source: string }>) => stories.map(item => article(item.source)));
});

describe("writing from a topic brief", () => {
  it("writes from the ticked stories in ranked order, as a topic post led by the best match", async () => {
    const result = await executeEditorialRequest(manual({ topicBrief: { id: briefId, storyIds: ["s3", "s1"] } }), signal);
    expect(getBrief).toHaveBeenCalledWith(scope, briefId);
    expect(articles.mock.calls[0][0].map((item: { id: string }) => item.id)).toEqual(["s1", "s3"]);
    const input = generate.mock.calls[0][0];
    expect(input).toMatchObject({ title: "programmatic DOOH", source: "Campaign", url: "https://campaign.test", contentMetadata: { topic: true, extractionMethod: "headlines" } });
    expect(input.content).toContain("Mint reported: Mint story");
    expect((result.article as { references: Array<{ source: string }> }).references.map(reference => reference.source)).toEqual(["Campaign", "Mint"]);
    expect(markUsed).toHaveBeenCalledWith(scope, briefId, ["s3", "s1"]);
  });

  it("asks for a fresh search when the brief expired or a story is unknown", async () => {
    getBrief.mockResolvedValueOnce(undefined);
    await expect(executeEditorialRequest(manual({ topicBrief: { id: briefId, storyIds: ["s1"] } }), signal)).rejects.toBeInstanceOf(TopicBriefUnavailableError);
    await expect(executeEditorialRequest(manual({ topicBrief: { id: briefId, storyIds: ["s9"] } }), signal)).rejects.toBeInstanceOf(TopicBriefUnavailableError);
    expect(generate).not.toHaveBeenCalled();
    expect(markUsed).not.toHaveBeenCalled();
  });

  it("still returns the post when recording the pick fails", async () => {
    markUsed.mockRejectedValue(new Error("db down"));
    await expect(executeEditorialRequest(manual({ topicBrief: { id: briefId, storyIds: ["s1"] } }), signal)).resolves.toBeTruthy();
  });
});

describe("opinion-only posts", () => {
  it("write the person's view, marked as opinion with no sources", async () => {
    const content = "programmatic DOOH\n\nBuyers will not scale it until measurement is shared.";
    await executeEditorialRequest(manual({ content, opinionOnly: true, sourceLabel: "Your view" }), signal);
    expect(generate.mock.calls[0][0]).toMatchObject({ source: "Your view", url: "", contentMetadata: { extractionMethod: "manual", opinion: true } });
  });
});

describe("request validation", () => {
  const base = { title: "programmatic DOOH", content: "", selectedPlatforms: ["linkedin"] };
  it("accepts a topic brief without content, and nothing that mixes it with other sources", () => {
    expect(manualReviewSchema.safeParse({ ...base, topicBrief: { id: briefId, storyIds: ["s1", "s2"] } }).success).toBe(true);
    expect(manualReviewSchema.safeParse({ ...base, topicBrief: { id: briefId, storyIds: ["s1"] }, opinionOnly: true }).success).toBe(false);
    expect(manualReviewSchema.safeParse({ ...base, stage: "main", selectedPlatforms: [], topicBrief: { id: briefId, storyIds: ["s1"] }, sourceUrls: ["https://a.test"] }).success).toBe(false);
    expect(manualReviewSchema.safeParse({ ...base, topicBrief: { id: briefId, storyIds: [] } }).success).toBe(false);
    expect(manualReviewSchema.safeParse({ ...base, topicBrief: { id: "not-a-uuid", storyIds: ["s1"] } }).success).toBe(false);
  });
  it("needs real words for an opinion post", () => {
    expect(manualReviewSchema.safeParse({ ...base, content: "too short", opinionOnly: true }).success).toBe(false);
    expect(manualReviewSchema.safeParse({ ...base, content: "programmatic DOOH needs shared measurement", opinionOnly: true }).success).toBe(true);
  });
});
