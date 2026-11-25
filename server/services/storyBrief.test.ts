import { beforeEach, describe, expect, it, vi } from "vitest";

// A story whose page can't be read is written from what Discover knows about it.
const { inbox, profile, pooled, headlines } = vi.hoisted(() => ({ inbox: vi.fn(), profile: vi.fn(), pooled: vi.fn(), headlines: vi.fn() }));
vi.mock("../storage", () => ({ storage: { getInboxItemByUrl: inbox, getUserProfile: profile } }));
vi.mock("./articlePool", () => ({ findPooledArticle: pooled }));
vi.mock("./keywordSearch", () => ({ fetchNewsHeadlines: headlines }));
vi.mock("../repositories/topicBriefs", () => ({ findTopicStory: async () => undefined }));
import { knownStory, relatedCoverage, sameDevelopment, storyBrief, storyBriefFor, type StorySignal } from "./storyBrief";
import { buildEvidenceBrief } from "./editorialEvidence";

const scope = { tenantId: "tenant-1", userId: "user-1" };
const url = "https://news.google.com/rss/articles/opaque?oc=5";
const story: StorySignal = {
  title: "Vistar Media launches programmatic DOOH marketplace in India", source: "Campaign India", url,
  snippet: "The marketplace connects 40,000 screens across 12 cities to Indian advertisers through one buying platform.",
  publishedAt: "2026-11-20T09:00:00.000Z",
};
const headline = (title: string, source: string, publishedAt: string | null = "2026-11-21T09:00:00.000Z", link: string | null = `https://news.google.com/rss/articles/${source.length}`) =>
  ({ title, source, sourceUrl: null, publishedAt, link });
const signal = new AbortController().signal;

beforeEach(() => {
  vi.resetAllMocks();
  inbox.mockResolvedValue(undefined);
  pooled.mockResolvedValue(null);
  profile.mockResolvedValue({ searchEdition: "en-IN" });
  headlines.mockResolvedValue([]);
});

describe("sameDevelopment", () => {
  it("matches differently worded headlines about one development", () => {
    expect(sameDevelopment(story.title, "Vistar Media brings its programmatic DOOH marketplace to India")).toBe(true);
  });
  it("does not match other stories on the same topic", () => {
    expect(sameDevelopment(story.title, "Programmatic DOOH spend rises in India")).toBe(false);
    expect(sameDevelopment(story.title, "")).toBe(false);
  });
});

describe("storyBrief", () => {
  it("names the outlet on every line, so each point can be attributed", () => {
    const brief = storyBrief(story, [headline("Vistar Media's programmatic DOOH marketplace arrives in India", "Exchange4Media")]);
    expect(brief.content.split("\n\n")).toEqual([
      "Campaign India reported on 20 Nov 2026: Vistar Media launches programmatic DOOH marketplace in India",
      `Campaign India: ${story.snippet}`,
      "Related coverage, Exchange4Media (21 Nov 2026): Vistar Media's programmatic DOOH marketplace arrives in India",
    ]);
    expect(brief).toMatchObject({ title: story.title, source: "Campaign India", url, domain: "news.google.com",
      contentMetadata: { extractionMethod: "headlines", originalLength: brief.content.length, retainedLength: brief.content.length, truncated: false } });
    expect(brief.references).toEqual([
      { title: story.title, source: "Campaign India", url },
      { title: "Vistar Media's programmatic DOOH marketplace arrives in India", source: "Exchange4Media", url: "https://news.google.com/rss/articles/14" },
    ]);
  });

  it("leaves out a snippet that only repeats the headline and outlet, and related links it doesn't have", () => {
    const brief = storyBrief({ ...story, snippet: `${story.title}  Campaign India`, publishedAt: null },
      [headline("Vistar Media programmatic DOOH marketplace lands in India", "Adgully", null, null)]);
    expect(brief.content).toBe(`Campaign India reported: ${story.title}\n\nRelated coverage, Adgully: Vistar Media programmatic DOOH marketplace lands in India`);
    expect(brief.references).toHaveLength(1);
  });

  it("is labelled as written from headlines, not warned about as merely short", () => {
    const evidence = buildEvidenceBrief(storyBrief(story, []));
    expect(evidence.warnings.map(warning => warning.code)).toEqual(["headlines_only"]);
    expect(evidence.excerpts.map(excerpt => excerpt.id)).toEqual(["p1", "p2"]);
  });
});

describe("knownStory", () => {
  it("uses the person's own Discover copy first, without the outlet Google appends to its headline", async () => {
    inbox.mockResolvedValue({ headline: `${story.title} - Campaign India`, source: "Campaign India", summary: story.snippet, publishedAt: new Date(story.publishedAt!) });
    expect(await knownStory(scope, url)).toEqual(story);
    expect(inbox).toHaveBeenCalledWith(scope, url);
    expect(pooled).not.toHaveBeenCalled();
  });

  it("falls back to the shared index, then to nothing", async () => {
    pooled.mockResolvedValueOnce({ title: story.title, source: "Campaign India", content: "excerpt", publishedAt: null });
    expect(await knownStory(scope, url)).toEqual({ ...story, snippet: "excerpt", publishedAt: null });
    expect(await knownStory(scope, url)).toBeNull();
  });

  it("treats lookup failures as unknown", async () => {
    inbox.mockRejectedValue(new Error("db down"));
    pooled.mockRejectedValue(new Error("db down"));
    expect(await knownStory(scope, url)).toBeNull();
  });
});

describe("relatedCoverage", () => {
  it("keeps one headline per other outlet about the same development, within days of it", async () => {
    headlines.mockResolvedValue([
      headline("Vistar Media launches programmatic DOOH marketplace in India", "Campaign India"),
      headline("Vistar Media brings programmatic DOOH marketplace to India", "Exchange4Media"),
      headline("Vistar Media programmatic DOOH marketplace now live in India", "Exchange4Media"),
      headline("Programmatic DOOH spend rises in India", "Adgully"),
      headline("Vistar Media launched programmatic DOOH marketplace India", "Old News", "2026-09-01T00:00:00.000Z"),
      ...["A", "B", "C", "D", "E"].map(name => headline("Vistar Media opens programmatic DOOH marketplace in India", `Outlet ${name}`)),
    ]);
    const related = await relatedCoverage(story, "en-IN", signal);
    expect(related.map(item => item.source)).toEqual(["Exchange4Media", "Outlet A", "Outlet B", "Outlet C", "Outlet D"]);
    expect(headlines).toHaveBeenCalledWith(story.title, "en-IN", expect.any(AbortSignal), null);
  });

  it("returns nothing when the search fails", async () => {
    headlines.mockRejectedValue(new Error("rate limited"));
    expect(await relatedCoverage(story, "en-US", signal)).toEqual([]);
  });
});

describe("storyBriefFor", () => {
  it("searches the person's news edition and builds the brief", async () => {
    inbox.mockResolvedValue({ headline: story.title, source: "Campaign India", summary: story.snippet, publishedAt: new Date(story.publishedAt!) });
    headlines.mockResolvedValue([headline("Vistar Media brings programmatic DOOH marketplace to India", "Exchange4Media")]);
    const brief = await storyBriefFor(scope, url, signal);
    expect(headlines).toHaveBeenCalledWith(story.title, "en-IN", expect.any(AbortSignal), null);
    expect(brief?.references.map(reference => reference.source)).toEqual(["Campaign India", "Exchange4Media"]);
  });

  it("returns null for a link nothing is known about, without searching", async () => {
    expect(await storyBriefFor(scope, url, signal)).toBeNull();
    expect(headlines).not.toHaveBeenCalled();
  });
});
