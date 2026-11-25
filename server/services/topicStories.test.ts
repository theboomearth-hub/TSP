import { beforeEach, describe, expect, it, vi } from "vitest";

// A topic finds related stories without reading any page; ticked ones become the writer's input.
const { pooled } = vi.hoisted(() => ({ pooled: vi.fn() }));
vi.mock("../storage", () => ({ storage: {} }));
vi.mock("./articlePool", () => ({ findPooledArticle: pooled }));
vi.mock("./newsSearch", () => ({ searchNews: vi.fn() }));
vi.mock("../repositories/topicBriefs", () => ({ pickedOutlets: vi.fn(), findTopicStory: vi.fn() }));
import { findRelatedStories, groupSameDevelopment, topicRelevance, topicStoryArticles, type RelatedStoriesDeps } from "./topicStories";
import { buildEvidenceBrief } from "./editorialEvidence";
import type { NewsSearchHit } from "./newsSearch";
import type { TopicStory } from "@shared/topic-stories";

const scope = { tenantId: "tenant-1", userId: "user-1" };
const now = Date.parse("2026-11-25T12:00:00Z");
const hit = (title: string, source: string, url: string, publishedAt = "2026-11-24T09:00:00.000Z", snippet = "", alsoCoveredBy: NewsSearchHit["alsoCoveredBy"] = []): NewsSearchHit =>
  ({ id: url, title, url, source, publishedAt, snippet, matchedTerms: [], alsoCoveredBy });
function deps(overrides: Partial<RelatedStoriesDeps> = {}): RelatedStoriesDeps {
  return {
    search: vi.fn(async () => [] as NewsSearchHit[]), discover: vi.fn(async () => []), hasFullText: vi.fn(async () => false),
    outletPreferences: vi.fn(async () => new Map()), now: () => now, ...overrides,
  };
}

beforeEach(() => { vi.resetAllMocks(); pooled.mockResolvedValue(null); });

describe("topicRelevance", () => {
  it("is the share of the topic's words found as whole words", () => {
    expect(topicRelevance(["programmatic", "DOOH", "measurement"], "Programmatic DOOH grows in India")).toBeCloseTo(2 / 3);
    expect(topicRelevance(["AI"], "Retail giants")).toBe(0);
  });
});

