import { chromium, Browser, Page, Frame, type Locator } from "playwright";
import { writeFile, mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssignmentInfo } from "./supabase.js";
import { aiDetectPageState } from "./ai-resolver.js";
import { findElementWithAI } from "./ai-helper.js";

// Thrown when Turnitin explicitly refuses a resubmission on the current assignment.
// The worker catches this, frees the assignment, and tries the next available one.
export class ResubmitDeniedError extends Error {
  constructor(assignmentLabel: string) {
    super(`Turnitin refused resubmission on assignment "${assignmentLabel}" — trying next assignment`);
    this.name = "ResubmitDeniedError";
  }
}

// Per-account Playwright storageState cache. Keyed by account_id so all
// assignments belonging to the same Turnitin account share one session.
// Lost on worker restart; a fresh login is acceptable since sessions last weeks.
type StorageStateObj = Awaited<ReturnType<import("playwright").BrowserContext["storageState"]>>;
const sessionCache = new Map<string, StorageStateObj>();

// ── Selectors — adjust here if Turnitin UI shifts ────────────────────────────
// These match the instructor (class-owner) view of Turnitin. Many selectors are
// identical to the student worker; where the instructor UI differs the selector
// is noted.
const SEL = {
  // ── Login page ──────────────────────────────────────────────────────────────
  emailInput: 'input[name="email"], input#email, input[type="email"], input[name="user_email"], input[autocomplete="username"]',
  passwordInput: 'input[name="password"], input[name="user_password"], input#password, input#user_password, input[type="password"]',
  loginButton: 'button[type="submit"], input[type="submit"], button:has-text("Log in"), input[value="Log in"], input[value="Login"], #login',

  // ── Assignment dashboard — opens the Submit File modal ───────────────────────
  // Instructor view uses the same "Upload Submission" button for a single
  // anonymous/student submission submitted on behalf of a student.
  uploadSubmissionButton: [
    'button:has-text("Upload Submission")',
    'a:has-text("Upload Submission")',
    'input[value="Upload Submission"]',
  ].join(", "),

  // ── Submit File modal ─────────────────────────────────────────────────────────
  fileInput: 'input[type="file"]',
  submissionTitleInput: [
    'input[name="title"]',
    'input#submission_title',
    'input[placeholder="Untitled" i]',
    'input[aria-label*="title" i]',
    'input[name*="title" i]',
  ].join(", "),
  uploadAndReviewButton: [
    'button:has-text("Upload and Review")',
    'input[value="Upload and Review"]',
    'a:has-text("Upload and Review")',
  ].join(", "),

  // ── Review screen ─────────────────────────────────────────────────────────────
  submitToTurnitinButton: [
    'button:has-text("Submit to Turnitin")',
    'input[value="Submit to Turnitin"]',
    'a:has-text("Submit to Turnitin")',
  ].join(", "),

  // ── Slow-preview confirmation screen ──────────────────────────────────────────
  slowPreviewText: 'text=click confirm to complete your upload',
  confirmSlowPreview: [
    'button:has-text("Confirm")',
    'input[value="Confirm"]',
  ].join(", "),

  // ── Submission Complete modal — close it ──────────────────────────────────────
  closeModalButton: [
    'button[aria-label="Close" i]',
    'button[title="Close" i]',
    '[data-dismiss="modal"]',
    '.modal button.close',
    'button:has-text("×")',
  ].join(", "),

  // ── Resubmit button (used assignment — dashboard already has a previous paper) ─
  resubmitButton: [
    'input[value="Resubmit"]',
    'input[value*="resubmit" i]',
    'input[name*="resubmit" i]',
    'input[title*="resubmit" i]',
    'input[alt*="resubmit" i]',
    'a[href*="resubmit"]',
    'a[title*="resubmit" i]',
    'a:has(img[alt*="resubmit" i])',
    'a:has(img[title*="resubmit" i])',
    'button:has-text("Resubmit")',
    '[class*="resubmit"]',
  ].join(", "),

  // ── Confirm Resubmission dialog ───────────────────────────────────────────────
  confirmResubmission: [
    'button:has-text("Confirm")',
    'input[value="Confirm"]',
    'a:has-text("Confirm")',
  ].join(", "),

  // ── Resubmit-denied indicators ────────────────────────────────────────────────
  resubmitDenied: [
    '[class*="resubmit"][disabled]',
    '[class*="resubmit"][aria-disabled="true"]',
    'button[disabled][class*="resubmit"]',
    'input[disabled][value*="Resubmit" i]',
    'a[class*="resubmit"][aria-disabled="true"]',
    '[class*="resubmit"].disabled',
  ].join(", "),

  // ── Similarity score link on the dashboard ────────────────────────────────────
  similarityCell: [
    '.or-link',
    '[data-similarity]',
    '.similarity-score',
    'a[href*="viewer"]',
    'a[href*="ev.turnitin"]',
    'a:has-text("%")',
    'div[class*="similarity" i]',
  ].join(", "),

  // ── Viewer download button ───────────────────────────────────────────────────
  downloadButton: [
    '[class*="tii-icon-download"]',
    '[class*="sidebar-download-button"]',
    '[class*="sidebar-download" i]',
    '[title="Download"]',
    '[title="Download" i]',
    '[aria-label="Download"]',
    '[aria-label*="download" i]',
    'button[data-testid*="download" i]',
    'button[class*="download" i]',
  ].join(", "),

  // ── Download popup — "Current View" option ───────────────────────────────────
  currentViewOption: [
    'button:has-text("Current View")',
    'a:has-text("Current View")',
    'li:has-text("Current View")',
    'span:has-text("Current View")',
    '[data-testid*="current-view" i]',
  ].join(", "),

  // ── AI Writing tab in the Turnitin viewer ────────────────────────────────────
  // TODO: capture exact selector with HEADLESS=false + [diag] logging on a live
  // instructor account, then replace these stubs. The AI fallback resolver will
  // attempt to find the tab even without a hardcoded selector.
  aiWritingTab: [
    '[data-testid*="ai-writing" i]',
    'button:has-text("AI Writing")',
    'a:has-text("AI Writing")',
    '[aria-label*="AI Writing" i]',
    '[class*="ai-writing" i]',
    '[class*="aiWriting" i]',
  ].join(", "),
};

