import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { OnboardingWorkspace } from "@/components/onboarding/onboarding-workspace";
import { QuickSetup } from "@/components/onboarding/quick-setup";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useInboxRefreshJob } from "@/hooks/use-inbox-refresh-job";
import type { OnboardingData } from "@/lib/onboarding-choices";
import { track } from "@/lib/analytics-consent";
import { useAppTourReporter } from "@/components/app-tour";

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  industry?: string;
  country?: string;
}

interface OnboardingPageProps {
  /** Setup was saved: keep showing its result instead of switching to the app at once. */
  onSetupSaved?: () => void;
  /** The user moved on from the result: show the app. */
  onSetupDone?: () => void;
}

/** First-run setup. It appears on the dashboard's own URL, so setup and the app are one place. */
export default function OnboardingPage({ onSetupSaved, onSetupDone }: Readonly<OnboardingPageProps>) {
  const [location, navigate] = useLocation();
  const reportTour = useAppTourReporter();
  const { toast } = useToast();
  const [saved, setSaved] = useState<OnboardingData | null>(null);
  // Pundit sets everything up from one answer; "choose myself" opens the step-by-step workspace.
  const [flow, setFlow] = useState<"quick" | "manual">("quick");
  const { startRefresh } = useInboxRefreshJob();

  const { data: user } = useQuery<User>({
    queryKey: ["/api/me"],
  });

  /** After either flow saves: show the finished view and fill Discover while it is read. */
  const finishSetup = (data: OnboardingData) => {
    // The rest of the app sees setup as done right away (leaving by the logo or Back never
    // brings the question back); the result stays on screen until the user moves on.
    onSetupSaved?.();
    queryClient.setQueryData<Record<string, unknown>>(["/api/profile"], profile => profile ? { ...profile, onboardingStatus: "completed" } : profile);
    queryClient.invalidateQueries({ queryKey: ["/api/profile"] });
    // Quick setup may have set the industry. Pages opened next reload it; refetching now
    // would restart this screen's headline preview.
    queryClient.invalidateQueries({ queryKey: ["/api/me"], refetchType: "none" });
    setSaved(data);
    reportTour?.("setup-saved");
    track("onboarding_complete", { flow });
    // The refresh runs server-side; Discover shows its progress. Nothing to search: skip.
    if (data.keywords.length || data.publications.length || data.influencers.length || data.companies.length) void startRefresh();
  };

  const completeOnboardingMutation = useMutation({
    mutationFn: async (data: OnboardingData) => {
      return await apiRequest("POST", "/api/profile/complete-onboarding", data);
    },
    onSuccess: (_response, data) => finishSetup(data),
    onError: () => {
      toast({
        title: "Something went wrong",
        description: "Please try again.",
        variant: "destructive",
      });
    },
  });

  /** Move on from the result: to a page, or to the app at the current dashboard URL. */
  const leave = (to?: string, state?: Record<string, unknown>) => {
    onSetupDone?.();
    const target = to ?? (location.startsWith("/dashboard") ? undefined : "/dashboard");
    if (target) navigate(target, state ? { state } : undefined);
  };

  if (flow === "quick") {
    return (
      <QuickSetup
        firstName={user?.firstName}
        userIndustry={user?.industry}
        userCountry={user?.country}
        completed={saved}
        onSaved={finishSetup}
        onLeave={leave}
        onManual={() => setFlow("manual")}
      />
    );
  }

  return (
    <OnboardingWorkspace
      onComplete={data => completeOnboardingMutation.mutate(data)}
      isPending={completeOnboardingMutation.isPending}
      userIndustry={user?.industry}
      userCountry={user?.country}
      completed={saved}
      onLeave={leave}
    />
  );
}
