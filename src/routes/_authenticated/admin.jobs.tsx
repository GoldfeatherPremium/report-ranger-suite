import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { JobsTable } from "@/components/jobs-table";
import { type Job, type JobStatus } from "@/lib/jobs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/admin/jobs")({ component: AdminJobs });

const STATUSES: (JobStatus | "all")[] = ["all", "pending", "queued", "processing", "completed", "failed", "cancelled"];

function AdminJobs() {
  const [status, setStatus] = useState<JobStatus | "all">("all");

  const { data = [], refetch } = useQuery({
    queryKey: ["admin", "jobs", status],
    refetchInterval: 5000,
    queryFn: async () => {
      let q = supabase
        .from("jobs")
        .select("*, user:users(email)")
        .order("created_at", { ascending: false })
        .limit(500);
      if (status !== "all") q = q.eq("status", status);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as (Job & { user: { email: string } | null })[];
    },
  });

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold">All jobs</h2>
          <p className="mt-1 text-sm text-muted-foreground">{data.length} shown</p>
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v as JobStatus | "all")}>
          <SelectTrigger className="w-full sm:w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <JobsTable jobs={data} showUser onChange={refetch} />
    </div>
  );
}
