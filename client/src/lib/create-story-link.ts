import { apiRequest, queryClient } from "./queryClient";

/** Onboarding's "Write a post" opens Create with a story link carried in navigation state. */
export const STORY_LINK_KEY = "createFromUrl";

export interface StoryToWrite { link: string; title: string; source: string; publishedAt: string | null }

/**
 * Saves a headline to the Shortlist before Create opens it, so Pundit knows its title, outlet and date
 * and can write from them when the page itself can't be read (most onboarding links are Google News
 * links). Returns the link Create should open: the saved story's, or the original if saving failed.
 */
export async function saveStoryForCreate(story: StoryToWrite): Promise<string> {
  try {
    const item = await (await apiRequest("POST", "/api/search/news/save", {
      url: story.link, title: story.title.slice(0, 500), source: story.source.slice(0, 200), publishedAt: story.publishedAt,
    })).json() as { articleUrl?: unknown };
    void queryClient.invalidateQueries({ queryKey: ["/api/inbox"] });
    return typeof item.articleUrl === "string" && storyLinkFromState({ [STORY_LINK_KEY]: item.articleUrl }) ? item.articleUrl : story.link;
  } catch {
    return story.link;
  }
}

export function storyLinkFromState(state: unknown): string | undefined {
  if (!state || typeof state !== "object") return undefined;
  const value = (state as Record<string, unknown>)[STORY_LINK_KEY];
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function withoutStoryLink(state: unknown): unknown {
  if (!state || typeof state !== "object") return state;
  const { [STORY_LINK_KEY]: _link, ...rest } = state as Record<string, unknown>;
  return rest;
}

/** Reminder emails open Create at /dashboard/create?article=<story URL>. */
export function storyLinkFromSearch(search: string): string | undefined {
  return storyLinkFromState({ [STORY_LINK_KEY]: new URLSearchParams(search).get("article") ?? undefined });
}

export function withoutArticleParam(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete("article");
  const rest = params.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}
