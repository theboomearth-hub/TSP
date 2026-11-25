import type { Express } from "express";
import { db } from "../db";
import { authedOf, requireDbUser } from "../middlewares/requireDbUser";
import { requirePermission } from "../middlewares/requirePermission";
import { engineRegistry } from "../services/engines/index.js";
import { storage } from "../storage";
import { candidatesAreSelected, completeOnboarding, completeOnboardingSchema, profileLists } from "../services/onboardingCompletion";
import { platformIntegrations } from "@shared/schema";
import { profileFocusDescriptionSchema, timezoneSchema } from "@shared/profile-preferences";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { filterEnabledPlatforms } from "../lib/platformAvailability";
import { searchEditionSchema } from "@shared/search-editions";
import { getEmailPreferences, updateEmailPreferences } from "../services/email/preferences";
import { legacyNotificationView } from "@shared/email-preferences";
import { PUBLISHING_PLATFORM_KEYS } from "@shared/publishing-capabilities";

const profilePatchSchema = z.object({
  ...profileLists,
  searchEdition: searchEditionSchema.optional(),
  focusDescription: profileFocusDescriptionSchema.optional(),
  timezone: timezoneSchema.optional(),
  enabledPlatforms: z.array(z.enum(PUBLISHING_PLATFORM_KEYS)).optional(),
  defaultPlatform: z.enum(PUBLISHING_PLATFORM_KEYS).optional(),
  defaultTone: z.enum(["professional", "authoritative", "contrarian", "ai-recommended"]).optional(),
  preferredPublishTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  requirePublishReview: z.boolean().optional(),
  autoPublish: z.boolean().optional(),
  dailyDigest: z.boolean().optional(),
  contentAlerts: z.boolean().optional(),
  productUpdates: z.boolean().optional(),
});

export function registerProfileRoutes(app: Express) {
  app.get("/api/profile", requireDbUser, requirePermission("profile:read:own"), async (req, res) => {
    try {
      const { dbUser, tenant: scope } = authedOf(req);
      const userId = dbUser.id;
      
      if (!userId) {
        console.error("No user ID found in request");
        return res.status(401).json({ message: "User not authenticated" });
      }
      
      let profile = await storage.getUserProfile(scope);

      profile ??= await storage.createUserProfile(scope, {
          onboardingStatus: "pending",
          publications: [],
          keywords: [],
          influencers: [],
          companies: [],
          });

      const disabledPlatforms = new Set(
        (await db.select({ key: platformIntegrations.key }).from(platformIntegrations).where(eq(platformIntegrations.enabled, false)))
          .map((row) => row.key),
      );
      const safeEnabledPlatforms = filterEnabledPlatforms(profile.enabledPlatforms, disabledPlatforms);

      if (safeEnabledPlatforms.length !== (profile.enabledPlatforms ?? []).length) {
        profile = await storage.updateUserProfile(scope, { enabledPlatforms: safeEnabledPlatforms });
      }

      res.json({ ...profile, enabledPlatforms: safeEnabledPlatforms,
        ...legacyNotificationView(await getEmailPreferences(userId)) });
    } catch (error) {
      console.error("Error fetching profile:", error);
      res.status(500).json({ message: "Failed to fetch profile" });
    }
  });

  app.patch("/api/profile", requireDbUser, requirePermission("profile:write:own"), async (req, res) => {
    try {
      const { tenant: scope } = authedOf(req);
      const validation = profilePatchSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ message: "Invalid request data", errors: validation.error.errors });
      }

      const existingProfile = await storage.getUserProfile(scope);
      if (!existingProfile) {
        return res.status(404).json({ message: "Profile not found" });
      }

      if (!candidatesAreSelected(validation.data.publications ?? existingProfile.publications ?? [], validation.data.publicationCandidates)) {
        return res.status(400).json({ message: "Publication candidates must match selected publication names" });
      }

      const disabledPlatforms = new Set(
        (await db.select({ key: platformIntegrations.key }).from(platformIntegrations).where(eq(platformIntegrations.enabled, false)))
          .map((row) => row.key),
      );

      const { dailyDigest, contentAlerts, productUpdates, ...profileData } = validation.data;
      const updateData = {
        ...profileData,
        ...(validation.data.enabledPlatforms !== undefined ? {
          enabledPlatforms: filterEnabledPlatforms(validation.data.enabledPlatforms, disabledPlatforms),
        } : {}),
      };

      const profile = await storage.updateUserProfile(scope, updateData);

      const notificationPatch = { dailyDigest, contentAlerts, productUpdates };
      const prefs = Object.values(notificationPatch).some(value => value !== undefined)
        ? await updateEmailPreferences(scope.userId, notificationPatch)
        : await getEmailPreferences(scope.userId);
      res.json({ ...profile, ...legacyNotificationView(prefs) });
    } catch (error) {
      // A concurrent selection change can invalidate a metadata-only PATCH.
      if (error instanceof z.ZodError) return res.status(400).json({ message: "Invalid publication candidates", errors: error.errors });
      console.error("Error updating profile:", error);
      res.status(500).json({ message: "Failed to update profile" });
    }
  });

  app.post("/api/profile/complete-onboarding", requireDbUser, requirePermission("profile:write:own"), async (req, res) => {
    try {
      const { dbUser, tenant: scope } = authedOf(req);
      const userId = dbUser.id;
      const validation = completeOnboardingSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ message: "Invalid request data", errors: validation.error.errors });
      }
      
      const profile = await completeOnboarding(scope, userId, validation.data);
      const industryToUse = validation.data.recommendedIndustry || "other";
      const engine = engineRegistry.getEngine(industryToUse);
      
      res.json({
        ...profile,
        assignedEngine: {
          industry: industryToUse,
          displayName: engine.config.displayName,
        },
      });
    } catch (error) {
      console.error("Error completing onboarding:", error);
      res.status(500).json({ message: "Failed to complete onboarding" });
    }
  });
}
