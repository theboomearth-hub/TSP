import { z } from "zod";
import { focusDescriptionSchema } from "@shared/profile-preferences";
import { publicationCandidateSchema, selectedPublicationCandidates, type PublicationCandidate } from "@shared/publication-preferences";
import { searchEditionSchema } from "@shared/search-editions";
import type { TenantScope } from "../storage";
import { completeOnboarding, completeOnboardingSchema, type CompleteOnboardingData } from "./onboardingCompletion";
import { key, short, withOneRetry } from "./onboardingShared";
import { phrasesFromFocus, researchAllSteps, type ResearchStep, type StepResponse } from "./onboardingSuggestions";
import { understandFocus, type Understanding } from "./onboardingUnderstanding";
import { getAIErrorResponse } from "./openRouter";

/**
 * One-click onboarding: read what the user does, ask one question only when that is too vague
 * to search, research sources, topics and people from one news search, and save the result.
 * The user changes anything later; nothing waits for a confirmation click.
 */
export const quickSetupRequestSchema = z.object({
  focusDescription: focusDescriptionSchema,
  industry: z.string().trim().max(100).optional(),
  searchEdition: searchEditionSchema.optional(),
  clarification: z.object({ question: z.string().trim().min(1).max(200), answer: z.string().trim().min(1).max(200) }).optional(),
  /** The user skipped Pundit's question: build from what they wrote. */
  skipQuestion: z.boolean().optional(),
});
export type QuickSetupRequest = z.input<typeof quickSetupRequestSchema>;

type Summary = Pick<Understanding, "role" | "industry" | "focusAreas" | "region" | "audience">;
export type QuickSetupEvent =
  | { type: "understanding"; understanding: Summary }
  | { type: "question"; question: { text: string; options: string[] } }
  | { type: "progress"; step: ResearchStep | null; message: string }
  | ({ type: "result" } & StepResponse)
  | { type: "error"; step: ResearchStep | null; code: string; retryAfterSeconds?: number }
  /** `degraded`: the AI couldn't help with part of it, so some picks came from the user's own words. */
  | { type: "saved"; setup: CompleteOnboardingData; degraded: boolean }
  | { type: "done" };

export interface QuickSetupActor {
  scope: TenantScope;
  userId: string;
  /** The user's industry, if they already have one; quick setup never overwrites it. */
  industry?: string | null;
}

const MAX_NAME = 100;
const fits = (name: string) => name.trim().length > 0 && name.trim().length <= MAX_NAME;

/** The save payload from the agent's picks. Without any topic, the user's own focus areas stand in. */
export function setupFromResearch(focusDescription: string, results: Partial<Record<ResearchStep, StepResponse>>, understanding: Understanding | null, userIndustry?: string | null) {
  const sources = results.publications?.step === "publications" ? results.publications : undefined;
  const topics = results.topics?.step === "topics" ? results.topics : undefined;
  const people = results.people?.step === "people" ? results.people : undefined;

  const publications = (sources?.picks ?? []).filter(fits);
  // A website the save would refuse is dropped, never a reason to lose the whole setup.
  const candidates: PublicationCandidate[] = (sources?.items ?? []).flatMap(item => {
    const parsed = item.url ? publicationCandidateSchema.safeParse({ name: item.name, url: item.url }) : undefined;
    return parsed?.success ? [parsed.data] : [];
  });
  const weights = new Map((topics?.items ?? []).map(item => [key(item.name), item.weight]));
  let keywords = (topics?.picks ?? []).filter(fits).map(name => ({ keyword: name, weight: weights.get(key(name)) ?? 0.7 }));
  const named = (list: Array<{ name: string }> = []) => new Set(list.map(entry => key(entry.name)));
  const peopleNames = named(people?.people), companyNames = named(people?.companies);
  const influencers = (people?.picks ?? []).filter(name => fits(name) && peopleNames.has(key(name)));
  const companies = (people?.picks ?? []).filter(name => fits(name) && companyNames.has(key(name)));

  // Discover searches topics, people and companies, so a setup needs at least one of them.
  let fallback = false;
  if (!keywords.length && !influencers.length && !companies.length) {
    fallback = true;
    const own = understanding?.focusAreas.length ? understanding.focusAreas : phrasesFromFocus(focusDescription);
    keywords = [...new Map(own.map(area => short(area)).filter(fits).map(area => [key(area), area])).values()]
      .slice(0, 5).map(area => ({ keyword: area, weight: 0.7 }));
  }

  const setup = completeOnboardingSchema.parse({
    focusDescription,
    publications,
    ...(candidates.length ? { publicationCandidates: selectedPublicationCandidates(publications, candidates) } : {}),
    keywords,
    influencers,
    companies,
    ...(!userIndustry && understanding?.category ? { recommendedIndustry: understanding.category } : {}),
  });
  return { setup, fallback };
}

