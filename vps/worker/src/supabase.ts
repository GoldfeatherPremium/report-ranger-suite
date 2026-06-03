import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
}

// Catch the most common setup mistake early: pasting the anon / publishable
// key instead of the service_role key. The worker bypasses RLS and needs the
// service_role key, so a wrong key would otherwise fail with confusing
// permission errors deep in the job loop.
assertServiceRoleKey(key);

// supabase-js eagerly builds a realtime client inside createClient(), even
// though this worker never opens a realtime channel. On Node < 22 there is no
// global WebSocket, so we must hand it the `ws` implementation or createClient()
// throws "Node.js 20 detected without native WebSocket support". The cast is
// because ws's constructor signature is slightly wider than the type supabase
// expects; it's fully compatible at runtime.
export const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: WebSocket as unknown as typeof globalThis.WebSocket },
});

function assertServiceRoleKey(key: string) {
  const parts = key.split(".");
  if (parts.length !== 3) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY must be the JWT service_role key, not a publishable key or placeholder");
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { role?: string };
    if (payload.role !== "service_role") {
      throw new Error(`SUPABASE_SERVICE_ROLE_KEY is a ${payload.role ?? "unknown"} key; paste the service_role key instead`);
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is not a valid JWT service_role key");
    }
    throw error;
  }
}

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
  cooldown_hours: number;
  last_submitted_at: string | null;
  account_id: string;
  account_label: string;
  email: string;
  login_url: string;
  password: string;
};

export async function claimNextJob(workerId: string): Promise<Job | null> {
  const { data, error } = await supabase.rpc("claim_next_job", { p_worker_id: workerId });
  if (error) throw error;
  // claim_next_job returns the jobs composite type. When there's no free slot
  // or no queued job it returns a SQL NULL row, which PostgREST serializes as
  // an object whose fields are all null (NOT JSON null). So a plain `!data`
  // check isn't enough — we must also reject a row that has no id, otherwise
  // the worker "claims" a phantom job, fails with "no slot assigned", and spins.
  const row = (Array.isArray(data) ? data[0] : data) as Job | null | undefined;
  if (!row || !row.id) return null;
  return row;
}

export async function getSlotInfo(slotId: string): Promise<SlotInfo> {
  const { data: slot, error: e1 } = await supabase
    .from("turnitin_slots")
    .select("id,label,submit_url,cooldown_hours,account_id, turnitin_accounts(label,email,login_url)")
    .eq("id", slotId)
    .single();
  if (e1) throw e1;

  const [pwdResult, lastUsageResult] = await Promise.all([
    supabase.rpc("decrypt_account_password", { account: slot.account_id }),
    supabase
      .from("turnitin_slot_usage")
      .select("submitted_at")
      .eq("slot_id", slotId)
      .order("submitted_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (pwdResult.error) throw pwdResult.error;

  const acc = (slot as unknown as { turnitin_accounts: { label: string; email: string; login_url: string } | { label: string; email: string; login_url: string }[] }).turnitin_accounts;
  const account = Array.isArray(acc) ? acc[0] : acc;
  return {
    slot_id: slot.id as string,
    slot_label: slot.label as string,
    submit_url: (slot.submit_url as string | null) ?? null,
    cooldown_hours: (slot.cooldown_hours as number | null) ?? 24,
    last_submitted_at: (lastUsageResult.data?.submitted_at as string | null) ?? null,
    account_id: slot.account_id as string,
    account_label: account.label,
    email: account.email,
    login_url: account.login_url,
    password: pwdResult.data as unknown as string,
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

export async function markJobSubmitted(jobId: string, submissionId: string) {
  // Called immediately after "Submission Complete!" so that retries know the
  // document is already in Turnitin and must reuse the same slot.
  await supabase.from("jobs").update({
    turnitin_submission_id: submissionId,
    last_polled_at: new Date().toISOString(),
  }).eq("id", jobId);
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

export async function markJobFailed(jobId: string, attempts: number, max: number, error: string, submissionId?: string | null) {
  const alreadySubmitted = submissionId != null;

  if (attempts >= max) {
    // Out of retries — mark permanently failed and always free the slot.
    await supabase.from("jobs").update({
      status: "failed",
      finished_at: new Date().toISOString(),
      error,
    }).eq("id", jobId);
    await supabase.from("turnitin_slot_usage")
      .update({ freed_at: new Date().toISOString() })
      .eq("job_id", jobId).is("freed_at", null);
  } else if (alreadySubmitted) {
    // Document was already submitted to Turnitin — requeue but KEEP the slot
    // assignment so the retry polls the same assignment dashboard instead of
    // uploading to a new slot.  The slot_usage row also stays open.
    // Delay by 15 min so we don't spin instantly when Turnitin is still processing.
    const retryAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await supabase.from("jobs").update({
      status: "queued",
      error,
      worker_id: null,
      // slot_id intentionally NOT nulled — preserved for the retry
      queued_at: retryAt,
    }).eq("id", jobId);
    // Do NOT free turnitin_slot_usage — the slot must stay "in use".
  } else {
    // Upload/submission itself failed — free the slot so any slot can be tried again.
    await supabase.from("jobs").update({
      status: "queued",
      error,
      slot_id: null,
      worker_id: null,
      queued_at: new Date().toISOString(),
    }).eq("id", jobId);
    await supabase.from("turnitin_slot_usage")
      .update({ freed_at: new Date().toISOString() })
      .eq("job_id", jobId).is("freed_at", null);
  }
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

// Called when Turnitin denies a resubmit on the current slot.
// Frees the current slot usage and atomically assigns the next available slot.
// Returns the new slot_id, or null if no slot is currently available.
export async function reassignJobSlot(
  jobId: string,
  excludeSlotIds: string[],
): Promise<string | null> {
  const { data, error } = await supabase.rpc("reassign_job_slot", {
    p_job_id: jobId,
    p_exclude_slot_ids: excludeSlotIds,
  });
  if (error) throw error;
  return (data as string | null) ?? null;
}

// Called when all slots have denied resubmission.
// Frees the current slot usage and puts the job back in the queue with no
// slot assigned so any worker can pick it up when a slot becomes free.
export async function requeueJobNoSlot(jobId: string, reason: string) {
  await supabase.from("turnitin_slot_usage")
    .update({ freed_at: new Date().toISOString() })
    .eq("job_id", jobId).is("freed_at", null);
  await supabase.from("jobs").update({
    status: "queued",
    slot_id: null,
    worker_id: null,
    error: reason,
    queued_at: new Date().toISOString(),
  }).eq("id", jobId);
}

export async function log(workerId: string, jobId: string | null, level: "info" | "warn" | "error", message: string, metadata?: object) {
  await supabase.from("worker_logs").insert({
    worker_id: workerId, job_id: jobId, level, message,
    metadata: (metadata ?? null) as never,
  });
  console.log(`[${level}] ${message}`);
}
