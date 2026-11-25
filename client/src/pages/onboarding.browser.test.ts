import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, expect as browserExpect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { build } from "esbuild";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { readFileSync } from "node:fs";
import postcss from "postcss";
import tailwindcss from "tailwindcss";

// Render the real page/wizard and API client. All persistence and AI responses
// are fixtures; no app server, database, .env loader, or external traffic.
let server: Server;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let origin: string;
let errors: string[];
type Body = Record<string, unknown>;
type Reply = { status?: number; data?: unknown; raw?: string };
type Path = "understand" | "agent" | "suggestions" | "quick-setup";
let handlers: Record<Path, (body: Body) => Reply>;
let calls: Array<{ path: Path; body: Body }>;
let completionStatus: number;
let completions: Body[];
let refreshes: Body[];

const focus = "I build reliable cloud infrastructure.";
const understanding = { role: "Platform engineer", industry: "Cloud infrastructure", focusAreas: ["Site reliability", "Kubernetes"], region: "India", audience: "Engineering leaders", question: null };
const sources = { step: "publications", grounded: true, note: "I picked reliability-focused trade press.", picks: ["Cloud Weekly", "SRE Digest"], followUps: ["More India-focused", "Less vendor news"], items: [
  { name: "Cloud Weekly", url: "https://cloudweekly.invalid/", reason: "Covers cloud reliability", evidence: { count: 3, headline: "Outage lessons from 2026", headlines: ["Outage lessons from 2026", "Why SLOs matter", "Chaos days at scale"] } },
  { name: "SRE Digest", url: null, reason: "Practitioner newsletter", evidence: { count: 1, headline: "On-call without burnout" } },
  { name: "Infra Daily", url: "https://infradaily.invalid/", reason: "Daily infrastructure news", evidence: { count: 2, headline: "Kubernetes ships a major release" } },
] };
const topics = { step: "topics", grounded: true, note: "Topics from your sources' headlines.", picks: ["Incident response"], followUps: ["Add platform engineering"], items: [
  { name: "Incident response", weight: 0.9, evidence: { count: 2, headline: "Outage lessons from 2026" } }, { name: "Chaos engineering", weight: 0.6 },
] };
const people = { step: "people", grounded: true, note: "People named in recent cloud news.", picks: ["Ana Rao", "Acme Cloud"], followUps: [],
  people: [{ name: "Ana Rao", reason: "SRE lead at Acme Cloud", evidence: { count: 1, headline: "Ana Rao on resilience" } }, { name: "Jane Leader", reason: "Founder of a cloud company", aiOnly: true }],
  companies: [{ name: "Acme Cloud", reason: "Cloud provider", evidence: { count: 2, headline: "Acme Cloud outage" } }, { name: "Beta Hosting", reason: "Hosting company" }],
};
const results: Record<string, object> = { publications: sources, topics, people };
const preview = { step: "preview", grounded: true, headlines: [
  { title: "Outage lessons from 2026", source: "Cloud Weekly", link: "https://news.google.com/rss/articles/outage", publishedAt: "2026-09-22T10:00:00.000Z", topic: "Incident response" },
] };
const sse = (events: object[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
const quickSaved = {
  focusDescription: focus, publications: ["Cloud Weekly", "SRE Digest"], publicationCandidates: [{ name: "Cloud Weekly", url: "https://cloudweekly.invalid/" }],
  keywords: [{ keyword: "Incident response", weight: 0.9 }], influencers: ["Ana Rao"], companies: ["Acme Cloud"],
};
const { question: _noQuestion, ...summary } = understanding;
const quickStream = (degraded = false) => sse([
  { type: "progress", step: null, message: "Reading what you do…" },
  { type: "understanding", understanding: summary },
  { type: "progress", step: null, message: 'Searching Google News for "cloud reliability"' },
  { type: "result", ...sources }, { type: "result", ...topics }, { type: "result", ...people },
  { type: "progress", step: null, message: "Saving your setup…" },
  { type: "saved", setup: quickSaved, degraded }, { type: "done" },
]);
const agentStream = (steps: string[]) => sse([...steps.flatMap(step => [
  { type: "progress", step, message: `Searching Google News for ${step}` }, { type: "result", ...results[step] },
]), { type: "done" }]);
const defaults: Record<Path, (body: Body) => Reply> = {
  understand: body => ({ data: body.clarification ? { ...understanding, region: (body.clarification as { answer: string }).answer } : understanding }),
  agent: body => ({ raw: agentStream(body.steps as string[]) }),
  "quick-setup": () => ({ raw: quickStream() }),
  suggestions: body => body.step === "preview" ? { data: preview }
    : { data: { step: body.step, grounded: true, picks: [], note: "", followUps: [], items: [{ name: "Ops Weekly", url: null, reason: "" }], people: [], companies: [] } },
};
const sent = (path: Path) => calls.filter(call => call.path === path).map(call => call.body);

beforeAll(async () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const css = await postcss([tailwindcss({ config: path.join(root, "tailwind.config.ts") })])
    .process(readFileSync(path.join(root, "client/src/index.css"), "utf8"), { from: path.join(root, "client/src/index.css") });
  const result = await build({
    absWorkingDir: root, bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic",
    define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "false", "import.meta.env.BASE_URL": '"/"' },
    alias: { "@": path.join(root, "client/src"), "@shared": path.join(root, "shared") },
    stdin: { resolveDir: root, loader: "tsx", contents: `
      import { StrictMode } from "react";
      import { createRoot } from "react-dom/client";
      import { QueryClientProvider } from "@tanstack/react-query";
      import { useLocation } from "wouter";
      import { queryClient } from "@/lib/queryClient";
      import OnboardingPage from "@/pages/onboarding";
      import { Toaster } from "@/components/ui/toaster";
      import { AppTourProvider } from "@/components/app-tour";
      function Fixture() {
        const [location] = useLocation();
        const onboarding = window.location.search.includes("tour=1")
          ? <AppTourProvider scope="fixture-user:workspace" phase="setup" enabled><OnboardingPage /></AppTourProvider>
          : <OnboardingPage />;
        return <>{location === "/onboarding" ? onboarding : <h1>Dashboard fixture</h1>}<Toaster /></>;
      }
      createRoot(document.getElementById("root")!).render(<StrictMode><QueryClientProvider client={queryClient}><Fixture /></QueryClientProvider></StrictMode>);
    ` },
  });
  server = createServer((req, res) => {
    if (req.url === "/fixture.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(result.outputFiles[0].text);
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
      (req.url?.includes("tour=1") ? '<style>' + css.css + '</style>' : '') +
      '</head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
}, 60000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

beforeEach(async () => {
  errors = []; completions = []; calls = []; refreshes = [];
  completionStatus = 200; handlers = { ...defaults };
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { errors.push(`External request blocked: ${url.origin}`); await route.abort(); return; }
    if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
    const reply = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) }).catch(() => undefined);
    if (url.pathname === "/api/me") return reply({ id: "fixture-user", industry: "technology-saas", country: "India" });
    const path = url.pathname.replace("/api/onboarding/", "") as Path;
    if (path in defaults) {
      const body = route.request().postDataJSON() as Body;
      calls.push({ path, body });
      const { status = 200, data, raw } = handlers[path](body);
      if (raw !== undefined) return route.fulfill({ status, contentType: "text/event-stream", body: raw }).catch(() => undefined);
      return reply(data, status);
    }
    if (url.pathname === "/api/profile/complete-onboarding") {
      completions.push(route.request().postDataJSON());
      return reply(completionStatus === 200 ? { onboardingCompleted: true } : { message: "Mock save failure" }, completionStatus);
    }
    if (url.pathname === "/api/inbox/refresh") {
      refreshes.push(route.request().postDataJSON());
      return reply({ jobId: "refresh-job", status: "queued" }, 202);
    }
    if (url.pathname === "/api/inbox/refresh/refresh-job") return reply({ status: "active", progress: { articlesProcessed: 0, articlesMatched: 0, articlesCreated: 0 } });
    errors.push(`Unexpected request: ${url.pathname}`);
    return reply({ message: "Unmocked request" }, 500);
  });
  page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
});