export async function runQuickSetup(input: QuickSetupRequest, actor: QuickSetupActor, signal: AbortSignal, emit: (event: QuickSetupEvent) => void,
  { retryDelayMs, save = completeOnboarding }: { retryDelayMs?: number; save?: typeof completeOnboarding } = {}) {
  const request = quickSetupRequestSchema.parse(input);
  const aiScope = { tenantId: actor.scope.tenantId };
  let degraded = false;
  const failed = (step: ResearchStep | null, error: unknown) => {
    const failure = getAIErrorResponse(error);
    const retryAfterSeconds = failure.retryAfterSeconds ? Number(failure.retryAfterSeconds) : undefined;
    console.warn(`[quick-setup] ${step ?? "understanding"} failed: ${failure.body.code}`);
    emit({ type: "error", step, code: failure.body.code, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) });
  };

  emit({ type: "progress", step: null, message: "Reading what you do…" });
  let understanding: Understanding | null = null;
  try {
    understanding = await withOneRetry(() => understandFocus({
      focusDescription: request.focusDescription, industry: request.industry, clarification: request.clarification,
    }, aiScope, signal), signal, () => emit({ type: "progress", step: null, message: "The AI service didn't respond, so I'm trying again…" }), retryDelayMs);
  } catch (error) {
    if (signal.aborted) throw error;
    // Without a summary, search from the user's own words rather than stop.
    degraded = true;
    failed(null, error);
    emit({ type: "progress", step: null, message: "I couldn't summarise that just now, so I'll search using your own words" });
  }

  if (understanding) {
    const { role, industry, focusAreas, region, audience } = understanding;
    emit({ type: "understanding", understanding: { role, industry, focusAreas, region, audience } });
    if (understanding.question && !request.clarification && !request.skipQuestion) {
      emit({ type: "question", question: understanding.question });
      emit({ type: "done" });
      return;
    }
  }

  const results = await researchAllSteps({
    focusDescription: request.focusDescription,
    ...(request.industry ? { industry: request.industry } : {}),
    ...(request.searchEdition ? { searchEdition: request.searchEdition } : {}),
    ...(understanding ? { understanding: { role: understanding.role, industry: understanding.industry, focusAreas: understanding.focusAreas, region: understanding.region, audience: understanding.audience } } : {}),
    searchPhrases: understanding?.searchPhrases ?? [],
  }, aiScope, signal, {
    progress: (step, message) => emit({ type: "progress", step, message }),
    result: result => emit({ type: "result", ...result }),
    error: (step, error) => { degraded = true; failed(step, error); },
  }, {
    retry: (work, step) => withOneRetry(work, signal, () => emit({ type: "progress", step, message: "The AI service didn't respond, so I'm trying again…" }), retryDelayMs),
  });

  const { setup, fallback } = setupFromResearch(request.focusDescription, results, understanding, actor.industry);
  signal.throwIfAborted();
  emit({ type: "progress", step: null, message: "Saving your setup…" });
  try {
    await save(actor.scope, actor.userId, setup);
  } catch (error) {
    if (signal.aborted) throw error;
    console.error("[quick-setup] save failed:", error instanceof Error ? error.message : error);
    emit({ type: "error", step: null, code: "save_failed" });
    emit({ type: "done" });
    return;
  }
  emit({ type: "saved", setup, degraded: degraded || fallback });
  emit({ type: "done" });
}
