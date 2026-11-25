import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowRight, Check, Pencil, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { OnboardingData } from "@/lib/onboarding-choices";
import { browserSearchEdition, type PreviewHeadline, type SuggestionStep } from "@/lib/onboarding-suggestions";
import { saveStoryForCreate, STORY_LINK_KEY } from "@/lib/create-story-link";
import { track } from "@/lib/analytics-consent";
import { QUICK_STEPS, useQuickSetup, type QuickSetupState } from "@/hooks/use-quick-setup";
import { useDiscoverPreview } from "@/hooks/use-discover-preview";
import { useAppTourSignal } from "@/components/app-tour";
import { OnboardingHeader } from "@/components/onboarding/onboarding-header";
import { DiscoverPreview } from "@/components/onboarding/discover-preview";

interface QuickSetupProps {
  firstName?: string;
  userIndustry?: string;
  userCountry?: string;
  /** What was saved; the screen then shows what Pundit set up. */
  completed: OnboardingData | null;
  onSaved: (setup: OnboardingData) => void;
  /** Move on from the result to a page (with optional history state), or to the app. */
  onLeave: (to?: string, state?: Record<string, unknown>) => void;
  /** Pick every source, topic and person yourself instead. */
  onManual: () => void;
}

const MIN_FOCUS = 10;
const MAX_FOCUS = 500;
const EXAMPLES = [
  { label: "Founder, B2B SaaS", text: "I'm the founder of a B2B SaaS startup, writing for CTOs and engineering leaders." },
  { label: "Fintech marketing", text: "I lead marketing at a fintech company in India, reaching CFOs and founders." },
  { label: "Healthcare consultant", text: "I advise hospitals on digital transformation and healthcare technology." },
  { label: "Climate investor", text: "I invest in early-stage climate tech startups in Europe." },
];
const TITLES: Record<SuggestionStep, string> = { publications: "Sources", topics: "Topics", people: "People and companies" };
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const listed = (names: string[], max = 3) => names.length > max ? `${names.slice(0, max).join(", ")} +${names.length - max}` : names.join(", ");

type ItemState = "done" | "running" | "waiting" | "error";
interface ChecklistItem { label: string; state: ItemState; detail: string }

function StatusIcon({ state }: Readonly<{ state: ItemState }>) {
  if (state === "done") return <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success text-success-foreground"><Check className="h-3 w-3" strokeWidth={3} /></span>;
  if (state === "running") return <span aria-hidden="true" className="h-5 w-5 shrink-0 animate-spin rounded-full border-[2.5px] border-primary border-t-secondary" />;
  if (state === "error") return <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold text-muted-foreground">–</span>;
  return <span aria-hidden="true" className="h-5 w-5 shrink-0 rounded-full border-2 border-input" />;
}

function checklist(state: QuickSetupState): ChecklistItem[] {
  const { understanding } = state;
  const asking = state.status === "question";
  const read: ChecklistItem = understanding
    ? { label: "Read what you do", state: "done", detail: [understanding.role, understanding.industry, understanding.region].filter(Boolean).join(" · ") }
    : state.understandingSkipped ? { label: "Read what you do", state: "error", detail: "Searching from your own words instead" }
      : { label: "Read what you do", state: state.status === "failed" ? "error" : "running", detail: "Reading…" };
  const steps = QUICK_STEPS.map((step): ChecklistItem => {
    const current = state.steps[step];
    if (asking || state.phase === "reading") return { label: TITLES[step], state: "waiting", detail: "Waiting" };
    if (current.status === "error") return { label: TITLES[step], state: "error", detail: "Nothing usable this time; you can add your own later" };
    if (current.status !== "done" || !current.result) return { label: TITLES[step], state: state.status === "failed" ? "error" : "running", detail: "Looking…" };
    const picks = current.result.picks;
    if (!picks.length) return { label: TITLES[step], state: "done", detail: "Nothing strong enough to pick" };
    const noun = step === "publications" ? ["source", "sources"] : step === "topics" ? ["topic", "topics"] : ["pick", "picks"];
    return { label: TITLES[step], state: "done", detail: `${count(picks.length, noun[0], noun[1])}: ${listed(picks)}` };
  });
  const settled = QUICK_STEPS.every(step => state.steps[step].status === "done" || state.steps[step].status === "error");
  const save: ChecklistItem = state.status === "saved" ? { label: "Save your setup", state: "done", detail: "Saved" }
    : !asking && settled ? { label: "Save your setup", state: state.status === "failed" ? "error" : "running", detail: "Saving…" }
      : { label: "Save your setup", state: "waiting", detail: "Waiting" };
  return [read, ...steps, save];
}