describe("findRelatedStories", () => {
  it("searches the topic's first words, then fewer when that finds too little", async () => {
    const search = vi.fn(async (query: string) => query === "programmatic DOOH measurement" ? [hit("Programmatic DOOH measurement gap", "Campaign", "https://a.test/1")]
      : [hit("Programmatic DOOH grows", "Adgully", "https://b.test/2"), hit("Programmatic DOOH deal", "Exchange4Media", "https://c.test/3")]);
    const found = await findRelatedStories(scope, "Why programmatic DOOH needs better measurement", "en-IN", deps({ search }));
    expect(search.mock.calls.map(call => call[0])).toEqual(["programmatic DOOH measurement", "programmatic DOOH"]);
    expect(search).toHaveBeenCalledWith(expect.any(String), "en-IN");
    expect(found.searchedFor).toBe("programmatic DOOH");
    expect(found.stories.map(story => story.id)).toEqual(["s1", "s2", "s3"]);
    expect(found.stories[0]).toMatchObject({ title: "Programmatic DOOH measurement gap", origin: "news", fullText: false });
  });

  it("stops at the first search that finds enough", async () => {
    const search = vi.fn(async () => ["1", "2", "3"].map(n => hit(`Retail media story ${n} launches ${n}`, `Outlet ${n}`, `https://x.test/${n}`)));
    await findRelatedStories(scope, "retail media networks India", "en-US", deps({ search }));
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("finds nothing for a topic without meaningful words, without searching", async () => {
    const search = vi.fn();
    expect(await findRelatedStories(scope, "why is it", "en-US", deps({ search }))).toEqual({ searchedFor: "", stories: [] });
    expect(search).not.toHaveBeenCalled();
  });

  it("folds the person's Discover copy and other outlets' copies of the same news into one story", async () => {
    const search = vi.fn(async () => [
      hit("Harvest Group acquires Good Peeps to expand retail media", "Yahoo Finance", "https://yahoo.test/a"),
      hit("Harvest Group acquires Good Peeps, targets retail media growth", "Pulse 2.0", "https://pulse.test/b"),
      hit("Kroger names new retail media chief", "Grocery Dive", "https://grocery.test/c"),
    ]);
    const discover = vi.fn(async () => [
      { headline: "Kroger names new retail media chief", source: "Grocery Dive", articleUrl: "https://grocery.test/c", summary: null, publishedAt: new Date("2026-11-24T09:00:00Z") },
      { headline: "Good Peeps acquired by Harvest Group in retail media push", source: "Adweek", articleUrl: "https://adweek.test/d", summary: "", publishedAt: null },
      { headline: "Unrelated cricket score", source: "Sports", articleUrl: "https://s.test/e", summary: "", publishedAt: null },
    ]);
    const found = await findRelatedStories(scope, "retail media", "en-US", deps({ search, discover }));
    expect(found.stories).toHaveLength(2);
    const harvest = found.stories.find(story => story.source === "Yahoo Finance")!;
    expect(harvest.alsoCoveredBy.map(outlet => outlet.source)).toEqual(["Adweek", "Pulse 2.0"]);
    expect(found.stories.find(story => story.source === "Grocery Dive")).toMatchObject({ origin: "discover" });
  });

  it("ranks outlets the person wrote from recently a little higher, and marks stories with stored text", async () => {
    const search = vi.fn(async () => [hit("AI agents reshape retail media planning at Walmart", "Digiday", "https://digiday.test/1"), hit("Amazon adds AI agents to retail media ad console", "Adweek", "https://adweek.test/2")]);
    const found = await findRelatedStories(scope, "AI agents retail media", "en-US", deps({
      search, outletPreferences: async () => new Map([["adweek", 3]]), hasFullText: async url => url.includes("adweek"),
    }));
    expect(found.stories.map(story => [story.source, story.fullText])).toEqual([["Adweek", true], ["Digiday", false]]);
  });

  it("leaves out stories that mention only a passing word of a longer topic", async () => {
    const search = vi.fn(async () => [hit("A letter from Tonic.ai's founders on a data sale", "Security Boulevard", "https://sb.test/1")]);
    const found = await findRelatedStories(scope, "why founders should write weekly letters to their teams", "en-US", deps({ search }));
    expect(found.stories).toEqual([]);
  });

  it("keeps searching when one search fails", async () => {
    const search = vi.fn().mockRejectedValueOnce(new Error("rate limited")).mockResolvedValue([hit("Programmatic DOOH grows", "Adgully", "https://b.test/2")]);
    const found = await findRelatedStories(scope, "programmatic DOOH measurement", "en-US", deps({ search }));
    expect(found.stories).toHaveLength(1);
  });
});

describe("groupSameDevelopment", () => {
  it("does not merge different stories that only share the topic's words", () => {
    const story = (title: string, source: string) => ({ title, source, url: `https://${source}.test`, snippet: "", publishedAt: null, alsoCoveredBy: [], origin: "news" as const });
    const grouped = groupSameDevelopment([story("AI agents reshape retail media planning at Walmart", "a"), story("Amazon adds AI agents to retail media ad console", "b")],
      ["AI", "agents", "retail", "media"]);
    expect(grouped).toHaveLength(2);
  });

  it("keeps the first copy and lists other outlets once", () => {
    const story = (source: string, url: string) => ({ title: "Vistar Media launches programmatic DOOH marketplace in India", source, url, snippet: "", publishedAt: null, alsoCoveredBy: [], origin: "news" as const });
    const grouped = groupSameDevelopment([story("Campaign", "https://a.test"), story("Adgully", "https://b.test"), story("campaign", "https://c.test")]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].alsoCoveredBy).toEqual([{ source: "Adgully", url: "https://b.test" }]);
  });
});

describe("topicStoryArticles", () => {
  const story = (overrides: Partial<TopicStory> = {}): TopicStory => ({
    id: "s1", title: "Vistar Media launches programmatic DOOH marketplace in India", source: "Campaign India", url: "https://campaign.test/vistar",
    snippet: "The marketplace connects 40,000 screens across 12 cities to Indian advertisers through one buying platform.",
    publishedAt: "2026-11-20T09:00:00.000Z", alsoCoveredBy: [{ source: "Adgully", url: "https://adgully.test/v" }], fullText: false, origin: "news", ...overrides,
  });

  it("uses the stored article text when the shared index has it", async () => {
    const body = "Vistar Media said its marketplace connects 40,000 screens. ".repeat(10);
    pooled.mockResolvedValue({ readable: true, inputKind: "page_body", content: body, publishedAt: new Date("2026-11-20T09:00:00Z") });
    const [article] = await topicStoryArticles([story({ fullText: true })]);
    expect(article).toMatchObject({ content: body, source: "Campaign India", contentMetadata: { extractionMethod: "index" } });
    expect(article.references?.map(reference => reference.source)).toEqual(["Campaign India", "Adgully"]);
  });

  it("otherwise writes from the headline, snippet and the outlets covering it, without reading the page", async () => {
    const [article] = await topicStoryArticles([story()]);
    expect(pooled).not.toHaveBeenCalled();
    expect(article.content.split("\n\n")).toEqual([
      "Campaign India reported on 20 Nov 2026: Vistar Media launches programmatic DOOH marketplace in India",
      `Campaign India: ${story().snippet}`,
      "Also covered by Adgully.",
    ]);
    expect(buildEvidenceBrief(article).warnings.map(warning => warning.code)).toEqual(["headlines_only"]);
  });
});

describe("opinion posts", () => {
  it("are labelled as opinion with no sources, not warned about as short", () => {
    const content = "Topic: programmatic DOOH\n\nMy view: buyers will not scale it until measurement is shared.";
    const evidence = buildEvidenceBrief({ title: "programmatic DOOH", content, source: "Your view",
      contentMetadata: { extractionMethod: "manual", originalLength: content.length, retainedLength: content.length, truncated: false, opinion: true } });
    expect(evidence.warnings.map(warning => warning.code)).toEqual(["opinion_only"]);
  });
});
