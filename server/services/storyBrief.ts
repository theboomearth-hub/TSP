import { storage, type TenantScope } from "../storage";
import { findPooledArticle } from "./articlePool";
import { findTopicStory } from "../repositories/topicBriefs";
import type { TopicOutlet } from "@shared/topic-stories";
import { fetchNewsHeadlines, type NewsHeadline } from "./keywordSearch";
import { publicationDate } from "./articleDates";
import type { FetchedArticle } from "./urlFetcher";

/**
 * A story Pundit can write about without reading its page: the headline, snippet, outlet and date
 * that Discover already holds, plus other outlets' headlines on it. Used when the page itself is
 * paywalled, blocked or hidden behind a Google News link, so "Write a post" never dead-ends.
 */
export interface StorySignal {
  title: string; source: string; url: string; snippet: string; publishedAt: string | null;
  /** Other outlets already known to cover it (a topic search grouped them); no search is needed then. */
  alsoCoveredBy?: TopicOutlet[];
}
export interface StoryReference { title: string; source: string; url: string }
export type StoryBrief = FetchedArticle & { references: StoryReference[] };

const SNIPPET_LIMIT = 1500;
const RELATED_LIMIT = 5;
const RELATED_SEARCH_TIMEOUT_MS = 4000;
// Coverage of one development lands within days of it; older or newer headlines are other stories.
const RELATED_WINDOW_MS = 10 * 86_400_000;
const STOP_WORDS = new Set(("the a an and or but for nor of in on at to from by with as is are was were be been its it this that these those " +
  "into over after before about new says say said will can could would should may might has have had not than more most how why what " +
  "who when where which their they them his her our your you we us").split(" "));

const clean = (text: string) => text.replace(/\s+/g, " ").trim();

function significantWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => word.length > 2 && !STOP_WORDS.has(word)));
}

/** Google appends " - <publication>" to headlines; the outlet is shown separately. */
function withoutOutletSuffix(title: string, source: string): string {
  const suffix = ` - ${source}`;
  return source && title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() : title.trim();
}

/**
 * Two headlines about the same development share most of the meaningful words of the longer one.
 * Strict on purpose: missing a related headline costs little; attributing another story to an outlet does not.
 */
export function sameDevelopment(a: string, b: string): boolean {
  const left = significantWords(a);
  const right = significantWords(b);
  if (!left.size || !right.size) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared >= 3 && shared / Math.max(left.size, right.size) >= 0.5;
}

/** A snippet worth passing on says something the headline and outlet name don't (feeds often repeat them). */
function usefulSnippet(snippet: string, title: string, source: string): string {
  const text = clean(snippet).slice(0, SNIPPET_LIMIT);
  const known = new Set([...significantWords(title), ...significantWords(source)]);
  const fresh = [...significantWords(text)].filter(word => !known.has(word));
  return fresh.length >= 4 ? text : "";
}

