import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { JobsTable } from "@/components/jobs-table";
import { useAuth } from "@/hooks/use-auth";
import type { Job } from "@/lib/jobs";

export const Route = createFileRoute("/_authenticated/history")({ component: HistoryPage });

function HistoryPage() {
  const { user } = useAuth();
  const { data: jobs = [], refetch } = useQuery({
    queryKey: ["jobs", "history", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("jobs").select("*")
        .in("status", ["completed", "failed", "cancelled"])
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as Job[];
    },
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h2 className="text-2xl font-semibold">Processing history</h2>
        <p className="mt-1 text-sm text-muted-foreground">All finished, failed, and cancelled jobs.</p>
      </div>
      <JobsTable jobs={jobs} onChange={refetch} />
    </div>
  );
}
