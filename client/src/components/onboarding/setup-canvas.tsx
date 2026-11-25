import type { ReactNode } from "react";
import { Hash, Newspaper, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { cn } from "@/lib/utils";
import type { PreviewHeadline } from "@/lib/onboarding-suggestions";
import { DiscoverPreview, type DiscoverPreviewState } from "@/components/onboarding/discover-preview";

interface SetupCanvasProps {
  className?: string;
  view: "empty" | "setup" | "finished";
  count: number;
  canFinish: boolean;
  /** The focus description is long enough; Finish then only waits for a topic, company or person. */
  focusReady: boolean;
  isPending: boolean;
  onFinish: () => void;
  /** The three sections, when there is a setup to show. */
  children?: ReactNode;
  finished?: {
    summary: string;
    preview: DiscoverPreviewState;
    onWritePost: (headline: PreviewHeadline) => void;
    onOpenDiscover: () => void;
    onOpenDashboard: () => void;
  };
}

const PLACEHOLDERS = [
  { icon: Newspaper, title: "Sources", text: "Publications covering your focus this month" },
  { icon: Hash, title: "Topics", text: "What those publications are writing about right now" },
  { icon: Users, title: "People and companies", text: "Named in those headlines, with the reason for each" },
];

/** "Your setup": empty until Pundit builds it (or you add your own), then the finish view. */
export function SetupCanvas({ className, view, count, canFinish, focusReady, isPending, onFinish, children, finished }: Readonly<SetupCanvasProps>) {
  if (view === "finished" && finished) {
    const { preview } = finished;
    return (
      <section aria-label="Your setup" className={cn("min-h-0 flex-col overflow-y-auto bg-background px-4 py-6 sm:px-8", className)}>
        <div className="mx-auto w-full max-w-3xl space-y-5">
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-success">Setup complete</p>
            <h1 className="font-heading text-2xl font-semibold sm:text-3xl">Your Discover is ready</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{finished.summary}</p>
          </div>
          <DiscoverPreview preview={preview} onWritePost={finished.onWritePost} />
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button type="button" onClick={finished.onOpenDiscover}>Open Discover</Button>
            <Button type="button" variant="outline" onClick={finished.onOpenDashboard}>Go to dashboard</Button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Your setup" className={cn("min-h-0 flex-col overflow-y-auto bg-background px-4 py-6 sm:px-8", className)}>
      <div className="mx-auto w-full max-w-4xl space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-1">
              <h1 className="font-heading text-2xl font-semibold">Review your curated feed</h1>
              <InfoTooltip label="Your setup">
                Pundit fills this in from live news, and you stay in control of every pick.
                Keep what fits, remove the rest, or add your own.
              </InfoTooltip>
            </div>
            {view !== "empty" && <p className="mt-1 text-sm text-muted-foreground">{count} selected · Keep what fits and remove anything that does not.</p>}
          </div>
          <div className="flex flex-col items-end gap-1">
            <Button type="button" onClick={onFinish} disabled={!canFinish || isPending} data-testid="button-complete-onboarding"
              aria-label="Finish setup" aria-describedby={focusReady && !canFinish ? "finish-setup-hint" : undefined}>
              {isPending ? "Saving…" : "Start my workspace"}
            </Button>
            {focusReady && !canFinish && (
              <p id="finish-setup-hint" className="max-w-56 text-right text-xs text-muted-foreground">Pick at least one topic, company or person to finish.</p>
            )}
          </div>
        </div>
        {view === "empty" ? (
          <div className="space-y-3">
            {PLACEHOLDERS.map(({ icon: Icon, title, text }) => (
              <div key={title} className="flex items-center gap-4 rounded-xl border border-dashed bg-card p-5">
                <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground"><Icon className="h-5 w-5" /></span>
                <div className="flex min-w-0 items-center gap-1">
                  <p className="font-medium">{title}</p>
                  <InfoTooltip label={title}>{text}</InfoTooltip>
                </div>
              </div>
            ))}
            <p className="text-sm text-muted-foreground">{focusReady ? "Check what Pundit understood, then build your setup." : "Tell Pundit about your work to begin."}</p>
          </div>
        ) : children}
      </div>
    </section>
  );
}
