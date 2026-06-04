import { chromium, Browser, Page, Frame, type Locator } from "playwright";
import { writeFile, mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SlotInfo } from "./supabase.js";
import { aiDetectPageState } from "./ai-resolver.js";
import { findElementWithAI } from "./ai-helper.js";

// Per-account Playwright storageState cache. Keyed by account_id so all slots
// belonging to the same Turnitin account share one session — login once, reuse
// for every slot of that account. Lost on worker restart; a fresh login on
// restart is acceptable since Turnitin sessions last days to weeks.
type StorageStateObj = Awaited<ReturnType<import("playwright").BrowserContext["storageState"]>>;
const sessionCache = new Map<string, StorageStateObj>();

// Thrown when Turnitin explicitly refuses a resubmission on the current slot.
// The worker catches this, frees the slot, and tries the next available one.
export class ResubmitDeniedError extends Error {
  constructor(slotLabel: string) {
    super(`Turnitin refused resubmission on slot "${slotLabel}" — trying next slot`);
    this.name = "ResubmitDeniedError";
  }
}

// === Selectors — adjust here if Turnitin UI shifts ===
// The flow below matches the real Turnitin "classic" student experience:
//   login → assignment dashboard → "Upload Submission" → Submit File modal →
//   choose file + title → "Upload and Review" → "Submit to Turnitin" →
//   "Submission Complete!" → close → wait for similarity % → open viewer →
//   download icon → "Current View" → PDF.
//
// IMPORTANT: the slot's `submit_url` must be the ASSIGNMENT DASHBOARD url, e.g.
//   https://www.turnitin.com/assignment/type/paper/dashboard/<assignmentId>?lang=en_us
// That is the page that has the blue "Upload Submission" button.
const SEL = {
  // ── Login page ──────────────────────────────────────────────────────────────
  emailInput: 'input[name="email"], input#email, input[type="email"], input[name="user_email"], input[autocomplete="username"]',
  passwordInput: 'input[name="password"], input[name="user_password"], input#password, input#user_password, input[type="password"]',
  loginButton: 'button[type="submit"], input[type="submit"], button:has-text("Log in"), input[value="Log in"], input[value="Login"], #login',

  // ── Assignment dashboard — opens the Submit File modal ───────────────────────
  uploadSubmissionButton: [
    'button:has-text("Upload Submission")',
    'a:has-text("Upload Submission")',
    'input[value="Upload Submission"]',
  ].join(", "),

  // ── "Submit File" modal ─────────────────────────────────────────────────────
  // The file <input> is usually hidden behind a "Choose file" label; setInputFiles
  // works on hidden inputs so we never trigger the OS file dialog.
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

  // ── Review screen ────────────────────────────────────────────────────────────
  submitToTurnitinButton: [
    'button:has-text("Submit to Turnitin")',
    'input[value="Submit to Turnitin"]',
    'a:has-text("Submit to Turnitin")',
  ].join(", "),

  // ── Slow-preview confirmation screen ─────────────────────────────────────────
  // Turnitin sometimes skips the preview and shows an hourglass with:
  // "You must click confirm to complete your upload."
  // Detect by the SPECIFIC MESSAGE TEXT so we don't fire on any other Confirm button.
  slowPreviewText: 'text=click confirm to complete your upload',
  confirmSlowPreview: [
    'button:has-text("Confirm")',
    'input[value="Confirm"]',
  ].join(", "),

  // ── Submission Complete modal — close it ─────────────────────────────────────
  closeModalButton: [
    'button[aria-label="Close" i]',
    'button[title="Close" i]',
    '[data-dismiss="modal"]',
    '.modal button.close',
    'button:has-text("×")',
  ].join(", "),

  // ── Resubmit button (used slots — dashboard already has a previous paper) ───
  // Turnitin's classic UI renders this as an icon whose text content is an
  // Angular i18n key (e.g. "ts-turnitin.lang.EntResubmit"), so text-based
  // selectors never fire.  The class attribute is the reliable signal.
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

  // ── "Confirm Resubmission" dialog ───────────────────────────────────────────
  confirmResubmission: [
    'button:has-text("Confirm")',
    'input[value="Confirm"]',
    'a:has-text("Confirm")',
  ].join(", "),

  // ── Resubmit-denied indicators ───────────────────────────────────────────────
  // Turnitin disables the resubmit button (disabled / aria-disabled) and shows
  // a timestamp message when resubmissions are not allowed.  These selectors
  // catch the disabled-button state before we even try to click.
  // Add more selectors here after inspecting the live page with DevTools.
  resubmitDenied: [
    '[class*="resubmit"][disabled]',
    '[class*="resubmit"][aria-disabled="true"]',
    'button[disabled][class*="resubmit"]',
    'input[disabled][value*="Resubmit" i]',
    'a[class*="resubmit"][aria-disabled="true"]',
    '[class*="resubmit"].disabled',
  ].join(", "),

  // ── Assignment dashboard — the clickable similarity-score link (e.g. "20%") ──
  // Clicking it opens the viewer in a new tab (ev.turnitin.com/app/carta/e).
  similarityCell: [
    '.or-link',
    '[data-similarity]',
    '.similarity-score',
    'a[href*="viewer"]',
    'a[href*="ev.turnitin"]',
    'a:has-text("%")',
    'div[class*="similarity" i]',
  ].join(", "),

  // ── Viewer (ev.turnitin.com/app/carta/e) — download icon in right panel ──────
  // The actual element is <div role="button" title="Download" class="... tii-icon-download sidebar-download-button ...">
  // Keep a wide fallback net for future Turnitin UI changes.
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

  // ── Download popup — "Current View" option ──────────────────────────────────
  currentViewOption: [
    'button:has-text("Current View")',
    'a:has-text("Current View")',
    'li:has-text("Current View")',
    'span:has-text("Current View")',
    '[data-testid*="current-view" i]',
  ].join(", "),
};

