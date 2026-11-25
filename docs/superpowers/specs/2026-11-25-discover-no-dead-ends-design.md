# Discover Phase 1: no dead ends

Requested on 2026-11-24: Discover should work from keywords and interests and not depend on
being able to fetch an article's page. This is the first of five phases (stories, smarter
interests, topic-first writing and measurement follow). This phase removes the failures
users hit most: stories that vanish because their page can't be read, and "Write a post"
refusing for the same reason.

Decision taken (2026-11-25): when the full article can't be read, Pundit writes from the
story's headline and snippet with clear attribution, and the draft is labelled
"Written from headlines".

## What changed

### Discover offers every relevant story

- **Unreadable pages stay.** Stories the crawler found paywalled, blocked or empty are no
  longer removed before scoring.
- **No read check before offering.** Before this phase, the top 24 stories were read during each
  refresh (up to 12 s) and unreadable ones were dropped. That check is gone. The accepted top 10
  are still read into the shared index right after the refresh, so most posts are written from
  full text.
- **Google News links stay.** A Google News story whose publisher link can't be decoded keeps
  its Google News link instead of being dropped. The link opens the story in a browser, and
  later refreshes try to decode it again. Such links are never read into the shared index.
- **Video pages are still left out.** They have no text at all.

### Writing never dead-ends on a story Discover knows

`server/services/storyBrief.ts`:

1. When reading a page fails, the server looks the link up in the person's own Discover
   (any status) and then in the shared index.
2. **Story brief.** If the link is found, Pundit writes from a brief instead of failing. Each line
   of the brief names its outlet, so every point can be attributed:
   - the headline with its outlet and date;
   - the snippet, when it says more than the headline;
   - up to 5 headlines from other outlets on the same development.
3. **Related coverage** comes from one Google News search for the headline (any age, 4 s limit).
   A headline counts only if it meets all three tests:
   - it shares at least 3 meaningful words, covering at least half of the longer headline;
   - it comes from a different outlet;
   - it was published within 10 days of the story.

   The match is strict on purpose. Missing a related headline costs little. Attributing a
   different story to an outlet does not.
4. **The brief's provenance.** The brief is marked `extractionMethod: "headlines"`. Evidence then
   carries a `headlines_only` warning instead of the "very little source text" warning. Every
   outlet used is listed as a reference.
5. **Writer prompt.** A headlines-only rule tells the AI to:
   - attribute each point to its outlet;
   - stay at the detail the lines state;
   - mark opinion as opinion;
   - never imply it read the article;
   - refuse only if no line states a development.
6. **Unknown links.** A link nothing is known about (a pasted URL that can't be read) still fails
   as before, with the same "source unreadable" message.
7. **Several stories attached.** Each unreadable story becomes a brief, combined with the
   readable ones. The draft is labelled as written from headlines if any story needed a brief.

### Links from onboarding and emails

- **Emails.** "Write about this" links in emails point at stories already in the person's
  Discover, so the fallback covers them without any change.
- **Onboarding.** "Write a post" and "Draft a post from the first story" now save the headline to
  the Shortlist first (`POST /api/search/news/save`), then open Create with the saved link. The
  server then knows the title, outlet and date, even for a Google News link. If saving fails,
  Create opens with the original link as before.

### Create shows it

- **Label on the document.** A "Written from headlines" chip appears on the document. Clicking it
  opens Review sources.
- **Review sources.** The source panel reads "Headlines and snippets (the full article couldn't
  be read)" and lists every outlet used.

## Not in this phase

- **Grouping and ranking** (Phase 2): cross-outlet story grouping with outlet counts, freshness
  recomputed at load, and "rising" stories.
- **Interests** (Phase 3): AI query expansion and similarity ranking; learning from save, draft
  and publish.
- **Writing** (Phase 4): topic briefs, roundups and the daily brief email.
- **Thin pages.** A page that reads but has only a description can still lead the AI to refuse
  for thin content. It is not yet merged with the headline brief.
- **Source links.** Where links go in a post (inline or first comment) is unchanged: one link,
  the story's own.
