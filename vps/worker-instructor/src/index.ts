import "dotenv/config";
import {
  claimNextInstructorJob, downloadSource, getAssignmentInfo, heartbeat, log,
  markJobDone, markJobFailed, markJobSubmitted, touchJob, uploadReport,
  reassignInstructorJobAssignment, requeueJobNoAssignment, setAiReportStatus, supabase,
} from "./supabase.js";
import { submitToTurnitin, ResubmitDeniedError } from "./turnitin.js";

function envNum(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return v > 0 ? v : fallback;
}

const WORKER_ID          = process.env.WORKER_ID ?? `instructor-${process.pid}`;
const HEADLESS           = (process.env.HEADLESS ?? "true") === "true";
const SUBMISSION_TIMEOUT_MS = envNum("SUBMISSION_TIMEOUT_MS", 900_000);
const UPLOAD_TIMEOUT_MS     = envNum("UPLOAD_TIMEOUT_MS",     600_000);
const POLL_INTERVAL_MS      = envNum("POLL_INTERVAL_MS",       30_000);
const CLAIM_IDLE_MS         = envNum("CLAIM_IDLE_MS",          10_000);
const HEARTBEAT_MS          = envNum("HEARTBEAT_MS",           30_000);
const CONCURRENCY           = envNum("CONCURRENCY",                 2);
const JOB_TIMEOUT_MS        = envNum("JOB_TIMEOUT_MS",      3_600_000);

let activeJobs = 0;
let shuttingDown = false;

async function heartbeatLoop() {
  while (!shuttingDown) {
    try { await heartbeat(WORKER_ID, activeJobs); } catch (e) { console.error("heartbeat", e); }
    await sleep(HEARTBEAT_MS);
  }
}

async function watchdogLoop() {
  while (!shuttingDown) {
    try { await supabase.rpc("requeue_stuck_jobs", { p_max_age_minutes: 45 }); } catch (e) { console.error("watchdog", e); }
    await sleep(60_000);
  }
}

async function processOne(): Promise<boolean> {
  const job = await claimNextInstructorJob(WORKER_ID);
  if (!job) return false;
  activeJobs++;

  let currentSubmissionId: string | null = job.turnitin_submission_id;
  const jobDeadline = Date.now() + JOB_TIMEOUT_MS;
  const deniedAssignments: string[] = [];
  let currentAssignmentId = job.instructor_assignment_id!;

  const isResume = currentSubmissionId != null;
  await log(WORKER_ID, job.id, "info",
    `claimed instructor job ${job.id} (${job.original_name})${isResume ? " [resume]" : ""}`);

  try {
    while (Date.now() < jobDeadline && !shuttingDown) {
      const assignment = await getAssignmentInfo(currentAssignmentId);
      await log(WORKER_ID, job.id, "info", `using assignment ${assignment.assignment_label} (${assignment.email})`);

      const fileBytes = await downloadSource(job.source_path);
      await touchJob(job.id);

      try {
        const { similarityPdf, aiPdf, submissionId } = await submitToTurnitin({
          assignment, fileBytes, originalName: job.original_name,
          headless: HEADLESS,
          submissionTimeoutMs: SUBMISSION_TIMEOUT_MS,
          pollIntervalMs: POLL_INTERVAL_MS,
          uploadTimeoutMs: UPLOAD_TIMEOUT_MS,
          existingSubmissionId: currentSubmissionId,
          onProgress: async (m) => { await log(WORKER_ID, job.id, "info", m); await touchJob(job.id); },
          onSubmitted: async (sid) => {
            currentSubmissionId = sid;
            await markJobSubmitted(job.id, sid);
            await log(WORKER_ID, job.id, "info", `submission confirmed, turnitin_id=${sid}`);
          },
        });

        await uploadReport(job.user_id, job.id, similarityPdf, "similarity");
        await log(WORKER_ID, job.id, "info", "Similarity PDF uploaded");

        if (aiPdf) {
          await uploadReport(job.user_id, job.id, aiPdf, "ai");
          await setAiReportStatus(job.id, "ready");
          await log(WORKER_ID, job.id, "info", "AI Writing PDF uploaded");
        } else {
          await setAiReportStatus(job.id, "failed");
          await log(WORKER_ID, job.id, "warn", "AI Writing PDF not available — marked failed");
        }

        await markJobDone(job.id, submissionId ?? currentSubmissionId);
        await log(WORKER_ID, job.id, "info", "done");
        return true;

      } catch (err) {
        if (err instanceof ResubmitDeniedError) {
          deniedAssignments.push(currentAssignmentId);
          await log(WORKER_ID, job.id, "warn",
            `assignment ${assignment.assignment_label} denied resubmit — trying next (denied so far: ${deniedAssignments.length})`);

          const newAssignmentId = await reassignInstructorJobAssignment(job.id, deniedAssignments);
          if (!newAssignmentId) {
            const reason = `All ${deniedAssignments.length} assignment(s) denied resubmission — requeued for next free assignment`;
            await requeueJobNoAssignment(job.id, reason);
            await log(WORKER_ID, job.id, "warn", "all assignments denied or busy — requeued");
            return true;
          }
          currentAssignmentId = newAssignmentId;
          currentSubmissionId = null;
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          await log(WORKER_ID, job.id, "warn", `step failed (${msg}) — retrying same assignment in 5s`);
          await sleep(5_000);
        }
      }
    }

    const reason = shuttingDown ? "Worker shutting down" : "Job timeout exceeded";
    await markJobFailed(job.id, job.attempts, job.max_attempts, reason, currentSubmissionId);
    await log(WORKER_ID, job.id, "error", reason);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log(WORKER_ID, job.id, "error", `fatal: ${msg}`);
    await markJobFailed(job.id, job.attempts, job.max_attempts, msg, currentSubmissionId);
  } finally {
    activeJobs--;
  }
  return true;
}

async function workerLoop() {
  while (!shuttingDown) {
    try {
      const handled = await processOne();
      if (!handled) await sleep(CLAIM_IDLE_MS);
    } catch (e) {
      console.error("loop error", e);
      await sleep(CLAIM_IDLE_MS);
    }
  }
}

async function mainLoop() {
  await Promise.all(Array.from({ length: CONCURRENCY }, () => workerLoop()));
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function shutdown(sig: string) {
  console.log(`Received ${sig}, draining…`);
  shuttingDown = true;
  setTimeout(() => process.exit(0), 5_000);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log(`turnitin-instructor-worker ${WORKER_ID} starting (headless=${HEADLESS}, concurrency=${CONCURRENCY})`);
heartbeatLoop();
watchdogLoop();
mainLoop().catch((e) => { console.error("fatal", e); process.exit(1); });
