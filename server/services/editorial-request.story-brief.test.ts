import { beforeEach, describe, expect, it, vi } from "vitest";

// "Write a post" never dead-ends on a page it can't read when Discover knows the story.
const { brief, fetcher, inbox, generate, main } = vi.hoisted(() => ({ brief: vi.fn(), fetcher: vi.fn(), inbox: vi.fn(), generate: vi.fn(), main: vi.fn() }));
vi.mock("../storage", () => ({ storage: { getInboxItemByUrl: inbox } }));
vi.mock("../middlewares/requireDbUser", () => ({ authedOf: vi.fn() }));
vi.mock("../routes/editorial-context", async importOriginal => ({ ...await importOriginal<typeof import("../routes/editorial-context")>(), editorialContext: vi.fn() }));
vi.mock("./punditBrain", () => ({ generatePlatformReviewsDetailed: generate, generateMainDraftDetailed: main }));
vi.mock("./urlFetcher", () => ({ fetchArticleFromUrl: fetcher }));
vi.mock("./articlePool", () => ({ findPooledArticle: async () => null }));
vi.mock("./keywordSearch", () => ({ isGoogleNewsArticleUrl: (url: string) => url.includes("news.google.com"), resolveGoogleNewsArticleUrl: async (url: string) => url }));
vi.mock("./storyBrief", () => ({ storyBriefFor: brief }));
vi.mock("./topicStories", () => ({ topicStoryArticles: vi.fn() }));
vi.mock("../repositories/topicBriefs", () => ({ getTopicBrief: vi.fn(), markTopicBriefUsed: vi.fn(), findTopicStory: vi.fn() }));
import { executeEditorialRequest } from "./editorial-request";
import { CrawlError } from "./crawlerFetch";
import { AIGenerationError } from "./openRouter";

const scope = { tenantId: "tenant-1", userId: "user-1" };
const paywalled = "https://paywalled.test/story";
const google = "https://news.google.com/rss/articles/opaque?oc=5";
const readable = "https://open.test/story";
const signal = new AbortController().signal;
const headlineBrief = (url: string) => {
  const content = `Campaign India reported: A story at ${url}\n\nRelated coverage, Adgully: The same story`;
  return { title: "A story", content, source: "Campaign India", url, domain: new URL(url).hostname,
    contentMetadata: { extractionMethod: "headlines", originalLength: content.length, retainedLength: content.length, truncated: false },
    references: [{ title: "A story", source: "Campaign India", url }, { title: "The same story", source: "Adgully", url: "https://news.google.com/rss/articles/related" }] };
};
const page = { title: "Open story", content: "Open Weekly reports that the open story happened. ".repeat(10), source: "Open Weekly", url: readable, domain: "open.test",
  contentMetadata: { extractionMethod: "article", originalLength: 510, retainedLength: 510, truncated: false } };
const single = (url: string, options: object = { voiceScope: scope }) =>
  ({ input: { url, selectedPlatforms: ["linkedin"], format: "short-post" }, options }) as unknown as Parameters<typeof executeEditorialRequest>[0];

beforeEach(() => {
  vi.resetAllMocks();
  generate.mockResolvedValue({ posts: {}, details: {} });
  main.mockResolvedValue({ mainDraft: { content: "Draft" } });
  inbox.mockResolvedValue({ id: "item" });
  brief.mockImplementation(async (_scope: unknown, url: string) => headlineBrief(url));
  fetcher.mockImplementation(async (url: string) => {
    if (url === readable) return page;
    throw new CrawlError("content", "No readable article content was found.");
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("writing from a story whose page can't be read", () => {
  it("writes a paywalled story from its headline brief instead of failing", async () => {
    const result = await executeEditorialRequest(single(paywalled), signal);
    expect(brief).toHaveBeenCalledWith(scope, paywalled, signal);
    expect(generate.mock.calls[0][0]).toMatchObject({ source: "Campaign India", url: paywalled, contentMetadata: { extractionMethod: "headlines" } });
    expect((result.article as { references?: unknown[] }).references).toHaveLength(2);
  });

  it("writes a story behind a Google News link that won't convert, without reading Google", async () => {
    await executeEditorialRequest(single(google), signal);
    expect(fetcher).not.toHaveBeenCalled();
    expect(generate.mock.calls[0][0]).toMatchObject({ url: google, contentMetadata: { extractionMethod: "headlines" } });
  });

  it("still fails for a link nothing is known about", async () => {
    brief.mockResolvedValue(null);
    await expect(executeEditorialRequest(single(paywalled), signal)).rejects.toBeInstanceOf(CrawlError);
    expect(generate).not.toHaveBeenCalled();
  });

  it("does not look for a brief without the person's scope, or for errors other than an unreadable page", async () => {
    await expect(executeEditorialRequest(single(paywalled, {}), signal)).rejects.toBeInstanceOf(CrawlError);
    fetcher.mockRejectedValue(new AIGenerationError("ai_timeout"));
    await expect(executeEditorialRequest(single(paywalled), signal)).rejects.toBeInstanceOf(AIGenerationError);
    expect(brief).not.toHaveBeenCalled();
  });

  it("combines a readable page with a headline brief when several stories are attached", async () => {
    const prepared = { input: { stage: "main", title: "Two stories", content: "", media: [], selectedPlatforms: [], format: "short-post", sourceUrls: [readable, paywalled] },
      options: { voiceScope: scope } } as unknown as Parameters<typeof executeEditorialRequest>[0];
    const result = await executeEditorialRequest(prepared, signal);
    const article = main.mock.calls[0][0];
    expect(article.contentMetadata.extractionMethod).toBe("headlines");
    expect(article.content).toContain("Open Weekly reports that the open story happened.");
    expect(article.content).toContain("Related coverage, Adgully: The same story");
    // Each attached story, then the other outlet the brief drew on, once each.
    expect((result.article as { references: { url: string }[] }).references.map(reference => reference.url)).toEqual([readable, paywalled, "https://news.google.com/rss/articles/related"]);
  });
});
