import "dotenv/config";
import {
  claimNextJob, downloadSource, getSlotInfo, heartbeat, log,
  markJobDone, markJobFailed, markJobSubmitted, touchJob, uploadReport, supabase,
} from "./supabase.js";
import { submitToTurnitin } from "./turnitin.js";

const WORKER_ID = process.env.WORKER_ID ?? `worker-${process.pid}`;
const HEADLESS = (process.env.HEADLESS ?? "true") === "true";
const SUBMISSION_TIMEOUT_MS = Number(process.env.SUBMISSION_TIMEOUT_MS ?? 1_800_000);
const UPLOAD_TIMEOUT_MS = Number(process.env.UPLOAD_TIMEOUT_MS ?? 600_000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 15_000);
const CLAIM_IDLE_MS = Number(process.env.CLAIM_IDLE_MS ?? 10_000);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 30_000);

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

async function processOne() {
  const job = await claimNextJob(WORKER_ID);
  if (!job) return false;
  activeJobs++;

  // Track the submission ID locally so markJobFailed knows whether the
  // document was already submitted (and must keep its slot on retry).
  let currentSubmissionId: string | null = job.turnitin_submission_id;

  const isResume = currentSubmissionId != null;
  await log(WORKER_ID, job.id, "info",
    `claimed job ${job.id} (${job.original_name})${isResume ? " [resume: doc already submitted]" : ""}`);

  try {
    if (!job.slot_id) throw new Error("job has no slot assigned");
    const slot = await getSlotInfo(job.slot_id);
    await log(WORKER_ID, job.id, "info", `using slot ${slot.slot_label} (${slot.email})`);

    const fileBytes = await downloadSource(job.source_path);
    await touchJob(job.id);

    const { pdf, submissionId } = await submitToTurnitin({
      slot, fileBytes, originalName: job.original_name,
      headless: HEADLESS, submissionTimeoutMs: SUBMISSION_TIMEOUT_MS, pollIntervalMs: POLL_INTERVAL_MS,
      uploadTimeoutMs: UPLOAD_TIMEOUT_MS,
      existingSubmissionId: job.turnitin_submission_id,
      onProgress: async (m) => { await log(WORKER_ID, job.id, "info", m); await touchJob(job.id); },
      onSubmitted: async (sid) => {
        // Called right after "Submission Complete!" — save immediately so a crash
        // or timeout after this point won't cause the doc to be re-submitted.
        currentSubmissionId = sid;
        await markJobSubmitted(job.id, sid);
        await log(WORKER_ID, job.id, "info", `submission confirmed, turnitin_id=${sid}`);
      },
    });

    await uploadReport(job.user_id, job.id, pdf);
    await markJobDone(job.id, submissionId ?? currentSubmissionId);
    await log(WORKER_ID, job.id, "info", `done`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log(WORKER_ID, job.id, "error", `failed: ${msg}`);
    await markJobFailed(job.id, job.attempts, job.max_attempts, msg, currentSubmissionId);
  } finally {
    activeJobs--;
  }
  return true;
}

async function mainLoop() {
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

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function shutdown(sig: string) {
  console.log(`Received ${sig}, draining…`);
  shuttingDown = true;
  setTimeout(() => process.exit(0), 5_000);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log(`turnitin-worker ${WORKER_ID} starting (headless=${HEADLESS})`);
heartbeatLoop();
watchdogLoop();
mainLoop().catch((e) => { console.error("fatal", e); process.exit(1); });
