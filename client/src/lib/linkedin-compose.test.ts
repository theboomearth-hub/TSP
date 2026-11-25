import { describe, expect, it } from "vitest";
import { generationRequest, nextMorning, postingOutcome } from "./linkedin-compose";

const source = { id: "s1", headline: "Story", source: "Wire", articleUrl: "https://news.test/s1" };

describe("LinkedIn composer helpers", () => {
  it("reports queued, published, simulated and failed outcomes without overstating delivery", () => {
    expect(postingOutcome({ jobIds: ["job"], results: [] }).title).toBe("Sending to LinkedIn");
    expect(postingOutcome({ results: [{ platform: "linkedin", status: "published" }] })).toMatchObject({ tone: "success", title: "Posted to LinkedIn" });
    expect(postingOutcome({ results: [{ platform: "linkedin", status: "simulated" }] }).title).toBe("Simulated — nothing was posted");
    expect(postingOutcome({ results: [{ platform: "linkedin", status: "failed" }] }).tone).toBe("error");
    expect(postingOutcome({ results: [{ platform: "linkedin", status: "unknown" }] }).title).toBe("Delivery not confirmed");
  });

  it("schedules for 9:00 local time the next day, skipping weekends when asked", () => {
    const friday = new Date(2026, 10, 20, 14, 30);
    expect(nextMorning(friday)).toEqual(new Date(2026, 10, 21, 9, 0));
    expect(nextMorning(friday, true)).toEqual(new Date(2026, 10, 23, 9, 0));
  });

  it("builds one LinkedIn generation from a story or from a substantial idea", () => {
    expect(generationRequest({ source, angle: "Questions buyers ask", take: "Compare definitions first", toneKey: "thoughtLeader" })).toEqual({
      endpoint: "/api/instant-review/selected",
      body: { selectedPlatforms: ["linkedin"], tones: ["thoughtLeader"], format: "short-post", userContext: "Angle: Questions buyers ask\nMy take: Compare definitions first", url: source.articleUrl },
    });
    expect(generationRequest({ angle: "Short", take: "", toneKey: "thoughtLeader" })).toEqual({ error: "Describe your idea in at least 20 characters, or start from a story." });
    const manual = generationRequest({ angle: "Measurement myths", take: "Most dashboards compare different definitions.", toneKey: "dataDriven" });
    expect(manual).toMatchObject({ endpoint: "/api/instant-review/manual", body: { title: "Measurement myths", selectedPlatforms: ["linkedin"], tones: ["dataDriven"] } });
  });

  const topic = { topic: "programmatic DOOH", briefId: "5d2c4b7e-1f0a-4c6b-9a8e-2b3c4d5e6f70", storyIds: ["s1", "s3"], storiesFound: 4 };
  it("writes a topic post from the ticked stories, with the chosen shape", () => {
    expect(generationRequest({ topic, angle: "Measurement is the blocker", take: "", toneKey: "thoughtLeader", shape: "roundup" })).toEqual({
      endpoint: "/api/instant-review/manual",
      body: { selectedPlatforms: ["linkedin"], tones: ["thoughtLeader"], format: "short-post", userContext: "Angle: Measurement is the blocker", title: "programmatic DOOH", content: "",
        topicBrief: { id: topic.briefId, storyIds: ["s1", "s3"] }, shape: "roundup" },
    });
    expect(generationRequest({ topic, angle: "", take: "", toneKey: "thoughtLeader", shape: "post" })).not.toHaveProperty("body.shape");
  });

  it("writes an opinion post from the person's view when no story is used, and asks for the view otherwise", () => {
    const none = { ...topic, storyIds: [], storiesFound: 0 };
    expect(generationRequest({ topic: none, angle: "", take: "", toneKey: "thoughtLeader" })).toEqual({
      error: "Pundit found no stories on this topic. Add your view in a sentence or two to write an opinion post." });
    expect(generationRequest({ topic: { ...none, storiesFound: 4 }, angle: "", take: "", toneKey: "thoughtLeader" })).toEqual({
      error: "Tick at least one story, or add your view to write an opinion post." });
    expect(generationRequest({ topic: none, angle: "", take: "Buyers won't scale it without shared measurement.", toneKey: "thoughtLeader" })).toMatchObject({
      endpoint: "/api/instant-review/manual",
      body: { title: "programmatic DOOH", content: "programmatic DOOH\n\nBuyers won't scale it without shared measurement.", opinionOnly: true, sourceLabel: "Your view" },
    });
  });
});