/** One-click onboarding: one question, Pundit builds and saves the setup, then shows what it found. */
export function QuickSetup({ firstName, userIndustry, userCountry, completed, onSaved, onLeave, onManual }: Readonly<QuickSetupProps>) {
  const [draft, setDraft] = useState("");
  const [focus, setFocus] = useState("");
  const [typedAnswer, setTypedAnswer] = useState("");
  const [degraded, setDegraded] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const searchEdition = useMemo(() => browserSearchEdition(userCountry), [userCountry]);
  const { state, start, reset } = useQuickSetup({
    industry: userIndustry, searchEdition,
    onSaved: (setup, wasDegraded) => { setDegraded(wasDegraded); onSaved(setup); },
  });
  const preview = useDiscoverPreview(completed, userIndustry, userCountry);

  useAppTourSignal("focus-submitted", Boolean(focus));
  useAppTourSignal("setup-started", state.status !== "idle" || Boolean(completed));
  useAppTourSignal("setup-saved", Boolean(completed));

  const asked = useRef(false);
  useEffect(() => {
    if (state.status !== "question" || asked.current) return;
    asked.current = true;
    track("onboarding_question_shown");
  }, [state.status]);

  const trimmed = draft.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < MIN_FOCUS;
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (trimmed.length < MIN_FOCUS) { input.current?.focus(); return; }
    const next = trimmed.slice(0, MAX_FOCUS);
    setFocus(next);
    track("onboarding_started", { flow: "quick" });
    void start(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
  };
  const fillExample = (text: string) => {
    setDraft(text);
    requestAnimationFrame(() => { const element = input.current; if (element) { element.focus(); element.setSelectionRange(text.length, text.length); } });
  };
  const edit = () => { reset(); setFocus(""); setDraft(focus); requestAnimationFrame(() => input.current?.focus()); };
  const answer = (reply: string) => {
    if (!state.question || !reply.trim()) return;
    setTypedAnswer("");
    void start(focus, { clarification: { question: state.question.text, answer: reply.trim().slice(0, 200) } });
  };
  const opening = useRef(false);
  const writePost = async (headline?: PreviewHeadline) => {
    if (opening.current) return;
    opening.current = true;
    const link = headline?.link ? await saveStoryForCreate({ ...headline, link: headline.link }) : undefined;
    onLeave("/dashboard/create", link ? { [STORY_LINK_KEY]: link } : undefined);
  };

  let body;
  if (completed) {
    const groups = [
      { title: "Sources", names: completed.publications },
      { title: "Topics", names: completed.keywords.map(keyword => keyword.keyword) },
      { title: "People", names: completed.influencers },
      { title: "Companies", names: completed.companies },
    ].filter(group => group.names.length);
    const previewPending = preview.hasTopics && (preview.status === "idle" || preview.status === "loading");
    const firstStory = preview.status === "ready" ? preview.headlines.find(headline => headline.link) : undefined;
    body = (
      <section aria-label="Your setup" data-app-tour="setup-result" className="space-y-6">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-success">Setup complete</p>
          <h1 className="font-heading text-3xl font-semibold tracking-tight">Your feed is ready</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Pundit is following these for you. Discover is filling with today's stories now. You can change any of this later in Settings.
          </p>
          {degraded && (
            <p className="mt-3 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
              Pundit's AI couldn't help with part of this, so some picks come straight from your description. You can refine them in Settings.
            </p>
          )}
        </div>
        <div className="space-y-3 rounded-xl border bg-card p-4">
          {groups.map(group => (
            <div key={group.title} className="space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.title}</p>
              <ul aria-label={group.title} className="flex flex-wrap gap-1.5">
                {group.names.map(name => <li key={name} className="rounded-full border bg-background px-3 py-1 text-sm">{name}</li>)}
              </ul>
            </div>
          ))}
          <a href="/dashboard/settings?tab=content" className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline"
            onClick={event => { event.preventDefault(); onLeave("/dashboard/settings?tab=content"); }}>
            Change what I follow
          </a>
        </div>
        <DiscoverPreview preview={preview} onWritePost={writePost} />
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button type="button" size="lg" disabled={previewPending} onClick={() => firstStory ? writePost(firstStory) : onLeave("/dashboard/discover")}>
            {previewPending ? "Finding your first story…" : firstStory ? "Draft a post from the first story" : "Open Discover"}
          </Button>
          <Button type="button" size="lg" variant="outline" onClick={() => onLeave()}>Go to my dashboard</Button>
        </div>
      </section>
    );
  } else if (state.status === "idle") {
    body = (
      <section aria-labelledby="quick-setup-title" className="space-y-6">
        <p className="text-sm font-medium text-primary">Hi{firstName ? ` ${firstName}` : ""}, I'm Pundit. I'll set up your news feed for you.</p>
        <div className="space-y-2">
          <h1 id="quick-setup-title" className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">What do you do, and who do you want to reach?</h1>
          <p className="text-base leading-relaxed text-muted-foreground">
            A sentence or two is enough. I'll find the sources, topics and people worth following in today's news.
          </p>
        </div>
        <form onSubmit={submit} data-app-tour="setup-ask" className="space-y-3">
          <Textarea ref={input} aria-label="Message Pundit" aria-describedby="quick-setup-hint" value={draft} maxLength={MAX_FOCUS} rows={3} autoFocus
            placeholder="e.g. I lead growth at a B2B fintech in India, writing for CFOs and founders."
            onChange={event => setDraft(event.target.value)} onKeyDown={onKeyDown} className="resize-none text-base md:text-base" />
          <p id="quick-setup-hint" className={cn("text-xs", tooShort ? "text-foreground" : "text-muted-foreground")}>
            {tooShort ? "Add a little more. A full sentence helps Pundit find the right news." : "Include your role, your field and who you write for."}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Start from an example:</span>
            {EXAMPLES.map(example => (
              <Button key={example.label} type="button" variant="outline" size="sm" className="rounded-full" onClick={() => fillExample(example.text)}>{example.label}</Button>
            ))}
          </div>
          <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
            <Button type="submit" size="lg" data-app-tour="setup-build" disabled={trimmed.length < MIN_FOCUS}>
              Set me up <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Button>
            <button type="button" onClick={onManual} className="inline-flex min-h-11 items-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              I'd rather choose each source myself
            </button>
          </div>
        </form>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
          Nothing is posted without your approval, and you can change everything later.
        </p>
      </section>
    );
  } else {
    const items = checklist(state);
    const latest = state.feed.at(-1);
    const summary = state.understanding;
    body = (
      <section aria-label="Pundit is setting you up" className="space-y-5">
        <div className="flex items-start gap-3 rounded-xl border bg-card p-4">
          <p className="min-w-0 flex-1 text-sm leading-relaxed [overflow-wrap:anywhere]"><span className="sr-only">You said: </span>“{focus}”</p>
          <Button type="button" variant="ghost" size="sm" onClick={edit}><Pencil className="h-3.5 w-3.5" aria-hidden="true" />Edit</Button>
        </div>
        {summary && (
          <section aria-label="What Pundit understood" className="space-y-2">
            <p className="text-sm"><span className="text-muted-foreground">I understood: </span>
              {[summary.role, summary.industry, summary.region, summary.audience ? `for ${summary.audience}` : ""].filter(Boolean).join(" · ")}
            </p>
            {summary.focusAreas.length > 0 && (
              <ul aria-label="Focus areas" className="flex flex-wrap gap-1.5">
                {summary.focusAreas.map(area => <li key={area} className="rounded-full bg-accent px-2.5 py-0.5 text-xs text-accent-foreground">{area}</li>)}
              </ul>
            )}
          </section>
        )}
        {state.status === "question" && state.question && (
          <section aria-label="Pundit's question" className="flex gap-3">
            <div className="min-w-0 flex-1 space-y-3">
              <p className="text-base font-medium">{state.question.text}</p>
              <div className="flex flex-wrap gap-2">
                {state.question.options.map(option => <Button key={option} type="button" variant="outline" onClick={() => answer(option)}>{option}</Button>)}
              </div>
              <form className="flex gap-2" onSubmit={event => { event.preventDefault(); answer(typedAnswer); }}>
                <Input aria-label="Or type your answer" value={typedAnswer} maxLength={200} placeholder="Or type your answer…" onChange={event => setTypedAnswer(event.target.value)} />
                <Button type="submit" variant="outline" disabled={!typedAnswer.trim()}>Answer</Button>
              </form>
              <button type="button" onClick={() => void start(focus, { skipQuestion: true })}
                className="inline-flex min-h-11 items-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                Skip, just set me up
              </button>
            </div>
          </section>
        )}
        <div data-app-tour="setup-build" className="space-y-3 rounded-xl border bg-card p-4">
          <ol aria-label="Pundit's progress" className="space-y-2.5">
            {items.map(item => (
              <li key={item.label} className="flex min-w-0 items-start gap-2.5 text-sm">
                <StatusIcon state={item.state} />
                <span className={cn("shrink-0 font-medium", item.state === "waiting" && "text-muted-foreground")}>{item.label}</span>
                <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">{item.detail}</span>
              </li>
            ))}
          </ol>
          {state.status === "running" && latest && <p role="status" className="animate-pulse text-sm text-muted-foreground">{latest}</p>}
          {state.feed.length > 0 && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Show what I did</summary>
              <ol className="mt-1 max-h-40 list-decimal space-y-0.5 overflow-y-auto pl-5">{state.feed.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ol>
            </details>
          )}
        </div>
        {state.status === "failed" && (
          <div role="alert" className="space-y-3 rounded-xl border border-destructive/40 bg-card p-4">
            <p className="text-sm">{state.failure} Try again, or choose your sources yourself.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => void start(focus)}>Try again</Button>
              <Button type="button" variant="outline" onClick={onManual}>Set up manually</Button>
            </div>
          </div>
        )}
      </section>
    );
  }

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-muted/30">
      <OnboardingHeader />
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-8 sm:px-6 sm:py-12">
        <div className="mx-auto w-full max-w-2xl">{body}</div>
      </main>
    </div>
  );
}
