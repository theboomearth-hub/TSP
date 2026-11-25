import { describe, expect, it } from "vitest";
import { aiConfigurationProblem } from "./openRouter";

// A fresh clone has no .env: the app starts, so the missing AI key must be named at start-up.
describe("aiConfigurationProblem", () => {
  it("is null when the chosen provider has a key", () => {
    expect(aiConfigurationProblem({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k" })).toBeNull();
    expect(aiConfigurationProblem({ AI_PROVIDER: "gemini", AI_INTEGRATIONS_GEMINI_API_KEY: "k" })).toBeNull();
    expect(aiConfigurationProblem({ OPENROUTER_API_KEY: "k" })).toBeNull();
    expect(aiConfigurationProblem({ ANTHROPIC_API_KEY: "k" })).toBeNull();
  });

  it("names the missing setting, and the default provider when none was chosen", () => {
    expect(aiConfigurationProblem({ AI_PROVIDER: "gemini", OPENROUTER_API_KEY: "k" }))
      .toBe('AI writing is off: AI_PROVIDER is gemini, but GEMINI_API_KEY or AI_INTEGRATIONS_GEMINI_API_KEY isn\'t set. Drafts and Pundit\'s setup will fail with "AI generation is not configured correctly".');
    expect(aiConfigurationProblem({})).toContain("AI_PROVIDER isn't set, so the provider defaults to openrouter, but OPENROUTER_API_KEY");
    expect(aiConfigurationProblem({ AI_PROVIDER: "openai", OPENAI_API_KEY: "  " })).toContain("but OPENAI_API_KEY isn't set");
  });

  it("flags an unsupported provider without repeating its value", () => {
    const problem = aiConfigurationProblem({ AI_PROVIDER: "secret-typo", GEMINI_API_KEY: "k" });
    expect(problem).toContain("unsupported provider");
    expect(problem).not.toContain("secret-typo");
  });
});
