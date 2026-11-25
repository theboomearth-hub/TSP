import { describe, expect, it } from "vitest";
import { topicQueries, topicWords } from "./topic-stories";

describe("topic search terms", () => {
  it("keeps the meaningful words of a one-liner, including short acronyms", () => {
    expect(topicWords("Why programmatic DOOH needs better measurement standards")).toEqual(["programmatic", "DOOH", "measurement", "standards"]);
    expect(topicWords("What AI means for B2B marketers")).toEqual(["AI", "means", "B2B", "marketers"]);
    expect(topicWords("retail media, retail Media")).toEqual(["retail", "media"]);
  });

  it("searches the first three words, then the first two", () => {
    expect(topicQueries("Why programmatic DOOH needs better measurement standards")).toEqual(["programmatic DOOH measurement", "programmatic DOOH"]);
    expect(topicQueries("retail media")).toEqual(["retail media"]);
    expect(topicQueries("why is it")).toEqual([]);
  });
});
