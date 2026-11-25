import type { Request } from "express";
import { z } from "zod";
import { ALL_PLATFORM_KEYS } from "@shared/schema";
import { authedOf } from "../middlewares/requireDbUser";
import { storage } from "../storage";
import { editorialContext, editorialPreferences, reviewUrl, validateEditorialFormat } from "../routes/editorial-context";
import { AIGenerationError } from "./openRouter";
import { generateMainDraftDetailed, generatePlatformReviewsDetailed, type EditorialOptions } from "./punditBrain";
import { fetchArticleFromUrl, type FetchedArticle } from "./urlFetcher";
import { findPooledArticle } from "./articlePool";
import { publicationDate } from "./articleDates";
import { CrawlError } from "./crawlerFetch";
import { isGoogleNewsArticleUrl, resolveGoogleNewsArticleUrl } from "./keywordSearch";
import { MAX_CREATION_REFERENCES } from "@shared/creation-session";
import { buildEvidenceBrief, MAX_SOURCE_CHARACTERS, MAX_SOURCE_PASSAGES } from "./editorialEvidence";
import { storyBriefFor, type StoryReference } from "./storyBrief";
import type { TenantScope } from "../storage";
import { findTopicStory, getTopicBrief, markTopicBriefUsed } from "../repositories/topicBriefs";
import { topicStoryArticles } from "./topicStories";
import { TOPIC_LIMITS } from "@shared/topic-stories";
import { TopicBriefUnavailableError } from "./topicBriefError";
export { TopicBriefUnavailableError } from "./topicBriefError";

// One link, so it can wait longer than the per-result budget during Discover refreshes.
const GOOGLE_NEWS_RESOLVE_TIMEOUT_MS = 5000;
const GOOGLE_NEWS_LINK_MESSAGE = "Google News hides the original link for this story. Open it, copy the publisher's link, and paste it here.";

/** Google News pages have no article body; read the publisher's page instead. */
async function publisherUrl(url: string, signal: AbortSignal): Promise<string> {
  if (!isGoogleNewsArticleUrl(url)) return url;
  const resolved = await resolveGoogleNewsArticleUrl(url, signal, GOOGLE_NEWS_RESOLVE_TIMEOUT_MS);
  if (isGoogleNewsArticleUrl(resolved)) throw new CrawlError("google-news", GOOGLE_NEWS_LINK_MESSAGE);
  return resolved;
}

type ReadArticle = FetchedArticle & { references?: StoryReference[] };

/**
 * Most Discover stories are already in the shared index with their page read; otherwise read the
 * publisher live. A page that can't be read (paywall, block, a Google News link that won't resolve)
 * is written from the story's headline, snippet and other outlets' headlines when Discover knows
 * the story; only a link nothing is known about fails.
 */
async function readArticle(url: string, signal: AbortSignal, scope?: TenantScope): Promise<ReadArticle> {
  try {
    return await readPage(url, signal);
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof CrawlError) || !scope) throw error;
    const brief = await storyBriefFor(scope, url, signal);
    if (brief) {
      console.log(`[story-brief] writing from headlines (${error.code})`);
      return brief;
    }
    throw error;
  }
}

async function readPage(url: string, signal: AbortSignal): Promise<FetchedArticle> {
  try {
    const target = await publisherUrl(url, signal);
    const indexed = await findPooledArticle(target).catch(() => null);
    if (indexed?.readable && indexed.inputKind === "page_body" && indexed.content) {
      console.log("[shared-index] story read from the index");
      const publishedAt = indexed.publishedAt?.toISOString() ?? null;
      return {
        title: indexed.title, content: indexed.content, source: indexed.source, url: indexed.canonicalUrl,
        domain: new URL(indexed.canonicalUrl).hostname.replace(/^www\./, ""),
        contentMetadata: { extractionMethod: "index", originalLength: indexed.content.length, retainedLength: indexed.content.length, truncated: false },
        publishedAt, publicationDate: publicationDate(publishedAt, "rss-pubDate"),
      };
    }
    return await fetchArticleFromUrl(target, signal);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof CrawlError) throw new CrawlError(error.code,
      `${new URL(url).hostname}: ${error.message}`, [{ url, message: error.message }]);
    throw error;
  }
}