// Turnitin message patterns when resubmission is refused.
// Sources: Turnitin help centre + observed student-facing messages.
const RESUBMIT_DENIED_TEXTS: RegExp[] = [
  // Turnitin's own help-centre wording
  /cannot resubmit/i,
  /resubmission is not allowed/i,
  /resubmissions.*not.*enabled/i,
  /not allowed to resubmit/i,
  /resubmit.*not.*available/i,
  // "You have N resubmission(s) left" warning modal (last attempt)
  /you have \d+ resubmission.* left/i,
  // "when you can submit next" timestamp message shown on disabled button
  /when you can submit next/i,
  /submission becomes available/i,
  // Generic fallbacks
  /you have already submitted/i,
  /submission limit/i,
  /paper already exists/i,
];

// ── Smart helpers: try hardcoded selector first, fall back to AI on timeout ────
//
// On TimeoutError / not-found, calls findElementWithAI to identify the element
// from the live DOM, then retries with the AI-derived selector.  On success,
// emits a [warn] [ai-fallback] log line so the operator knows which SEL entry
// needs updating.  If AI also fails, the function returns false / re-throws so
// existing error handling (slot freeing, retries) is unchanged.
//
// `smartFill` / `smartClick` are intentionally NOT async-retrying on their own —
// they are called from loops that already handle retries at the step level.

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

// Detects when Turnitin explicitly refuses a resubmission on the current slot.
// Checks: hardcoded deny selectors (stub) → page text heuristics → AI fallback.
// Returns true only on a clear denial signal; false on ambiguity (worker retries).
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

// AI intent map used by runStepRecovery — one entry per upload step.
const STEP_INTENTS: Record<number, { intent?: string; textWait?: string }> = {
  4: { intent: "the Upload and Review button to proceed to the submission review screen" },
  5: { intent: "the Submit to Turnitin button or Confirm button to complete the upload and submit it" },
  6: { textWait: "Submission Complete" },
  7: { textWait: "%" },  // similarity score visible on dashboard
};

