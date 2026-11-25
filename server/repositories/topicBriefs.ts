import { and, desc, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { canonicalHttpUrl } from "@shared/canonical-url";
import { topicBriefs, type TopicBrief } from "@shared/schema";
import { TOPIC_BRIEF_HOURS, type TopicAngle, type TopicStory } from "@shared/topic-stories";
import { withTenantTransaction, type TenantScope } from "../storage";

/** Topic-first writing: the stories one topic search found, kept for the person for 24 hours. */
const owned = (scope: TenantScope) => and(eq(topicBriefs.tenantId, scope.tenantId), eq(topicBriefs.userId, scope.userId));
const live = () => gt(topicBriefs.expiresAt, sql`now()`);
const RECENT_LIMIT = 20;

export async function createTopicBrief(scope: TenantScope, input: { topic: string; searchedFor: string; stories: TopicStory[] }): Promise<TopicBrief> {
  return withTenantTransaction(scope, async tx => {
    // Expired briefs are never read again; clearing them here keeps the table small without a job.
    // Briefs written from are kept 30 days more: recent topics and outlet preferences read them.
    await tx.delete(topicBriefs).where(and(owned(scope), lt(topicBriefs.expiresAt, sql`now()`),
      or(isNull(topicBriefs.usedAt), lt(topicBriefs.usedAt, sql`now() - interval '30 days'`))));
    const [brief] = await tx.insert(topicBriefs).values({
      tenantId: scope.tenantId, userId: scope.userId, topic: input.topic, searchedFor: input.searchedFor, stories: input.stories,
      expiresAt: sql`now() + make_interval(hours => ${TOPIC_BRIEF_HOURS})`,
    }).returning();
    return brief;
  });
}

/** The person's own brief, while it lasts. */
export async function getTopicBrief(scope: TenantScope, id: string): Promise<TopicBrief | undefined> {
  return withTenantTransaction(scope, async tx => (await tx.select().from(topicBriefs).where(and(owned(scope), eq(topicBriefs.id, id), live())).limit(1))[0]);
}

export async function saveTopicAngles(scope: TenantScope, id: string, angles: TopicAngle[]): Promise<void> {
  await withTenantTransaction(scope, tx => tx.update(topicBriefs).set({ angles }).where(and(owned(scope), eq(topicBriefs.id, id))));
}

/** Records what the person wrote from; recent topics and outlet preferences are read from this. */
export async function markTopicBriefUsed(scope: TenantScope, id: string, picked: string[]): Promise<void> {
  await withTenantTransaction(scope, tx => tx.update(topicBriefs).set({ picked, usedAt: sql`now()` }).where(and(owned(scope), eq(topicBriefs.id, id))));
}

/** A story from any of the person's live briefs, by link: lets Create attach topic stories by URL. */
export async function findTopicStory(scope: TenantScope, url: string): Promise<TopicStory | undefined> {
  const key = canonicalHttpUrl(url);
  if (!key) return undefined;
  const rows = await withTenantTransaction(scope, tx => tx.select({ stories: topicBriefs.stories }).from(topicBriefs)
    .where(and(owned(scope), live(), sql`exists (select 1 from jsonb_array_elements(${topicBriefs.stories}) story where story->>'url' = ${url} or story->>'url' = ${key})`))
    .orderBy(desc(topicBriefs.createdAt)).limit(1));
  return rows[0]?.stories.find(story => story.url === url || canonicalHttpUrl(story.url) === key);
}

/** Topics the person wrote about recently, newest first, one entry per topic. */
export async function recentTopics(scope: TenantScope, limit = 5): Promise<string[]> {
  const rows = await withTenantTransaction(scope, tx => tx.select({ topic: topicBriefs.topic }).from(topicBriefs)
    .where(and(owned(scope), isNotNull(topicBriefs.usedAt))).orderBy(desc(topicBriefs.usedAt)).limit(RECENT_LIMIT));
  const topics = new Map<string, string>();
  for (const { topic } of rows) if (!topics.has(topic.toLowerCase())) topics.set(topic.toLowerCase(), topic);
  return [...topics.values()].slice(0, limit);
}

/** Outlets of the stories the person actually wrote from in the last 30 days, with how often. */
export async function pickedOutlets(scope: TenantScope): Promise<Map<string, number>> {
  const rows = await withTenantTransaction(scope, tx => tx.select({ stories: topicBriefs.stories, picked: topicBriefs.picked }).from(topicBriefs)
    .where(and(owned(scope), isNotNull(topicBriefs.usedAt), sql`${topicBriefs.usedAt} > now() - interval '30 days'`)).orderBy(desc(topicBriefs.usedAt)).limit(RECENT_LIMIT));
  const counts = new Map<string, number>();
  for (const row of rows) {
    const picked = new Set(row.picked);
    for (const story of row.stories) if (picked.has(story.id)) counts.set(story.source.toLowerCase(), (counts.get(story.source.toLowerCase()) ?? 0) + 1);
  }
  return counts;
}
