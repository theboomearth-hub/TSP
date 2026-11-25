import type { Express } from "express";
import { z } from "zod";
import { TOPIC_LIMITS, type TopicBriefResponse } from "@shared/topic-stories";
import type { TopicBrief } from "@shared/schema";
import { authedOf, requireDbUser } from "../middlewares/requireDbUser";
import { requirePermission } from "../middlewares/requirePermission";
import { aiGenerationRateLimit, newsSearchRateLimit } from "../middlewares/rateLimit";
import { storage } from "../storage";
import { findRelatedStories } from "../services/topicStories";
import { suggestAngles } from "../services/topicAngles";
import { getAIErrorResponse } from "../services/openRouter";
import { createTopicBrief, getTopicBrief, recentTopics, saveTopicAngles } from "../repositories/topicBriefs";

const relatedSchema = z.object({ topic: z.string().trim().min(TOPIC_LIMITS.minChars).max(TOPIC_LIMITS.maxChars) });

export function briefResponse(brief: TopicBrief): TopicBriefResponse {
  return { briefId: brief.id, topic: brief.topic, searchedFor: brief.searchedFor, stories: brief.stories, expiresAt: brief.expiresAt.toISOString() };
}

/** Topic-first writing: related stories for a one-liner or saved keyword, kept 24 hours to write from. */
export function registerTopicRoutes(app: Express) {
  app.post("/api/topics/related", requireDbUser, requirePermission("inbox:read:own"), newsSearchRateLimit, async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const parsed = relatedSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: `Describe the topic in ${TOPIC_LIMITS.minChars} to ${TOPIC_LIMITS.maxChars} characters.` });
    try {
      const scope = authedOf(req).tenant;
      const profile = await storage.getUserProfile(scope);
      const found = await findRelatedStories(scope, parsed.data.topic, profile?.searchEdition ?? "en-US");
      const brief = await createTopicBrief(scope, { topic: parsed.data.topic, ...found });
      res.json(briefResponse(brief));
    } catch {
      console.error("[topics] Finding related stories failed.");
      res.status(500).json({ message: "Couldn't look for related stories. Try again." });
    }
  });

  // Angle ideas for a brief's stories: one AI call, kept with the brief so asking again is free.
  app.post("/api/topics/:id/angles", requireDbUser, requirePermission("generation:create:own"), aiGenerationRateLimit, async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (!z.string().uuid().safeParse(req.params.id).success) return res.status(404).json({ message: "These stories are no longer available." });
    try {
      const scope = authedOf(req).tenant;
      const brief = await getTopicBrief(scope, req.params.id);
      if (!brief) return res.status(404).json({ message: "These stories are no longer available. Search the topic again." });
      if (brief.angles) return res.json({ angles: brief.angles });
      const profile = await storage.getUserProfile(scope);
      const angles = await suggestAngles({ topic: brief.topic, focus: profile?.focusDescription, stories: brief.stories }, { tenantId: scope.tenantId });
      await saveTopicAngles(scope, brief.id, angles);
      res.json({ angles });
    } catch (error) {
      const failure = getAIErrorResponse(error);
      res.status(failure.status).json(failure.body);
    }
  });

  // Topics the person wrote about lately, offered again in Compose.
  app.get("/api/topics/recent", requireDbUser, requirePermission("inbox:read:own"), async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      res.json({ topics: await recentTopics(authedOf(req).tenant) });
    } catch {
      res.json({ topics: [] });
    }
  });
}
