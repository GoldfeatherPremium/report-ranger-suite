import { supabase } from "@/integrations/supabase/client";

export type JobStatus = "pending" | "queued" | "processing" | "completed" | "failed" | "cancelled";

export type Job = {
  id: string;
  user_id: string;
  status: JobStatus;
  original_name: string;
  source_path: string;
  mime_type: string | null;
  size_bytes: number | null;
  error: string | null;
  attempts: number;
  max_attempts: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  started_at: string | null;
  queued_at: string | null;
  slot_id: string | null;
  turnitin_submission_id: string | null;
  worker_id: string | null;
  last_polled_at: string | null;
  pipeline: "student" | "instructor";
  instructor_assignment_id: string | null;
  ai_report_status: "pending" | "ready" | "failed" | null;
};

export const ACTIVE_STATUSES: JobStatus[] = ["pending", "queued", "processing"];

export const statusStyles: Record<JobStatus, string> = {
  pending: "bg-muted text-muted-foreground border-border",
  queued: "bg-info/15 text-info border-info/30",
  processing: "bg-warning/15 text-warning border-warning/30 animate-pulse",
  completed: "bg-success/15 text-success border-success/30",
  failed: "bg-destructive/15 text-destructive border-destructive/30",
  cancelled: "bg-muted text-muted-foreground border-border opacity-70",
};

export function formatBytes(n: number | null | undefined) {
  if (!n) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

export async function uploadAndCreateJob(
  userId: string,
  file: File,
  pipeline: "student" | "instructor" = "student",
): Promise<{ error: string | null }> {
  const ext = file.name.includes(".") ? file.name.split(".").pop() : "";
  const key = `${userId}/${crypto.randomUUID()}${ext ? "." + ext : ""}`;
  const { error: upErr } = await supabase.storage.from("documents").upload(key, file, {
    contentType: file.type || undefined,
    upsert: false,
  });
  if (upErr) return { error: upErr.message };

  const { error: insErr } = await supabase.from("jobs").insert({
    user_id: userId,
    original_name: file.name,
    source_path: key,
    mime_type: file.type || null,
    size_bytes: file.size,
    status: "queued",
    queued_at: new Date().toISOString(),
    max_attempts: 5,
    pipeline,
  });
  if (insErr) {
    await supabase.storage.from("documents").remove([key]);
    return { error: insErr.message };
  }
  return { error: null };
}

export async function downloadReport(
  jobId: string,
  kind: "similarity" | "ai" = "similarity",
): Promise<string | null> {
  const { data: report } = await supabase
    .from("reports")
    .select("storage_path, file_name")
    .eq("job_id", jobId)
    .eq("kind", kind)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!report) return null;
  const { data } = await supabase.storage.from("reports").createSignedUrl(report.storage_path, 60 * 10, {
    download: report.file_name,
  });
  return data?.signedUrl ?? null;
}

export async function retryJob(id: string) {
  // RPC (security definer): requeues as a fresh upload, clears the stale
  // slot/submission so the worker doesn't mistake it for a resume, and frees
  // the prior slot-usage row (the client cannot touch that table under RLS).
  return supabase.rpc("retry_job" as never, { p_job_id: id } as never);
}

export async function cancelJob(id: string) {
  // RPC (security definer): marks cancelled and frees the slot when no document
  // was submitted, so a cancelled job doesn't leak a Turnitin slot for 24h.
  return supabase.rpc("cancel_job" as never, { p_job_id: id } as never);
}

export async function deleteJob(id: string, sourcePath: string) {
  // Remove the generated report object(s) too — deleting the job row cascades
  // the reports rows, but the PDF in the 'reports' bucket would otherwise orphan.
  const { data: reps } = await supabase.from("reports").select("storage_path").eq("job_id", id);
  if (reps && reps.length) {
    await supabase.storage.from("reports").remove(reps.map((r) => r.storage_path));
  }
  await supabase.storage.from("documents").remove([sourcePath]);
  return supabase.from("jobs").delete().eq("id", id);
}