// When step N fails, run AI-assisted recovery on steps N-1, N, and N+1.
// For click steps: dump the page, ask AI to find the element, click it, then
// wait for "Submission Complete" to confirm the submission path was reached.
// For text-wait steps: just poll for the text for up to 30s.
// Returns true if any of the three steps produced a "Submission Complete" signal.
async function runStepRecovery(
  page: Page,
  failedStep: number,
  onProgress: Logger,
): Promise<boolean> {
  await onProgress(
    `[recovery] step${failedStep} failed — AI recovery on steps ${failedStep - 1}–${failedStep + 1}`,
  );
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
        await onProgress(
          `[recovery] step${s}: AI click "${ai.selector}" — ${clicked ? "ok" : "miss"}`,
        );
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

export type SubmissionResult = {
  pdf: Buffer;
  submissionId: string | null;
};

export async function submitToTurnitin(opts: {
  slot: SlotInfo;
  fileBytes: Buffer;
  originalName: string;
  headless: boolean;
  submissionTimeoutMs: number;
  pollIntervalMs: number;
  uploadTimeoutMs: number;
  /** When set, the document was already submitted in a prior attempt — skip the
   *  upload modal and go straight to polling the similarity score on the same slot. */
  existingSubmissionId?: string | null;
  /** Called right after "Submission Complete!" so the worker can save the
   *  submission ID immediately (before the slow similarity-score wait). */
  onSubmitted?: (submissionId: string) => Promise<void>;
  onProgress: (msg: string) => Promise<void>;
}): Promise<SubmissionResult> {
  const { slot, fileBytes, originalName, headless, submissionTimeoutMs, pollIntervalMs, uploadTimeoutMs,
          existingSubmissionId, onSubmitted, onProgress } = opts;

  const tmp = await mkdtemp(join(tmpdir(), "tii-"));
  const filePath = join(tmp, originalName);
  await writeFile(filePath, fileBytes);

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    // Present as a normal desktop Chrome. Playwright's default headless UA
    // contains "HeadlessChrome", which Turnitin and similar sites often block
    // with a challenge page that has no login form (which then looks like a
    // missing selector). A realistic UA + viewport avoids that.
    const savedState = sessionCache.get(slot.account_id);
    const ctx = await browser.newContext({
      acceptDownloads: true,
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
      locale: "en-US",
      ...(savedState ? { storageState: savedState } : {}),
    });
    const page = await ctx.newPage();

    // ── Login (or reuse cached session) ──────────────────────────────────────
    let usedCachedSession = savedState != null;

    if (usedCachedSession) {
      // Navigate directly to the assignment dashboard with the cached session — skip login page.
      const targetUrl = slot.submit_url ?? slot.login_url;
      await onProgress(`cached session found for slot ${slot.slot_label} — navigating directly to ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForLoadState("load", { timeout: 60_000 }).catch(() => {});

      // If the login form appeared, the session expired — clear cache and fall through to full login.
      if (await locateInAnyFrame(page, SEL.emailInput)) {
        await onProgress(`cached session expired for slot ${slot.slot_label} — clearing cache, re-logging in`);
        sessionCache.delete(slot.account_id);
        usedCachedSession = false;
      } else {
        await onProgress(`session valid — login skipped for slot ${slot.slot_label}`);
      }
    }

    if (!usedCachedSession) {
      // Full login flow.
      await onProgress(`opening login: ${slot.login_url}`);
      await page.goto(slot.login_url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForLoadState("load", { timeout: 60_000 }).catch(() => {});

      await onProgress(`login page loaded: url=${page.url()} title=${await page.title().catch(() => "?")}`);

      // Find and fill the email field anywhere on the page (including iframes).
      const emailOk = await smartFill(page, SEL.emailInput, slot.email,
        "the email or username input field on the Turnitin login page", onProgress, 30_000);
      if (!emailOk) {
        await dumpPageControls(page, onProgress);
        throw new Error(
          "Could not find the Turnitin email field. The [diag] lines above list every input/button on the page — share them and I'll set the exact selectors. (The login URL may also be wrong for these accounts.)",
        );
      }
      const passwordOk = await smartFill(page, SEL.passwordInput, slot.password,
        "the password input field on the Turnitin login page", onProgress, 15_000);
      if (!passwordOk) {
        await dumpPageControls(page, onProgress);
        throw new Error("Found the email field but not the password field — see the [diag] lines above.");
      }

      await Promise.all([
        page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {}),
        smartClick(page, SEL.loginButton, "the Log in / Sign in submit button on the login page",
          onProgress, 15_000).catch(() => page.keyboard.press("Enter")),
      ]);
      await onProgress(`after login submit: url=${page.url()} title=${await page.title().catch(() => "?")}`);

      // If the email field is still present, the login almost certainly failed.
      // Also check for CAPTCHAs or unexpected pages via AI.
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

      // Save session state so the next job on this slot can skip login.
      const state = await ctx.storageState();
      sessionCache.set(slot.account_id, state);
      await onProgress(`session saved to cache for slot ${slot.slot_label}`);

      // ── Go to the assignment dashboard ──────────────────────────────────────
      // submit_url should be the .../assignment/type/paper/dashboard/<id> URL,
      // i.e. the page with the "Upload Submission" button.
      if (slot.submit_url) {
        await onProgress(`opening assignment dashboard: ${slot.submit_url}`);
        await page.goto(slot.submit_url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForLoadState("load", { timeout: 60_000 }).catch(() => {});
      } else {
        await onProgress("WARNING: slot has no submit_url; staying on the post-login page");
      }
    }

    // ── RESUME PATH: document already submitted in a prior attempt ─────────────
    // Skip the entire upload modal — the document is already in Turnitin.
    // Just wait for the similarity score on this same slot's dashboard.
    if (existingSubmissionId) {
      await onProgress(`resuming score-wait (already submitted, id=${existingSubmissionId})`);
      const submissionId = await waitForSimilarity(page, submissionTimeoutMs, pollIntervalMs, onProgress);
      const pdf = await downloadSimilarityPdf(page, onProgress);
      return { pdf, submissionId: submissionId ?? existingSubmissionId };
    }

    // ── Step 1: decide path based on what is on the page ──────────────────────
    //   Document present in slot → resubmit flow  (Turnitin 24 h cooldown enforced
    //                               at DB level by claim_next_job; also checked here)
    //   No document in slot      → fresh upload flow
    await onProgress("step1: checking page — looking for existing document or upload button");
    {
      const step1Deadline = Date.now() + 60_000;
      let step1Done = false;
      while (Date.now() < step1Deadline && !step1Done) {
        // Resubmit checked first: when a document is already there the upload
        // button may also be visible on some UI variants, so we must not
        // accidentally enter the fresh-upload path for a used slot.
        const hasResubmit = (await locateInAnyFrame(page, SEL.resubmitButton)) !== null;
        const hasUpload   = (await locateInAnyFrame(page, SEL.uploadSubmissionButton)) !== null;

        if (hasResubmit) {
          await onProgress("step1: existing document detected — checking if resubmit is allowed");
          // Pre-click: if the button is already disabled, Turnitin won't allow it.
          if (await isResubmitDenied(page, onProgress)) {
            throw new ResubmitDeniedError(slot.slot_label);
          }
          await onProgress("step1: resubmit allowed — proceeding");
          await smartClick(page, SEL.resubmitButton,
            "the resubmit or re-upload icon button for the existing paper submission", onProgress, 10_000);
          await onProgress("step1b: confirming resubmission dialog");
          await smartClick(page, SEL.confirmResubmission,
            "the Confirm button in the Confirm Resubmission dialog", onProgress, 15_000);
          // Allow any denial message to render, then check if Turnitin refused
          await page.waitForTimeout(1_500);
          if (await isResubmitDenied(page, onProgress)) {
            throw new ResubmitDeniedError(slot.slot_label);
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
        // Normal selectors exhausted — ask AI to identify the button from the page dump.
        const diagLines = await dumpPageControls(page, onProgress);
        const pageState = await aiDetectPageState(
          diagLines, page.url(), await page.title().catch(() => ""), onProgress,
        );
        if (pageState === "captcha") {
          throw new Error("CAPTCHA detected on dashboard — manual intervention required.");
        }
        if (pageState === "login") {
          throw new Error("Ended up back on the login page — session may have expired.");
        }
        // Try AI-guided click: resubmit first, then upload.
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
            "Check that the slot's submit_url is the assignment dashboard URL " +
            "(turnitin.com/assignment/type/paper/dashboard/<id>). See [diag] lines.",
          );
        }
        await onProgress("step1: AI-resolved button clicked — continuing");
      }
    }

    // ── Step 2: attach the file (hidden file input — no OS dialog) ──────────────
    await onProgress("step2: attaching file to the Submit File dialog");
    if (!(await setFileInAnyFrame(page, SEL.fileInput, filePath, 30_000))) {
      await dumpPageControls(page, onProgress);
      throw new Error("Could not find the file input in the Submit File dialog — see [diag] lines.");
    }

    // ── Step 3: ensure a submission title (defaults to the file name) ───────────
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
    // Normal path:   Review screen appears → "Submit to Turnitin" button
    // Slow preview:  Preview times out → hourglass + "Confirm" button
    //                ("You must click confirm to complete your upload.")
    // Both paths converge at Step 6 (wait for "Submission Complete!").
    await onProgress(`step5: waiting for 'Submit to Turnitin' or 'Confirm' (slow preview) — up to ${Math.round(uploadTimeoutMs / 1000)}s`);
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
          // Turnitin's Angular handler checks event.isTrusted — force:true and
          // dispatchEvent both fail.  Use mouse.move + mouse.click at real coordinates.
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
            // No bounding box (e.g. inside hidden iframe) — fall back to AI smartClick
            if (!confirmClicked) {
              await smartClick(page, SEL.confirmSlowPreview,
                "the Confirm button after the slow-preview hourglass screen", onProgress, 5_000);
              confirmClicked = true;
            }
          }
          // Verify the click registered: slow-preview text should disappear, or
          // "Submission Complete!" should appear.
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
        // All hardcoded selectors exhausted — try AI recovery on steps 4, 5, 6
        const recovered = await runStepRecovery(page, 5, onProgress);
        if (!recovered) {
          throw new Error(
            "Could not find 'Submit to Turnitin' or 'Confirm' button after upload — see [diag] lines.",
          );
        }
        // runStepRecovery confirmed "Submission Complete" — skip step 6 wait
        submissionConfirmedByRecovery = true;
      }
    }

    // ── Step 6: confirm completion and close the modal ─────────────────────────
    if (!submissionConfirmedByRecovery) {
      await onProgress("step6: waiting for 'Submission Complete!'");
      const completed = await waitForTextInAnyFrame(page, "Submission Complete", 120_000);
      if (!completed) {
        await onProgress("step6: 'Submission Complete!' not seen — attempting AI recovery");
        const recovered = await runStepRecovery(page, 6, onProgress);
        if (!recovered) {
          throw new Error(
            "Submission Complete! never appeared (120s + AI recovery). Restarting upload flow on same slot.",
          );
        }
      }
    }
    await tryClickInAnyFrame(page, SEL.closeModalButton, 10_000);
    await onProgress("submission complete; dialog closed");

    // Immediately save that this document has been submitted.  We extract the
    // submission_id from any <a href="...oid=N..."> link on the dashboard if
    // available; otherwise we use a sentinel so retries know to skip re-upload.
    const sentinelId = await extractSubmissionIdFromPage(page) ?? "TII:submitted";
    await onSubmitted?.(sentinelId);

    // ── Step 7: wait for the similarity score on the dashboard ─────────────────
    await onProgress("waiting for similarity score");
    const submissionId = await waitForSimilarity(page, submissionTimeoutMs, pollIntervalMs, onProgress);

    // ── Step 8: open viewer and download the PDF ───────────────────────────────
    await onProgress("downloading similarity PDF");
    const pdf = await downloadSimilarityPdf(page, onProgress);

    return { pdf, submissionId };
  } finally {
    await browser?.close().catch(() => {});
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// Return the first frame (main page or any iframe) that currently contains the
// selector, or null. Turnitin sometimes renders parts of the UI inside iframes.
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
      } catch { /* element appeared then detached; retry */ }
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
      } catch { /* appeared then detached / not yet clickable; retry */ }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`No element matched ${selector} within ${timeoutMs}ms`);
}

// Like clickInAnyFrame but returns false instead of throwing when nothing is found.
async function tryClickInAnyFrame(page: Page, selector: string, timeoutMs: number): Promise<boolean> {
  try {
    await clickInAnyFrame(page, selector, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

// Set files on a (possibly hidden) <input type=file> in any frame. setInputFiles
// works on hidden inputs, so this bypasses the OS file picker entirely.
async function setFileInAnyFrame(page: Page, selector: string, filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      const loc = f.locator(selector).first();
      const n = await loc.count().catch(() => 0);
      if (n > 0) {
        try {
          await loc.setInputFiles(filePath, { timeout: 5_000 });
          return true;
        } catch { /* appeared then detached; retry */ }
      }
    }
    await page.waitForTimeout(500);
  }
  return false;
}

// Best-effort: fill the submission title if the field exists and is empty/"Untitled".
async function setTitleIfEmpty(page: Page, selector: string, value: string, onProgress: (m: string) => Promise<void>): Promise<void> {
  // Try normal selector first; if missing, ask AI — title field is non-fatal either way.
  const frame = await locateInAnyFrame(page, selector);
  if (!frame) {
    // AI fallback for the title field
    const filled = await smartFill(page, selector, value,
      "the submission title text input field in the Submit File modal", onProgress, 5_000);
    if (!filled) {
      await onProgress("no submission-title field found (continuing — Turnitin may auto-fill it)");
    }
    return;
  }
  try {
    const loc = frame.locator(selector).first();
    const current = (await loc.inputValue({ timeout: 3_000 }).catch(() => "")) ?? "";
    if (!current.trim() || current.trim().toLowerCase() === "untitled") {
      await loc.fill(value, { timeout: 5_000 });
      await onProgress(`set submission title: ${value}`);
    }
  } catch { /* best effort — don't fail the run over the title */ }
}

// Wait until the given (case-sensitive substring) text appears in any frame.
async function waitForTextInAnyFrame(page: Page, text: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      const n = await f.locator(`text=${text}`).count().catch(() => 0);
      if (n > 0) return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

// Collect every input/button/link on the page (all frames) into an array of
// diagnostic strings, log them, and return them so the AI resolver can read them.
async function dumpPageControls(page: Page, onProgress: (m: string) => Promise<void>): Promise<string[]> {
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
            ]
              .filter(Boolean)
              .join(" ");
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

// Try to extract a Turnitin submission/paper oid from the current page.
// After a successful submission, Turnitin typically renders the paper title as
// an <a> whose href contains "oid=<number>".  Returns null if not found.
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

async function waitForSimilarity(page: Page, timeoutMs: number, pollMs: number, onProgress: (m: string) => Promise<void>): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let submissionId: string | null = null;

  while (Date.now() < deadline) {
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch { /* ignore */ }

    // Try to extract submission id from URL or from a paper link on the dashboard
    const url = page.url();
    const m = url.match(/oid=(\d+)/) ?? url.match(/submission[_-]?id=(\d+)/i);
    if (m) submissionId = m[1];
    if (!submissionId) submissionId = await extractSubmissionIdFromPage(page);

    // Look for a percentage on the similarity cell
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

// ─────────────────────────────────────────────────────────────────────────────
// Download flow (3 steps matching the Turnitin viewer UI):
//
//  Step 1 — Assignment dashboard: click the similarity-score link (e.g. "20%").
//            Turnitin opens ev.turnitin.com/app/carta/e in a new browser tab.
//
//  Step 2 — Viewer right panel: click the downward-arrow (Download) icon button.
//            A "Download" popup/modal appears.
//
//  Step 3 — Download popup: click "Current View".
//            The browser triggers a file download; capture and return the bytes.
// ─────────────────────────────────────────────────────────────────────────────
async function downloadSimilarityPdf(
  page: Page,
  onProgress: (m: string) => Promise<void>,
): Promise<Buffer> {
  const ctx = page.context();

  // Text pattern for the "Current View" download dialog option.
  // Regex so we match regardless of element type (<div>, <a>, <button>, etc.).
  const DL_OPTION_TEXT = /current\s*view/i;

  // ── Step 1: open the similarity viewer ──────────────────────────────────────
  await onProgress("dl-step1: clicking similarity score link to open viewer");
  const newPagePromise = ctx.waitForEvent("page", { timeout: 60_000 }).catch(() => null);

  const simClicked = await smartClick(page, SEL.similarityCell,
    "the similarity percentage link or score cell that opens the Turnitin report viewer", onProgress, 15_000);
  if (!simClicked) {
    await dumpPageControls(page, onProgress);
    throw new Error("Cannot click similarity cell — check [diag] lines above for correct selector");
  }

  // Viewer may open in a new tab (most common) or navigate in the same tab.
  let viewer = await newPagePromise;
  if (!viewer) {
    await onProgress("no new tab detected — assuming same-tab navigation");
    await page.waitForURL(/ev\.turnitin\.com/, { timeout: 30_000 }).catch(() => {});
    viewer = page;
  }

  await viewer.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => {});
  await onProgress(`dl-step1 done: viewer url=${viewer.url()}`);

  // The viewer is a React SPA — wait for toolbar to fully render.
  await viewer.waitForTimeout(6_000);

  // Move the mouse to the right panel area so any auto-hiding toolbar becomes
  // visible/active before we start looking for the download button.
  await viewer.mouse.move(1280, 450).catch(() => {});
  await viewer.waitForTimeout(1_000);

  // ── Steps 2+3: find download button → open dialog → click "Current View" ──────
  // Register the download listener NOW, before any clicking, so we never miss it.
  const downloadPromise = viewer.waitForEvent("download", { timeout: 120_000 });
  downloadPromise.catch(() => {});  // suppress unhandled-rejection crash

  // viewer is now definitely non-null — safe to close over it in helpers.
  const v = viewer;

  // Returns true when the download dialog is open (found "Current View" text in any frame).
  async function dlDialogOpen(): Promise<boolean> {
    for (const fr of v.frames()) {
      if ((await fr.getByText(DL_OPTION_TEXT).count().catch(() => 0)) > 0) return true;
    }
    return false;
  }

  // Clicks "Current View" in the open dialog using real mouse coordinates.
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

  // The confirmed download button HTML:
  //   <div role="button" title="Download" class="... tii-icon-download sidebar-download-button ...">
  // Clicking it opens a CENTER DIALOG with three options: "Current View", "Digital Receipt",
  // "Originally Submitted File".
  const DL_BTN_SEL = [
    '[class*="tii-icon-download"]',
    '[class*="sidebar-download-button"]',
    '[title="Download"]',
  ].join(", ");

  // Only look in the main frame — the toolbar lives there, not in the document sub-iframe.
  const mainFrame = viewer.mainFrame();

  let menuOpened = false;
  const dlBtnDeadline = Date.now() + 15_000;
  while (Date.now() < dlBtnDeadline && !menuOpened) {
    const n = await mainFrame.locator(DL_BTN_SEL).count().catch(() => 0);
    if (n > 0) {
      // Get the element's real screen coordinates and use viewer.mouse.click() —
      // this dispatches trusted low-level pointer events (isTrusted=true) that
      // React's event handlers respond to.  force:true / dispatchEvent both fail
      // on Turnitin because the app checks event.isTrusted.
      const box = await mainFrame.locator(DL_BTN_SEL).first().boundingBox().catch(() => null);
      if (box) {
        const cx = Math.round(box.x + box.width / 2);
        const cy = Math.round(box.y + box.height / 2);
        await onProgress(`dl-step2: download button found at (${cx},${cy}), hovering then clicking`);
        await viewer.mouse.move(cx, cy);
        await viewer.waitForTimeout(400);
        await viewer.mouse.click(cx, cy);
        await viewer.waitForTimeout(3_000); // allow dialog animation to complete
        if (await dlDialogOpen()) {
          await onProgress("dl-step2: dialog found — 'Current View' visible");
          menuOpened = true;
        } else {
          await onProgress("dl-step2: dialog not visible yet, retrying");
        }
      }
    }
    if (!menuOpened) await viewer.waitForTimeout(1_000);
  }

  // Probe fallback: iterate every [role="button"] in the main frame.
  // Only reached if the class-based fast path didn't match (future UI change).
  if (!menuOpened) {
    await onProgress("dl-step2: fast path missed — probing main-frame [role=button] elements");
    const btns = await mainFrame.locator("[role='button'], button").all().catch(() => [] as Locator[]);
    await onProgress(`dl-step2: probing ${btns.length} elements`);
    for (const btn of btns) {
      if (viewer.isClosed()) break;
      const beforeUrl = viewer.url();
      try {
        const box = await btn.boundingBox().catch(() => null);
        if (!box) continue;
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
        if (await dlDialogOpen()) { menuOpened = true; }
        if (menuOpened) break;
      } catch {
        if (viewer.isClosed()) break;
      }
    }
  }

  if (!menuOpened) {
    if (!viewer.isClosed()) await dumpPageControls(viewer, onProgress);
    throw new Error(
      "Could not open the Turnitin download menu — see [diag] lines above.",
    );
  }

  await viewer.waitForTimeout(500);

  // ── Step 3: click "Current View" in the open dialog ────────────────────────
  await onProgress("dl-step3: clicking 'Current View'");
  if (!(await clickCurrentView(15_000))) {
    if (!viewer.isClosed()) await dumpPageControls(viewer, onProgress);
    throw new Error("Download dialog open but could not click 'Current View' — see [diag] lines above.");
  }

  const download = await downloadPromise;
  const dlPath = await download.path();
  if (!dlPath) throw new Error("Turnitin download completed but no file path was returned");

  await onProgress("download received, reading file");
  return await readFile(dlPath);
}