afterEach(async () => {
  await context?.close();
  expect(errors, errors.join("\n")).toEqual([]);
});

const chip = (name: string) => page.getByRole("button", { name, exact: true });
const pundit = () => page.getByRole("region", { name: "Pundit" });
const setup = () => page.getByRole("region", { name: "Your setup" });
const section = (name: string) => setup().getByRole("region", { name });
const card = () => page.getByRole("region", { name: "What the agent understood" });

async function say(text: string) {
  await page.getByRole("textbox", { name: "Message Pundit" }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

/** The step-by-step workspace, for people who pick everything themselves. */
async function openWorkspace(query = "") {
  await page.goto(`${origin}/onboarding${query}`);
  await page.getByRole("button", { name: "I'd rather choose each source myself", exact: true }).click();
  await browserExpect(pundit()).toContainText("Hi, I'm Pundit.");
}

async function start() {
  await openWorkspace();
  await say(`  ${focus}  `);
  await browserExpect(card().getByRole("textbox", { name: "Role", exact: true })).toHaveValue("Platform engineer");
}

async function buildSetup() {
  await chip("Build my setup").click();
  await browserExpect(pundit()).toContainText("I picked reliability-focused trade press.");
  await browserExpect(pundit()).toContainText("People named in recent cloud news.");
}

describe("talking to Pundit", () => {
  it("starts a conversation and shows an editable summary of what Pundit understood", async () => {
    await start();
    await browserExpect(pundit().getByRole("list", { name: "Conversation" })).toContainText(focus);
    expect(sent("understand")).toEqual([{ focusDescription: focus, industry: "technology-saas" }]);
    await card().getByRole("textbox", { name: "Role", exact: true }).fill("SRE manager");
    await card().getByRole("button", { name: "Remove focus area Kubernetes", exact: true }).click();
    await card().getByLabel("Add a focus area").fill("Observability");
    await card().getByRole("button", { name: "Add focus area", exact: true }).click();
    await buildSetup();
    expect(sent("agent")[0]).toEqual({
      focusDescription: focus, industry: "technology-saas", searchEdition: "en-IN",
      understanding: { role: "SRE manager", industry: "Cloud infrastructure", focusAreas: ["Site reliability", "Observability"], region: "India", audience: "Engineering leaders" },
      publications: [], topics: [], exclude: [], steps: ["publications", "topics", "people"],
    });
  });

  it("asks one question for a vague focus and takes the answer from a quick reply or the composer", async () => {
    handlers.understand = body => body.clarification
      ? { data: { ...understanding, region: (body.clarification as { answer: string }).answer } }
      : { data: { ...understanding, region: null, question: { text: "Which region do you mainly cover?", options: ["India", "Global"] } } };
    await openWorkspace();
    await say(focus);
    await browserExpect(card()).toContainText("Which region do you mainly cover?");
    await say("Asia-Pacific");
    await browserExpect(card().getByRole("textbox", { name: "Region", exact: true })).toHaveValue("Asia-Pacific");
    expect(sent("understand")[1]).toEqual({ focusDescription: focus, industry: "technology-saas", clarification: { question: "Which region do you mainly cover?", answer: "Asia-Pacific" } });
  });

  it("asks for more when the first message is too short to work with", async () => {
    await openWorkspace();
    await say("SRE");
    await browserExpect(pundit()).toContainText("Could you tell me a bit more");
    expect(sent("understand")).toEqual([]);
  });
});

describe("Pundit builds your setup", () => {
  it("opens the setup automatically on mobile", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await start();
    await buildSetup();
    await browserExpect(page.getByRole("tab", { name: /Your setup/ })).toHaveAttribute("aria-selected", "true");
    await browserExpect(section("Topics")).toBeVisible();
  });

  it("fills every section live with reasons and evidence, shows its progress and notes, and has no static lists", async () => {
    await start(); await buildSetup();
    const progress = pundit().getByRole("list", { name: "Pundit's progress" });
    await browserExpect(progress).toContainText("Picked 2 sources");
    await browserExpect(progress).toContainText("Picked 1 topic");
    await browserExpect(section("Sources").getByRole("button", { name: "Remove source Cloud Weekly", exact: true })).toContainText("Covers cloud reliability");
    await browserExpect(section("Sources").getByRole("button", { name: "Remove source Cloud Weekly", exact: true })).toContainText("3 recent articles");
    await browserExpect(section("Sources").getByRole("button", { name: "Select source Infra Daily", exact: true })).toBeVisible();
    await browserExpect(section("Topics").getByRole("button", { name: "Remove topic Incident response", exact: true })).toBeVisible();
    await browserExpect(section("People and companies").getByRole("button", { name: "Remove leader Ana Rao", exact: true })).toBeVisible();
    await browserExpect(section("People and companies").getByRole("button", { name: "Select leader Jane Leader", exact: true })).toContainText("AI suggestion");
    await browserExpect(pundit().getByRole("button", { name: "More India-focused", exact: true })).toBeVisible();
    await browserExpect(page.getByRole("button", { name: /^Select source (TechCrunch|The Verge|Wired)$/ })).toHaveCount(0);
    await pundit().getByText("Show what I did").click();
    await browserExpect(pundit()).toContainText("Searching Google News for topics");
  });

  it("shows the headlines behind a source", async () => {
    await start(); await buildSetup();
    await section("Sources").getByRole("button", { name: "Why Cloud Weekly?", exact: true }).click();
    await browserExpect(section("Sources").getByRole("list", { name: "Headlines behind Cloud Weekly" })).toContainText("Chaos days at scale");
  });

  it("steers with a suggested request or the composer, keeping the user's picks and never re-adding removals", async () => {
    handlers.agent = body => body.instruction === "More India-focused" ? { raw: sse([
      { type: "progress", step: "publications", message: "Searching for India news" },
      { type: "result", step: "publications", grounded: true, note: "I focused on Indian outlets.", picks: ["India Cloud Times", "SRE Digest"], followUps: [], items: [
        { name: "India Cloud Times", url: "https://ict.invalid/", reason: "Indian cloud news" }, { name: "SRE Digest", url: null, reason: "" }, { name: "Cloud Weekly", url: "https://cloudweekly.invalid/", reason: "" },
      ] }, { type: "done" }]) } : defaults.agent(body);
    await start(); await buildSetup();
    await section("Sources").getByRole("button", { name: "Remove source SRE Digest", exact: true }).click();
    await section("Sources").getByRole("button", { name: "Select source Infra Daily", exact: true }).click();
    await pundit().getByRole("button", { name: "More India-focused", exact: true }).click();
    await browserExpect(pundit()).toContainText("I focused on Indian outlets.");
    await browserExpect(section("Sources").getByRole("button", { name: "Remove source Infra Daily", exact: true })).toBeVisible();
    await browserExpect(section("Sources").getByRole("button", { name: "Remove source India Cloud Times", exact: true })).toBeVisible();
    await browserExpect(section("Sources").getByRole("button", { name: "Select source Cloud Weekly", exact: true })).toBeVisible();
    await browserExpect(page.getByRole("button", { name: /source SRE Digest$/ })).toHaveCount(0);
    expect(sent("agent")[1]).toMatchObject({ steps: ["publications"], instruction: "More India-focused", exclude: ["SRE Digest"] });
    await section("Topics").getByRole("button", { name: "Select topic Chaos engineering", exact: true }).click();
    await browserExpect(page.getByRole("radio", { name: /^Topics/ })).toHaveAttribute("aria-checked", "true");
    await say("fewer event topics");
    await browserExpect(pundit().getByRole("list", { name: "Conversation" })).toContainText("fewer event topics");
    await browserExpect.poll(() => sent("agent").length).toBe(3);
    expect(sent("agent")[2]).toMatchObject({ steps: ["topics"], instruction: "fewer event topics" });
  });

  it("adds more like the user's picks", async () => {
    await start(); await buildSetup();
    await section("Sources").getByRole("button", { name: "Select source Infra Daily", exact: true }).click();
    await browserExpect(section("Sources")).toContainText("1 new suggestion based on your picks");
    await browserExpect(section("Sources").getByRole("button", { name: "Select source Ops Weekly", exact: true })).toBeVisible();
  });

  it("says when the AI is busy and tries later failed steps again together", async () => {
    let first = true;
    handlers.agent = body => {
      if (!first) return defaults.agent(body);
      first = false;
      return { raw: sse([{ type: "result", ...sources },
        { type: "error", step: "topics", code: "ai_quota", retryAfterSeconds: 60 }, { type: "error", step: "people", code: "ai_quota", retryAfterSeconds: 60 }, { type: "done" }]) };
    };
    await start();
    await chip("Build my setup").click();
    await browserExpect(section("Topics").getByRole("alert")).toContainText("The AI service is busy right now. Try again in about a minute.");
    await browserExpect(pundit()).toContainText("The AI service is busy right now.");
    await section("Topics").getByRole("button", { name: "Try again", exact: true }).click();
    await browserExpect(section("Topics").getByRole("button", { name: "Remove topic Incident response", exact: true })).toBeVisible();
    await browserExpect(section("People and companies").getByRole("button", { name: "Remove leader Ana Rao", exact: true })).toBeVisible();
    expect(sent("agent")[1]).toMatchObject({ steps: ["topics", "people"] });
  });
});

describe("setting up manually", () => {
  it("adds the user's own entries, refuses a bad website, and lets Pundit take over", async () => {
    await start();
    await chip("Set up manually").click();
    await section("Sources").getByLabel("Source name").fill("My Blog");
    await section("Sources").getByLabel("Source website (optional)").fill("myblog.test/news");
    await section("Sources").getByRole("button", { name: "Add source", exact: true }).click();
    await browserExpect(section("Sources").getByRole("list", { name: "Selected publication URLs" })).toContainText("My Blog: https://myblog.test/news — Unverified URL");
    await section("Sources").getByLabel("Source name").fill("Bad Site");
    await section("Sources").getByLabel("Source website (optional)").fill("not a website!");
    await section("Sources").getByRole("button", { name: "Add source", exact: true }).click();
    await browserExpect(section("Sources").getByText("Enter a valid website, or leave it empty.", { exact: true })).toBeVisible();
    await section("Topics").getByLabel("Custom topic").fill("Platform engineering");
    await section("Topics").getByTestId("button-add-keyword").click();
    await section("People and companies").getByLabel("Custom leader").fill("Kelsey Hightower");
    await section("People and companies").getByTestId("button-add-influencer").click();
    await section("People and companies").getByLabel("Custom company").fill("HashiCorp");
    await section("People and companies").getByTestId("button-add-company").click();
    expect(sent("agent")).toEqual([]);
    await pundit().getByRole("button", { name: "Let Pundit help", exact: true }).click();
    await browserExpect(section("Topics").getByRole("button", { name: "Remove topic Incident response", exact: true })).toBeVisible();
    await browserExpect(section("Topics").getByRole("button", { name: "Remove topic Platform engineering", exact: true })).toBeVisible();
    expect(sent("agent")[0]).toMatchObject({ steps: ["publications", "topics", "people"], topics: ["Platform engineering"], publications: [{ name: "My Blog", url: "https://myblog.test/news" }] });
  });

  it("needs one topic, company or person to finish, so Discover has something to search for, and adds no hidden defaults", async () => {
    await start();
    // A focus alone (or an agent step that failed) would leave Discover empty.
    await browserExpect(chip("Finish setup")).toBeDisabled();
    await browserExpect(setup().getByText("Pick at least one topic, company or person to finish.", { exact: true })).toBeVisible();
    await chip("Set up manually").click();
    await section("Topics").getByLabel("Custom topic").fill("Platform engineering");
    await section("Topics").getByTestId("button-add-keyword").click();
    await browserExpect(chip("Finish setup")).toBeEnabled();
    await browserExpect(setup().getByText("Pick at least one topic, company or person to finish.", { exact: true })).toHaveCount(0);
    await chip("Finish setup").click();
    await browserExpect(page.getByRole("heading", { name: "Your Discover is ready" })).toBeVisible();
    expect(sent("agent")).toEqual([]);
    expect(completions).toEqual([{ focusDescription: focus, publications: [], keywords: [{ keyword: "Platform engineering", weight: 0.7 }], influencers: [], companies: [] }]);
  });
});

describe("finishing", () => {
  it("guides the real chat and setup, and does not advance when saving fails", async () => {
    await openWorkspace("?tour=1");
    const tour = page.getByTestId("dialog-app-tour");
    await browserExpect(tour).toContainText("Start by talking to Pundit");
    await say(focus);
    await browserExpect(tour).toContainText("Done. Select Next to continue.");
    await tour.getByRole("button", { name: "Next", exact: true }).click();
    await browserExpect(tour).toContainText("Check what Pundit understood");
    await buildSetup();
    await browserExpect(tour).toContainText("Done. Select Next to continue.");
    await tour.getByRole("button", { name: "Next", exact: true }).click();
    await browserExpect(tour).toContainText("Review your curated setup");
    await browserExpect(tour).not.toContainText("Done. Select Next to continue.");
    completionStatus = 500;
    await chip("Finish setup").click();
    await browserExpect(page.getByText("Something went wrong", { exact: true })).toBeVisible();
    await browserExpect(tour).toContainText("Review your curated setup");
    completionStatus = 200;
    await chip("Finish setup").click();
    await browserExpect(page.getByRole("heading", { name: "Your Discover is ready" })).toBeVisible();
    await browserExpect(tour).toContainText("Done. Select Next to continue.");
    const progress = await page.evaluate(() => JSON.parse(localStorage.getItem("tsp-app-tour:v3:fixture-user:workspace")!));
    expect(progress).toMatchObject({ step: 2, ready: true, completed: false, dismissed: false });
    await tour.getByRole("button", { name: "Next", exact: true }).click();
    await browserExpect(page).toHaveURL(`${origin}/dashboard/settings?tab=integrations`);
  });

  it("starts the first Discover refresh once the setup is saved, not before", async () => {
    await start(); await buildSetup();
    completionStatus = 500;
    await chip("Finish setup").click();
    await browserExpect(page.getByText("Something went wrong", { exact: true })).toBeVisible();
    expect(refreshes).toEqual([]);
    completionStatus = 200;
    await chip("Finish setup").click();
    await browserExpect(page.getByRole("heading", { name: "Your Discover is ready" })).toBeVisible();
    await browserExpect.poll(() => refreshes.length).toBe(1);
    expect(refreshes[0]).toMatchObject({ autoRefresh: false });
  });

  it("saves URLs and weights, shows today's headlines, and Write a post opens Create with the story", async () => {
    await start(); await buildSetup();
    await section("Topics").getByRole("button", { name: "Select topic Chaos engineering", exact: true }).click();
    completionStatus = 500;
    await chip("Finish setup").click();
    await browserExpect(page.getByText("Something went wrong", { exact: true })).toBeVisible();
    await browserExpect(section("Sources").getByRole("button", { name: "Remove source Cloud Weekly", exact: true })).toBeVisible();
    completionStatus = 200;
    await chip("Finish setup").click();
    await browserExpect(page.getByRole("heading", { name: "Your Discover is ready" })).toBeVisible();
    expect(completions[1]).toEqual({
      focusDescription: focus, publications: ["Cloud Weekly", "SRE Digest"],
      publicationCandidates: [{ name: "Cloud Weekly", url: "https://cloudweekly.invalid/" }],
      keywords: [{ keyword: "Incident response", weight: 0.9 }, { keyword: "Chaos engineering", weight: 0.6 }],
      influencers: ["Ana Rao"], companies: ["Acme Cloud"],
    });
    await browserExpect(pundit()).toContainText("All set.");
    const story = page.getByRole("region", { name: "Discover preview" }).getByRole("link", { name: "Outage lessons from 2026" });
    await browserExpect(story).toHaveAttribute("href", "https://news.google.com/rss/articles/outage");
    await page.getByRole("button", { name: "Write a post about Outage lessons from 2026", exact: true }).click();
    await browserExpect(page).toHaveURL(`${origin}/dashboard/create`);
    expect(await page.evaluate(() => window.history.state?.createFromUrl)).toBe("https://news.google.com/rss/articles/outage");
  });
});

const message = () => page.getByRole("textbox", { name: "Message Pundit" });
const setMeUp = () => page.getByRole("button", { name: "Set me up", exact: true });
const progressList = () => page.getByRole("list", { name: "Pundit's progress" });

describe("one-click setup", () => {
  it("sets everything up from one answer: no review step and no Finish button", async () => {
    await page.goto(`${origin}/onboarding`);
    await browserExpect(page.getByRole("heading", { name: "What do you do, and who do you want to reach?" })).toBeVisible();
    await message().fill(`  ${focus}  `);
    await setMeUp().click();
    await browserExpect(page.getByRole("heading", { name: "Your feed is ready" })).toBeVisible();
    expect(sent("quick-setup")).toEqual([{ focusDescription: focus, industry: "technology-saas", searchEdition: "en-IN" }]);
    // The server saved it; the browser never sends a separate completion.
    expect(completions).toEqual([]);
    const setup = page.getByRole("region", { name: "Your setup" });
    await browserExpect(setup.getByRole("list", { name: "Sources" })).toContainText("Cloud Weekly");
    await browserExpect(setup.getByRole("list", { name: "Topics" })).toContainText("Incident response");
    await browserExpect(setup.getByRole("list", { name: "People" })).toContainText("Ana Rao");
    await browserExpect(setup.getByRole("list", { name: "Companies" })).toContainText("Acme Cloud");
    await browserExpect(setup.getByRole("link", { name: "Change what I follow" })).toHaveAttribute("href", "/dashboard/settings?tab=content");
    await browserExpect.poll(() => refreshes.length).toBe(1);
    expect(sent("understand")).toEqual([]);
    expect(sent("agent")).toEqual([]);
  });

  it("shows what Pundit understood and found while it works", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await context.route("**/api/onboarding/quick-setup", async route => {
      calls.push({ path: "quick-setup", body: route.request().postDataJSON() });
      await held;
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: quickStream() });
    });
    await page.goto(`${origin}/onboarding`);
    await message().fill(focus);
    await message().press("Enter");
    await browserExpect(page.getByRole("region", { name: "Pundit is setting you up" })).toContainText(focus);
    await browserExpect(progressList()).toContainText("Read what you do");
    release();
    await browserExpect(page.getByRole("heading", { name: "Your feed is ready" })).toBeVisible();
  });

  it("starts from an example without sending it, and needs a full sentence", async () => {
    await page.goto(`${origin}/onboarding`);
    await browserExpect(setMeUp()).toBeDisabled();
    await message().fill("SRE");
    await browserExpect(page.getByText("Add a little more. A full sentence helps Pundit find the right news.")).toBeVisible();
    await browserExpect(setMeUp()).toBeDisabled();
    await page.getByRole("button", { name: "Founder, B2B SaaS", exact: true }).click();
    await browserExpect(message()).toHaveValue("I'm the founder of a B2B SaaS startup, writing for CTOs and engineering leaders.");
    await browserExpect(message()).toBeFocused();
    expect(sent("quick-setup")).toEqual([]);
    await browserExpect(setMeUp()).toBeEnabled();
  });

  it("asks one question only when the description is vague, then builds from the answer or a skip", async () => {
    handlers["quick-setup"] = body => body.clarification || body.skipQuestion ? { raw: quickStream() } : { raw: sse([
      { type: "understanding", understanding: { ...summary, region: null } },
      { type: "question", question: { text: "Which region do you mainly cover?", options: ["India", "Global"] } }, { type: "done" },
    ]) };
    await page.goto(`${origin}/onboarding`);
    await message().fill(focus);
    await setMeUp().click();
    const question = page.getByRole("region", { name: "Pundit's question" });
    await browserExpect(question).toContainText("Which region do you mainly cover?");
    await question.getByRole("button", { name: "India", exact: true }).click();
    await browserExpect(page.getByRole("heading", { name: "Your feed is ready" })).toBeVisible();
    expect(sent("quick-setup")[1]).toEqual({ focusDescription: focus, industry: "technology-saas", searchEdition: "en-IN",
      clarification: { question: "Which region do you mainly cover?", answer: "India" } });

    await page.goto(`${origin}/onboarding`);
    await message().fill(focus);
    await setMeUp().click();
    await page.getByRole("button", { name: "Skip, just set me up", exact: true }).click();
    await browserExpect(page.getByRole("heading", { name: "Your feed is ready" })).toBeVisible();
    expect(sent("quick-setup")[3]).toMatchObject({ skipQuestion: true });
  });

  it("says when part of the setup came from the user's own words", async () => {
    handlers["quick-setup"] = () => ({ raw: quickStream(true) });
    await page.goto(`${origin}/onboarding`);
    await message().fill(focus);
    await setMeUp().click();
    await browserExpect(page.getByRole("region", { name: "Your setup" })).toContainText("some picks come straight from your description");
  });

  it("offers Try again and the manual path when the setup can't be saved", async () => {
    let attempts = 0;
    handlers["quick-setup"] = () => ++attempts === 1
      ? { raw: sse([{ type: "result", ...sources }, { type: "error", step: null, code: "save_failed" }, { type: "done" }]) }
      : { raw: quickStream() };
    await page.goto(`${origin}/onboarding`);
    await message().fill(focus);
    await setMeUp().click();
    await browserExpect(page.getByRole("alert")).toContainText("couldn't save them just now");
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await browserExpect(page.getByRole("heading", { name: "Your feed is ready" })).toBeVisible();
    expect(refreshes).toHaveLength(1);
  });

  it("says so when the user has asked too often, and the manual path still works", async () => {
    handlers["quick-setup"] = () => ({ status: 429, data: { message: "Too many requests" } });
    await page.goto(`${origin}/onboarding`);
    await message().fill(focus);
    await setMeUp().click();
    await browserExpect(page.getByRole("alert")).toContainText("You've asked Pundit a lot in the last hour.");
    await page.getByRole("button", { name: "Set up manually", exact: true }).click();
    await browserExpect(pundit()).toContainText("Hi, I'm Pundit.");
  });

  it("goes back to the question with the description kept", async () => {
    handlers["quick-setup"] = () => ({ raw: sse([{ type: "understanding", understanding: summary },
      { type: "question", question: { text: "Which region do you mainly cover?", options: ["India", "Global"] } }, { type: "done" }]) });
    await page.goto(`${origin}/onboarding`);
    await message().fill(focus);
    await setMeUp().click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await browserExpect(message()).toHaveValue(focus);
  });

  it("drafts a post from the first story in one click", async () => {
    await page.goto(`${origin}/onboarding`);
    await message().fill(focus);
    await setMeUp().click();
    await page.getByRole("button", { name: "Draft a post from the first story", exact: true }).click();
    await browserExpect(page).toHaveURL(`${origin}/dashboard/create`);
    expect(await page.evaluate(() => window.history.state?.createFromUrl)).toBe("https://news.google.com/rss/articles/outage");
  });

  it("closes the guide when Pundit saves the setup, instead of popping it up over the workspace later", async () => {
    await page.goto(`${origin}/onboarding?tour=1`);
    const tour = page.getByTestId("dialog-app-tour");
    await browserExpect(tour).toContainText("Start by talking to Pundit");
    await message().fill(focus);
    await message().press("Enter");
    await browserExpect(page.getByRole("heading", { name: "Your feed is ready" })).toBeVisible();
    await browserExpect(tour).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("tsp-app-tour:v3:fixture-user:workspace")!))).toMatchObject({ step: 3, dismissed: true });
  });

  it("fits a 320 px phone without horizontal scroll", async () => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto(`${origin}/onboarding`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await message().fill(focus);
    await setMeUp().click();
    await browserExpect(page.getByRole("heading", { name: "Your feed is ready" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
