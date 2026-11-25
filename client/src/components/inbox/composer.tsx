import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bookmark, BookmarkCheck, CalendarClock, ChevronDown, Maximize2, Minimize2, Minus, MoreVertical, Reply, Search, Sparkles, Square, Trash2, Undo2, X, Linkedin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { useIsSignedIn } from "@/lib/dev-auth";
import { apiRequest } from "@/lib/queryClient";
import { editorialRequest } from "@/lib/editorial-request";
import type { ReviewResponse } from "@/lib/editorial";
import { invalidatePublishingQueries } from "@/lib/publishing";
import { CREATE_TONES, type CreateTone } from "@/components/dashboard/create-post-state";
import { useAppTourReporter, type TourOutcome } from "@/components/app-tour";
import { LINKEDIN_STATUS_KEY, linkedInPostingState, type LinkedInConnectionStatus } from "@/lib/inbox-queries";
import { UNDO_SECONDS_EVENT } from "@/lib/inbox-feedback";
import { trackInbox } from "@/lib/inbox-analytics";
import {
  cancelLinkedInSchedule, approveLinkedInDraft, definitelyNotAdmitted, generationRequest, LINKEDIN_CHARACTER_LIMIT, nextMorning, postingOutcome, publishApprovedDraft, readUndoSeconds,
  saveLinkedInDraft, scheduleLabel, scheduleLinkedInDraft, storeUndoSeconds, toSavedDraft, UNDO_WINDOW_OPTIONS, type ComposeSource, type ComposeTopic, type PostingResultKind, type SavedDraft,
} from "@/lib/linkedin-compose";
import { findTopicStories, RECENT_TOPICS_KEY, saveTopicStory, storyMeta, suggestTopicAngles, writtenFromLabel } from "@/lib/topic-compose";
import { queryClient } from "@/lib/queryClient";
import { topicLabels } from "@shared/inbox-view";
import { TOPIC_LIMITS, TOPIC_SHAPE_LABELS, TOPIC_SHAPES, topicWords, type TopicAngle, type TopicBriefResponse, type TopicShape } from "@shared/topic-stories";
import { cn } from "@/lib/utils";
import type { Draft, UserProfile } from "@shared/schema";

export interface Compose {
  key: string;
  source?: ComposeSource;
  angle: string;
  take: string;
  body: string;
  tone: CreateTone;
  draft?: SavedDraft;
  saving: boolean;
  saveError?: string;
  generating: boolean;
  notice?: string;
  previousBody?: string;
  mode: "inline" | "float";
  minimized: boolean;
  maximized: boolean;
  /** One-shot request to focus the text, set only by explicit user actions. */
  focusToken?: number;
  /** Topic-first writing (no source story): what to post about, and the related stories found for it. */
  topic: string;
  brief?: TopicBriefResponse;
  /** Ticked story ids, in the brief's order. */
  picked: string[];
  searching: boolean;
  searchError?: string;
  angles?: TopicAngle[];
  anglesLoading?: boolean;
  shape: TopicShape;
  /** Stories this person chose to keep in their Shortlist. */
  savedStories: string[];
  /** What the last written post was based on, shown under the text. */
  writtenFrom?: { label: "headlines" | "opinion" | null; sources: string[] };
}
interface Pending { compose: Compose; left: number }
export type OpenableDraft = Pick<Draft, "id" | "content" | "updatedAt" | "tone">;
interface ComposerValue {
  inlineFor: (sourceId: string) => Compose | undefined;
  openForStory: (source: ComposeSource, inline: boolean) => void;
  openBlank: (angle?: string) => void;
  /** A new post about a topic, optionally with an angle: related stories are looked up straight away. */
  openTopic: (topic: string, angle?: string) => void;
  /** Continue a saved LinkedIn draft; edits stay revision-checked against it. */
  openDraft: (draft: OpenableDraft) => void;
  /** Adds text to the compose you last used if it is on screen, else starts a new one. */
  insertNote: (text: string, into: "body" | "take") => "existing" | "new";
}
const ComposerContext = createContext<ComposerValue | null>(null);
export function useComposer(): ComposerValue {
  const value = useContext(ComposerContext);
  if (!value) throw new Error("useComposer must be used within ComposerProvider");
  return value;
}
const ActionsContext = createContext<ReturnType<typeof useComposerActions> | null>(null);
const MAX_WINDOWS = 2;
const toneKeyFor = (value?: string | null): CreateTone => CREATE_TONES.find(tone => tone.value === value)?.key ?? "thoughtLeader";
const toneValue = (key: CreateTone) => CREATE_TONES.find(tone => tone.key === key)!.value;
const message = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;
const TOUR_OUTCOME: Partial<Record<PostingResultKind, TourOutcome>> = { published: "published", simulated: "simulated", failed: "attention", unknown: "attention" };
const joinText = (current: string, addition: string) => current.trim() ? `${current.replace(/\s+$/, "")}\n\n${addition}` : addition;

