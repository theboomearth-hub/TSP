import type { Express, Request, Response } from "express";
import { onboardingSuggestionRateLimit } from "../middlewares/rateLimit";
import { authedOf, requireDbUser } from "../middlewares/requireDbUser";
import { requirePermission } from "../middlewares/requirePermission";
import { onboardingAgentRequestSchema, runOnboardingAgent, type AgentEvent } from "../services/onboardingAgent";
import { quickSetupRequestSchema, runQuickSetup, type QuickSetupEvent } from "../services/onboardingQuickSetup";
import { onboardingSuggestionRequestSchema, suggestOnboardingItems } from "../services/onboardingSuggestions";
import { understandFocus, understandRequestSchema } from "../services/onboardingUnderstanding";
import { AIGenerationError, getAIErrorResponse } from "../services/openRouter";

const SUGGESTION_BUDGET_MS = 25_000;
const UNDERSTAND_BUDGET_MS = 25_000;
// A full build researches three steps in sequence.
const AGENT_BUDGET_MS = 150_000;
// Quick setup: one summary call, one news search, three parallel picks, then the save.
const QUICK_SETUP_BUDGET_MS = 90_000;

/** Run one AI-backed JSON request with a time budget, stopping the work if the user leaves. */
async function respondWithAi(res: Response, budgetMs: number, work: (signal: AbortSignal) => Promise<unknown>) {
  res.setHeader("Cache-Control", "no-store");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new AIGenerationError("ai_timeout")), budgetMs);
  res.on("close", () => { if (!res.writableFinished) controller.abort(new AIGenerationError("ai_cancelled")); });
  try {
    res.json(await work(controller.signal));
  } catch (error) {
    const failure = getAIErrorResponse(controller.signal.aborted ? controller.signal.reason : error);
    if (failure.retryAfterSeconds) res.setHeader("Retry-After", String(failure.retryAfterSeconds));
    if (!res.headersSent) res.status(failure.status).json(failure.body);
  } finally {
    clearTimeout(timer);
  }
}

/** Stream server-sent events from `work`, within a time budget, stopping the work if the user leaves. */
async function streamEvents<E extends { type: string }>(res: Response, budgetMs: number,
  work: (signal: AbortSignal, send: (event: E) => void) => Promise<void>, failure: (code: string) => E) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new AIGenerationError("ai_timeout")), budgetMs);
  res.on("close", () => { if (!res.writableFinished) controller.abort(new AIGenerationError("ai_cancelled")); });
  const send = (event: E) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
  try {
    await work(controller.signal, send);
  } catch (error) {
    send(failure(getAIErrorResponse(controller.signal.aborted ? controller.signal.reason : error).body.code));
  } finally {
    clearTimeout(timer);
    res.end();
  }
}

export function registerOnboardingSuggestionRoutes(app: Express) {
  const guards = [requireDbUser, requirePermission("generation:create:own"), onboardingSuggestionRateLimit] as const;

  app.post("/api/onboarding/suggestions", ...guards, async (req: Request, res: Response) => {
    const parsed = onboardingSuggestionRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ code: "invalid_request", message: "Provide a step and a focus of 10–500 characters." });
    await respondWithAi(res, SUGGESTION_BUDGET_MS, signal => suggestOnboardingItems(parsed.data, { tenantId: authedOf(req).tenant.tenantId }, signal));
  });

  app.post("/api/onboarding/understand", ...guards, async (req: Request, res: Response) => {
    const parsed = understandRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ code: "invalid_request", message: "Provide a focus of 10–500 characters." });
    await respondWithAi(res, UNDERSTAND_BUDGET_MS, signal => understandFocus(parsed.data, { tenantId: authedOf(req).tenant.tenantId }, signal));
  });

  // Server-sent events: progress, each step's result as soon as it is ready, then done.
  app.post("/api/onboarding/agent", ...guards, async (req: Request, res: Response) => {
    const parsed = onboardingAgentRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ code: "invalid_request", message: "Provide a focus of 10–500 characters and the steps to run, in order." });
    await streamEvents<AgentEvent>(res, AGENT_BUDGET_MS, (signal, send) => runOnboardingAgent(parsed.data, { tenantId: authedOf(req).tenant.tenantId }, signal, send),
      code => ({ type: "error", step: null, code }));
  });

  // One-click setup: understanding, research and the save in one stream. It saves the profile,
  // so it also needs permission to write it.
  app.post("/api/onboarding/quick-setup", ...guards, requirePermission("profile:write:own"), async (req: Request, res: Response) => {
    const parsed = quickSetupRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ code: "invalid_request", message: "Provide a focus of 10–500 characters." });
    const { dbUser, tenant } = authedOf(req);
    await streamEvents<QuickSetupEvent>(res, QUICK_SETUP_BUDGET_MS,
      (signal, send) => runQuickSetup(parsed.data, { scope: tenant, userId: dbUser.id, industry: dbUser.industry }, signal, send),
      code => ({ type: "error", step: null, code }));
  });
}