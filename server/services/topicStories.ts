import { canonicalHttpUrl } from "@shared/canonical-url";
import { TOPIC_LIMITS, topicQueries, topicWords, type TopicOutlet, type TopicStory } from "@shared/topic-stories";
import { storage, type TenantScope } from "../storage";
import { findPooledArticle } from "./articlePool";
import { publicationDate } from "./articleDates";
import { searchNews, type NewsSearchHit } from "./newsSearch";
import { sameDevelopment, storyBrief } from "./storyBrief";
import { pickedOutlets } from "../repositories/topicBriefs";
import type { FetchedArticle } from "./urlFetcher";

/**
 * Topic-first writing: stories related to a one-liner or saved keyword, from the person's own Discover
 * and a news search (shared index, Google News and Bing, already grouped across outlets). No page is
 * read here; whether the shared index holds an article's text is only looked up.
 */
const NEWS_LIMIT = 20;
const ENOUGH_STORIES = 3;
const DISCOVER_LIMIT = 200;
const DAY_MS = 86_400_000;

export interface DiscoverStory { headline: string; source: string; articleUrl: string; summary: string | null; publishedAt: Date | string | null }
export interface RelatedStoriesDeps {
  search: (query: string, edition: string) => Promise<NewsSearchHit[]>;
  discover: (scope: TenantScope) => Promise<DiscoverStory[]>;
  hasFullText: (url: string) => Promise<boolean>;
  outletPreferences: (scope: TenantScope) => Promise<Map<string, number>>;
  now: () => number;
}

export const defaultRelatedStoriesDeps: RelatedStoriesDeps = {
  search: async (query, edition) => (await searchNews({ query, edition, limit: NEWS_LIMIT })).results,
  discover: async scope => {
    const [active, saved] = await Promise.all([
      storage.getInboxItems(scope, { status: "active", limit: DISCOVER_LIMIT }),
      storage.getInboxItems(scope, { status: "saved", limit: DISCOVER_LIMIT }),
    ]);
    return [...active, ...saved];
  },
  hasFullText: async url => {
    const pooled = await findPooledArticle(url).catch(() => null);
    return Boolean(pooled?.readable && pooled.inputKind === "page_body" && pooled.content);
  },
  outletPreferences: scope => pickedOutlets(scope).catch(() => new Map<string, number>()),
  now: () => Date.now(),
};

type Candidate = Omit<TopicStory, "id" | "fullText">;

const lower = (value: string) => value.toLowerCase();
const keyOf = (url: string) => canonicalHttpUrl(url) ?? url;

/** Share of the topic's meaningful words that appear in the text (0 to 1). */
export function topicRelevance(words: readonly string[], text: string): number {
  if (!words.length) return 0;
  const haystack = ` ${lower(text).replace(/[^\p{L}\p{N}&]+/gu, " ")} `;
  const found = words.filter(word => haystack.includes(` ${lower(word).replace(/[^\p{L}\p{N}&]+/gu, " ").trim()} `)).length;
  return found / words.length;
}

function freshness(publishedAt: string | null, now: number): number {
  const time = publishedAt ? Date.parse(publishedAt) : NaN;
  if (!Number.isFinite(time)) return 0.6;
  const days = Math.max(0, (now - time) / DAY_MS);
  return days <= 2 ? 1 : Math.max(0.3, 1 - (days - 2) / 40);
}

function fromHit(hit: NewsSearchHit): Candidate {
  return { title: hit.title, source: hit.source, url: hit.url, snippet: hit.snippet, publishedAt: hit.publishedAt,
    alsoCoveredBy: hit.alsoCoveredBy.slice(0, 5), origin: "news" };
}

function fromDiscover(item: DiscoverStory): Candidate {
  const published = item.publishedAt ? new Date(item.publishedAt) : null;
  return { title: item.headline, source: item.source, url: item.articleUrl, snippet: (item.summary ?? "").slice(0, 280),
    publishedAt: published && !Number.isNaN(published.getTime()) ? published.toISOString() : null, alsoCoveredBy: [], origin: "discover" };
}

/**
 * Every result of a topic search shares the topic's words, so two headlines report the same news only
 * when they also share most of their other words.
 */
function sameNews(topicWordList: readonly string[], a: string, b: string): boolean {
  const topic = new Set(topicWordList.map(lower));
  const rest = (title: string) => title.split(/\s+/).filter(word => !topic.has(lower(word.replace(/[^\p{L}\p{N}&]/gu, "")))).join(" ");
  return sameDevelopment(rest(a), rest(b));
}

/** Folds the person's Discover stories into the news results: same link, or the same development from another outlet. */
function merge(news: Candidate[], discover: Candidate[], words: readonly string[]): Candidate[] {
  const merged = news.map(candidate => ({ ...candidate, alsoCoveredBy: [...candidate.alsoCoveredBy] }));
  for (const story of discover) {
    const key = keyOf(story.url);
    const same = merged.find(candidate => keyOf(candidate.url) === key || candidate.alsoCoveredBy.some(outlet => keyOf(outlet.url) === key));
    if (same) { same.origin = "discover"; continue; }
    const development = merged.find(candidate => sameNews(words, candidate.title, story.title));
    if (development) {
      if (lower(development.source) !== lower(story.source) && !development.alsoCoveredBy.some(outlet => lower(outlet.source) === lower(story.source))) {
        development.alsoCoveredBy.push({ source: story.source, url: story.url } satisfies TopicOutlet);
      }
      continue;
    }
    merged.push(story);
  }
  return merged;
}

