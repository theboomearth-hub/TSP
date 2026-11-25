import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  scope: { tenantId: "topic-tenant", userId: "topic-user" },
  permissions: new Map<string, string>(),
  storage: { getUserProfile: vi.fn() },
  find: vi.fn(),
  angles: vi.fn(),
  repo: { createTopicBrief: vi.fn(), getTopicBrief: vi.fn(), recentTopics: vi.fn(), saveTopicAngles: vi.fn() },
}));

vi.mock("../db", () => { throw new Error("Database must not load in topic route tests"); });
vi.mock("../lib/redis", () => ({ redis: undefined }));
vi.mock("../storage", () => ({ storage: m.storage }));
vi.mock("../services/topicStories", () => ({ findRelatedStories: m.find }));
vi.mock("../services/topicAngles", () => ({ suggestAngles: m.angles }));
vi.mock("../repositories/topicBriefs", () => m.repo);
vi.mock("../middlewares/requireDbUser", () => ({
  requireDbUser: (req: express.Request, _res: unknown, next: () => void) => { Object.assign(req, { dbUser: { id: m.scope.userId }, tenant: m.scope }); next(); },
  authedOf: (req: express.Request & { tenant?: unknown; dbUser?: unknown }) => ({ tenant: req.tenant, dbUser: req.dbUser }),
}));
vi.mock("../middlewares/requirePermission", () => ({
  requirePermission: (permission: string) => Object.assign((_req: unknown, _res: unknown, next: () => void) => next(), { permission }),
}));
vi.mock("../middlewares/rateLimit", () => ({
  newsSearchRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  aiGenerationRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { registerTopicRoutes } from "./topics";
import { AIGenerationError } from "../services/openRouter";

const app = express();
app.use(express.json());
const original = { get: app.get.bind(app), post: app.post.bind(app) };
for (const method of ["get", "post"] as const) {
  (app as unknown as Record<string, unknown>)[method] = (path: string, ...handlers: Array<{ permission?: string }>) => {
    const permission = handlers.find(handler => handler.permission)?.permission;
    if (permission) m.permissions.set(`${method} ${path}`, permission);
    return (original[method] as (...args: unknown[]) => unknown)(path, ...handlers);
  };
}
registerTopicRoutes(app);

const briefId = "5d2c4b7e-1f0a-4c6b-9a8e-2b3c4d5e6f70";
const story = { id: "s1", title: "Vistar launches DOOH marketplace", source: "Campaign", url: "https://campaign.test/x", snippet: "", publishedAt: null, alsoCoveredBy: [], fullText: false, origin: "news" };
const row = (extra: object = {}) => ({ id: briefId, topic: "programmatic DOOH", searchedFor: "programmatic DOOH", stories: [story], angles: null, expiresAt: new Date("2026-11-26T12:00:00Z"), ...extra });

beforeEach(() => {
  vi.resetAllMocks();
  m.storage.getUserProfile.mockResolvedValue({ searchEdition: "en-IN", focusDescription: "I run marketing for a DOOH company." });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/topics/related", () => {
  it("searches in the person's edition and keeps the result as their brief", async () => {
    m.find.mockResolvedValue({ searchedFor: "programmatic DOOH", stories: [story] });
    m.repo.createTopicBrief.mockResolvedValue(row());
    const response = await request(app).post("/api/topics/related").send({ topic: "  programmatic DOOH  ", tenantId: "forged" });
    expect(response.status).toBe(200);
    expect(m.find).toHaveBeenCalledWith(m.scope, "programmatic DOOH", "en-IN");
    expect(m.repo.createTopicBrief).toHaveBeenCalledWith(m.scope, { topic: "programmatic DOOH", searchedFor: "programmatic DOOH", stories: [story] });
    expect(response.body).toEqual({ briefId, topic: "programmatic DOOH", searchedFor: "programmatic DOOH", stories: [story], expiresAt: "2026-11-26T12:00:00.000Z" });
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it.each([{}, { topic: "ab" }, { topic: "x".repeat(201) }, { topic: 42 }])("rejects a missing or out-of-range topic (%j)", async body => {
    expect((await request(app).post("/api/topics/related").send(body)).status).toBe(400);
    expect(m.find).not.toHaveBeenCalled();
  });

  it("reports a failed search without details", async () => {
    m.find.mockRejectedValue(new Error("secret provider detail"));
    const response = await request(app).post("/api/topics/related").send({ topic: "retail media" });
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });
});

describe("POST /api/topics/:id/angles", () => {
  it("asks the AI once and keeps the angles with the brief", async () => {
    const angles = [{ title: "Measurement is the blocker", why: "", storyIds: ["s1"] }];
    m.repo.getTopicBrief.mockResolvedValue(row());
    m.angles.mockResolvedValue(angles);
    const response = await request(app).post(`/api/topics/${briefId}/angles`).send({});
    expect(response.body).toEqual({ angles });
    expect(m.angles).toHaveBeenCalledWith({ topic: "programmatic DOOH", focus: "I run marketing for a DOOH company.", stories: [story] }, { tenantId: "topic-tenant" });
    expect(m.repo.saveTopicAngles).toHaveBeenCalledWith(m.scope, briefId, angles);
  });

  it("returns kept angles without asking again", async () => {
    m.repo.getTopicBrief.mockResolvedValue(row({ angles: [{ title: "Kept", why: "", storyIds: [] }] }));
    expect((await request(app).post(`/api/topics/${briefId}/angles`).send({})).body).toEqual({ angles: [{ title: "Kept", why: "", storyIds: [] }] });
    expect(m.angles).not.toHaveBeenCalled();
  });

  it("is 404 for another person's, expired or malformed brief", async () => {
    m.repo.getTopicBrief.mockResolvedValue(undefined);
    expect((await request(app).post(`/api/topics/${briefId}/angles`).send({})).status).toBe(404);
    expect((await request(app).post("/api/topics/not-a-uuid/angles").send({})).status).toBe(404);
    expect(m.angles).not.toHaveBeenCalled();
  });

  it("passes AI failures through as their usual responses", async () => {
    m.repo.getTopicBrief.mockResolvedValue(row());
    m.angles.mockRejectedValue(new AIGenerationError("ai_configuration"));
    expect((await request(app).post(`/api/topics/${briefId}/angles`).send({})).status).toBe(503);
  });
});

describe("GET /api/topics/recent", () => {
  it("lists recent topics, and nothing rather than an error when they can't be read", async () => {
    m.repo.recentTopics.mockResolvedValueOnce(["retail media"]).mockRejectedValueOnce(new Error("db down"));
    expect((await request(app).get("/api/topics/recent")).body).toEqual({ topics: ["retail media"] });
    expect((await request(app).get("/api/topics/recent")).body).toEqual({ topics: [] });
  });
});

describe("permissions", () => {
  it("search and recent topics need read access; angles need generation access", () => {
    expect(Object.fromEntries(m.permissions)).toEqual({
      "post /api/topics/related": "inbox:read:own",
      "post /api/topics/:id/angles": "generation:create:own",
      "get /api/topics/recent": "inbox:read:own",
    });
  });
});
