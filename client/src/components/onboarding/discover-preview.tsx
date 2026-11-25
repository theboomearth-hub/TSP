import { Button } from "@/components/ui/button";
import type { PreviewHeadline } from "@/lib/onboarding-suggestions";

export interface DiscoverPreviewState { status: "idle" | "loading" | "ready" | "empty"; headlines: PreviewHeadline[]; hasTopics: boolean }

/** The finish screen's taste of Discover: today's headlines on the saved topics, each with "Write a post". */
export function DiscoverPreview({ preview, onWritePost }: Readonly<{ preview: DiscoverPreviewState; onWritePost: (headline: PreviewHeadline) => void }>) {
  return (
    <section aria-label="Discover preview" className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">In your feed today</p>
      {preview.status === "loading" && <p role="status" className="animate-pulse text-sm text-muted-foreground">Finding recent articles on your topics…</p>}
      {preview.status === "empty" && (
        <p className="text-sm text-muted-foreground">{preview.hasTopics ? "Discover fills in the first time you refresh it." : "Pick a few topics in Settings so Discover knows what to look for."}</p>
      )}
      {preview.status === "ready" && (
        <ul className="space-y-3">
          {preview.headlines.map(headline => (
            <li key={headline.title} className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                {headline.link
                  ? <a href={headline.link} target="_blank" rel="noopener noreferrer" className="font-medium leading-snug hover:underline [overflow-wrap:anywhere]">{headline.title}</a>
                  : <span className="font-medium leading-snug">{headline.title}</span>}
                <p className="mt-1 text-xs text-muted-foreground">
                  {[headline.source, headline.publishedAt ? new Date(headline.publishedAt).toLocaleDateString() : "", `on ${headline.topic}`].filter(Boolean).join(" · ")}
                </p>
              </div>
              {headline.link && (
                <Button type="button" variant="outline" size="sm" aria-label={`Write a post about ${headline.title}`} onClick={() => onWritePost(headline)}>
                  Write a post
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