const selection = z.array(z.enum(ALL_PLATFORM_KEYS)).max(4);
const requestIntent = z.string().uuid().optional();
const stage = z.enum(["main", "platform"]).optional();
const draftEditing = {
  instruction: z.string().trim().min(1).max(4000).optional(),
  currentDraft: z.string().max(5000).optional(),
};
const validSelection = (input: { stage?: "main" | "platform"; selectedPlatforms: string[] }) =>
  input.stage === "main" ? input.selectedPlatforms.length === 0 : input.selectedPlatforms.length > 0;
export const selectedReviewSchema = z.object({ ...editorialPreferences, ...draftEditing, requestIntent, stage, url: reviewUrl, selectedPlatforms: selection }).refine(validSelection);
export const manualReviewSchema = z.object({
  ...editorialPreferences,
  ...draftEditing,
  requestIntent,
  stage,
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().max(24_000),
  media: z.array(z.object({ id: z.string().uuid().optional(), type: z.enum(["image", "video", "audio"]), name: z.string().max(255), url: z.string().max(2_000) })).max(8).default([]),
  selectedPlatforms: selection.default(["linkedin"]),
  sourceUrl: reviewUrl.optional(),
  sourceLabel: z.string().trim().min(1).max(300).optional(),
  sourceUrls: z.array(reviewUrl).min(1).max(MAX_CREATION_REFERENCES).optional(),
  /** Write from stories a topic search found; the server reads them from its own stored brief. */
  topicBrief: z.object({
    id: z.string().uuid(),
    storyIds: z.array(z.string().regex(/^s[1-9]$/)).min(1).max(TOPIC_LIMITS.stories),
  }).strict().optional(),
  /** No related stories: write the person's view of the topic, with no factual claims. */
  opinionOnly: z.literal(true).optional(),
}).refine(validSelection).refine(input => {
  if (input.topicBrief) return !input.sourceUrls && !input.opinionOnly;
  if (input.sourceUrls) return input.stage === "main" && !input.opinionOnly;
  return input.content.length >= 20 && input.content.length <= (input.stage === "main" ? 24_000 : 20_000);
});

export type EditorialKind = "selected" | "manual";
export interface PreparedEditorialRequest {
  input: z.infer<typeof selectedReviewSchema> | z.infer<typeof manualReviewSchema>;
  options: Pick<EditorialOptions, "voice" | "voiceScope" | "format" | "userContext" | "scope" | "shape">;
}

/** Server execution context only; not part of admission, persistence, or dedupe. */
export interface EditorialExecutionContext {
  deadlineAt?: number;
  jobId?: string;
}
const executionBudgetSchema = z.object({
  timeoutMs: z.number().int().min(1).max(240_000).optional(),
  deadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  jobId: z.string().uuid().optional(),
}).strict();

function preparedOptions({ voice, voiceScope, format, userContext, scope, shape }: PreparedEditorialRequest["options"]): PreparedEditorialRequest["options"] {
  // Runtime allowlist too: arbitrary persisted preferences cannot set execution controls.
  return { voice, voiceScope, format, userContext, scope, ...(shape ? { shape } : {}) };
}

/** A story the person may write from: in their Discover, or picked in one of their live topic searches. */
async function isOwnStory(scope: TenantScope, url: string): Promise<boolean> {
  if (await storage.getInboxItemByUrl(scope, url)) return true;
  try { return Boolean(await findTopicStory(scope, url)); } catch { return false; }
}