function useComposerActions(onConnectLinkedIn: () => void) {
  const signedIn = Boolean(useIsSignedIn());
  const { toast } = useToast();
  const reportTour = useAppTourReporter();
  const tour = useRef(reportTour);
  tour.current = reportTour;
  const lastActive = useRef<string | null>(null);
  const profile = useQuery<UserProfile>({ queryKey: ["/api/profile"], enabled: signedIn });
  const linkedIn = useQuery<LinkedInConnectionStatus>({ queryKey: LINKEDIN_STATUS_KEY, enabled: signedIn, staleTime: 30_000 });
  const ready = linkedInPostingState(linkedIn.data) === "ready";
  const requireReview = profile.data?.requirePublishReview ?? true;
  const [composes, setComposes] = useState<Compose[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [undoSeconds, setUndoSeconds] = useState(readUndoSeconds);
  // Quick settings can change the window while compose windows are open.
  useEffect(() => {
    const sync = () => setUndoSeconds(readUndoSeconds());
    window.addEventListener(UNDO_SECONDS_EVENT, sync);
    return () => window.removeEventListener(UNDO_SECONDS_EVENT, sync);
  }, []);
  const ref = useRef(composes);
  const pendingRef = useRef<{ pending: Pending; timer: ReturnType<typeof setInterval> } | null>(null);
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const saveChains = useRef(new Map<string, Promise<void>>());
  const generations = useRef(new Map<string, AbortController>());
  const searches = useRef(new Map<string, AbortController>());
  const recentTopics = useQuery<{ topics: string[] }>({ queryKey: RECENT_TOPICS_KEY, enabled: signedIn, staleTime: 60_000 });
  const topicSuggestions = useMemo(() => {
    const seen = new Set<string>();
    return [...(recentTopics.data?.topics ?? []), ...topicLabels(profile.data?.keywords)]
      .filter(topic => !seen.has(topic.toLowerCase()) && Boolean(seen.add(topic.toLowerCase()))).slice(0, 6);
  }, [recentTopics.data, profile.data?.keywords]);

  const commit = useCallback((next: Compose[]) => { ref.current = next; setComposes(next); }, []);
  const get = (key: string) => ref.current.find(compose => compose.key === key);
  const patch = useCallback((key: string, change: Partial<Compose> | ((compose: Compose) => Partial<Compose>)) => {
    commit(ref.current.map(compose => compose.key === key ? { ...compose, ...(typeof change === "function" ? change(compose) : change) } : compose));
  }, [commit]);
  const remove = useCallback((key: string) => {
    clearTimeout(saveTimers.current.get(key));
    generations.current.get(key)?.abort();
    searches.current.get(key)?.abort();
    commit(ref.current.filter(compose => compose.key !== key));
  }, [commit]);

  const create = (fields: Partial<Compose> & Pick<Compose, "mode">): Compose => ({
    key: crypto.randomUUID(), angle: "", take: "", body: "", tone: toneKeyFor(profile.data?.defaultTone), saving: false, generating: false, minimized: false, maximized: false,
    topic: "", picked: [], searching: false, shape: "post", savedStories: [], ...fields,
  });
  const addWindow = (compose: Compose) => {
    const floats = ref.current.filter(item => item.mode === "float" && !item.minimized);
    const minimize = floats.length >= MAX_WINDOWS ? floats[0].key : null;
    commit([...ref.current.map(item => item.key === minimize ? { ...item, minimized: true } : item), compose]);
  };

  /** Serialized per compose so a slow save never overwrites a newer one. */
  const saveNow = useCallback(async (key: string): Promise<SavedDraft | undefined> => {
    clearTimeout(saveTimers.current.get(key));
    const run = async () => {
      const compose = get(key);
      if (!compose?.body.trim() || compose.draft?.content === compose.body) return;
      patch(key, { saving: true, saveError: undefined });
      try {
        const draft = await saveLinkedInDraft(compose.draft, compose.body, toneValue(compose.tone), compose.source?.id);
        patch(key, { draft, saving: false });
        tour.current?.("draft-saved", draft.id);
        if (!compose.draft) trackInbox("draft_saved", { from: compose.source ? "story" : "idea_or_blank" });
        void invalidatePublishingQueries();
      } catch (error) {
        const conflict = error instanceof Error && /409|changed|revision/i.test(error.message);
        patch(key, { saving: false, saveError: conflict ? "This draft changed elsewhere. Reopen it from Drafts to keep both versions." : message(error, "Couldn't save. Your text is kept here.") });
        throw error;
      }
    };
    const chain = (saveChains.current.get(key) ?? Promise.resolve()).then(run, run);
    saveChains.current.set(key, chain.catch(() => undefined));
    await chain;
    return get(key)?.draft;
  }, [patch]);
  const scheduleSave = useCallback((key: string) => {
    clearTimeout(saveTimers.current.get(key));
    saveTimers.current.set(key, setTimeout(() => { void saveNow(key).catch(() => undefined); }, 1200));
  }, [saveNow]);

  /** Angle ideas for the stories found; a failure just leaves them out. */
  const loadAngles = async (key: string, briefId: string, signal: AbortSignal) => {
    patch(key, { anglesLoading: true });
    try {
      const angles = await suggestTopicAngles(briefId, signal);
      if (get(key)?.brief?.briefId === briefId) patch(key, { angles, anglesLoading: false });
    } catch {
      if (get(key)?.brief?.briefId === briefId) patch(key, { anglesLoading: false });
    }
  };

  /** Related stories for the topic; the best three are ticked. Returns whether the brief is current. */
  const searchTopic = async (key: string, topicOverride?: string): Promise<boolean> => {
    const compose = get(key);
    if (!compose || compose.source) return false;
    const topic = (topicOverride ?? compose.topic).trim();
    if (topic.length < TOPIC_LIMITS.minChars || !topicWords(topic).length) { patch(key, { searchError: "Describe the topic in a few words." }); return false; }
    searches.current.get(key)?.abort();
    const controller = new AbortController();
    searches.current.set(key, controller);
    patch(key, { topic, searching: true, searchError: undefined, angles: undefined, anglesLoading: false });
    try {
      const brief = await findTopicStories(topic, controller.signal);
      if (controller.signal.aborted || get(key)?.topic.trim() !== topic) return false;
      patch(key, { brief, picked: brief.stories.slice(0, TOPIC_LIMITS.ticked).map(story => story.id), searching: false });
      trackInbox("topic_searched", { stories: brief.stories.length });
      if (brief.stories.length) void loadAngles(key, brief.briefId, controller.signal);
      return true;
    } catch (error) {
      if (!controller.signal.aborted && get(key)) patch(key, { searching: false, searchError: message(error, "Couldn't look for related stories. Try again.") });
      return false;
    } finally {
      if (searches.current.get(key) === controller) searches.current.delete(key);
    }
  };

  const togglePick = (key: string, storyId: string) => {
    const compose = get(key);
    if (!compose?.brief) return;
    const picked = new Set(compose.picked);
    if (picked.has(storyId)) picked.delete(storyId); else picked.add(storyId);
    patch(key, { picked: compose.brief.stories.map(story => story.id).filter(id => picked.has(id)) });
  };
  /** An angle idea fills the Angle line and ticks the stories behind it. */
  const chooseAngle = (key: string, angle: TopicAngle) => {
    const compose = get(key);
    if (!compose?.brief) return;
    const behind = new Set(angle.storyIds);
    const picked = compose.brief.stories.map(story => story.id).filter(id => behind.has(id));
    patch(key, { angle: angle.title.slice(0, 200), ...(picked.length ? { picked } : {}) });
  };
  const saveStory = async (key: string, storyId: string) => {
    const story = get(key)?.brief?.stories.find(item => item.id === storyId);
    if (!story) return;
    try {
      await saveTopicStory(story);
      patch(key, current => ({ savedStories: [...new Set([...current.savedStories, storyId])] }));
      trackInbox("topic_story_saved");
      toast({ title: "Saved to Shortlist", description: "Find it in Shortlist any time." });
    } catch (error) { toast({ title: "Couldn't save the story", description: message(error, "Try again."), variant: "destructive" }); }
  };

  /** The topic part of a request: the current brief and ticked stories, once the search matches the topic. */
  const topicFor = (compose: Compose): ComposeTopic | undefined => {
    const brief = compose.brief;
    if (compose.source || !brief || brief.topic !== compose.topic.trim()) return undefined;
    return { topic: brief.topic, briefId: brief.briefId, storyIds: compose.picked, storiesFound: brief.stories.length };
  };

  const update = (key: string, change: Partial<Pick<Compose, "angle" | "take" | "body" | "tone" | "topic" | "shape">>) => {
    patch(key, change);
    if (change.body !== undefined || change.tone !== undefined) scheduleSave(key);
  };

  const generate = async (key: string) => {
    let compose = get(key);
    if (!compose || compose.generating) return;
    // A typed topic that hasn't been searched yet is searched first; the best stories are then used.
    if (!compose.source && compose.topic.trim() && !topicFor(compose)) {
      if (!await searchTopic(key)) return;
      compose = get(key);
      if (!compose) return;
    }
    const topic = topicFor(compose);
    const request = generationRequest({ source: compose.source, topic, angle: compose.angle, take: compose.take, toneKey: compose.tone, shape: compose.shape });
    if ("error" in request) { patch(key, { notice: request.error }); return; }
    const controller = new AbortController();
    generations.current.set(key, controller);
    patch(key, { generating: true, notice: undefined });
    try {
      const data = await editorialRequest<ReviewResponse>(request.endpoint, request.body, { signal: controller.signal });
      const text = (data.posts?.linkedin as Record<string, unknown> | undefined)?.[compose.tone];
      if (typeof text !== "string" || !text.trim()) throw new Error("No LinkedIn post was returned. Try again.");
      const label = writtenFromLabel((data as { evidence?: { warnings?: Array<{ code: string }> } }).evidence?.warnings);
      const sources = topic ? (compose.brief?.stories ?? []).filter(story => topic.storyIds.includes(story.id)).map(story => story.source) : [];
      patch(key, current => ({ previousBody: current.body.trim() ? current.body : undefined, body: text,
        writtenFrom: topic || label ? { label, sources: [...new Set(sources)] } : undefined,
        notice: label === "opinion" ? "Opinion post written from your view. It makes no factual claims." : "Draft written. Check every claim against the source before posting." }));
      scheduleSave(key);
      if (topic) {
        trackInbox("topic_written", { stories: topic.storyIds.length, opinion: !topic.storyIds.length, shape: compose.shape });
        void queryClient.invalidateQueries({ queryKey: RECENT_TOPICS_KEY });
      }
    } catch (error) {
      if (get(key)) patch(key, { notice: controller.signal.aborted ? "Stopped. Nothing was replaced." : message(error, "Couldn't write a draft. Try again.") });
    } finally {
      generations.current.delete(key);
      if (get(key)) patch(key, { generating: false });
    }
  };

  const send = useCallback(async (compose: Compose) => {
    // Restored composes float: an inline pane may not be on screen, and transient flags are stale.
    const reopen = () => commit([...ref.current, { ...compose, mode: "float", minimized: false, maximized: false, generating: false, saving: false, focusToken: Date.now() }]);
    let approved: SavedDraft;
    try { approved = await approveLinkedInDraft(compose.draft!, requireReview); }
    catch (error) {
      toast({ title: "Not posted", description: `${message(error, "Approval failed.")} Your draft is open again.`, variant: "destructive" });
      reopen(); void invalidatePublishingQueries(); return;
    }
    try {
      const outcome = postingOutcome(await publishApprovedDraft(approved));
      toast({ title: outcome.title, description: outcome.description, variant: outcome.tone === "error" ? "destructive" : undefined });
      trackInbox("post_result", { outcome: outcome.kind });
      const tourOutcome = TOUR_OUTCOME[outcome.kind];
      if (tourOutcome) tour.current?.("publishing-result", approved.id, tourOutcome);
    } catch (error) {
      if (definitelyNotAdmitted(error)) {
        toast({ title: "Not posted", description: `${message(error, "LinkedIn posting was refused.")} Your draft is open again.`, variant: "destructive" });
        reopen();
      } else {
        // Admission may have committed; the scheduler could still deliver it. Never invite a second post.
        toast({ title: "Delivery not confirmed", description: "Check Posted before trying again so the post is not duplicated.", variant: "destructive" });
        tour.current?.("publishing-result", approved.id, "attention");
      }
    } finally { void invalidatePublishingQueries(); }
  }, [commit, requireReview, toast]);
  const finishPending = useCallback((post: boolean) => {
    const current = pendingRef.current;
    if (!current) return;
    clearInterval(current.timer);
    pendingRef.current = null;
    setPending(null);
    if (post) void send(current.pending.compose);
    else {
      commit([...ref.current, { ...current.pending.compose, mode: "float", minimized: false, maximized: false, generating: false, saving: false, focusToken: Date.now() }]);
      toast({ title: "Posting cancelled", description: "Nothing was sent. Your draft is open again." });
      trackInbox("post_undone");
    }
  }, [commit, send, toast]);
  const finishRef = useRef(finishPending);
  finishRef.current = finishPending;
  useEffect(() => () => { if (pendingRef.current) clearInterval(pendingRef.current.timer); }, []);

  const readyToSend = (key: string): Compose | undefined => {
    const compose = get(key);
    if (!compose) return undefined;
    if (!ready) {
      patch(key, { notice: compose.body.trim() ? "Connect LinkedIn to post. Your draft is saved." : "Connect LinkedIn to post." });
      if (compose.body.trim()) void saveNow(key).catch(() => undefined);
      onConnectLinkedIn();
      return undefined;
    }
    if (compose.generating) { patch(key, { notice: "Wait for Help me write to finish, or stop it first." }); return undefined; }
    if (!compose.body.trim()) { patch(key, { notice: "Write something before posting." }); return undefined; }
    if (compose.body.length > LINKEDIN_CHARACTER_LIMIT) { patch(key, { notice: `Shorten the post to ${LINKEDIN_CHARACTER_LIMIT.toLocaleString()} characters.` }); return undefined; }
    return compose;
  };

  /** One click: save the visible text, then hold it client-side for the undo window. Nothing is sent before it ends. */
  const reserving = useRef(false);
  const post = async (key: string) => {
    if (!readyToSend(key)) return;
    // Reserved synchronously: two Post clicks during a save must never both become pending.
    if (pendingRef.current || reserving.current) { patch(key, { notice: "Another post is waiting to send. Undo it or wait a moment." }); return; }
    reserving.current = true;
    try {
      let draft: SavedDraft | undefined;
      try { draft = await saveNow(key); } catch { return; }
      const compose = get(key);
      if (!compose || !draft || draft.content !== compose.body) { if (compose) patch(key, { notice: "Your latest edit is still saving. Try again in a moment." }); return; }
      remove(key);
      const entry: Pending = { compose: { ...compose, draft }, left: undoSeconds };
      const timer: ReturnType<typeof setInterval> = setInterval(() => {
        const current = pendingRef.current;
        if (!current || current.timer !== timer) { clearInterval(timer); return; }
        const left = current.pending.left - 1;
        if (left <= 0) { finishRef.current(true); return; }
        current.pending = { ...current.pending, left };
        setPending(current.pending);
      }, 1000);
      pendingRef.current = { pending: entry, timer };
      setPending(entry);
      trackInbox("post_queued", { undo_seconds: undoSeconds });
    } finally { reserving.current = false; }
  };

  const schedule = async (key: string, at: Date) => {
    if (!readyToSend(key)) return;
    if (at.getTime() <= Date.now() + 60_000) { patch(key, { notice: "Choose a time at least a minute from now." }); return; }
    let draft: SavedDraft | undefined;
    try { draft = await saveNow(key); } catch { return; }
    if (!draft) return;
    try {
      await scheduleLinkedInDraft(draft, at, requireReview);
      remove(key);
      const id = draft.id;
      tour.current?.("publishing-result", id, "scheduled");
      trackInbox("post_scheduled");
      toast({ title: `Scheduled for ${scheduleLabel(at)}`, description: "Nothing posts before then. Change it in Scheduled.",
        action: <ToastAction altText="Undo schedule" onClick={() => { void cancelLinkedInSchedule(id).then(() => {
          toast({ title: "Schedule cancelled", description: "The post is back in Drafts." }); void invalidatePublishingQueries();
        }, error => toast({ title: "Couldn't cancel", description: message(error, "Check Scheduled."), variant: "destructive" })); }}>Undo</ToastAction> });
    } catch (error) { patch(key, { notice: message(error, "Couldn't schedule. Your draft is kept.") }); }
    finally { void invalidatePublishingQueries(); }
  };

  const close = async (key: string) => {
    const compose = get(key);
    if (!compose) return;
    try { await saveNow(key); } catch { return; }
    remove(key);
    if (compose.body.trim()) toast({ title: "Draft saved", description: "Find it in Drafts." });
  };
  const discard = async (key: string) => {
    if (!get(key)) return;
    // Let an in-flight autosave finish first, so the draft it creates is the one deleted.
    clearTimeout(saveTimers.current.get(key));
    await (saveChains.current.get(key) ?? Promise.resolve());
    const id = get(key)?.draft?.id;
    remove(key);
    if (id) {
      try { await apiRequest("DELETE", `/api/drafts/${encodeURIComponent(id)}`); void invalidatePublishingQueries(); }
      catch (error) { toast({ title: "Couldn't delete the saved draft", description: message(error, "It remains in Drafts."), variant: "destructive" }); return; }
    }
    toast({ title: "Draft discarded" });
  };

  const opened = (from: "story" | "blank" | "draft" | "note" | "topic") => { tour.current?.("create-opened"); trackInbox("compose_opened", { from }); };
  const onScreen = (compose: Compose) => {
    if (compose.minimized) return false;
    if (compose.mode === "float") return true;
    // An inline compose stays mounted under a hidden reading pane (list view on narrow screens).
    const element = document.querySelector<HTMLElement>(`[data-compose-key="${CSS.escape(compose.key)}"]`);
    if (!element) return false;
    return typeof element.checkVisibility === "function" ? element.checkVisibility() : element.getClientRects().length > 0;
  };
  const value: ComposerValue = {
    inlineFor: sourceId => composes.find(compose => compose.mode === "inline" && compose.source?.id === sourceId),
    openForStory: (source, inline) => {
      opened("story");
      const existing = ref.current.find(compose => compose.source?.id === source.id);
      if (existing) { patch(existing.key, { mode: inline ? "inline" : "float", minimized: false, focusToken: Date.now() }); return; }
      const compose = create({ source, mode: inline ? "inline" : "float", focusToken: Date.now() });
      if (inline) commit([...ref.current, compose]); else addWindow(compose);
    },
    openBlank: angle => {
      opened("blank");
      const blank = ref.current.find(compose => compose.mode === "float" && !compose.source && !compose.body.trim() && !compose.take.trim());
      if (blank) { patch(blank.key, { minimized: false, focusToken: Date.now(), ...(angle ? { angle } : {}) }); return; }
      addWindow(create({ mode: "float", angle: angle ?? "", focusToken: Date.now() }));
    },
    openTopic: (topic, angle) => {
      opened("topic");
      const compose = create({ mode: "float", topic: topic.slice(0, TOPIC_LIMITS.maxChars), angle: angle?.slice(0, 200) ?? "", focusToken: Date.now() });
      addWindow(compose);
      void searchTopic(compose.key);
    },
    openDraft: draft => {
      if (pendingRef.current?.pending.compose.draft?.id === draft.id) {
        toast({ title: "This post is about to send", description: "Undo it first if you want to edit it." });
        return;
      }
      opened("draft");
      const existing = ref.current.find(compose => compose.draft?.id === draft.id);
      if (existing) { patch(existing.key, { mode: "float", minimized: false, focusToken: Date.now() }); return; }
      addWindow(create({ mode: "float", body: draft.content, draft: toSavedDraft(draft), tone: toneKeyFor(draft.tone), focusToken: Date.now() }));
    },
    insertNote: (text, into) => {
      const last = ref.current.find(compose => compose.key === lastActive.current);
      const target = last && onScreen(last) ? last : [...ref.current].reverse().find(compose => compose.mode === "float" && !compose.minimized);
      if (!target) {
        opened("note");
        const compose = create({ mode: "float", focusToken: Date.now(), ...(into === "take" ? { take: text.slice(0, 2000) } : { body: text }) });
        addWindow(compose);
        if (into === "body") scheduleSave(compose.key);
        return "new";
      }
      if (into === "take") update(target.key, { take: joinText(target.take, text).slice(0, 2000) });
      else update(target.key, { body: joinText(target.body, text) });
      patch(target.key, { focusToken: Date.now() });
      return "existing";
    },
  };
  return { value, composes, pending, undoSeconds, ready, update, generate, post, schedule, close, discard, patch, finishPending,
    searchTopic, togglePick, chooseAngle, saveStory, topicSuggestions,
    touch: (key: string) => { lastActive.current = key; },
    setUndoSeconds: (seconds: number) => { storeUndoSeconds(seconds); setUndoSeconds(seconds); },
    stop: (key: string) => generations.current.get(key)?.abort() };
}

/** Gmail-style compose windows and inline replies, with one-click LinkedIn posting behind an undo window. */
export function ComposerProvider({ children, onConnectLinkedIn, sidePanelOpen = false }: Readonly<{ children: ReactNode; onConnectLinkedIn: () => void; sidePanelOpen?: boolean }>) {
  const actions = useComposerActions(onConnectLinkedIn);
  const floats = actions.composes.filter(compose => compose.mode === "float");
  const maximized = floats.find(compose => compose.maximized && !compose.minimized);
  return (
    <ComposerContext.Provider value={actions.value}>
      <ActionsContext.Provider value={actions}>
        {children}
        {/* Like Gmail, compose windows sit left of an open side panel (rail 3.5rem + panel 20.5rem). */}
        {floats.length > 0 && <div className={cn("pointer-events-none fixed bottom-0 right-4 z-40 flex items-end gap-3 max-lg:left-0 max-lg:right-0", sidePanelOpen ? "md:right-[25rem]" : "md:right-[4.5rem]")} aria-label="Compose windows">
          {floats.map(compose => <ComposeCard key={compose.key} compose={compose} />)}
        </div>}
        {maximized && <div className="fixed inset-0 z-30 bg-foreground/30" aria-hidden="true" onClick={() => actions.patch(maximized.key, { maximized: false })} />}
        {actions.pending && <div role="status" aria-live="polite" className="fixed bottom-5 left-5 z-50 flex items-center gap-2 rounded-md bg-foreground py-2 pl-4 pr-2 text-sm text-background shadow-lg" data-testid="pending-post">
          <span>Posting to LinkedIn in {actions.pending.left}s…</span>
          <Button size="sm" variant="ghost" className="text-background hover:bg-background/15 hover:text-background" onClick={() => actions.finishPending(false)}>Undo</Button>
          <Button size="sm" variant="ghost" className="text-background hover:bg-background/15 hover:text-background" onClick={() => actions.finishPending(true)}>Post now</Button>
        </div>}
      </ActionsContext.Provider>
    </ComposerContext.Provider>
  );
}

export function InlineCompose({ compose }: Readonly<{ compose: Compose }>) {
  return <ComposeCard compose={compose} />;
}

function ComposeCard({ compose }: Readonly<{ compose: Compose }>) {
  const actions = useContext(ActionsContext)!;
  const [picking, setPicking] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const float = compose.mode === "float";
  const over = compose.body.length > LINKEDIN_CHARACTER_LIMIT;
  const empty = !compose.body.trim();
  const tone = CREATE_TONES.find(item => item.key === compose.tone)!;
  const title = compose.angle.trim() || compose.source?.headline || compose.topic.trim() || (compose.draft ? "LinkedIn draft" : "New LinkedIn post");
  const topicMode = !compose.source && !(compose.draft && !compose.topic.trim());
  const stories = compose.brief?.topic === compose.topic.trim() ? compose.brief.stories : undefined;
  // Pausing while typing a topic looks up related stories (searches are rate limited, so only on change).
  useEffect(() => {
    const topic = compose.topic.trim();
    if (!topicMode || compose.searching || compose.brief?.topic === topic || topic.length < TOPIC_LIMITS.minChars || !topicWords(topic).length) return;
    const timer = setTimeout(() => void actions.searchTopic(compose.key), 1500);
    return () => clearTimeout(timer);
  }, [compose.topic, topicMode]);
  const tomorrow = useMemo(() => nextMorning(new Date()), [picking]);
  const weekday = useMemo(() => nextMorning(new Date(), true), [picking]);
  useEffect(() => {
    if (!compose.focusToken || compose.minimized) return;
    bodyRef.current?.focus();
    actions.patch(compose.key, { focusToken: undefined });
  }, [compose.focusToken, compose.minimized]);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    // Portaled menus and dialogs bubble here through React; they handle their own keys.
    if (event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void actions.post(compose.key); }
    else if (event.key === "Escape" && float) { event.preventDefault(); actions.patch(compose.key, { minimized: true, maximized: false }); }
  };

  return (
    <section role={float ? "dialog" : "region"} aria-label={float ? `Compose: ${title}` : "Draft my take"} onKeyDown={onKeyDown} data-testid={`compose-${compose.mode}`}
      data-compose-key={compose.key} onFocusCapture={() => actions.touch(compose.key)}
      className={cn("pointer-events-auto flex min-w-0 flex-col overflow-hidden border bg-card shadow-lg",
        float ? "rounded-t-md" : "mt-5 rounded-md shadow-sm",
        float && (compose.minimized ? "w-72" : compose.maximized ? "fixed inset-x-[8vw] bottom-[6vh] top-[6vh] z-40 rounded-md" : "h-[min(36rem,85vh)] w-[32rem] max-lg:h-[85vh] max-lg:w-full"))}>
      <header className={cn("flex h-10 shrink-0 items-center gap-1 pl-3 pr-1 text-sm font-semibold", float ? "bg-foreground text-background" : "border-b")}>
        {float
          ? <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => actions.patch(compose.key, { minimized: !compose.minimized, ...(compose.minimized ? { focusToken: Date.now() } : {}) })}>{title}</button>
          : <span className="flex min-w-0 flex-1 items-center gap-2"><Reply className="h-4 w-4 shrink-0" aria-hidden="true" />Draft my take</span>}
        {float ? <>
          <HeaderButton label={compose.minimized ? "Restore" : "Minimize"} onClick={() => actions.patch(compose.key, { minimized: !compose.minimized, maximized: false, ...(compose.minimized ? { focusToken: Date.now() } : {}) })}><Minus className="h-4 w-4" aria-hidden="true" /></HeaderButton>
          {!compose.minimized && <HeaderButton label={compose.maximized ? "Exit full screen" : "Full screen"} onClick={() => actions.patch(compose.key, { maximized: !compose.maximized })}>
            {compose.maximized ? <Minimize2 className="h-4 w-4" aria-hidden="true" /> : <Maximize2 className="h-4 w-4" aria-hidden="true" />}</HeaderButton>}
        </> : <HeaderButton label="Pop out" onClick={() => actions.patch(compose.key, { mode: "float", minimized: false })}><Maximize2 className="h-4 w-4" aria-hidden="true" /></HeaderButton>}
        <HeaderButton label="Save and close" onClick={() => void actions.close(compose.key)}><X className="h-4 w-4" aria-hidden="true" /></HeaderButton>
      </header>
      {!compose.minimized && <>
        <div className="flex min-h-9 items-center gap-2 border-b px-3 text-xs">
          <span className="w-16 shrink-0 text-muted-foreground">Post as</span>
          <Linkedin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="font-medium">{actions.ready ? "Your LinkedIn profile" : "LinkedIn not connected"}</span>
        </div>
        {topicMode ? <TopicPanel compose={compose} stories={stories} /> : <div className="flex min-h-9 items-center gap-2 border-b px-3 text-xs">
          <span className="w-16 shrink-0 text-muted-foreground">Based on</span>
          <span className="min-w-0 truncate rounded bg-muted px-2 py-0.5">{compose.source ? compose.source.headline : "Your own idea"}</span>
        </div>}
        <label className="flex min-h-9 items-center gap-2 border-b px-3 text-xs">
          <span className="w-16 shrink-0 text-muted-foreground">Angle</span>
          <input value={compose.angle} onChange={event => actions.update(compose.key, { angle: event.target.value })} maxLength={200}
            placeholder="What is the point of this post?" className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none" />
        </label>
        <textarea ref={bodyRef} value={compose.body} onChange={event => actions.update(compose.key, { body: event.target.value })} aria-label="Post text"
          placeholder="Write your post, or use Help me write below." className={cn("min-h-0 w-full flex-1 resize-none bg-transparent px-3 py-2 text-sm leading-relaxed outline-none", !float && "min-h-[10rem]")} data-testid="compose-body" />
        {compose.writtenFrom && compose.body.trim() && <p className="mx-3 mb-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground" data-testid="compose-written-from">
          {compose.writtenFrom.label === "headlines" && <span className="rounded-full bg-amber-500/10 px-2 py-0.5 font-medium text-amber-800 dark:text-amber-300" title="The full articles couldn't be read; check the originals before posting.">Written from headlines</span>}
          {compose.writtenFrom.label === "opinion" && <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-foreground" title="No related stories were found; the post states your view and makes no factual claims.">Opinion, no sources</span>}
          {compose.writtenFrom.sources.length > 0 && <span>Sources: {compose.writtenFrom.sources.join(", ")}</span>}
        </p>}
        <div className="mx-3 mb-2 flex flex-wrap items-center gap-1.5 rounded-md border bg-muted/40 p-1.5">
          <Sparkles className="ml-1 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <input value={compose.take} onChange={event => actions.update(compose.key, { take: event.target.value })} maxLength={2000} aria-label="Your take"
            placeholder={compose.source ? "Your take (optional)" : !topicMode ? "Describe your idea" : stories && !stories.length ? "Your view on it (needed)" : "Your view (optional)"}
            className="h-8 min-w-[8rem] flex-1 rounded border bg-card px-2 text-xs outline-none focus:border-input" />
          {topicMode && stories && stories.length > 0 && <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="outline" size="sm" className="h-8 gap-1 text-xs" aria-label={`Post shape: ${TOPIC_SHAPE_LABELS[compose.shape]}`}>{TOPIC_SHAPE_LABELS[compose.shape]}<ChevronDown className="h-3 w-3" aria-hidden="true" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end"><DropdownMenuLabel>Shape</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={compose.shape} onValueChange={value => actions.update(compose.key, { shape: value as TopicShape })}>
                {TOPIC_SHAPES.map(shape => <DropdownMenuRadioItem key={shape} value={shape}>{TOPIC_SHAPE_LABELS[shape]}</DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>}
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="outline" size="sm" className="h-8 gap-1 text-xs">{tone.label}<ChevronDown className="h-3 w-3" aria-hidden="true" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end"><DropdownMenuLabel>Tone</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={compose.tone} onValueChange={value => actions.update(compose.key, { tone: value as CreateTone })}>
                {CREATE_TONES.map(item => <DropdownMenuRadioItem key={item.key} value={item.key}>{item.label}</DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          {compose.generating
            ? <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => actions.stop(compose.key)}><Square className="mr-1 h-3 w-3" aria-hidden="true" />Stop</Button>
            : <Button size="sm" className="h-8 text-xs" onClick={() => void actions.generate(compose.key)} data-testid="button-help-me-write">Help me write</Button>}
          {compose.previousBody !== undefined && !compose.generating && <Button size="sm" variant="ghost" className="h-8 px-2 text-xs" aria-label="Restore previous text"
            onClick={() => { actions.update(compose.key, { body: compose.previousBody! }); actions.patch(compose.key, { previousBody: undefined, notice: "Previous text restored." }); }}><Undo2 className="h-3.5 w-3.5" aria-hidden="true" /></Button>}
        </div>
        {(compose.notice || compose.saveError) && <p role="status" className={cn("mx-3 mb-2 text-xs", compose.saveError ? "text-destructive" : "text-muted-foreground")}>{compose.saveError ?? compose.notice}</p>}
        <footer className="flex shrink-0 items-center gap-1 border-t px-2 py-2">
          <span className="inline-flex overflow-hidden rounded-md">
            <Button className="rounded-r-none px-5" disabled={(empty || over) && actions.ready} onClick={() => void actions.post(compose.key)} data-testid="button-compose-post">
              {actions.ready ? "Post" : "Connect LinkedIn"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button className="rounded-l-none border-l border-primary-foreground/30 px-2" disabled={empty || over || !actions.ready} aria-label="Schedule options"><ChevronDown className="h-4 w-4" aria-hidden="true" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top">
                <DropdownMenuLabel>Schedule post</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => void actions.schedule(compose.key, tomorrow)}>Tomorrow morning<span className="ml-auto pl-4 text-xs text-muted-foreground">{scheduleLabel(tomorrow)}</span></DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void actions.schedule(compose.key, weekday)}>Next weekday morning<span className="ml-auto pl-4 text-xs text-muted-foreground">{scheduleLabel(weekday)}</span></DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setPicking(true)}><CalendarClock className="mr-2 h-4 w-4" aria-hidden="true" />Pick date & time…</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
          {actions.ready && <span className="ml-1 hidden text-[11px] text-muted-foreground sm:inline">Undo for {actions.undoSeconds}s</span>}
          <span className="ml-auto" />
          <span className="text-[11px] text-muted-foreground" aria-live="polite">{compose.saving ? "Saving…" : compose.draft && compose.draft.content === compose.body ? "Saved" : ""}</span>
          <span className={cn("px-1 text-[11px] tabular-nums", over ? "font-semibold text-destructive" : "text-muted-foreground")}>{compose.body.length.toLocaleString()}/{LINKEDIN_CHARACTER_LIMIT.toLocaleString()}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8" aria-label="More options"><MoreVertical className="h-4 w-4" aria-hidden="true" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top">
              <DropdownMenuLabel>Undo window</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={String(actions.undoSeconds)} onValueChange={value => actions.setUndoSeconds(Number(value))}>
                {UNDO_WINDOW_OPTIONS.map(seconds => <DropdownMenuRadioItem key={seconds} value={String(seconds)}>{seconds} seconds</DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Discard draft" onClick={() => void actions.discard(compose.key)}><Trash2 className="h-4 w-4" aria-hidden="true" /></Button>
        </footer>
      </>}
      <SchedulePicker open={picking} onOpenChange={setPicking} onSchedule={at => { setPicking(false); void actions.schedule(compose.key, at); }} />
    </section>
  );
}

/** Topic-first writing: the topic, suggestions, and the related stories to write from. */
function TopicPanel({ compose, stories }: Readonly<{ compose: Compose; stories?: TopicBriefResponse["stories"] }>) {
  const actions = useContext(ActionsContext)!;
  const [collapsed, setCollapsed] = useState(false);
  const written = Boolean(compose.writtenFrom && compose.body.trim());
  const picked = new Set(compose.picked);
  const showStories = stories && !(written && collapsed);
  return (
    <div className="border-b px-3 pb-1.5 text-xs" data-testid="compose-topic">
      <div className="flex min-h-9 items-center gap-2">
        <span className="w-16 shrink-0 text-muted-foreground">Topic</span>
        <input value={compose.topic} maxLength={TOPIC_LIMITS.maxChars} aria-label="Topic" placeholder="What do you want to post about?"
          onChange={event => actions.update(compose.key, { topic: event.target.value })}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void actions.searchTopic(compose.key); } }}
          className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none" />
        <Button type="button" size="sm" variant="ghost" className="h-8 px-2" aria-label="Find related stories" disabled={compose.searching || compose.topic.trim().length < TOPIC_LIMITS.minChars}
          onClick={() => void actions.searchTopic(compose.key)}><Search className="h-3.5 w-3.5" aria-hidden="true" /></Button>
      </div>
      {!stories && !compose.searching && actions.topicSuggestions.length > 0 && <div className="flex flex-wrap gap-1 pb-1 pl-[4.5rem]" role="group" aria-label="Topic suggestions">
        {actions.topicSuggestions.map(topic => <button key={topic} type="button" className="rounded-full border px-2 py-0.5 hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => { actions.update(compose.key, { topic }); void actions.searchTopic(compose.key, topic); }}>{topic}</button>)}
      </div>}
      {compose.searching && <p role="status" className="pb-1 pl-[4.5rem] text-muted-foreground">Looking for related stories…</p>}
      {compose.searchError && !compose.searching && <p role="alert" className="pb-1 pl-[4.5rem] text-destructive">{compose.searchError}</p>}
      {stories && written && <button type="button" className="pb-1 pl-[4.5rem] text-primary underline-offset-2 hover:underline" onClick={() => setCollapsed(!collapsed)}>
        {collapsed ? `Based on ${compose.picked.length || "no"} stor${compose.picked.length === 1 ? "y" : "ies"} · Change` : "Hide stories"}</button>}
      {showStories && (stories.length === 0
        ? <p role="status" className="pb-1 pl-[4.5rem] text-muted-foreground">No recent stories on this topic. Add your view below and Pundit writes an opinion post that makes no factual claims.</p>
        : <section aria-label="Related stories" className="pl-[4.5rem]">
          <p className="flex items-center justify-between pb-0.5 text-muted-foreground"><span>Related stories{compose.brief?.searchedFor ? ` for “${compose.brief.searchedFor}”` : ""}</span><span>{compose.picked.length} of {stories.length} ticked</span></p>
          <ul className="max-h-40 space-y-1 overflow-y-auto pr-1">
            {stories.map(story => {
              const saved = compose.savedStories.includes(story.id);
              return <li key={story.id} className="flex items-start gap-2 rounded px-1 py-0.5 hover:bg-muted/50">
                <input type="checkbox" className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary" checked={picked.has(story.id)} aria-label={`Use story: ${story.title}`}
                  onChange={() => actions.togglePick(compose.key, story.id)} />
                <div className="min-w-0 flex-1">
                  <a href={story.url} target="_blank" rel="noopener noreferrer" className="line-clamp-2 font-medium text-foreground hover:underline">{story.title}</a>
                  <p className="text-[11px] text-muted-foreground">{storyMeta(story)}{story.fullText ? " · Full text" : ""}{story.origin === "discover" ? " · In your Discover" : ""}</p>
                </div>
                <button type="button" className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-60" disabled={saved}
                  aria-label={saved ? `Saved to Shortlist: ${story.title}` : `Save to Shortlist: ${story.title}`} title={saved ? "In your Shortlist" : "Save to Shortlist"}
                  onClick={() => void actions.saveStory(compose.key, story.id)}>{saved ? <BookmarkCheck className="h-3.5 w-3.5" aria-hidden="true" /> : <Bookmark className="h-3.5 w-3.5" aria-hidden="true" />}</button>
              </li>;
            })}
          </ul>
          {(compose.anglesLoading || (compose.angles?.length ?? 0) > 0) && <div className="flex flex-wrap items-center gap-1 pt-1" role="group" aria-label="Angle ideas">
            <span className="text-muted-foreground">Angles:</span>
            {compose.anglesLoading && <span className="text-muted-foreground" role="status">thinking…</span>}
            {compose.angles?.map(angle => <button key={angle.title} type="button" title={angle.why}
              className={cn("rounded-full border px-2 py-0.5 text-left hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring", compose.angle === angle.title && "border-primary bg-primary/10")}
              onClick={() => actions.chooseAngle(compose.key, angle)}>{angle.title}</button>)}
          </div>}
        </section>)}
    </div>
  );
}

function HeaderButton({ label, onClick, children }: Readonly<{ label: string; onClick: () => void; children: ReactNode }>) {
  return <button type="button" aria-label={label} title={label} onClick={onClick} className="flex h-8 w-8 items-center justify-center rounded hover:bg-muted/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">{children}</button>;
}

function SchedulePicker({ open, onOpenChange, onSchedule }: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; onSchedule: (at: Date) => void }>) {
  const local = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const [value, setValue] = useState(() => local(nextMorning(new Date())));
  const at = new Date(value);
  const valid = Number.isFinite(at.getTime()) && at.getTime() > Date.now() + 60_000;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Pick date & time</DialogTitle><DialogDescription>In your browser’s time zone ({Intl.DateTimeFormat().resolvedOptions().timeZone}).</DialogDescription></DialogHeader>
        <label className="block text-sm font-medium">When
          <input type="datetime-local" value={value} min={local(new Date())} onChange={event => setValue(event.target.value)} className="mt-1 block h-10 w-full rounded-md border px-3" />
        </label>
        {!valid && <p className="text-xs text-destructive">Choose a time at least a minute from now.</p>}
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={!valid} onClick={() => onSchedule(at)}>Schedule post</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
