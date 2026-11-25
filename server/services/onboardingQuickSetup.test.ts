import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateText, fetchNewsHeadlines } = vi.hoisted(() => ({ generateText: vi.fn(), fetchNewsHeadlines: vi.fn() }));
vi.mock("../lib/redis", () => ({ redis: undefined }));
vi.mock("./openRouter", async original => ({ ...await original<typeof import("./openRouter")>(), generateText }));
vi.mock("./keywordSearch", async original => ({ ...await original<typeof import("./keywordSearch")>(), fetchNewsHeadlines }));
import { clearOnboardingCache } from "./onboardingShared";
import { runQuickSetup, type QuickSetupEvent, type QuickSetupRequest } from "./onboardingQuickSetup";
import { phrasesFromFocus } from "./onboardingSuggestions";
import { AIGenerationError } from "./openRouter";

const actor = { scope: { tenantId: "tenant-a", userId: "user-a" }, userId: "user-a" };
const focus = "I lead marketing at an out-of-home advertising company focused on programmatic DOOH in India.";
const understanding = {
  role: "Head of Marketing", industry: "Out-of-home advertising", focusAreas: ["Programmatic DOOH", "OOH measurement"], region: "India", audience: "Agencies",
  question: null, searchPhrases: ["programmatic DOOH India", "OOH measurement"], category: "Media & Advertising",
};
const headline = (title: string, source: string, sourceUrl: string | null = null) => ({ title, source, sourceUrl, publishedAt: null, link: null });
const news: Record<string, ReturnType<typeof headline>[]> = {
  "programmatic DOOH India": [headline("Vistar Media expands programmatic DOOH in India", "Media4Growth", "https://www.media4growth.com/"), headline("Ana Rao on OOH measurement", "exchange4media", "https://www.exchange4media.com/")],
  "OOH measurement": [headline("New OOH measurement standard", "Media4Growth", "https://www.media4growth.com/")],
};
const replies: Record<string, unknown> = {
  UNDERSTAND: understanding,
  "CHOOSE OUTLETS": { outlets: [{ name: "Media4Growth", reason: "OOH trade news" }, { name: "exchange4media", reason: "Indian ad news" }], note: "Trade press first.", followUps: [] },
  "EXTRACT TOPICS": { topics: [{ topic: "Programmatic DOOH", weight: 1, headlines: [1] }, { topic: "OOH measurement", weight: 0.8, headlines: [2, 3] }], note: "", followUps: [] },
  "EXTRACT PEOPLE": { people: [{ name: "Ana Rao", role: "OOH analyst", headlines: [3] }], companies: [{ name: "Vistar Media", why: "DOOH platform", headlines: [1] }], knownPeople: [], note: "", followUps: [] },
};
const save = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  clearOnboardingCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  generateText.mockImplementation(async (prompt: string) => {
    const kind = Object.keys(replies).find(prefix => prompt.startsWith(prefix));
    if (!kind) throw new Error(`Unexpected prompt: ${prompt.slice(0, 40)}`);
    return JSON.stringify(replies[kind]);
  });
  fetchNewsHeadlines.mockImplementation(async (query: string) => news[query] ?? []);
  save.mockResolvedValue({});
});

async function run(request: Partial<QuickSetupRequest> = {}, extra: Partial<typeof actor> & { industry?: string | null } = {}) {
  const events: QuickSetupEvent[] = [];
  await runQuickSetup({ focusDescription: focus, searchEdition: "en-IN", ...request }, { ...actor, ...extra }, new AbortController().signal, event => events.push(event), { retryDelayMs: 0, save });
  return events;
}
const prompts = () => generateText.mock.calls.map(([prompt]) => (prompt as string).split(".")[0]);