/** One entry per development: a later outlet's copy of the same news becomes "also covered by" on the first. */
export function groupSameDevelopment(candidates: readonly Candidate[], topicWordList: readonly string[] = []): Candidate[] {
  const groups: Candidate[] = [];
  for (const candidate of candidates) {
    const group = groups.find(kept => sameNews(topicWordList, kept.title, candidate.title));
    if (!group) { groups.push({ ...candidate, alsoCoveredBy: [...candidate.alsoCoveredBy] }); continue; }
    for (const outlet of [{ source: candidate.source, url: candidate.url }, ...candidate.alsoCoveredBy]) {
      const known = lower(outlet.source) === lower(group.source) || group.alsoCoveredBy.some(existing => lower(existing.source) === lower(outlet.source));
      if (!known) group.alsoCoveredBy.push(outlet);
    }
    if (candidate.origin === "discover" && !group.snippet) group.snippet = candidate.snippet;
  }
  return groups;
}

/**
 * Up to six stories for a topic, best first. News is searched with the topic's first few meaningful
 * words, then fewer when that finds too little; the person's own Discover stories count when they
 * mention most of the topic. Outlets the person wrote from recently rank a little higher.
 */
export async function findRelatedStories(scope: TenantScope, topic: string, edition: string, deps: RelatedStoriesDeps = defaultRelatedStoriesDeps):
  Promise<{ searchedFor: string; stories: TopicStory[] }> {
  const words = topicWords(topic);
  const queries = topicQueries(topic);
  if (!words.length || !queries.length) return { searchedFor: "", stories: [] };
  const discoverWork = deps.discover(scope).catch(() => [] as DiscoverStory[]);
  const preferencesWork = deps.outletPreferences(scope).catch(() => new Map<string, number>());

  let searchedFor = queries[0];
  const hits = new Map<string, NewsSearchHit>();
  for (const query of queries) {
    searchedFor = query;
    for (const hit of await deps.search(query, edition).catch(() => [] as NewsSearchHit[])) if (!hits.has(keyOf(hit.url))) hits.set(keyOf(hit.url), hit);
    if (hits.size >= ENOUGH_STORIES) break;
  }

  // A Discover story counts when it mentions most of the topic (all of a one- or two-word topic).
  const needed = words.length <= 2 ? 1 : 0.5;
  const discover = (await discoverWork).map(fromDiscover).filter(story => topicRelevance(words, `${story.title} ${story.snippet}`) >= needed);
  const preferences = await preferencesWork;
  const now = deps.now();
  const scored = groupSameDevelopment(merge([...hits.values()].map(fromHit), discover, words), words)
    .map(candidate => {
      const relevance = topicRelevance(words, `${candidate.title} ${candidate.snippet}`);
          const outlets = 0.08 * Math.min(candidate.alsoCoveredBy.length, 5);
      const preferred = 0.05 * Math.min(preferences.get(lower(candidate.source)) ?? 0, 3);
      const yours = candidate.origin === "discover" ? 0.05 : 0;
      return { candidate, relevance, score: relevance * 0.6 + freshness(candidate.publishedAt, now) * 0.25 + outlets + preferred + yours };
    })
    // A longer topic needs at least half its words in the headline or snippet; a passing mention isn't related.
    .filter(entry => words.length >= 3 ? entry.relevance >= 0.5 : entry.relevance > 0)
    .sort((a, b) => b.score - a.score || a.candidate.url.localeCompare(b.candidate.url))
    .slice(0, TOPIC_LIMITS.stories);
  const fullText = await Promise.all(scored.map(entry => deps.hasFullText(entry.candidate.url).catch(() => false)));
  return { searchedFor, stories: scored.map((entry, index) => ({
    id: `s${index + 1}`, ...entry.candidate, alsoCoveredBy: entry.candidate.alsoCoveredBy.slice(0, 8), fullText: fullText[index] })) };
}

export type TopicArticle = FetchedArticle & { references?: Array<{ title: string; source: string; url: string }> };

/**
 * One article per ticked story, for the writer: the stored text when the shared index has it,
 * otherwise a headline brief naming the outlet and the others covering it. Never reads a page.
 */
export async function topicStoryArticles(stories: readonly TopicStory[]): Promise<TopicArticle[]> {
  return Promise.all(stories.map(async story => {
    const pooled = story.fullText ? await findPooledArticle(story.url).catch(() => null) : null;
    if (pooled?.readable && pooled.inputKind === "page_body" && pooled.content) {
      const publishedAt = pooled.publishedAt?.toISOString() ?? story.publishedAt;
      let domain = "";
      try { domain = new URL(story.url).hostname.replace(/^www\./, ""); } catch { /* stored links are validated */ }
      return { title: story.title, content: pooled.content, source: story.source, url: story.url, domain,
        contentMetadata: { extractionMethod: "index" as const, originalLength: pooled.content.length, retainedLength: pooled.content.length, truncated: false },
        publishedAt, publicationDate: publicationDate(publishedAt, "rss-pubDate"),
        references: [{ title: story.title, source: story.source, url: story.url },
          ...story.alsoCoveredBy.map(outlet => ({ title: "Coverage of the same story", source: outlet.source, url: outlet.url }))] };
    }
    return storyBrief({ title: story.title, source: story.source, url: story.url, snippet: story.snippet, publishedAt: story.publishedAt, alsoCoveredBy: story.alsoCoveredBy }, []);
  }));
}
