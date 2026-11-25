/**
 * Writing from a topic instead of an article: a one-liner, a saved keyword or an idea finds related
 * stories (headlines, snippets, outlets), and Pundit writes from the ones the person ticks.
 * See docs/superpowers/specs/2026-11-25-topic-first-writing-design.md.
 */
export const TOPIC_LIMITS = { minChars: 3, maxChars: 200, viewChars: 1000, stories: 6, ticked: 3, angles: 3 } as const;
/** Picked stories live this long; afterwards writing from them needs a fresh search. */
export const TOPIC_BRIEF_HOURS = 24;

export const TOPIC_SHAPES = ["post", "roundup", "takeaways", "take"] as const;
export type TopicShape = typeof TOPIC_SHAPES[number];
export const TOPIC_SHAPE_LABELS: Record<TopicShape, string> = {
  post: "Post", roundup: "Roundup", takeaways: "3 takeaways", take: "My take",
};

export interface TopicOutlet { source: string; url: string }
export interface TopicStory {
  /** Stable within one brief: s1 is the best match. */
  id: string;
  title: string;
  source: string;
  url: string;
  snippet: string;
  publishedAt: string | null;
  /** Other outlets covering the same development. */
  alsoCoveredBy: TopicOutlet[];
  /** The shared index holds the article's text, so the post can use more than the headline. */
  fullText: boolean;
  /** Where it was found: the person's own Discover, or a news search. */
  origin: "discover" | "news";
}
export interface TopicAngle { title: string; why: string; storyIds: string[] }
export interface TopicBriefResponse {
  briefId: string;
  topic: string;
  /** The search actually run, so the person can see what was looked for. */
  searchedFor: string;
  stories: TopicStory[];
  expiresAt: string;
}

const STOP_WORDS = new Set(("a an and or but for nor of in on at to from by with as is are was were be been being its it this that these those " +
  "into over after before about how why what who when where which will can could would should may might must has have had do does did " +
  "not no than more most less least very really just also our your my their his her we you they i me us them " +
  "new latest today now next future need needs needed better best good great big real way ways thing things post write " +
  "thoughts think view take matters matter important why's let lets").split(" "));

/** Meaningful words of a topic, in the order written, without duplicates. Short acronyms (AI, OOH) count. */
export function topicWords(topic: string): string[] {
  const words = topic.normalize("NFKC").match(/[\p{L}\p{N}][\p{L}\p{N}&'’.-]*/gu) ?? [];
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of words) {
    const word = raw.replace(/['’.-]+$/u, "");
    const key = word.toLowerCase();
    const acronym = /^[\p{Lu}\p{N}]{2,}$/u.test(word);
    if (seen.has(key) || STOP_WORDS.has(key) || (!acronym && key.length < 3)) continue;
    seen.add(key);
    kept.push(word);
  }
  return kept;
}

/**
 * The news queries for a topic, most specific first. News search needs every word to match, so a
 * sentence is cut to its first few meaningful words, then fewer if that finds too little.
 */
export function topicQueries(topic: string): string[] {
  const words = topicWords(topic);
  if (!words.length) return [];
  const queries = [words.slice(0, 3).join(" "), words.slice(0, 2).join(" ")];
  return [...new Set(queries.filter(Boolean))];
}
