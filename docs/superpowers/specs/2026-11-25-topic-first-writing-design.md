# Topic-first writing: no article or link needed

Requested on 2026-11-25: people should be able to write from a one-liner, a saved keyword
or an idea, and Pundit should find the related stories and suggest how to write about them.
This builds on [Discover Phase 1](2026-11-25-discover-no-dead-ends-design.md), which made
it possible to write from a story's headline when its page can't be read.

## Decisions (2026-11-25)

1. **Nothing related found:** Pundit asks for the person's view, then writes an opinion post
   labelled "Opinion, no sources" that makes no factual claims.
2. **Where first:** the Gmail-style Compose. The classic Create screen gets topic search in
   its "Attach articles" panel.
3. **Links:** the post names every outlet it uses and links only the main story, as before.
4. **Picked stories:** kept for 24 hours in a topic brief on the server. Each story has a
   "Save to Shortlist" button for anyone who wants to keep it.

## The flow in Compose

1. **Topic.** A new compose has a Topic field ("What do you want to post about?"), with
   recent topics and the person's Labels as chips.
2. **Related stories.** The search starts when the person pauses typing (1.5 s), presses
   Enter, or picks a chip.
   - **Search:** `POST /api/topics/related` returns up to 6 stories, best first, with the top
     3 ticked. Each shows its outlet, date, "+N outlets", "Full text" and "In your Discover".
   - **Angle ideas:** three AI-suggested angles appear under the stories
     (`POST /api/topics/:id/angles`). Picking one fills the Angle line and ticks the
     stories behind it.
   - **Shape:** Post, Roundup, 3 takeaways or My take.
3. **Help me write.** If the topic hasn't been searched yet, Pundit searches first.
   - **From stories:** with stories ticked, it writes from them.
   - **No stories:** it needs the person's view and writes an opinion post.
   - **Label:** under the text, a line says what the post was based on: "Written from
     headlines" or "Opinion, no sources", and "Sources: …".
4. **Other ways in.**
   - **Labels:** a "Write about …" button on every Label in the menu.
   - **Ideas:** an idea's pillar becomes the topic and its angle fills the Angle line.
   - **Moments:** a moment's title becomes the topic and its suggested angle fills the
     Angle line.

## Server

### Finding stories (`server/services/topicStories.ts`)

- **Search terms.** `topicWords` keeps a topic's meaningful words (`shared/topic-stories.ts`).
  News search needs every word to match, so the first 3 words are searched, then the first 2
  when that finds fewer than 3 stories.
- **Sources.**
  - The person's own Discover (For you and Shortlist) counts when a story mentions most of
    the topic.
  - News search: the shared index plus Google News and Bing, already grouped across outlets.
  - No page is read. The search only checks whether the shared index holds an article's text.
- **One entry per story.** Copies of the same news from different outlets become one entry
  with "also covered by". The topic's own words are ignored when comparing headlines,
  because every result shares them.
- **Ranking.** The score adds:
  - relevance (share of the topic's words found) × 0.6;
  - freshness × 0.25;
  - 0.08 per extra outlet, up to 5;
  - 0.05 per recent pick of that outlet, up to 3;
  - 0.05 for a story in the person's Discover.

### Topic briefs (`topic_briefs`, migration 0066)

- **Storage.** One row per search. It is private to its owner (row-level security) and expires
  after 24 hours.
- **Trust.** The write request sends only the brief id and the ticked story ids. The server
  rebuilds the writer's input from its own row, so story text never comes from the browser.
- **Learning.** A brief that was written from records its picks and is kept 30 more days.
  Recent topics and outlet preferences are read from those records.

### Writing (`server/services/editorial-request.ts`)

- **Topic post.** `manualReviewSchema` accepts a `topicBrief` (id plus story ids) or
  `opinionOnly`, plus a `shape`.
  - Each ticked story becomes a section. It uses the stored article text when the shared
    index has it, and otherwise a headline brief (the Phase 1 story brief plus "Also covered
    by …").
  - Sections are combined as for several attached articles. The best-ranked ticked story is
    the main one: its outlet is the post's `source` and its link is the only link.
  - The content is marked `topic: true`.
- **Opinion post.** The topic and the person's view are the content. They are marked
  `opinion: true`, with the source label "Your view" and no link.
- **Writer rules** (`server/services/punditBrain.ts`).
  - **TOPIC POST:** synthesise across the stories, credit every fact to its outlet, keep facts
    from different outlets apart, mention the main outlet, link only the main story.
  - **OPINION POST:** the author's view only. No external facts, figures, dates or events, and
    nothing attributed to anyone.
  - **SHAPE:** roundup, 3 takeaways or my take. The plain post adds no shape rule.
- **Warnings.** Evidence carries `opinion_only`, next to Phase 1's `headlines_only`.
- **Expired or unknown brief.** The answer is `410 topic_expired`: "These stories are no longer
  available. Search the topic again." This holds on the direct routes and for queued jobs.
- **Classic Create.** It can attach topic stories by link, because a link from one of the
  person's live briefs counts as their own story, just as a Discover story does.

### Angles (`server/services/topicAngles.ts`)

- **The call.** One AI call that sees only the topic, the person's focus, and the stories'
  headlines and snippets. It returns 3 distinct angles, each with the ids of the stories behind
  it; ids it didn't supply are dropped.
- **Storage.** Angles are kept with the brief, so asking again is free.
- **Limit.** It uses the AI rate limit of 30 calls per 15 minutes. A failure just leaves the
  angles out.

## Limits and costs

- **Searches.** Topic search shares News search's limit of 20 searches a minute per person.
- **AI calls.** Angle ideas are one small AI call per search with stories. Writing is one AI
  call, as before, and counts against the plan's daily generation allowance.

## Not done

- **Learning from angles.** Pundit learns from the stories people pick, not yet from the angles.
- **AI search phrases.** An AI step that rewrites a topic into better search phrases when the
  plain words find little.
- **Format options in classic Create.** Its topic search attaches stories but doesn't offer
  shapes.