// Turnitin message patterns when resubmission is refused.
const RESUBMIT_DENIED_TEXTS: RegExp[] = [
  /cannot resubmit/i,
  /resubmission is not allowed/i,
  /resubmissions.*not.*enabled/i,
  /not allowed to resubmit/i,
  /resubmit.*not.*available/i,
  /you have \d+ resubmission.* left/i,
  /when you can submit next/i,
  /submission becomes available/i,
  /you have already submitted/i,
  /submission limit/i,
  /paper already exists/i,
];

type Logger = (msg: string) => Promise<void>;

async function smartClick(
  page: Page,
  selector: string,
  intent: string,
  log: Logger,
  timeoutMs = 8_000,
): Promise<boolean> {
  const ok = await tryClickInAnyFrame(page, selector, timeoutMs);
  if (ok) return true;
  const ai = await findElementWithAI(page, intent);
  if (!ai) return false;
  await log(`[warn] [ai-fallback] intent="${intent}" used selector=${ai.selector} — update SEL`);
  return tryClickInAnyFrame(page, ai.selector, 5_000);
}

async function smartFill(
  page: Page,
  selector: string,
  value: string,
  intent: string,
  log: Logger,
  timeoutMs = 5_000,
): Promise<boolean> {
  const ok = await fillInAnyFrame(page, selector, value, timeoutMs);
  if (ok) return true;
  const ai = await findElementWithAI(page, intent);
  if (!ai) return false;
  await log(`[warn] [ai-fallback] intent="${intent}" used selector=${ai.selector} — update SEL`);
  return fillInAnyFrame(page, ai.selector, value, 5_000);
}

async function isResubmitDenied(page: Page, onProgress: Logger): Promise<boolean> {
  if (SEL.resubmitDenied && (await locateInAnyFrame(page, SEL.resubmitDenied))) {
    await onProgress("[warn] resubmit denied detected (disabled button selector matched)");
    return true;
  }
  const body = await page.evaluate(() => document.body.innerText).catch(() => "");
  for (const pat of RESUBMIT_DENIED_TEXTS) {
    if (pat.test(body)) {
      await onProgress(`[warn] resubmit denied detected (text match: ${pat})`);
      return true;
    }
  }
  const ai = await findElementWithAI(page,
    "an error message, alert, or notice saying resubmission is not allowed or the slot is locked for resubmission");
  if (ai) {
    await onProgress(`[warn] resubmit denied detected (AI: ${ai.reasoning})`);
    return true;
  }
  return false;
}

const STEP_INTENTS: Record<number, { intent?: string; textWait?: string }> = {
  4: { intent: "the Upload and Review button to proceed to the submission review screen" },
  5: { intent: "the Submit to Turnitin button or Confirm button to complete the upload and submit it" },
  6: { textWait: "Submission Complete" },
  7: { textWait: "%" },
};

