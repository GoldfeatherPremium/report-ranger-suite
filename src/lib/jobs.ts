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

export async function uploadAndCreateJob(userId: string, file: File): Promise<{ error: string | null }> {
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
  });
  if (insErr) {
    await supabase.storage.from("documents").remove([key]);
    return { error: insErr.message };
  }
  return { error: null };
}

export async function downloadReport(jobId: string): Promise<string | null> {
  const { data: report } = await supabase
    .from("reports")
    .select("storage_path, file_name")
    .eq("job_id", jobId)
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
  return supabase.from("jobs").update({
    status: "queued",
    error: null,
    queued_at: new Date().toISOString(),
  }).eq("id", id);
}

export async function cancelJob(id: string) {
  return supabase.from("jobs").update({
    status: "cancelled",
    finished_at: new Date().toISOString(),
  }).eq("id", id);
}

export async function deleteJob(id: string, sourcePath: string) {
  await supabase.storage.from("documents").remove([sourcePath]);
  return supabase.from("jobs").delete().eq("id", id);
}
