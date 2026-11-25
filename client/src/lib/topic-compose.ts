import { apiRequest, queryClient } from "./queryClient";
import type { TopicAngle, TopicBriefResponse, TopicStory } from "@shared/topic-stories";

/** Topic-first writing in Compose: related stories, angle ideas and recent topics. */
export async function findTopicStories(topic: string, signal?: AbortSignal): Promise<TopicBriefResponse> {
  return (await apiRequest("POST", "/api/topics/related", { topic: topic.trim() }, { signal })).json();
}

export async function suggestTopicAngles(briefId: string, signal?: AbortSignal): Promise<TopicAngle[]> {
  const body = await (await apiRequest("POST", `/api/topics/${encodeURIComponent(briefId)}/angles`, {}, { signal })).json() as { angles?: TopicAngle[] };
  return Array.isArray(body.angles) ? body.angles : [];
}

export const RECENT_TOPICS_KEY = ["/api/topics/recent"] as const;

/** Optional: keep one story in the Shortlist. Topic stories are otherwise kept only for 24 hours. */
export async function saveTopicStory(story: TopicStory): Promise<void> {
  await apiRequest("POST", "/api/search/news/save", {
    url: story.url, title: story.title.slice(0, 500), source: story.source.slice(0, 200), publishedAt: story.publishedAt,
    snippet: story.snippet ? story.snippet.slice(0, 1000) : null,
  });
  void queryClient.invalidateQueries({ queryKey: ["/api/inbox"] });
}

/** The label a written post carries: what it was written from. */
export function writtenFromLabel(warnings: ReadonlyArray<{ code: string }> | undefined): "headlines" | "opinion" | null {
  if (warnings?.some(warning => warning.code === "opinion_only")) return "opinion";
  if (warnings?.some(warning => warning.code === "headlines_only")) return "headlines";
  return null;
}

export function storyMeta(story: TopicStory, locale?: string): string {
  const date = story.publishedAt ? new Date(story.publishedAt).toLocaleDateString(locale, { day: "numeric", month: "short" }) : "";
  const others = story.alsoCoveredBy.length ? `+${story.alsoCoveredBy.length} outlet${story.alsoCoveredBy.length === 1 ? "" : "s"}` : "";
  return [story.source, date, others].filter(Boolean).join(" · ");
}