function dayLabel(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * What is already known about a link: the person's own Discover copy, then a story from one of their
 * topic searches, then the shared index. Never throws.
 */
export async function knownStory(scope: TenantScope, url: string): Promise<StorySignal | null> {
  const item = await Promise.resolve().then(() => storage.getInboxItemByUrl(scope, url)).catch(() => undefined);
  if (item?.headline?.trim() && item.source?.trim()) {
    return { title: withoutOutletSuffix(item.headline, item.source), source: item.source.trim(), url,
      snippet: item.summary ?? "", publishedAt: item.publishedAt ? new Date(item.publishedAt).toISOString() : null };
  }
  const picked = await Promise.resolve().then(() => findTopicStory(scope, url)).catch(() => undefined);
  if (picked) return { title: picked.title, source: picked.source, url, snippet: picked.snippet, publishedAt: picked.publishedAt, alsoCoveredBy: picked.alsoCoveredBy };
  const pooled = await findPooledArticle(url).catch(() => null);
  if (pooled?.title.trim() && pooled.source.trim()) {
    return { title: withoutOutletSuffix(pooled.title, pooled.source), source: pooled.source.trim(), url,
      snippet: pooled.content, publishedAt: pooled.publishedAt?.toISOString() ?? null };
  }
  return null;
}

/** Other outlets' headlines on the same development, from one quick news search. Never throws. */
export async function relatedCoverage(story: StorySignal, searchEdition: string, signal: AbortSignal): Promise<NewsHeadline[]> {
  let headlines: NewsHeadline[];
  try {
    // Any age: the story may be weeks old. The date window below keeps coverage of the same days.
    headlines = await fetchNewsHeadlines(story.title.slice(0, 200), searchEdition, AbortSignal.any([signal, AbortSignal.timeout(RELATED_SEARCH_TIMEOUT_MS)]), null);
  } catch {
    return [];
  }
  const storyTime = story.publishedAt ? Date.parse(story.publishedAt) : NaN;
  const outlets = new Set([story.source.toLowerCase()]);
  const related: NewsHeadline[] = [];
  for (const headline of headlines) {
    const outlet = headline.source.toLowerCase();
    if (outlets.has(outlet) || !sameDevelopment(story.title, headline.title)) continue;
    const time = headline.publishedAt ? Date.parse(headline.publishedAt) : NaN;
    if (Number.isFinite(storyTime) && Number.isFinite(time) && Math.abs(time - storyTime) > RELATED_WINDOW_MS) continue;
    outlets.add(outlet);
    related.push(headline);
    if (related.length >= RELATED_LIMIT) break;
  }
  return related;
}

/** The brief the writer works from: one line per passage, each naming its outlet, so every point can be attributed. */
export function storyBrief(story: StorySignal, related: readonly NewsHeadline[]): StoryBrief {
  const date = dayLabel(story.publishedAt);
  const lines = [`${story.source} reported${date ? ` on ${date}` : ""}: ${clean(story.title)}`];
  const snippet = usefulSnippet(story.snippet, story.title, story.source);
  if (snippet) lines.push(`${story.source}: ${snippet}`);
  for (const headline of related) {
    const day = dayLabel(headline.publishedAt);
    lines.push(`Related coverage, ${headline.source}${day ? ` (${day})` : ""}: ${clean(headline.title)}`);
  }
  const covering = (story.alsoCoveredBy ?? []).filter(outlet => outlet.source.toLowerCase() !== story.source.toLowerCase());
  if (covering.length) lines.push(`Also covered by ${listOf(covering.map(outlet => outlet.source))}.`);
  const content = lines.join("\n\n");
  const references: StoryReference[] = [{ title: clean(story.title), source: story.source, url: story.url },
    ...related.flatMap(headline => headline.link ? [{ title: clean(headline.title), source: headline.source, url: headline.link }] : []),
    ...covering.map(outlet => ({ title: "Coverage of the same story", source: outlet.source, url: outlet.url }))];
  let domain = "";
  try { domain = new URL(story.url).hostname.replace(/^www\./, ""); } catch { /* the link was validated upstream */ }
  return {
    title: clean(story.title), content, source: story.source, url: story.url, domain, references,
    contentMetadata: { extractionMethod: "headlines", originalLength: content.length, retainedLength: content.length, truncated: false },
    publishedAt: story.publishedAt, publicationDate: publicationDate(story.publishedAt, "rss-pubDate"),
  };
}

function listOf(names: string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** A brief for a link Discover knows, or null when nothing is known about it. Only an abort throws. */
export async function storyBriefFor(scope: TenantScope, url: string, signal: AbortSignal): Promise<StoryBrief | null> {
  const story = await knownStory(scope, url);
  signal.throwIfAborted();
  if (!story) return null;
  if (story.alsoCoveredBy?.length) return storyBrief(story, []);
  const profile = await Promise.resolve().then(() => storage.getUserProfile(scope)).catch(() => undefined);
  const related = await relatedCoverage(story, profile?.searchEdition ?? "en-US", signal);
  signal.throwIfAborted();
  return storyBrief(story, related);
}