async function runStepRecovery(page: Page, failedStep: number, onProgress: Logger): Promise<boolean> {
  await onProgress(`[recovery] step${failedStep} failed — AI recovery on steps ${failedStep - 1}–${failedStep + 1}`);
  for (const s of [failedStep - 1, failedStep, failedStep + 1]) {
    const info = STEP_INTENTS[s];
    if (!info) continue;
    if (info.textWait) {
      const found = await waitForTextInAnyFrame(page, info.textWait, 30_000);
      if (found) {
        await onProgress(`[recovery] step${s}: "${info.textWait}" found — recovered`);
        return true;
      }
    } else if (info.intent) {
      await dumpPageControls(page, onProgress);
      const ai = await findElementWithAI(page, info.intent);
      if (ai) {
        const clicked = await tryClickInAnyFrame(page, ai.selector, 5_000);
        await onProgress(`[recovery] step${s}: AI click "${ai.selector}" — ${clicked ? "ok" : "miss"}`);
        if (clicked && s >= failedStep) {
          const complete = await waitForTextInAnyFrame(page, "Submission Complete", 90_000);
          if (complete) {
            await onProgress("[recovery] Submission Complete detected after AI click — recovered");
            return true;
          }
        }
      }
    }
  }
  return false;
}

export type InstructorSubmissionResult = {
  similarityPdf: Buffer;
  aiPdf: Buffer | null;
  submissionId: string | null;
};