/** Shared by HTTP and queue admission: never persist a Request, user row, or headers. */
export async function prepareEditorialRequest(req: Request, kind: EditorialKind, signal: AbortSignal): Promise<PreparedEditorialRequest> {
  const parsed = (kind === "manual" ? manualReviewSchema : selectedReviewSchema).safeParse(req.body);
  if (!parsed.success) throw new AIGenerationError("ai_invalid_input");
  const input = parsed.data;
  validateEditorialFormat(input.selectedPlatforms, input.format);
  if ("media" in input) {
    const scope = authedOf(req).tenant;
    for (const item of input.media) {
      if (item.id && !(await storage.getMediaAsset(scope, item.id))) {
        throw Object.assign(new Error("An attached media item is not available to this account"), { status: 403 });
      }
    }
    for (const url of input.sourceUrls ?? []) {
      if (!await isOwnStory(scope, url)) {
        throw Object.assign(new Error("A selected article is no longer available in this workspace. Refresh your sources."), { status: 404 });
      }
      signal.throwIfAborted();
    }
    if (input.topicBrief) {
      const brief = await getTopicBrief(scope, input.topicBrief.id);
      const known = new Set(brief?.stories.map(story => story.id));
      if (!brief || input.topicBrief.storyIds.some(id => !known.has(id))) throw new TopicBriefUnavailableError();
      signal.throwIfAborted();
    }
  }
  const options = preparedOptions(await editorialContext(req, input, signal));
  return { input: { ...input, selectedPlatforms: [...new Set(input.selectedPlatforms)] }, options };
}

async function readSelectedArticles(urls: string[], prepared: PreparedEditorialRequest, signal: AbortSignal) {
  const scope = prepared.options.voiceScope;
  if (!scope) throw new AIGenerationError("ai_invalid_input");
  const unique = [...new Set(urls)];
  const results = await Promise.allSettled(unique.map(async url => {
    if (!await isOwnStory(scope, url)) {
      throw new AIGenerationError("ai_invalid_input");
    }
    signal.throwIfAborted();
    return readArticle(url, signal, scope);
  }));
  signal.throwIfAborted();
  const articles: ReadArticle[] = [];
  const failures: CrawlError["sources"] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") articles.push(result.value);
    else if (result.reason instanceof CrawlError) failures.push({ url: unique[index], message: result.reason.message });
    else throw result.reason;
  }
  if (failures.length) throw new CrawlError("sources",
    `Could not read ${failures.map(source => new URL(source.url).hostname).join(", ")}. No draft was generated and no selected sources were skipped.`, failures);
  return combineArticles(articles);
}

/** Several sources as one writer input: every source keeps its header and a fair share of characters and passages. */
function combineArticles(articles: ReadArticle[]) {
  const headers = articles.map(article => `Source: ${article.source}\nTitle: ${article.title}\nURL: ${article.url}\n`);
  const available = MAX_SOURCE_CHARACTERS - headers.reduce((total, text) => total + text.length + 2, 0);
  if (available < articles.length * 20) throw new AIGenerationError("ai_invalid_input");
  const perArticle = Math.floor(available / articles.length);
  const passagesPerArticle = Math.floor(MAX_SOURCE_PASSAGES / articles.length);
  const content = articles.map((article, index) => {
    const section = headers[index] + article.content.slice(0, perArticle);
    // Reserve passage slots as well as characters so dense first sources cannot
    // displace every later source when the writer's evidence brief is built.
    const passages = buildEvidenceBrief({ ...article, content: section }).excerpts.slice(0, passagesPerArticle);
    const last = passages.at(-1);
    if (!last) throw new AIGenerationError("ai_invalid_input");
    return section.slice(0, last.end);
  }).join("\n\n");
  const originalLength = articles.reduce((total, article, index) => total + headers[index].length +
    Math.max(article.content.length, article.contentMetadata?.originalLength ?? 0), (articles.length - 1) * 2);
  const method = (name: string) => articles.some(article => article.contentMetadata?.extractionMethod === name);
  // Each selected story, then the other outlets a headline brief drew on; one entry per link.
  const references = [...new Map(articles.flatMap(article => article.references ?? [{ title: article.title, source: article.source, url: article.url }])
    .map(reference => [reference.url, reference])).values()];
  return { ...articles[0], content, references,
    contentMetadata: {
      // Headlines first: it is the label the person most needs to see before publishing.
      extractionMethod: method("headlines") ? "headlines" as const : method("metadata") ? "metadata" as const : "article" as const,
      originalLength, retainedLength: content.length, truncated: originalLength > content.length,
    },
  };
}

