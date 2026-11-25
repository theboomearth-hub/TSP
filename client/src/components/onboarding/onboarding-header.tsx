import { Sparkles } from "lucide-react";
import { Link } from "wouter";
import { AppTourButton } from "@/components/app-tour";
import { HelpButton } from "@/components/help-panel";

/** The setup screens' header: the logo, what is happening, Help and the app tour. */
export function OnboardingHeader() {
  return (
    <header className="shrink-0 border-b bg-card/95 px-4 py-3 backdrop-blur sm:px-6">
      <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4">
        <Link href="/"><span className="flex cursor-pointer items-center gap-2" data-testid="link-logo-onboarding">
          <img src="/logo-mark.png" alt="" className="h-7 w-7 rounded-md" aria-hidden="true" /><span className="font-heading text-lg font-bold text-primary">TheSocialPundit</span>
        </span></Link>
        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground sm:flex">
            <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
            Personalizing your workspace
          </div>
          <HelpButton />
          <AppTourButton />
        </div>
      </div>
    </header>
  );
}
