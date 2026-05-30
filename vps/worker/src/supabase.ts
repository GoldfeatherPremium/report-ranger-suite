import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
}

export const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: WebSocket },
});

export type Job = {
  id: string;
  user_id: string;
  status: string;
  original_name: string;
  source_path: string;
  mime_type: string | null;
  size_bytes: number | null;
  attempts: number;
  max_attempts: number;
  slot_id: string | null;
  turnitin_submission_id: string | null;
};

export type SlotInfo = {
  slot_id: string;
  slot_label: string;
  submit_url: string | null;
  account_id: string;
  account_label: string;
  email: string;
  login_url: string;
  password: string;
};

export async function claimNextJob(workerId: string): Promise<Job | null> {
  const { data, error } = await supabase.rpc("claim_next_job", { p_worker_id: workerId });
  if (error) throw error;
  if (!data) return null;
  // RPC returns a single row (the jobs table type)
  return Array.isArray(data) ? (data[0] as Job) ?? null : (data as Job);
}

export async function getSlotInfo(slotId: string): Promise<SlotInfo> {
  const { data: slot, error: e1 } = await supabase
    .from("turnitin_slots")
    .select("id,label,submit_url,account_id, turnitin_accounts(label,email,login_url)")
    .eq("id", slotId)
    .single();
  if (e1) throw e1;
  const { data: pwd, error: e2 } = await supabase.rpc("decrypt_account_password", { account: slot.account_id });
  if (e2) throw e2;
  const acc = (slot as unknown as { turnitin_accounts: { label: string; email: string; login_url: string } | { label: string; email: string; login_url: string }[] }).turnitin_accounts;
  const account = Array.isArray(acc) ? acc[0] : acc;
  return {
    slot_id: slot.id as string,
    slot_label: slot.label as string,
    submit_url: (slot.submit_url as string | null) ?? null,
    account_id: slot.account_id as string,
    account_label: account.label,
    email: account.email,
    login_url: account.login_url,
    password: pwd as unknown as string,
  };
}

export async function downloadSource(sourcePath: string): Promise<Buffer> {
  const { data, error } = await supabase.storage.from("documents").download(sourcePath);
  if (error || !data) throw error ?? new Error("download failed");
  return Buffer.from(await data.arrayBuffer());
}

export async function uploadReport(userId: string, jobId: string, pdf: Buffer): Promise<string> {
  const path = `${userId}/${jobId}.pdf`;
  const { error } = await supabase.storage.from("reports").upload(path, pdf, {
    contentType: "application/pdf",
    upsert: true,
  });
  if (error) throw error;
  const { error: ins } = await supabase.from("reports").insert({
    job_id: jobId,
    storage_path: path,
    file_name: `${jobId}.pdf`,
    mime_type: "application/pdf",
    size_bytes: pdf.length,
  });
  if (ins) throw ins;
  return path;
}

export async function markJobDone(jobId: string, submissionId: string | null) {
  await supabase.from("jobs").update({
    status: "completed",
    finished_at: new Date().toISOString(),
    turnitin_submission_id: submissionId,
    last_polled_at: new Date().toISOString(),
  }).eq("id", jobId);
  await supabase.from("turnitin_slot_usage")
    .update({ freed_at: new Date().toISOString(), turnitin_submission_id: submissionId })
    .eq("job_id", jobId).is("freed_at", null);
}

export async function markJobFailed(jobId: string, attempts: number, max: number, error: string) {
  if (attempts >= max) {
    await supabase.from("jobs").update({
      status: "failed",
      finished_at: new Date().toISOString(),
      error,
    }).eq("id", jobId);
  } else {
    await supabase.from("jobs").update({
      status: "queued",
      error,
      slot_id: null,
      worker_id: null,
      queued_at: new Date().toISOString(),
    }).eq("id", jobId);
  }
  await supabase.from("turnitin_slot_usage")
    .update({ freed_at: new Date().toISOString() })
    .eq("job_id", jobId).is("freed_at", null);
}

export async function touchJob(jobId: string) {
  await supabase.from("jobs").update({ last_polled_at: new Date().toISOString() }).eq("id", jobId);
}

export async function heartbeat(workerId: string, activeJobs: number) {
  await supabase.from("worker_health").upsert({
    worker_id: workerId,
    last_seen: new Date().toISOString(),
    active_jobs: activeJobs,
    status: "online",
  });
}

export async function log(workerId: string, jobId: string | null, level: "info" | "warn" | "error", message: string, metadata?: object) {
  await supabase.from("worker_logs").insert({
    worker_id: workerId, job_id: jobId, level, message,
    metadata: (metadata ?? null) as never,
  });
  console.log(`[${level}] ${message}`);
}
