import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Users, Briefcase, Loader2, AlertTriangle } from "lucide-react";
import type { JobStatus } from "@/lib/jobs";
import { statusStyles } from "@/lib/jobs";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/admin/")({ component: AdminOverview });

const ALL_STATUSES: JobStatus[] = ["pending", "queued", "processing", "completed", "failed", "cancelled"];

function AdminOverview() {
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "overview"],
    refetchInterval: 5000,
    queryFn: async () => {
      const [usersR, jobsR] = await Promise.all([
        supabase.from("users").select("id", { count: "exact", head: true }),
        supabase.from("jobs").select("status"),
      ]);
      const jobs = (jobsR.data ?? []) as { status: JobStatus }[];
      const byStatus = ALL_STATUSES.reduce((acc, s) => {
        acc[s] = jobs.filter((j) => j.status === s).length;
        return acc;
      }, {} as Record<JobStatus, number>);
      return {
        totalUsers: usersR.count ?? 0,
        totalJobs: jobs.length,
        processing: byStatus.processing + byStatus.queued + byStatus.pending,
        failed: byStatus.failed,
        byStatus,
      };
    },
  });

  if (isLoading || !data) {
    return <div className="flex justify-center p-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div>
        <h2 className="text-2xl font-semibold">Admin overview</h2>
        <p className="mt-1 text-sm text-muted-foreground">Workspace-wide stats, refreshing every few seconds.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Users} label="Total users" value={data.totalUsers} />
        <StatCard icon={Briefcase} label="Total jobs" value={data.totalJobs} />
        <StatCard icon={Loader2} label="Active" value={data.processing} accent="info" />
        <StatCard icon={AlertTriangle} label="Failed" value={data.failed} accent="destructive" />
      </div>

      <div className="rounded-xl border bg-card p-6">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Jobs by status</h3>
        <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {ALL_STATUSES.map((s) => (
            <div key={s} className={cn("rounded-lg border p-4", statusStyles[s])}>
              <p className="text-xs uppercase tracking-wide opacity-80">{s}</p>
              <p className="mt-1 text-2xl font-semibold">{data.byStatus[s]}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, accent }: { icon: React.ElementType; label: string; value: number; accent?: "info" | "destructive" }) {
  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <Icon className={cn("h-4 w-4", accent === "destructive" && "text-destructive", accent === "info" && "text-info")} />
      </div>
      <p className="mt-2 text-3xl font-semibold">{value}</p>
    </div>
  );
}
