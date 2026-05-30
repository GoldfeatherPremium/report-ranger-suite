import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { UploadDropzone } from "@/components/upload-dropzone";
import { JobsTable } from "@/components/jobs-table";
import { ACTIVE_STATUSES, type Job } from "@/lib/jobs";

export const Route = createFileRoute("/_authenticated/dashboard")({ component: Dashboard });

function Dashboard() {
  const { user } = useAuth();
  const { data: jobs = [], refetch } = useQuery({
    queryKey: ["jobs", "me", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("jobs").select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as Job[];
    },
    refetchInterval: (q) => {
      const list = (q.state.data ?? []) as Job[];
      return list.some((j) => ACTIVE_STATUSES.includes(j.status)) ? 4000 : false;
    },
  });

  const active = jobs.filter((j) => ACTIVE_STATUSES.includes(j.status)).length;
  const completed = jobs.filter((j) => j.status === "completed").length;
  const failed = jobs.filter((j) => j.status === "failed").length;

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div>
        <h2 className="text-2xl font-semibold">Upload documents</h2>
        <p className="mt-1 text-sm text-muted-foreground">Files are queued for processing immediately.</p>
      </div>

      <UploadDropzone onUploaded={refetch} />

      <div className="grid grid-cols-3 gap-4">
        <Stat label="Active" value={active} />
        <Stat label="Completed" value={completed} />
        <Stat label="Failed" value={failed} />
      </div>

      <div>
        <h3 className="mb-3 text-lg font-semibold">Recent jobs</h3>
        <JobsTable jobs={jobs} onChange={refetch} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}