describe("one-click setup", () => {
  it("summarises, searches the news once, picks everything in parallel and saves it", async () => {
    const events = await run();
    // One summary call, then the three picks: no separate search-phrase call.
    expect(prompts().sort()).toEqual(["CHOOSE OUTLETS", "EXTRACT PEOPLE", "EXTRACT TOPICS", "UNDERSTAND"]);
    // Every search runs once, shared by all three picks.
    expect(fetchNewsHeadlines.mock.calls.map(([query]) => query)).toEqual(["programmatic DOOH India", "OOH measurement", "Programmatic DOOH", "OOH measurement India"]);
    expect(events.find(event => event.type === "understanding")).toEqual({ type: "understanding", understanding: {
      role: "Head of Marketing", industry: "Out-of-home advertising", focusAreas: ["Programmatic DOOH", "OOH measurement"], region: "India", audience: "Agencies" } });
    expect(events.filter(event => event.type === "result").map(event => event.type === "result" && event.step).sort()).toEqual(["people", "publications", "topics"]);
    const setup = {
      focusDescription: focus,
      publications: ["Media4Growth", "exchange4media"],
      publicationCandidates: [{ name: "Media4Growth", url: "https://www.media4growth.com/" }, { name: "exchange4media", url: "https://www.exchange4media.com/" }],
      keywords: [{ keyword: "Programmatic DOOH", weight: 1 }, { keyword: "OOH measurement", weight: 0.8 }],
      influencers: ["Ana Rao"], companies: ["Vistar Media"], recommendedIndustry: "media_advertising",
    };
    expect(save).toHaveBeenCalledWith(actor.scope, "user-a", setup);
    expect(events.at(-2)).toEqual({ type: "saved", setup, degraded: false });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("never replaces an industry the user already has", async () => {
    await run({}, { industry: "technology_saas" });
    expect(save.mock.calls[0][2]).not.toHaveProperty("recommendedIndustry");
  });

  it("asks one question for a vague focus and waits for the answer without researching or saving", async () => {
    replies.UNDERSTAND = { ...understanding, region: null, question: { text: "Which region do you mainly cover?", options: ["India", "Global"] } };
    try {
      const events = await run({ focusDescription: "I work in marketing and advertising." });
      expect(events.slice(-2)).toEqual([{ type: "question", question: { text: "Which region do you mainly cover?", options: ["India", "Global"] } }, { type: "done" }]);
      expect(fetchNewsHeadlines).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      // Answering, or skipping, builds and saves.
      await run({ focusDescription: "I work in marketing and advertising.", clarification: { question: "Which region do you mainly cover?", answer: "India" } });
      await run({ focusDescription: "I work in marketing and advertising.", skipQuestion: true });
      expect(save).toHaveBeenCalledTimes(2);
    } finally {
      replies.UNDERSTAND = understanding;
    }
  });

  it("still saves a usable setup from the user's own words when the AI is down", async () => {
    generateText.mockRejectedValue(new AIGenerationError("ai_configuration"));
    fetchNewsHeadlines.mockResolvedValue(news["programmatic DOOH India"]);
    const events = await run();
    expect(events.flatMap(event => event.type === "error" ? [`${event.step}:${event.code}`] : []).sort())
      .toEqual(["null:ai_configuration", "people:ai_configuration", "topics:ai_configuration"]);
    const saved = events.find(event => event.type === "saved");
    expect(saved).toMatchObject({ type: "saved", degraded: true, setup: {
      // Sources still come from the news by article count; topics from the focus itself.
      publications: ["Media4Growth", "exchange4media"],
      keywords: [{ keyword: "out-of-home advertising company", weight: 0.7 }, { keyword: "programmatic DOOH in India", weight: 0.7 }],
      influencers: [], companies: [],
    } });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("tries a step once more when the AI service didn't answer", async () => {
    let failed = false;
    const answer = generateText.getMockImplementation()!;
    generateText.mockImplementation(async (prompt: string, ...rest: unknown[]) => {
      if (prompt.startsWith("EXTRACT TOPICS") && !failed) { failed = true; throw new AIGenerationError("ai_unavailable"); }
      return answer(prompt, ...rest);
    });
    const events = await run();
    expect(events).toContainEqual({ type: "progress", step: "topics", message: "The AI service didn't respond, so I'm trying again…" });
    expect(events.find(event => event.type === "saved")).toMatchObject({ degraded: false });
  });

  it("says the save failed instead of claiming the setup is ready", async () => {
    save.mockRejectedValue(new Error("database unavailable"));
    const events = await run();
    expect(events.slice(-2)).toEqual([{ type: "error", step: null, code: "save_failed" }, { type: "done" }]);
    expect(events.some(event => event.type === "saved")).toBe(false);
  });

  it("rejects a focus too short to search", async () => {
    await expect(run({ focusDescription: "SRE" })).rejects.toThrow();
    expect(generateText).not.toHaveBeenCalled();
  });
});

describe("phrases from the user's own words, when the AI can't help", () => {
  it("keeps what they work on and leaves out who they write for", () => {
    expect(phrasesFromFocus("I lead marketing at an out-of-home advertising company focused on programmatic DOOH in India, writing for agencies and brands."))
      .toEqual(["out-of-home advertising company", "programmatic DOOH in India"]);
    expect(phrasesFromFocus("I lead marketing at a fintech company in India, reaching CFOs and founders.")).toEqual(["fintech company in India"]);
    expect(phrasesFromFocus("I'm the founder of a B2B SaaS startup, writing for CTOs and engineering leaders.")).toEqual(["B2B SaaS startup"]);
    expect(phrasesFromFocus("I advise hospitals on digital transformation and healthcare technology.")).toEqual(["hospitals on digital transformation", "healthcare technology"]);
    // Any tense: "and write for …" is the audience too, not a topic.
    expect(phrasesFromFocus("I run marketing for a digital out-of-home advertising company and write for agency and brand marketers in India."))
      .toEqual(["digital out-of-home advertising company"]);
  });
});
