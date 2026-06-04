import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Users, Briefcase, Loader2, AlertTriangle, Server } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import type { JobStatus } from "@/lib/jobs";
import { statusStyles } from "@/lib/jobs";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/admin/")({ component: AdminOverview });

const ALL_STATUSES: JobStatus[] = ["pending", "queued", "processing", "completed", "failed", "cancelled"];

// A worker is considered "online" only if it has heartbeated recently.
const WORKER_STALE_MS = 90_000;

type WorkerHealth = {
  worker_id: string;
  last_seen: string;
  active_jobs: number;
  status: string;
};

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

  const { data: workers = [] } = useQuery({
    queryKey: ["admin", "workers"],
    refetchInterval: 5000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("worker_health")
        .select("worker_id,last_seen,active_jobs,status")
        .order("last_seen", { ascending: false });
      if (error) throw error;
      return (data ?? []) as WorkerHealth[];
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

      <WorkerPanel
        title="Student workers"
        subtitle="Similarity-only pipeline (turnitin-worker service)."
        workers={workers.filter((w) => !w.worker_id.startsWith("instructor-"))}
      />
      <WorkerPanel
        title="Instructor workers (AI)"
        subtitle="Similarity + AI Writing pipeline (turnitin-instructor-worker service)."
        workers={workers.filter((w) => w.worker_id.startsWith("instructor-"))}
      />
    </div>
  );
}

function WorkerPanel({ title, subtitle, workers }: { title: string; subtitle: string; workers: WorkerHealth[] }) {
  return (
    <div className="rounded-xl border bg-card p-6">
      <div className="flex items-center gap-2">
        <Server className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
      <div className="mt-4 overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-2">Worker ID</th>
              <th className="px-4 py-2">State</th>
              <th className="px-4 py-2">Active jobs</th>
              <th className="px-4 py-2">Last heartbeat</th>
            </tr>
          </thead>
          <tbody>
            {workers.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">No workers connected.</td></tr>
            )}
            {workers.map((w) => {
              const online = Date.now() - new Date(w.last_seen).getTime() < WORKER_STALE_MS;
              return (
                <tr key={w.worker_id} className="border-b last:border-0">
                  <td className="px-4 py-2 font-medium">{w.worker_id}</td>
                  <td className="px-4 py-2">
                    <span className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs",
                      online ? "border-success/30 bg-success/10 text-success" : "border-destructive/30 bg-destructive/10 text-destructive",
                    )}>
                      <span className={cn("h-1.5 w-1.5 rounded-full", online ? "bg-success" : "bg-destructive")} />
                      {online ? "Online" : "Offline"}
                    </span>
                  </td>
                  <td className="px-4 py-2">{w.active_jobs}</td>
                  <td className="px-4 py-2 text-muted-foreground">{formatDistanceToNow(new Date(w.last_seen), { addSuffix: true })}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
