import { useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { track } from "@/lib/analytics-consent";

/** The browser's time zone, so the first digest arrives at 9:00 local time. */
function browserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; }
}

interface CompleteRegistrationProps {
  existingFirstName?: string | null;
  existingLastName?: string | null;
  existingName?: string | null;
}

/**
 * Finishes the account without a form: the name comes from sign-up and the time zone from the
 * browser. Industry and market are no longer asked here; Pundit infers them during setup.
 */
export default function CompleteRegistrationPage({ existingFirstName, existingLastName, existingName }: CompleteRegistrationProps) {
  const [, setLocation] = useLocation();
  const nameParts = (existingName || "").trim().split(/\s+/).filter(Boolean);
  const firstName = existingFirstName || nameParts[0] || "User";
  const lastName = existingLastName || nameParts.slice(1).join(" ") || "Member";

  const registration = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/complete-registration", { firstName, lastName, timeZone: browserTimeZone() }),
    onSuccess: async () => {
      track("registration_complete");
      await queryClient.invalidateQueries({ queryKey: ["/api/me"] });
      await queryClient.refetchQueries({ queryKey: ["/api/me"] });
      setLocation("/dashboard");
    },
  });

  // Once per visit, including React's development double-mount.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    registration.mutate();
  }, [registration]);

  const message = registration.error instanceof Error ? registration.error.message : "";
  const accountMissing = message.includes("not found");

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      {registration.isError ? (
        <div role="alert" className="w-full max-w-sm space-y-4 rounded-xl border bg-card p-6 text-center">
          <p className="font-heading text-lg font-semibold">{accountMissing ? "We couldn't find your account" : "We couldn't finish creating your account"}</p>
          <p className="text-sm text-muted-foreground">{accountMissing ? "Please sign up again." : "Please try again in a moment."}</p>
          {accountMissing
            ? <Button asChild><Link href="/sign-up">Sign up again</Link></Button>
            : <Button type="button" onClick={() => registration.mutate()} disabled={registration.isPending}>Try again</Button>}
        </div>
      ) : (
        <div role="status" className="flex flex-col items-center gap-4">
          <div className="relative flex h-14 w-14 items-center justify-center">
            <span className="absolute inset-0 rounded-full border-2 border-primary/20" />
            <span className="absolute inset-0 animate-spin rounded-full border-2 border-b-transparent border-l-transparent border-r-transparent border-t-primary" />
          </div>
          <p className="text-sm text-muted-foreground">Setting up your account…</p>
        </div>
      )}
    </div>
  );
}
