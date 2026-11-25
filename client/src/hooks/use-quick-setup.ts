import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiRequest } from "@/lib/queryClient";
import type { OnboardingData } from "@/lib/onboarding-choices";
import {
  parseQuickSetupEvent, readEventStream,
  type QuickSetupSummary, type SuggestionResult, type SuggestionStep,
} from "@/lib/onboarding-suggestions";
import type { SearchEditionId } from "@shared/search-editions";

const TIMEOUT_MS = 100_000;
const FEED_LINES = 30;
export const QUICK_STEPS: SuggestionStep[] = ["publications", "topics", "people"];

export type QuickStepStatus = "waiting" | "running" | "done" | "error";
export interface QuickSetupState {
  status: "idle" | "running" | "question" | "saved" | "failed";
  /** "reading" until Pundit has read (or failed to read) the description, then "researching". */
  phase: "reading" | "researching";
  understanding: QuickSetupSummary | null;
  /** True when Pundit couldn't summarise and searched from the user's own words. */
  understandingSkipped: boolean;
  question: { text: string; options: string[] } | null;
  steps: Record<SuggestionStep, { status: QuickStepStatus; result?: SuggestionResult }>;
  feed: string[];
  saved: { setup: OnboardingData; degraded: boolean } | null;
  failure: string | null;
}

const freshSteps = (): QuickSetupState["steps"] => ({ publications: { status: "waiting" }, topics: { status: "waiting" }, people: { status: "waiting" } });
const initial = (): QuickSetupState => ({
  status: "idle", phase: "reading", understanding: null, understandingSkipped: false, question: null, steps: freshSteps(), feed: [], saved: null, failure: null,
});

function failureMessage(code: string | undefined, timedOut: boolean) {
  if (timedOut || code === "ai_timeout") return "Setting up took longer than it should.";
  if (code === "rate_limited" || code === "ai_budget") return "You've asked Pundit a lot in the last hour. Try again in a few minutes.";
  if (code === "save_failed") return "I found your sources and topics but couldn't save them just now.";
  return "Pundit stopped before finishing your setup.";
}

/** Settle on abort even if the response never finishes. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

interface Options {
  industry?: string;
  searchEdition: SearchEditionId;
  onSaved: (setup: OnboardingData, degraded: boolean) => void;
}

/**
 * One-click setup on the client: one request that reads the user's description, asks at most
 * one question, researches and saves. Progress and each step's picks arrive as they happen.
 */
export function useQuickSetup({ industry, searchEdition, onSaved }: Options) {
  const [state, setState] = useState<QuickSetupState>(initial);
  const controller = useRef<AbortController | null>(null);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const start = useCallback(async (focusDescription: string, extra: { clarification?: { question: string; answer: string }; skipQuestion?: boolean } = {}) => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; current.abort(); }, TIMEOUT_MS);
    // A second run (after the question) keeps what Pundit already understood until it re-reads.
    setState(previous => ({ ...initial(), status: "running", understanding: previous.understanding }));
    const update = (change: (previous: QuickSetupState) => Partial<QuickSetupState>) => {
      if (controller.current === current) setState(previous => ({ ...previous, ...change(previous) }));
    };
    let finished = false;
    let lastError: string | undefined;
    try {
      await untilAborted((async () => {
        const response = await apiRequest("POST", "/api/onboarding/quick-setup", {
          focusDescription: focusDescription.trim(), ...(industry ? { industry } : {}), searchEdition, ...extra,
        }, { signal: current.signal });
        await readEventStream(response, raw => {
          if (current.signal.aborted) return;
          const event = parseQuickSetupEvent(raw);
          if (!event) return;
          switch (event.type) {
            case "understanding":
              update(() => ({ understanding: event.understanding, phase: "researching" }));
              break;
            case "question":
              finished = true;
              update(() => ({ status: "question", question: event.question }));
              break;
            case "progress":
              update(previous => ({
                feed: [...previous.feed, event.message].slice(-FEED_LINES),
                ...(event.step && previous.steps[event.step].status === "waiting" ? { steps: { ...previous.steps, [event.step]: { status: "running" } } } : {}),
              }));
              break;
            case "result":
              update(previous => ({ phase: "researching", steps: { ...previous.steps, [event.step]: { status: "done", result: event.result } } }));
              break;
            case "error":
              lastError = event.code;
              if (event.step) update(previous => ({ steps: { ...previous.steps, [event.step!]: { status: "error" } } }));
              // Before any research, a failed read is not the end: Pundit searches from the user's words.
              else update(previous => previous.phase === "reading" ? { phase: "researching", understandingSkipped: true } : {});
              break;
            case "saved":
              finished = true;
              update(() => ({ status: "saved", saved: { setup: event.setup, degraded: event.degraded } }));
              if (controller.current === current) onSavedRef.current(event.setup, event.degraded);
              break;
          }
        });
      })(), current.signal);
      if (!finished) update(() => ({ status: "failed", failure: failureMessage(lastError, false) }));
    } catch (error) {
      if (current.signal.aborted && !timedOut) return;
      const code = error instanceof ApiError && error.status === 429 ? "rate_limited" : lastError;
      update(() => ({ status: "failed", failure: failureMessage(code, timedOut) }));
    } finally {
      clearTimeout(timer);
      if (controller.current === current) controller.current = null;
    }
  }, [industry, searchEdition]);

  /** Stop and go back to the question. */
  const reset = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setState(initial());
  }, []);

  useEffect(() => () => controller.current?.abort(), []);

  return { state, start, reset };
}
