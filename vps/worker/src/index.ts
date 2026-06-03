import "dotenv/config";
import {
  claimNextJob, downloadSource, getSlotInfo, heartbeat, log,
  markJobDone, markJobFailed, markJobSubmitted, touchJob, uploadReport,
  reassignJobSlot, requeueJobNoSlot, supabase,
} from "./supabase.js";
import { submitToTurnitin, ResubmitDeniedError } from "./turnitin.js";

function envNum(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return v > 0 ? v : fallback;
}

const WORKER_ID          = process.env.WORKER_ID ?? `worker-${process.pid}`;
const HEADLESS           = (process.env.HEADLESS ?? "true") === "true";
const SUBMISSION_TIMEOUT_MS = envNum("SUBMISSION_TIMEOUT_MS", 900_000);   // 15 min
const UPLOAD_TIMEOUT_MS     = envNum("UPLOAD_TIMEOUT_MS",     600_000);   // 10 min
const POLL_INTERVAL_MS      = envNum("POLL_INTERVAL_MS",       30_000);   // 30 s
const CLAIM_IDLE_MS         = envNum("CLAIM_IDLE_MS",          10_000);
const HEARTBEAT_MS          = envNum("HEARTBEAT_MS",           30_000);
const CONCURRENCY           = envNum("CONCURRENCY",                 3);   // parallel jobs
const JOB_TIMEOUT_MS        = envNum("JOB_TIMEOUT_MS",      3_600_000);   // 1 hour total per job

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
  const job = await claimNextJob(WORKER_ID);
  if (!job) return false;
  activeJobs++;

  let currentSubmissionId: string | null = job.turnitin_submission_id;
  const jobDeadline = Date.now() + JOB_TIMEOUT_MS;
  const deniedSlots: string[] = [];
  let currentSlotId = job.slot_id!;

  const isResume = currentSubmissionId != null;
  await log(WORKER_ID, job.id, "info",
    `claimed job ${job.id} (${job.original_name})${isResume ? " [resume: doc already submitted]" : ""}`);

  try {
    while (Date.now() < jobDeadline && !shuttingDown) {
      const slot = await getSlotInfo(currentSlotId);
      await log(WORKER_ID, job.id, "info", `using slot ${slot.slot_label} (${slot.email})`);

      const fileBytes = await downloadSource(job.source_path);
      await touchJob(job.id);

      try {
        const { pdf, submissionId } = await submitToTurnitin({
          slot, fileBytes, originalName: job.original_name,
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

        await uploadReport(job.user_id, job.id, pdf);
        await markJobDone(job.id, submissionId ?? currentSubmissionId);
        await log(WORKER_ID, job.id, "info", "done");
        return true;

      } catch (err) {
        if (err instanceof ResubmitDeniedError) {
          // Turnitin explicitly refused this slot — move to the next available one.
          deniedSlots.push(currentSlotId);
          await log(WORKER_ID, job.id, "warn",
            `slot ${slot.slot_label} denied resubmit — trying next slot (denied so far: ${deniedSlots.length})`);

          const newSlotId = await reassignJobSlot(job.id, deniedSlots);
          if (!newSlotId) {
            // Every slot is either in use or has denied this job — requeue for later.
            const reason = `All ${deniedSlots.length} slot(s) denied resubmission — requeued for next free slot`;
            await requeueJobNoSlot(job.id, reason);
            await log(WORKER_ID, job.id, "warn", "all slots denied or busy — requeued");
            return true;
          }
          currentSlotId = newSlotId;
          currentSubmissionId = null; // new slot = fresh upload
        } else {
          // Transient failure — retry the same slot from the beginning.
          const msg = err instanceof Error ? err.message : String(err);
          await log(WORKER_ID, job.id, "warn",
            `step failed (${msg}) — retrying same slot in 5s`);
          await sleep(5_000);
        }
      }
    }

    // Job deadline exceeded (or shutting down)
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
  // Spawn CONCURRENCY independent worker loops — each claims its own job and slot.
  // DB-level FOR UPDATE SKIP LOCKED in claim_next_job prevents collisions.
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

console.log(`turnitin-worker ${WORKER_ID} starting (headless=${HEADLESS}, concurrency=${CONCURRENCY})`);
heartbeatLoop();
watchdogLoop();
mainLoop().catch((e) => { console.error("fatal", e); process.exit(1); });