/** The ticked stories of the person's topic brief, best match first, as one writer input. Never reads a page. */
async function readTopicBrief(request: { id: string; storyIds: string[] }, scope: PreparedEditorialRequest["options"]["voiceScope"]) {
  if (!scope) throw new AIGenerationError("ai_invalid_input");
  const brief = await getTopicBrief(scope, request.id);
  const picked = new Set(request.storyIds);
  const stories = brief?.stories.filter(story => picked.has(story.id)) ?? [];
  if (!brief || stories.length !== picked.size) throw new TopicBriefUnavailableError();
  const combined = combineArticles(await topicStoryArticles(stories));
  return { ...combined, contentMetadata: { ...combined.contentMetadata, topic: true } };
}

/** Same source fetch, evidence pipeline, and response contract for both transports. */
export async function executeEditorialRequest(prepared: PreparedEditorialRequest, signal: AbortSignal, onPlatformComplete?: EditorialOptions["onPlatformComplete"], timeoutMs?: number, context: EditorialExecutionContext = {}) {
  signal.throwIfAborted();
  const budget = executionBudgetSchema.safeParse({ ...context, timeoutMs });
  if (!budget.success) throw new AIGenerationError("ai_invalid_input");
  const deadlineAt = Math.min(timeoutMs === undefined ? Infinity : Date.now() + timeoutMs, budget.data.deadlineAt ?? Infinity);
  if (deadlineAt <= Date.now()) throw new AIGenerationError("ai_timeout");
  const { input, options } = prepared;
  const article = "url" in input ? await readArticle(input.url, signal, options.voiceScope)
    : input.topicBrief ? { ...await readTopicBrief(input.topicBrief, options.voiceScope), title: input.title }
    : input.sourceUrls ? { ...await readSelectedArticles(input.sourceUrls, prepared, signal), title: input.title } : {
    title: input.title, content: input.content, source: input.sourceLabel ?? "Your draft", url: input.sourceUrl ?? "",
    contentMetadata: { extractionMethod: "manual" as const, originalLength: input.content.length, retainedLength: input.content.length, truncated: false,
      ...(input.opinionOnly ? { opinion: true } : {}) },
  };
  signal.throwIfAborted();
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new AIGenerationError("ai_timeout");
  // Attachments are returned for the editor, never treated as inspected evidence.
  const executionOptions = { ...preparedOptions(options), signal,
    ...(input.stage === "platform" ? { adaptReviewedDraft: true } : {}),
    ...(input.stage === "main" ? { draftInstruction: input.instruction, currentDraft: input.currentDraft } : {}),
    ...(input.tones ? { tones: input.tones } : {}),
    ...(onPlatformComplete ? { onPlatformComplete } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs: remaining }),
    ...(Number.isFinite(deadlineAt) ? { deadlineAt } : {}),
    ...(budget.data.jobId ? { jobId: budget.data.jobId } : {}) };
  const result = input.stage === "main" ? await generateMainDraftDetailed(article, executionOptions)
    : await generatePlatformReviewsDetailed(article, input.selectedPlatforms, executionOptions);
  signal.throwIfAborted();
  // What the person wrote from teaches recent topics and preferred outlets; never a reason to fail.
  if ("topicBrief" in input && input.topicBrief && options.voiceScope) await markTopicBriefUsed(options.voiceScope, input.topicBrief.id, input.topicBrief.storyIds).catch(() => undefined);
  return { article: "media" in input ? { ...article, media: input.media, domain: "manual" } : article, ...result, format: input.format };
}