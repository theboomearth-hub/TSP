# One-click onboarding — design

Requested on 2026-11-24: onboarding should take one click, with at most one or two
questions, and Pundit should do the rest. This replaces the default path of the
[onboarding workspace](2026-09-24-onboarding-workspace-design.md); that workspace stays
as the "choose each source myself" path, unchanged apart from losing its step bar.

## The experience

0. **One place, not separate pages.** Setup appears on the dashboard's own URL until it
   is done; there is no separate onboarding page. `/onboarding` is kept only as an old
   link (the welcome email uses it) and forwards to `/dashboard`. After saving, the
   rest of the app treats setup as done at once, but "Your feed is ready" stays on
   screen until the user moves on (draft a post, open Discover, go to the dashboard,
   or change what they follow); the app then opens in the same place.
1. **No registration form.** After sign-up, the account is completed automatically
   from the sign-up name and the browser's time zone. Industry and market are no
   longer asked; Pundit infers them.
2. **One question.** "What do you do, and who do you want to reach?" A text box,
   four example chips (which fill the box; they never submit) and **Set me up**.
   Enter submits. A small link opens the step-by-step workspace instead.
3. **At most one follow-up.** Only when the description is too vague to search,
   Pundit asks one question with quick answers, a typed answer, or "Skip, just set
   me up".
4. **Pundit builds and saves.** A checklist (read what you do, sources, topics,
   people and companies, save) with live narration and "Show what I did". There
   is no review step and no Finish button: the setup is saved when research ends.
5. **Payoff.** "Your feed is ready": what Pundit follows (sources, topics, people,
   companies), today's matching headlines with **Write a post**, a primary
   **Draft a post from the first story**, and "Change what I follow" (Settings →
   Content). Discover starts refreshing as soon as the setup is saved.

## Server

- `POST /api/onboarding/quick-setup` streams server-sent events: `progress`,
  `understanding`, `question`, `result` (per step), `error`, `saved`, `done`.
  Guards: signed in, `generation:create:own` and `profile:write:own`, and the
  onboarding rate limit. Budget 90 s.
- **Fewer, parallel AI calls.** The understanding call also returns 2–4 search
  phrases and the closest built-in industry (the model sees readable industry
  names, never codes). One shared news search (up to 6 queries, headlines taken
  from each query in turn) then feeds the sources, topics and people picks in
  parallel: four AI calls in total, with one sequential step, instead of five
  in a row. Prompts, grounding rules and pick counts (6, 8, 4 + 4) are unchanged.
- **Never a dead end.** A failed summary means searching from the user's own words; a
  failed step is reported and the rest carry on; with no topic, person or company
  picked, the user's focus areas (or phrases from their description, without the
  audience clause) become topics. `saved.degraded` tells the client to say so.
  A failed save emits `error` with `save_failed`, never `saved`.
- **One save path.** `completeOnboarding` (in `onboardingCompletion.ts`) is used by both
  "Finish setup" and quick setup. Quick setup sets the user's industry only when
  they have none.
- `POST /api/complete-registration` accepts a name alone; industry and market are
  optional and, when left out, keep any value the account already has.

## Also in this change

- The lightning-bolt icon is gone from the product: Pundit's avatar, the loading
  spinner, the sign-in/up pages (now the real logo mark) and the pricing page.
- The app tour's setup steps describe both paths; the third step points at the
  finished setup (`data-app-tour="setup-result"`).
- **The tour no longer pops up after setup.** It carries on into the workspace only
  when the guide is open on its last setup step at the moment setup is saved (the
  user is following it). Otherwise saving setup closes it and marks it dismissed, in
  both layouts, at the "Connect an account" step, so **App tour** reopens it there.
  This replaces the earlier rule that a guide skipped past setup resumes on its own.
- The setup result stays only on the page where it was saved; any navigation (a
  button, the tour, Back) opens the app.

## Not yet done

- A landing-page start (type the sentence before signing up), the auto-drafted
  first post, the work-email guess, a shorter tour, and saving the inferred
  search region to the profile.
