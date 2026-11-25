import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { storage, type TenantScope } from "../storage";
import { users } from "@shared/models/auth";
import { INDUSTRY_SLUGS } from "@shared/schema";
import { focusDescriptionSchema, profileKeywordsSchema, profileListSchema } from "@shared/profile-preferences";
import { publicationCandidatesSchema, reconcilePublicationCandidates, type PublicationCandidate } from "@shared/publication-preferences";

export function candidatesAreSelected(names: string[], candidates: PublicationCandidate[] = []) {
  return reconcilePublicationCandidates(names, candidates).length === candidates.length;
}

export const profileLists = {
  publications: profileListSchema.optional(),
  publicationCandidates: publicationCandidatesSchema.optional(),
  keywords: profileKeywordsSchema.optional(),
  influencers: profileListSchema.optional(),
  companies: profileListSchema.optional(),
};

export const completeOnboardingSchema = z.object({
  ...profileLists,
  focusDescription: focusDescriptionSchema,
  recommendedIndustry: z.enum(INDUSTRY_SLUGS).optional(),
}).refine(data => candidatesAreSelected(data.publications ?? [], data.publicationCandidates), {
  path: ["publicationCandidates"], message: "Publication candidates must match selected publication names",
});
export type CompleteOnboardingInput = z.input<typeof completeOnboardingSchema>;
export type CompleteOnboardingData = z.output<typeof completeOnboardingSchema>;

/**
 * Save a finished onboarding: the user's sources, topics, people and companies, and mark
 * onboarding completed. Used by "Finish setup" and by quick setup, so both save the same way.
 */
export async function completeOnboarding(scope: TenantScope, userId: string, data: CompleteOnboardingData) {
  const { focusDescription, publications, publicationCandidates, keywords, influencers, companies, recommendedIndustry } = data;
  if (recommendedIndustry) {
    await db.update(users).set({ industry: recommendedIndustry }).where(eq(users.id, userId));
    console.log(`[Onboarding] Updated user ${userId} industry to: ${recommendedIndustry}`);
  }
  const profileData = {
    focusDescription,
    onboardingStatus: "completed" as const,
    publications: publications || [],
    ...(publicationCandidates !== undefined ? { publicationCandidates } : {}),
    keywords: keywords || [],
    influencers: influencers || [],
    companies: companies || [],
    recommendedIndustry: recommendedIndustry || undefined,
  };
  const existing = await storage.getUserProfile(scope);
  return existing ? storage.updateUserProfile(scope, profileData) : storage.createUserProfile(scope, profileData);
}