export async function submitToTurnitin(opts: {
  assignment: AssignmentInfo;
  fileBytes: Buffer;
  originalName: string;
  headless: boolean;
  submissionTimeoutMs: number;
  pollIntervalMs: number;
  uploadTimeoutMs: number;
  existingSubmissionId?: string | null;
  onSubmitted?: (submissionId: string) => Promise<void>;
  onProgress: (msg: string) => Promise<void>;
}): Promise<InstructorSubmissionResult> {
  const { assignment, fileBytes, originalName, headless, submissionTimeoutMs, pollIntervalMs,
          uploadTimeoutMs, existingSubmissionId, onSubmitted, onProgress } = opts;

  const tmp = await mkdtemp(join(tmpdir(), "tii-instr-"));
  const filePath = join(tmp, originalName);
  await writeFile(filePath, fileBytes);

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const savedState = sessionCache.get(assignment.account_id);
    const ctx = await browser.newContext({
      acceptDownloads: true,
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
      locale: "en-US",
      ...(savedState ? { storageState: savedState } : {}),
    });
    const page = await ctx.newPage();

    // ── Login (or reuse cached session) ────────────────────────────────────────
    let usedCachedSession = savedState != null;

    if (usedCachedSession) {
      const targetUrl = assignment.submit_url ?? assignment.login_url;
      await onProgress(`cached session found for account ${assignment.account_label} — navigating directly to ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForLoadState("load", { timeout: 60_000 }).catch(() => {});
      if (await locateInAnyFrame(page, SEL.emailInput)) {
        await onProgress(`cached session expired for account ${assignment.account_label} — clearing cache, re-logging in`);
        sessionCache.delete(assignment.account_id);
        usedCachedSession = false;
      } else {
        await onProgress(`session valid — login skipped for account ${assignment.account_label}`);
      }
    }

    if (!usedCachedSession) {
      await onProgress(`opening login: ${assignment.login_url}`);
      await page.goto(assignment.login_url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForLoadState("load", { timeout: 60_000 }).catch(() => {});
      await onProgress(`login page loaded: url=${page.url()} title=${await page.title().catch(() => "?")}`);

      const emailOk = await smartFill(page, SEL.emailInput, assignment.email,
        "the email or username input field on the Turnitin login page", onProgress, 30_000);
      if (!emailOk) {
        await dumpPageControls(page, onProgress);
        throw new Error(
          "Could not find the Turnitin email field. The [diag] lines above list every input/button on the page.",
        );
      }
      const passwordOk = await smartFill(page, SEL.passwordInput, assignment.password,
        "the password input field on the Turnitin login page", onProgress, 15_000);
      if (!passwordOk) {
        await dumpPageControls(page, onProgress);
        throw new Error("Found the email field but not the password field — see [diag] lines above.");
      }

      await Promise.all([
        page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {}),
        smartClick(page, SEL.loginButton, "the Log in / Sign in submit button on the login page",
          onProgress, 15_000).catch(() => page.keyboard.press("Enter")),
      ]);
      await onProgress(`after login submit: url=${page.url()} title=${await page.title().catch(() => "?")}`);

      if (await locateInAnyFrame(page, SEL.emailInput)) {
        const diagLines = await dumpPageControls(page, onProgress);
        const pageState = await aiDetectPageState(
          diagLines, page.url(), await page.title().catch(() => ""), onProgress,
        );
        if (pageState === "captcha") {
          throw new Error("Login blocked by CAPTCHA — manual intervention required (see [diag] lines).");
        }
        throw new Error("Still on a login form after submitting — login likely failed (check credentials/captcha; see [diag] lines).");
      }
      await onProgress("logged in");

      const state = await ctx.storageState();
      sessionCache.set(assignment.account_id, state);
      await onProgress(`session saved to cache for account ${assignment.account_label}`);

      if (assignment.submit_url) {
        await onProgress(`opening assignment dashboard: ${assignment.submit_url}`);
        await page.goto(assignment.submit_url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForLoadState("load", { timeout: 60_000 }).catch(() => {});
      } else {
        await onProgress("WARNING: assignment has no submit_url; staying on the post-login page");
      }
    }

    // ── RESUME PATH: document already submitted in a prior attempt ─────────────
    if (existingSubmissionId) {
      await onProgress(`resuming score-wait (already submitted, id=${existingSubmissionId})`);
      const submissionId = await waitForSimilarity(page, submissionTimeoutMs, pollIntervalMs, onProgress);
      const similarityPdf = await downloadSimilarityPdf(page, onProgress);
      const aiPdf = await downloadAiPdf(page, onProgress);
      return { similarityPdf, aiPdf, submissionId: submissionId ?? existingSubmissionId };
    }

    // ── Step 1: decide path ────────────────────────────────────────────────────
    await onProgress("step1: checking page — looking for existing document or upload button");
    {
      const step1Deadline = Date.now() + 60_000;
      let step1Done = false;
      while (Date.now() < step1Deadline && !step1Done) {
        const hasResubmit = (await locateInAnyFrame(page, SEL.resubmitButton)) !== null;
        const hasUpload   = (await locateInAnyFrame(page, SEL.uploadSubmissionButton)) !== null;

        if (hasResubmit) {
          await onProgress("step1: existing document detected — checking if resubmit is allowed");
          if (await isResubmitDenied(page, onProgress)) {
            throw new ResubmitDeniedError(assignment.assignment_label);
          }
          await onProgress("step1: resubmit allowed — proceeding");
          await smartClick(page, SEL.resubmitButton,
            "the resubmit or re-upload icon button for the existing paper submission", onProgress, 10_000);
          await onProgress("step1b: confirming resubmission dialog");
          await smartClick(page, SEL.confirmResubmission,
            "the Confirm button in the Confirm Resubmission dialog", onProgress, 15_000);
          await page.waitForTimeout(1_500);
          if (await isResubmitDenied(page, onProgress)) {
            throw new ResubmitDeniedError(assignment.assignment_label);
          }
          step1Done = true;
        } else if (hasUpload) {
          await onProgress("step1: no existing document — fresh upload flow");
          await smartClick(page, SEL.uploadSubmissionButton,
            "the blue Upload Submission button to open the file upload modal", onProgress, 10_000);
          step1Done = true;
        } else {
          await page.waitForTimeout(500);
        }
      }
      if (!step1Done) {
        const diagLines = await dumpPageControls(page, onProgress);
        const pageState = await aiDetectPageState(
          diagLines, page.url(), await page.title().catch(() => ""), onProgress,
        );
        if (pageState === "captcha") throw new Error("CAPTCHA detected on dashboard — manual intervention required.");
        if (pageState === "login") throw new Error("Ended up back on the login page — session may have expired.");
        let aiHit = false;
        for (const [aiIntent, label] of [
          ["the resubmit or re-upload icon button for an existing paper submission", "resubmit"],
          ["the blue Upload Submission button to open the file upload modal", "upload"],
        ] as const) {
          const ai = await findElementWithAI(page, aiIntent);
          if (ai && await tryClickInAnyFrame(page, ai.selector, 5_000)) {
            await onProgress(`[warn] [ai-fallback] intent="${label} button" used selector=${ai.selector} — update SEL`);
            aiHit = true;
            break;
          }
        }
        if (!aiHit) {
          throw new Error(
            "Could not find resubmit button or 'Upload Submission' button on the dashboard. " +
            "Check that the assignment's submit_url is the assignment dashboard URL. See [diag] lines.",
          );
        }
        await onProgress("step1: AI-resolved button clicked — continuing");
      }
    }

    // ── Step 2: attach the file ────────────────────────────────────────────────
    await onProgress("step2: attaching file to the Submit File dialog");
    if (!(await setFileInAnyFrame(page, SEL.fileInput, filePath, 30_000))) {
      await dumpPageControls(page, onProgress);
      throw new Error("Could not find the file input in the Submit File dialog — see [diag] lines.");
    }

    // ── Step 3: submission title ───────────────────────────────────────────────
    const titleBase = originalName.replace(/\.[^.]+$/, "");
    await setTitleIfEmpty(page, SEL.submissionTitleInput, titleBase, onProgress);

    // ── Step 4: Upload and Review ──────────────────────────────────────────────
    await onProgress("step4: clicking 'Upload and Review'");
    if (!(await smartClick(page, SEL.uploadAndReviewButton,
      "the Upload and Review button to proceed after attaching the file", onProgress, 30_000))) {
      await dumpPageControls(page, onProgress);
      throw new Error("Could not find the 'Upload and Review' button — see [diag] lines.");
    }

    // ── Step 5: wait for review screen OR slow-preview confirm screen ────────────
    await onProgress(`step5: waiting for 'Submit to Turnitin' or 'Confirm' — up to ${Math.round(uploadTimeoutMs / 1000)}s`);
    let submissionConfirmedByRecovery = false;
    {
      const step5Deadline = Date.now() + uploadTimeoutMs;
      let step5Done = false;
      while (Date.now() < step5Deadline && !step5Done) {
        const hasSubmit      = (await locateInAnyFrame(page, SEL.submitToTurnitinButton)) !== null;
        const hasSlowPreview = (await locateInAnyFrame(page, SEL.slowPreviewText)) !== null;

        if (hasSubmit) {
          await onProgress("step5: preview screen — clicking 'Submit to Turnitin'");
          await smartClick(page, SEL.submitToTurnitinButton,
            "the final Submit to Turnitin button to confirm the submission", onProgress, 10_000);
          step5Done = true;
        } else if (hasSlowPreview) {
          await onProgress("step5: slow-preview screen — clicking 'Confirm' (trusted mouse event)");
          let confirmClicked = false;
          for (const frame of page.frames()) {
            const loc = frame.locator(SEL.confirmSlowPreview).first();
            if ((await loc.count().catch(() => 0)) === 0) continue;
            const box = await loc.boundingBox().catch(() => null);
            if (box) {
              const cx = Math.round(box.x + box.width / 2);
              const cy = Math.round(box.y + box.height / 2);
              await onProgress(`step5: Confirm at (${cx},${cy}) — mouse click`);
              await page.mouse.move(cx, cy);
              await page.waitForTimeout(200);
              await page.mouse.click(cx, cy);
              confirmClicked = true;
              break;
            }
            if (!confirmClicked) {
              await smartClick(page, SEL.confirmSlowPreview,
                "the Confirm button after the slow-preview hourglass screen", onProgress, 5_000);
              confirmClicked = true;
            }
          }
          await page.waitForTimeout(2_000);
          const slowPreviewStillHere = (await locateInAnyFrame(page, SEL.slowPreviewText)) !== null;
          const alreadyDone = await waitForTextInAnyFrame(page, "Submission Complete", 3_000);
          if (!slowPreviewStillHere || alreadyDone) {
            step5Done = true;
          } else {
            await onProgress("step5: Confirm click did not register — retrying");
          }
        } else {
          await page.waitForTimeout(500);
        }
      }
      if (!step5Done) {
        const recovered = await runStepRecovery(page, 5, onProgress);
        if (!recovered) {
          throw new Error("Could not find 'Submit to Turnitin' or 'Confirm' button after upload — see [diag] lines.");
        }
        submissionConfirmedByRecovery = true;
      }
    }

    // ── Step 6: confirm completion ─────────────────────────────────────────────
    if (!submissionConfirmedByRecovery) {
      await onProgress("step6: waiting for 'Submission Complete!'");
      const completed = await waitForTextInAnyFrame(page, "Submission Complete", 120_000);
      if (!completed) {
        await onProgress("step6: 'Submission Complete!' not seen — attempting AI recovery");
        const recovered = await runStepRecovery(page, 6, onProgress);
        if (!recovered) {
          throw new Error(
            "Submission Complete! never appeared (120s + AI recovery). Restarting upload flow on same assignment.",
          );
        }
      }
    }
    await tryClickInAnyFrame(page, SEL.closeModalButton, 10_000);
    await onProgress("submission complete; dialog closed");

    const sentinelId = await extractSubmissionIdFromPage(page) ?? "TII:submitted";
    await onSubmitted?.(sentinelId);

    // ── Step 7: wait for the similarity score ─────────────────────────────────
    await onProgress("waiting for similarity score");
    const submissionId = await waitForSimilarity(page, submissionTimeoutMs, pollIntervalMs, onProgress);

    // ── Step 8: download Similarity PDF ───────────────────────────────────────
    await onProgress("downloading Similarity PDF");
    const similarityPdf = await downloadSimilarityPdf(page, onProgress);

    // ── Step 9: download AI Writing PDF (best-effort) ──────────────────────────
    // The viewer is still open from step 8. Attempt to switch to the AI Writing
    // tab and download that PDF. If the tab is not found, mark AI as failed and
    // complete the job with the Similarity PDF only — the similarity result must
    // never be blocked by a missing AI report.
    await onProgress("downloading AI Writing PDF");
    const aiPdf = await downloadAiPdf(page, onProgress);

    return { similarityPdf, aiPdf, submissionId };

  } finally {
    await browser?.close().catch(() => {});
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ── AI Writing PDF download ────────────────────────────────────────────────────
// Attempts to click the AI Writing tab in the Turnitin viewer, then downloads
// the PDF via the same Download → Current View flow.  Returns null (never throws)
// so a missing AI tab never blocks the similarity result.
async function downloadAiPdf(page: Page, onProgress: Logger): Promise<Buffer | null> {
  try {
    await onProgress("ai-dl: looking for AI Writing tab in viewer");
    // The viewer may already be open as a new tab from the similarity download.
    // Try to find the AI Writing tab on the current page or any open page in context.
    const aiTabFound = await smartClick(page, SEL.aiWritingTab,
      "the AI Writing tab or button in the Turnitin report viewer", onProgress, 10_000);

    if (!aiTabFound) {
      await dumpPageControls(page, onProgress);
      await onProgress("[warn] AI Writing tab not found — TODO: update SEL.aiWritingTab with real selector from [diag] lines. AI report will be marked failed.");
      return null;
    }

    await onProgress("ai-dl: AI Writing tab clicked — waiting for content to load");
    await page.waitForTimeout(4_000);

    // Download the AI Writing report PDF using the same Download → Current View flow.
    const ctx = page.context();
    const DL_OPTION_TEXT = /current\s*view/i;
    const downloadPromise = ctx.waitForEvent("download", { timeout: 60_000 });
    downloadPromise.catch(() => {});

    const mainFrame = page.mainFrame();
    const DL_BTN_SEL = ['[class*="tii-icon-download"]', '[class*="sidebar-download-button"]', '[title="Download"]'].join(", ");

    let menuOpened = false;
    const dlBtnDeadline = Date.now() + 15_000;
    while (Date.now() < dlBtnDeadline && !menuOpened) {
      const n = await mainFrame.locator(DL_BTN_SEL).count().catch(() => 0);
      if (n > 0) {
        const box = await mainFrame.locator(DL_BTN_SEL).first().boundingBox().catch(() => null);
        if (box) {
          const cx = Math.round(box.x + box.width / 2);
          const cy = Math.round(box.y + box.height / 2);
          await page.mouse.move(cx, cy);
          await page.waitForTimeout(400);
          await page.mouse.click(cx, cy);
          await page.waitForTimeout(3_000);
          for (const fr of page.frames()) {
            if ((await fr.getByText(DL_OPTION_TEXT).count().catch(() => 0)) > 0) { menuOpened = true; break; }
          }
        }
      }
      if (!menuOpened) await page.waitForTimeout(1_000);
    }

    if (!menuOpened) {
      await onProgress("[warn] ai-dl: could not open download menu for AI Writing PDF — AI report will be marked failed");
      return null;
    }

    // Click "Current View"
    let clicked = false;
    const cvDeadline = Date.now() + 10_000;
    while (Date.now() < cvDeadline && !clicked) {
      for (const fr of page.frames()) {
        const loc = fr.getByText(DL_OPTION_TEXT).first();
        if ((await loc.count().catch(() => 0)) > 0) {
          const box = await loc.boundingBox().catch(() => null);
          if (box) {
            await page.mouse.move(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
            await page.waitForTimeout(200);
            await page.mouse.click(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
          } else {
            await loc.click({ timeout: 3_000 }).catch(() => {});
          }
          clicked = true;
          break;
        }
      }
      if (!clicked) await page.waitForTimeout(400);
    }

    if (!clicked) {
      await onProgress("[warn] ai-dl: 'Current View' not clickable — AI report will be marked failed");
      return null;
    }

    const download = await downloadPromise;
    const dlPath = await download.path();
    if (!dlPath) {
      await onProgress("[warn] ai-dl: download path null — AI report will be marked failed");
      return null;
    }

    await onProgress("ai-dl: AI Writing PDF received");
    return await readFile(dlPath);

  } catch (err) {
    await onProgress(`[warn] ai-dl: error downloading AI Writing PDF (${err instanceof Error ? err.message : String(err)}) — AI report will be marked failed`);
    return null;
  }
}

// ── Shared helpers (same as student worker) ────────────────────────────────────

async function locateInAnyFrame(page: Page, selector: string): Promise<Frame | null> {
  for (const f of page.frames()) {
    const n = await f.locator(selector).count().catch(() => 0);
    if (n > 0) return f;
  }
  return null;
}

async function fillInAnyFrame(page: Page, selector: string, value: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = await locateInAnyFrame(page, selector);
    if (frame) {
      try {
        await frame.locator(selector).first().fill(value, { timeout: 5_000 });
        return true;
      } catch { /* retry */ }
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function clickInAnyFrame(page: Page, selector: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = await locateInAnyFrame(page, selector);
    if (frame) {
      try {
        await frame.locator(selector).first().click({ timeout: 5_000 });
        return;
      } catch { /* retry */ }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`No element matched ${selector} within ${timeoutMs}ms`);
}

async function tryClickInAnyFrame(page: Page, selector: string, timeoutMs: number): Promise<boolean> {
  try {
    await clickInAnyFrame(page, selector, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function setFileInAnyFrame(page: Page, selector: string, filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      const loc = f.locator(selector).first();
      if ((await loc.count().catch(() => 0)) > 0) {
        try {
          await loc.setInputFiles(filePath, { timeout: 5_000 });
          return true;
        } catch { /* retry */ }
      }
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function setTitleIfEmpty(page: Page, selector: string, value: string, onProgress: Logger): Promise<void> {
  const frame = await locateInAnyFrame(page, selector);
  if (!frame) {
    const filled = await smartFill(page, selector, value,
      "the submission title text input field in the Submit File modal", onProgress, 5_000);
    if (!filled) await onProgress("no submission-title field found (continuing)");
    return;
  }
  try {
    const loc = frame.locator(selector).first();
    const current = (await loc.inputValue({ timeout: 3_000 }).catch(() => "")) ?? "";
    if (!current.trim() || current.trim().toLowerCase() === "untitled") {
      await loc.fill(value, { timeout: 5_000 });
      await onProgress(`set submission title: ${value}`);
    }
  } catch { /* best effort */ }
}

async function waitForTextInAnyFrame(page: Page, text: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      if ((await f.locator(`text=${text}`).count().catch(() => 0)) > 0) return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function dumpPageControls(page: Page, onProgress: Logger): Promise<string[]> {
  const lines: string[] = [];
  try {
    const header = `[diag] url=${page.url()} title=${await page.title().catch(() => "?")} frames=${page.frames().length}`;
    await onProgress(header);
    lines.push(header);
    for (const f of page.frames()) {
      const controls = await f
        .$$eval("input, button, a[href], select, textarea, [role=button]", (els) =>
          els.slice(0, 60).map((e) => {
            const a = e as HTMLInputElement;
            return [
              a.tagName.toLowerCase(),
              a.type ? `type=${a.type}` : "",
              a.name ? `name=${a.name}` : "",
              a.id ? `id=${a.id}` : "",
              a.getAttribute("aria-label") ? `aria=${a.getAttribute("aria-label")}` : "",
              a.placeholder ? `ph=${a.placeholder}` : "",
              a.className ? `cls=${a.className.toString().slice(0, 60)}` : "",
              (a.textContent || "").trim() ? `txt=${(a.textContent || "").trim().slice(0, 30)}` : "",
            ].filter(Boolean).join(" ");
          }),
        )
        .catch(() => [] as string[]);
      if (controls.length) {
        const frameHeader = `[diag] frame(${f.url().slice(0, 70)}):`;
        await onProgress(frameHeader);
        lines.push(frameHeader);
        for (const c of controls) {
          const line = `[diag]   <${c}>`;
          await onProgress(line);
          lines.push(line);
        }
      }
    }
  } catch (e) {
    await onProgress(`[diag] dump failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return lines;
}

async function extractSubmissionIdFromPage(page: Page): Promise<string | null> {
  try {
    for (const f of page.frames()) {
      const href = await f.locator('a[href*="oid="]').first().getAttribute("href", { timeout: 3_000 }).catch(() => null);
      if (href) {
        const m = href.match(/oid=(\d+)/);
        if (m) return m[1];
      }
    }
  } catch { /* best-effort */ }
  return null;
}

async function waitForSimilarity(
  page: Page, timeoutMs: number, pollMs: number, onProgress: Logger,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let submissionId: string | null = null;

  while (Date.now() < deadline) {
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch { /* ignore */ }

    const url = page.url();
    const m = url.match(/oid=(\d+)/) ?? url.match(/submission[_-]?id=(\d+)/i);
    if (m) submissionId = m[1];
    if (!submissionId) submissionId = await extractSubmissionIdFromPage(page);

    const text = await page.locator(SEL.similarityCell).first().innerText({ timeout: 5_000 }).catch(() => "");
    if (/\d+\s*%/.test(text)) {
      await onProgress(`similarity ready: ${text.trim()}`);
      return submissionId;
    }

    await onProgress(`not ready yet, sleeping ${Math.round(pollMs / 1000)}s`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error("Timed out waiting for similarity score");
}

async function downloadSimilarityPdf(page: Page, onProgress: Logger): Promise<Buffer> {
  const ctx = page.context();
  const DL_OPTION_TEXT = /current\s*view/i;

  await onProgress("dl-step1: clicking similarity score link to open viewer");
  const newPagePromise = ctx.waitForEvent("page", { timeout: 60_000 }).catch(() => null);

  const simClicked = await smartClick(page, SEL.similarityCell,
    "the similarity percentage link or score cell that opens the Turnitin report viewer", onProgress, 15_000);
  if (!simClicked) {
    await dumpPageControls(page, onProgress);
    throw new Error("Cannot click similarity cell — check [diag] lines above for correct selector");
  }

  let viewer = await newPagePromise;
  if (!viewer) {
    await onProgress("no new tab detected — assuming same-tab navigation");
    await page.waitForURL(/ev\.turnitin\.com/, { timeout: 30_000 }).catch(() => {});
    viewer = page;
  }

  await viewer.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => {});
  await onProgress(`dl-step1 done: viewer url=${viewer.url()}`);
  await viewer.waitForTimeout(6_000);
  await viewer.mouse.move(1280, 450).catch(() => {});
  await viewer.waitForTimeout(1_000);

  const downloadPromise = viewer.waitForEvent("download", { timeout: 120_000 });
  downloadPromise.catch(() => {});

  const v = viewer;

  async function dlDialogOpen(): Promise<boolean> {
    for (const fr of v.frames()) {
      if ((await fr.getByText(DL_OPTION_TEXT).count().catch(() => 0)) > 0) return true;
    }
    return false;
  }

  async function clickCurrentView(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const fr of v.frames()) {
        const loc = fr.getByText(DL_OPTION_TEXT).first();
        if ((await loc.count().catch(() => 0)) > 0) {
          const box = await loc.boundingBox().catch(() => null);
          if (box) {
            const cx = Math.round(box.x + box.width / 2);
            const cy = Math.round(box.y + box.height / 2);
            await v.mouse.move(cx, cy);
            await v.waitForTimeout(200);
            await v.mouse.click(cx, cy);
          } else {
            await loc.click({ timeout: 3_000 }).catch(() => {});
          }
          return true;
        }
      }
      await v.waitForTimeout(400);
    }
    return false;
  }

  await onProgress("dl-step2: looking for download button");

  const DL_BTN_SEL = [
    '[class*="tii-icon-download"]',
    '[class*="sidebar-download-button"]',
    '[title="Download"]',
  ].join(", ");

  const mainFrame = viewer.mainFrame();

  let menuOpened = false;
  const dlBtnDeadline = Date.now() + 15_000;
  while (Date.now() < dlBtnDeadline && !menuOpened) {
    const n = await mainFrame.locator(DL_BTN_SEL).count().catch(() => 0);
    if (n > 0) {
      const box = await mainFrame.locator(DL_BTN_SEL).first().boundingBox().catch(() => null);
      if (box) {
        const cx = Math.round(box.x + box.width / 2);
        const cy = Math.round(box.y + box.height / 2);
        await onProgress(`dl-step2: download button found at (${cx},${cy}), clicking`);
        await viewer.mouse.move(cx, cy);
        await viewer.waitForTimeout(400);
        await viewer.mouse.click(cx, cy);
        await viewer.waitForTimeout(3_000);
        if (await dlDialogOpen()) {
          await onProgress("dl-step2: dialog found — 'Current View' visible");
          menuOpened = true;
        }
      }
    }
    if (!menuOpened) await viewer.waitForTimeout(1_000);
  }

  if (!menuOpened) {
    await onProgress("dl-step2: fast path missed — probing [role=button] elements");
    const btns = await mainFrame.locator("[role='button'], button").all().catch(() => [] as Locator[]);
    for (const btn of btns) {
      if (viewer.isClosed()) break;
      try {
        const box = await btn.boundingBox().catch(() => null);
        if (!box) continue;
        const beforeUrl = viewer.url();
        const cx = Math.round(box.x + box.width / 2);
        const cy = Math.round(box.y + box.height / 2);
        await viewer.mouse.move(cx, cy);
        await viewer.waitForTimeout(200);
        await viewer.mouse.click(cx, cy);
        await viewer.waitForTimeout(2_500);
        if (viewer.isClosed()) break;
        if (viewer.url() !== beforeUrl) {
          await viewer.goBack({ timeout: 10_000 }).catch(() => {});
          continue;
        }
        if (await dlDialogOpen()) { menuOpened = true; break; }
      } catch {
        if (viewer.isClosed()) break;
      }
    }
  }

  if (!menuOpened) {
    if (!viewer.isClosed()) await dumpPageControls(viewer, onProgress);
    throw new Error("Could not open the Turnitin download menu — see [diag] lines above.");
  }

  await viewer.waitForTimeout(500);

  await onProgress("dl-step3: clicking 'Current View'");
  if (!(await clickCurrentView(15_000))) {
    if (!viewer.isClosed()) await dumpPageControls(viewer, onProgress);
    throw new Error("Download dialog open but could not click 'Current View' — see [diag] lines above.");
  }

  const download = await downloadPromise;
  const dlPath = await download.path();
  if (!dlPath) throw new Error("Download completed but no file path returned");

  await onProgress("Similarity PDF download received");
  return await readFile(dlPath);
}
