import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
}

assertServiceRoleKey(key);

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
  instructor_assignment_id: string | null;
  turnitin_submission_id: string | null;
  ai_report_status: string | null;
};

export type AssignmentInfo = {
  assignment_id: string;
  assignment_label: string;
  submit_url: string | null;
  cooldown_hours: number;
  last_submitted_at: string | null;
  class_id: string;
  class_label: string;
  account_id: string;
  account_label: string;
  email: string;
  login_url: string;
  password: string;
};

export type ReportKind = "similarity" | "ai";

export async function claimNextInstructorJob(workerId: string): Promise<Job | null> {
  const { data, error } = await supabase.rpc("claim_next_instructor_job", { p_worker_id: workerId });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as Job | null | undefined;
  if (!row || !row.id) return null;
  return row;
}

export async function getAssignmentInfo(assignmentId: string): Promise<AssignmentInfo> {
  const { data: a, error: e1 } = await supabase
    .from("turnitin_instructor_assignments")
    .select("id,label,submit_url,cooldown_hours,class_id, turnitin_instructor_classes(id,label,account_id, turnitin_instructor_accounts(id,label,email,login_url))")
    .eq("id", assignmentId)
    .single();
  if (e1) throw e1;

  const [pwdResult, lastUsageResult] = await Promise.all([
    supabase.rpc("decrypt_instructor_account_password", {
      account: (a as unknown as { turnitin_instructor_classes: { turnitin_instructor_accounts: { id: string } } }).turnitin_instructor_classes.turnitin_instructor_accounts.id,
    }),
    supabase
      .from("turnitin_instructor_slot_usage")
      .select("submitted_at")
      .eq("assignment_id", assignmentId)
      .order("submitted_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (pwdResult.error) throw pwdResult.error;

  type Raw = {
    id: string; label: string; submit_url: string | null; cooldown_hours: number; class_id: string;
    turnitin_instructor_classes: {
      id: string; label: string; account_id: string;
      turnitin_instructor_accounts: { id: string; label: string; email: string; login_url: string };
    };
  };
  const r = a as unknown as Raw;
  const cls = r.turnitin_instructor_classes;
  const acc = cls.turnitin_instructor_accounts;

  return {
    assignment_id: r.id,
    assignment_label: r.label,
    submit_url: r.submit_url ?? null,
    cooldown_hours: r.cooldown_hours ?? 24,
    last_submitted_at: (lastUsageResult.data?.submitted_at as string | null) ?? null,
    class_id: cls.id,
    class_label: cls.label,
    account_id: acc.id,
    account_label: acc.label,
    email: acc.email,
    login_url: acc.login_url,
    password: pwdResult.data as unknown as string,
  };
}

export async function downloadSource(sourcePath: string): Promise<Buffer> {
  const { data, error } = await supabase.storage.from("documents").download(sourcePath);
  if (error || !data) throw error ?? new Error("download failed");
  return Buffer.from(await data.arrayBuffer());
}

export async function uploadReport(
  userId: string, jobId: string, pdf: Buffer, kind: ReportKind,
): Promise<string> {
  const path = `${userId}/${jobId}.${kind}.pdf`;
  const { error } = await supabase.storage.from("reports").upload(path, pdf, {
    contentType: "application/pdf",
    upsert: true,
  });
  if (error) throw error;
  const { error: ins } = await supabase.from("reports").insert({
    job_id: jobId,
    storage_path: path,
    file_name: `${jobId}.${kind}.pdf`,
    mime_type: "application/pdf",
    size_bytes: pdf.length,
    kind,
  });
  if (ins) throw ins;
  return path;
}

export async function setAiReportStatus(jobId: string, status: "pending" | "ready" | "failed") {
  await supabase.from("jobs").update({ ai_report_status: status }).eq("id", jobId);
}

export async function markJobSubmitted(jobId: string, submissionId: string) {
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
  await supabase.from("turnitin_instructor_slot_usage")
    .update({ freed_at: new Date().toISOString(), turnitin_submission_id: submissionId })
    .eq("job_id", jobId).is("freed_at", null);
}

export async function markJobFailed(
  jobId: string, attempts: number, max: number, error: string, submissionId?: string | null,
) {
  const alreadySubmitted = submissionId != null;

  if (attempts >= max) {
    await supabase.from("jobs").update({
      status: "failed",
      finished_at: new Date().toISOString(),
      error,
    }).eq("id", jobId);
    await supabase.from("turnitin_instructor_slot_usage")
      .update({ freed_at: new Date().toISOString() })
      .eq("job_id", jobId).is("freed_at", null);
  } else if (alreadySubmitted) {
    const retryAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await supabase.from("jobs").update({
      status: "queued",
      error,
      worker_id: null,
      queued_at: retryAt,
    }).eq("id", jobId);
  } else {
    await supabase.from("jobs").update({
      status: "queued",
      error,
      instructor_assignment_id: null,
      worker_id: null,
      queued_at: new Date().toISOString(),
    }).eq("id", jobId);
    await supabase.from("turnitin_instructor_slot_usage")
      .update({ freed_at: new Date().toISOString() })
      .eq("job_id", jobId).is("freed_at", null);
  }
}

export async function reassignInstructorJobAssignment(
  jobId: string, excludeAssignmentIds: string[],
): Promise<string | null> {
  const { data, error } = await supabase.rpc("reassign_instructor_job_assignment", {
    p_job_id: jobId,
    p_exclude_assignment_ids: excludeAssignmentIds,
  });
  if (error) throw error;
  return (data as string | null) ?? null;
}

export async function requeueJobNoAssignment(jobId: string, reason: string) {
  await supabase.from("turnitin_instructor_slot_usage")
    .update({ freed_at: new Date().toISOString() })
    .eq("job_id", jobId).is("freed_at", null);
  await supabase.from("jobs").update({
    status: "queued",
    instructor_assignment_id: null,
    worker_id: null,
    error: reason,
    queued_at: new Date().toISOString(),
  }).eq("id", jobId);
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

export async function log(
  workerId: string, jobId: string | null, level: "info" | "warn" | "error", message: string, metadata?: object,
) {
  await supabase.from("worker_logs").insert({
    worker_id: workerId, job_id: jobId, level, message,
    metadata: (metadata ?? null) as never,
  });
  console.log(`[${level}] ${message}`);
}
