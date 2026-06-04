import { chromium, Browser, Page, Frame, BrowserContext, type Locator } from "playwright";
import { writeFile, mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssignmentInfo } from "./supabase.js";
import { aiDetectPageState } from "./ai-resolver.js";
import { findElementWithAI } from "./ai-helper.js";

export class ResubmitDeniedError extends Error {
  constructor(assignmentLabel: string) {
    super(`Turnitin refused resubmission on assignment "${assignmentLabel}" — trying next assignment`);
    this.name = "ResubmitDeniedError";
  }
}

type StorageStateObj = Awaited<ReturnType<import("playwright").BrowserContext["storageState"]>>;
const sessionCache = new Map<string, StorageStateObj>();

// ── Selectors ─────────────────────────────────────────────────────────────────
const SEL = {
  // Login
  emailInput: 'input[name="email"], input#email, input[type="email"], input[name="user_email"], input[autocomplete="username"]',
  passwordInput: 'input[name="password"], input[name="user_password"], input#password, input#user_password, input[type="password"]',
  loginButton: 'button[type="submit"], input[type="submit"], button:has-text("Log in"), input[value="Log in"], input[value="Login"], #login',

  // ⋮ "More" button on each student row.
  // CONFIRMED FROM [diag]: each row's action button is a plain light-DOM
  //   <button class="options-dropdown" aria-haspopup="true">More actions</button>
  // NOTE: the page also has decoy aria-haspopup buttons ("Instructor", "English"
  // nav) — we must NOT click those, so we scope by the "options-dropdown" class
  // and the "More actions" text. The safety gate is a second line of defence.
  moreDotsButton: [
    // Primary — confirmed exact match
    'button.options-dropdown',
    'button[aria-haspopup="true"]:has-text("More actions")',
    'button:has-text("More actions")',
    '[aria-label*="more actions" i]',
    // Web-component fallbacks (the popup menu items are tii-grn-* components)
    'tii-grn-dropdown tii-grn-button',
    'table tii-grn-button',
  ].join(", "),

  // "Submit file" dropdown item — tii-grn-dropdown-menu-item-alpha web component.
  // Playwright's :has-text() pierces shadow DOM so it matches the inner text.
  submitFileMenuItem: [
    'tii-grn-dropdown-menu-item-alpha:has-text("Submit file")',
    'tii-grn-dropdown-menu-item-alpha:has-text("Submit")',
    // Standard HTML fallbacks
    '[role="menuitem"]:has-text("Submit file")',
    'a:has-text("Submit file")',
    'li:has-text("Submit file")',
    '.p-menu-item-content:has-text("Submit")',
  ].join(", "),

  // File attachment
  fileInput: 'input[type="file"]',
  browseFilesButton: 'button:has-text("Browse Files"), button:has-text("Browse")',
  yourDeviceOption: [
    'a:has-text("Your device")',
    'button:has-text("Your device")',
    'li:has-text("Your device")',
    '[role="menuitem"]:has-text("Your device")',
  ].join(", "),

  // Submission title
  submissionTitleInput: [
    'input[name="title"]',
    'input#submission_title',
    'input[placeholder*="title" i]',
    'input[aria-label*="title" i]',
    'input[placeholder="File name"]',
    'input[placeholder*="name" i]',
  ].join(", "),

  // "Upload and Preview" button (instructor label — not "Upload and Review")
  uploadAndPreviewButton: [
    'button:has-text("Upload and Preview")',
    'input[value="Upload and Preview"]',
    'button:has-text("Upload and review")',
    'input[value="Upload and review"]',
  ].join(", "),

  // "Submit" button on the "Submit without preview" screen
  submitButton: [
    'button:has-text("Submit")',
    'input[value="Submit"]',
  ].join(", "),

  // "Submit to Turnitin" (alternative if preview renders fully)
  submitToTurnitinButton: [
    'button:has-text("Submit to Turnitin")',
    'input[value="Submit to Turnitin"]',
    'a:has-text("Submit to Turnitin")',
  ].join(", "),

  // Slow-preview confirmation
  slowPreviewText: 'text=click confirm to complete your upload',
  confirmSlowPreview: 'button:has-text("Confirm"), input[value="Confirm"]',

  // Close processing / success toasts
  closeToastButton: [
    'button[aria-label="Close" i]',
    'button[title="Close" i]',
    '.p-toast-icon-close',
    'button.close',
    '[data-dismiss="modal"]',
    'button:has-text("×")',
    '.toast-close',
    '.notification-close',
  ].join(", "),

  // "Resubmit file" dropdown item — tii-grn-dropdown-menu-item-alpha web component.
  resubmitMenuItem: [
    'tii-grn-dropdown-menu-item-alpha:has-text("Resubmit file")',
    'tii-grn-dropdown-menu-item-alpha:has-text("Resubmit")',
    // Standard HTML fallbacks
    '[role="menuitem"]:has-text("Resubmit file")',
    'a:has-text("Resubmit file")',
    'li:has-text("Resubmit file")',
    '[role="menuitem"]:has-text("Resubmit")',
  ].join(", "),
  // Confirm button in the resubmit dialog — likely also a tii-grn-button
  confirmResubmission: [
    'tii-grn-button:has-text("Confirm")',
    'button:has-text("Confirm")',
    'input[value="Confirm"]',
    'a:has-text("Confirm")',
  ].join(", "),
  resubmitDenied: [
    // tii-grn-dropdown-menu-item-alpha with disabled state
    'tii-grn-dropdown-menu-item-alpha[disabled]:has-text("Resubmit")',
    'tii-grn-dropdown-menu-item-alpha[aria-disabled="true"]:has-text("Resubmit")',
    // Standard fallbacks
    '[class*="resubmit"][disabled]',
    '[class*="resubmit"][aria-disabled="true"]',
    'button[disabled][class*="resubmit"]',
  ].join(", "),

  // Similarity score link (opens viewer)
  similarityCell: [
    'a[href*="submission-viewer"]',
    'a[href*="reports-ap"]',
    'a[href*="ev.turnitin"]',
    '.or-link',
    '[data-similarity]',
    '.similarity-score',
    'a:has-text("%")',
    'div[class*="similarity" i]',
    'span[class*="similarity" i]',
  ].join(", "),

  // Viewer "Download" text button (top right)
  viewerDownloadButton: [
    'button:has-text("Download")',
    'a:has-text("Download")',
    '[data-testid="download-button"]',
    '[data-testid*="download" i]',
    '[aria-label="Download"]',
    '[aria-label*="download" i]',
  ].join(", "),

  // Download popup options
  downloadSimilarityReport: [
    'button:has-text("Similarity Report")',
    'a:has-text("Similarity Report")',
    'li:has-text("Similarity Report")',
    '[role="menuitem"]:has-text("Similarity Report")',
    'span:has-text("Similarity Report")',
  ].join(", "),
  downloadAiWritingReport: [
    'button:has-text("AI Writing Report")',
    'a:has-text("AI Writing Report")',
    'li:has-text("AI Writing Report")',
    '[role="menuitem"]:has-text("AI Writing Report")',
    'span:has-text("AI Writing Report")',
  ].join(", "),
};

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

// ── Retry-aware click ─────────────────────────────────────────────────────────
// Clicks a button and verifies the expected UI state changed. Retries up to
// maxRetries times if the click registered but the page didn't advance.
async function retryClick(
  page: Page,
  selector: string,
  intent: string,
  successCheck: () => Promise<boolean>,
  log: Logger,
  maxRetries = 4,
  retryDelayMs = 2_500,
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const clicked = await smartClick(page, selector, intent, log, 12_000);
    if (!clicked) {
      await log(`[retry] could not find button (attempt ${attempt}/${maxRetries})`);
      await page.waitForTimeout(retryDelayMs);
      continue;
    }
    await page.waitForTimeout(retryDelayMs);
    if (await successCheck()) return true;
    if (attempt < maxRetries) {
      await log(`[retry] click did not advance page state (attempt ${attempt}/${maxRetries}) — retrying`);
    }
  }
  return false;
}

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
  await log(`[warn] [ai-fallback] intent="${intent}" selector=${ai.selector} — update SEL`);
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
  await log(`[warn] [ai-fallback] intent="${intent}" selector=${ai.selector} — update SEL`);
  return fillInAnyFrame(page, ai.selector, value, 5_000);
}

async function isResubmitDenied(page: Page, onProgress: Logger): Promise<boolean> {
  if (SEL.resubmitDenied && (await locateInAnyFrame(page, SEL.resubmitDenied))) {
    await onProgress("[warn] resubmit denied (disabled button)"); return true;
  }
  const body = await page.evaluate(() => document.body.innerText).catch(() => "");
  for (const pat of RESUBMIT_DENIED_TEXTS) {
    if (pat.test(body)) { await onProgress(`[warn] resubmit denied (text: ${pat})`); return true; }
  }
  const ai = await findElementWithAI(page, "an error message saying resubmission is not allowed or the slot is locked");
  if (ai) { await onProgress(`[warn] resubmit denied (AI: ${ai.reasoning})`); return true; }
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
  aiWaitTimeoutMs: number;
  existingSubmissionId?: string | null;
  onSubmitted?: (submissionId: string) => Promise<void>;
  onProgress: (msg: string) => Promise<void>;
}): Promise<InstructorSubmissionResult> {
  const { assignment, fileBytes, originalName, headless, submissionTimeoutMs, pollIntervalMs,
          uploadTimeoutMs, aiWaitTimeoutMs, existingSubmissionId, onSubmitted, onProgress } = opts;

  const titleBase = originalName.replace(/\.[^.]+$/, "");

  const tmp = await mkdtemp(join(tmpdir(), "tii-instr-"));
  const filePath = join(tmp, originalName);
  await writeFile(filePath, fileBytes);

  let browser: Browser | null = null;
  let ctxRef: BrowserContext | null = null;
  const accountId = assignment.account_id;

  try {
    browser = await chromium.launch({ headless, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

    const savedState = sessionCache.get(accountId);
    const ctx = await browser.newContext({
      acceptDownloads: true,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
      locale: "en-US",
      ...(savedState ? { storageState: savedState } : {}),
    });
    ctxRef = ctx;
    const page = await ctx.newPage();

    // ── Login / session reuse ──────────────────────────────────────────────────
    let usedCachedSession = savedState != null;
    if (usedCachedSession) {
      const targetUrl = assignment.submit_url ?? assignment.login_url;
      await onProgress(`cached session for ${assignment.account_label} — navigating to ${targetUrl}`);
      await gotoAssignmentPage(page, targetUrl, onProgress);
      if (await locateInAnyFrame(page, SEL.emailInput)) {
        await onProgress("cached session expired — re-logging in");
        sessionCache.delete(assignment.account_id);
        usedCachedSession = false;
      } else {
        await onProgress("session valid — login skipped");
      }
    }

    if (!usedCachedSession) {
      await onProgress(`opening login: ${assignment.login_url}`);
      await page.goto(assignment.login_url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForLoadState("load", { timeout: 60_000 }).catch(() => {});

      const emailOk = await smartFill(page, SEL.emailInput, assignment.email,
        "the email input on the Turnitin login page", onProgress, 30_000);
      if (!emailOk) { await dumpPageControls(page, onProgress); throw new Error("Email field not found — see [diag]"); }

      const passwordOk = await smartFill(page, SEL.passwordInput, assignment.password,
        "the password input on the Turnitin login page", onProgress, 15_000);
      if (!passwordOk) { await dumpPageControls(page, onProgress); throw new Error("Password field not found — see [diag]"); }

      await Promise.all([
        page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {}),
        smartClick(page, SEL.loginButton, "the Log in submit button", onProgress, 15_000)
          .catch(() => page.keyboard.press("Enter")),
      ]);

      if (await locateInAnyFrame(page, SEL.emailInput)) {
        const diagLines = await dumpPageControls(page, onProgress);
        const state = await aiDetectPageState(diagLines, page.url(), await page.title().catch(() => ""), onProgress);
        if (state === "captcha") throw new Error("CAPTCHA detected — manual intervention required.");
        throw new Error("Still on login form after submitting — check credentials (see [diag]).");
      }
      await onProgress("logged in");
      sessionCache.set(assignment.account_id, await ctx.storageState());

      if (assignment.submit_url) {
        await onProgress(`navigating to assignment page: ${assignment.submit_url}`);
        await gotoAssignmentPage(page, assignment.submit_url, onProgress);
      } else {
        await onProgress("[warn] no submit_url configured for this assignment — cannot open the assignment page. Set the Assignment URL in admin.");
      }
    }

    // ── RESUME PATH ────────────────────────────────────────────────────────────
    if (existingSubmissionId) {
      await onProgress(`resuming (already submitted, id=${existingSubmissionId})`);
      const submissionId = await waitForSimilarity(page, titleBase, submissionTimeoutMs, pollIntervalMs, onProgress);
      const aiReady = await waitForAiWritingScore(page, titleBase, aiWaitTimeoutMs, pollIntervalMs, onProgress);
      const { similarityPdf, aiPdf } = await downloadBothReports(page, ctx, titleBase, aiReady, onProgress);
      return { similarityPdf, aiPdf, submissionId: submissionId ?? existingSubmissionId };
    }

    // ── Step 1: click ⋮ on any row → "Resubmit file" ─────────────────────────
    // The assignment page always has pre-existing student rows (no empty rows).
    // The submission table is rendered inside a Turnitin iframe, so we must
    // search ALL frames — page.locator() only sees the main document.
    await onProgress("step1: searching all frames for ⋮ buttons in submission table");
    let submitFileOpened = false;
    {
      const step1Deadline = Date.now() + 90_000;
      while (Date.now() < step1Deadline && !submitFileOpened) {

        // Make sure below-fold rows are rendered before we look for buttons.
        await scrollAllFrames(page);

        // Detect ⋮ buttons via in-page evaluate (querySelectorAll) — this is the
        // SAME mechanism the [diag] dump uses and which reliably sees the
        // button.options-dropdown / "More actions" buttons that locator() misses.
        const dotFrames: { frame: Frame; count: number }[] = [];
        for (const frame of page.frames()) {
          const count = await tagDotsInFrame(frame);
          if (count > 0) dotFrames.push({ frame, count });
        }
        const totalDots = dotFrames.reduce((s, d) => s + d.count, 0);

        if (totalDots === 0) {
          // Diagnostic: show what aria-haspopup buttons DO exist
          for (const f of page.frames()) {
            const hpButtons = await f.$$eval(
              "button[aria-haspopup], [role='button'][aria-haspopup]",
              (els) => els.slice(0, 10).map((e) => {
                const el = e as HTMLElement;
                return `class="${el.className}" haspopup="${el.getAttribute("aria-haspopup") || ""}" text="${(el.innerText || "").slice(0, 30)}"`;
              }),
            ).catch(() => [] as string[]);
            if (hpButtons.length > 0) {
              await onProgress(`[diag] ${f.url().slice(0, 50)}: ${hpButtons.join(" | ")}`);
            }
          }
          // AI assistance (Gemini) — last resort when our heuristics find nothing.
          // Requires GEMINI_API_KEY in the worker .env; silently no-ops otherwise.
          const ai = await findElementWithAI(page, 'the three-dot "More actions" ⋮ button on a student submission row that opens a menu with "Resubmit file"');
          if (ai) {
            await onProgress(`[ai] step1: Gemini suggested selector: ${ai.selector} (${ai.reasoning})`);
            await tryClickInAnyFrame(page, ai.selector, 5_000);
            await page.waitForTimeout(1_200);
            if ((await menuItemFrame(page, ["resubmit", "submit file"])) === null) {
              await onProgress("[ai] step1: AI click did not open a submission menu — closing");
              await page.keyboard.press("Escape");
            }
          }

          await onProgress(`[warn] step1: no ⋮ "More actions" buttons found yet (${page.frames().length} frames) — scrolling + waiting`);
          await page.waitForTimeout(2_000);
          continue;
        }

        await onProgress(`step1: found ${totalDots} ⋮ button(s) across ${dotFrames.length} frame(s) — trying each row`);

        for (const { frame, count } of dotFrames) {
          if (submitFileOpened) break;
          for (let idx = 0; idx < count; idx++) {
            if (submitFileOpened) break;
            try {
              // Re-tag in case the DOM re-rendered between rows
              await tagDotsInFrame(frame);
              const clicked = await clickDotInFrame(frame, idx);
              if (!clicked) continue;
              await onProgress(`step1: clicked ⋮ on row ${idx + 1}`);

              // Wait up to 3s for the popup menu to render
              let hasResubmit = false;
              let hasSubmitFile = false;
              for (let w = 0; w < 6; w++) {
                await page.waitForTimeout(500);
                hasResubmit   = (await menuItemFrame(page, ["resubmit"]))     !== null;
                hasSubmitFile = (await menuItemFrame(page, ["submit file"]))  !== null;
                if (hasResubmit || hasSubmitFile) break;
              }

              // SAFETY: close immediately if not a submission menu
              if (!hasResubmit && !hasSubmitFile) {
                await onProgress(`[warn] step1: row ${idx + 1} popup not a submission menu — closing`);
                await page.keyboard.press("Escape");
                await page.waitForTimeout(300);
                continue;
              }

              if (hasResubmit) {
                await onProgress(`step1: row ${idx + 1} → clicking 'Resubmit file'`);
                if (await isResubmitDenied(page, onProgress)) {
                  await onProgress(`step1: row ${idx + 1} denied — trying next row`);
                  await page.keyboard.press("Escape");
                  await page.waitForTimeout(400);
                  continue;
                }
                const ok = await clickMenuItem(page, ["resubmit"]);
                if (!ok) { await page.keyboard.press("Escape"); continue; }
                await page.waitForTimeout(800);
                // Confirm dialog (if any)
                if ((await menuItemFrame(page, ["confirm"])) !== null) {
                  await onProgress("step1: confirming resubmit dialog");
                  await clickMenuItem(page, ["confirm"]);
                  await page.waitForTimeout(1_000);
                }
                if (await isResubmitDenied(page, onProgress)) throw new ResubmitDeniedError(assignment.assignment_label);
                submitFileOpened = true;
              } else {
                await onProgress(`step1: row ${idx + 1} → clicking 'Submit file'`);
                const ok = await clickMenuItem(page, ["submit file", "submit"]);
                if (!ok) { await page.keyboard.press("Escape"); continue; }
                submitFileOpened = true;
              }
            } catch (rowErr) {
              if (rowErr instanceof ResubmitDeniedError) throw rowErr;
              await onProgress(`[warn] step1: row ${idx + 1} attempt failed (${rowErr instanceof Error ? rowErr.message : String(rowErr)}) — next row`);
            }
          }
        }
        if (!submitFileOpened) await page.waitForTimeout(1_000);
      }

      if (!submitFileOpened) {
        await dumpPageControls(page, onProgress);
        const diagLines = await dumpPageControls(page, onProgress);
        const state = await aiDetectPageState(diagLines, page.url(), await page.title().catch(() => ""), onProgress);
        if (state === "captcha") throw new Error("CAPTCHA on assignment page.");
        if (state === "login")   throw new Error("Redirected to login — session expired.");
        throw new Error("No empty student row found — all slots in cooldown or submit_url wrong. See [diag].");
      }
    }

    // ── Step 2: attach file ────────────────────────────────────────────────────
    await onProgress("step2: attaching file");
    let fileAttached = await setFileInAnyFrame(page, SEL.fileInput, filePath, 10_000);
    if (!fileAttached) {
      await smartClick(page, SEL.browseFilesButton, "the Browse Files button in the Submit file dialog", onProgress, 10_000);
      await page.waitForTimeout(600);
      await smartClick(page, SEL.yourDeviceOption, "the Your device option in the Browse Files dropdown", onProgress, 5_000);
      await page.waitForTimeout(600);
      fileAttached = await setFileInAnyFrame(page, SEL.fileInput, filePath, 15_000);
    }
    if (!fileAttached) { await dumpPageControls(page, onProgress); throw new Error("File attach failed — see [diag]."); }
    await onProgress(`step2: attached ${originalName}`);

    // ── Step 3: submission title ───────────────────────────────────────────────
    await setTitleIfEmpty(page, SEL.submissionTitleInput, titleBase, onProgress);

    // ── Step 4: Upload and Preview (with retry) ────────────────────────────────
    await onProgress("step4: clicking 'Upload and Preview'");
    const step4ok = await retryClick(
      page,
      SEL.uploadAndPreviewButton,
      "the Upload and Preview button to upload the file",
      async () => {
        // Success: either the submit button appeared or the slow-preview text appeared
        const hasSubmit      = (await locateInAnyFrame(page, SEL.submitButton))          !== null;
        const hasSubmitTII   = (await locateInAnyFrame(page, SEL.submitToTurnitinButton)) !== null;
        const hasSlowPreview = (await locateInAnyFrame(page, SEL.slowPreviewText))       !== null;
        const hasProcessing  = await waitForTextInAnyFrame(page, "file is processing", 500);
        return hasSubmit || hasSubmitTII || hasSlowPreview || hasProcessing;
      },
      onProgress,
    );
    if (!step4ok) { await dumpPageControls(page, onProgress); throw new Error("'Upload and Preview' click never advanced — see [diag]."); }

    // ── Step 5: Submit (with retry) ────────────────────────────────────────────
    await onProgress(`step5: waiting for Submit button (up to ${Math.round(uploadTimeoutMs / 1000)}s)`);
    let submissionConfirmed = false;
    {
      const step5Deadline = Date.now() + uploadTimeoutMs;
      while (Date.now() < step5Deadline && !submissionConfirmed) {
        if (await waitForTextInAnyFrame(page, "File submitted", 500)) {
          await onProgress("step5: 'File submitted' detected — already done");
          submissionConfirmed = true; break;
        }
        if (await waitForTextInAnyFrame(page, "file is processing", 500)) {
          await onProgress("step5: processing toast detected — already done");
          submissionConfirmed = true; break;
        }

        const hasSubmit      = (await locateInAnyFrame(page, SEL.submitButton))          !== null;
        const hasSubmitTII   = (await locateInAnyFrame(page, SEL.submitToTurnitinButton)) !== null;
        const hasSlowPreview = (await locateInAnyFrame(page, SEL.slowPreviewText))       !== null;

        const sel = hasSubmit ? SEL.submitButton : hasSubmitTII ? SEL.submitToTurnitinButton : null;

        if (sel) {
          // Trusted mouse click
          let clicked = false;
          for (const frame of page.frames()) {
            const loc = frame.locator(sel).first();
            if ((await loc.count().catch(() => 0)) === 0) continue;
            const box = await loc.boundingBox().catch(() => null);
            if (box) {
              await page.mouse.move(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
              await page.waitForTimeout(200);
              await page.mouse.click(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
              clicked = true; break;
            }
          }
          if (!clicked) await smartClick(page, sel, "the Submit button to confirm the file upload", onProgress, 5_000);
          await page.waitForTimeout(3_000);
          // Check if it registered
          if (await waitForTextInAnyFrame(page, "file is processing", 2_000) ||
              await waitForTextInAnyFrame(page, "File submitted", 2_000)) {
            submissionConfirmed = true;
          } else {
            await onProgress("[retry] Submit click may not have registered — will retry");
          }
        } else if (hasSlowPreview) {
          for (const frame of page.frames()) {
            const loc = frame.locator(SEL.confirmSlowPreview).first();
            if ((await loc.count().catch(() => 0)) === 0) continue;
            const box = await loc.boundingBox().catch(() => null);
            if (!box) continue;
            await page.mouse.move(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
            await page.waitForTimeout(200);
            await page.mouse.click(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
            break;
          }
          await page.waitForTimeout(2_500);
          if (await waitForTextInAnyFrame(page, "file is processing", 2_000) ||
              await waitForTextInAnyFrame(page, "File submitted", 2_000)) {
            submissionConfirmed = true;
          }
        } else {
          await page.waitForTimeout(500);
        }
      }
      if (!submissionConfirmed) { await dumpPageControls(page, onProgress); throw new Error("Submit never confirmed — see [diag]."); }
    }

    // ── Step 6: close success toast ────────────────────────────────────────────
    await waitForTextInAnyFrame(page, "submitted successfully", 60_000);
    await tryClickInAnyFrame(page, SEL.closeToastButton, 5_000);
    await onProgress("step6: submission confirmed");
    await page.waitForTimeout(1_000);

    const sentinelId = await extractSubmissionIdFromPage(page) ?? "TII:submitted";
    await onSubmitted?.(sentinelId);

    // ── Step 7a: wait for OUR row's similarity score ───────────────────────────
    await onProgress("step7a: waiting for similarity score in our row");
    const submissionId = await waitForSimilarity(page, titleBase, submissionTimeoutMs, pollIntervalMs, onProgress);

    // ── Step 7b: wait for AI Writing score (up to aiWaitTimeoutMs) ────────────
    const aiWaitMin = Math.round(aiWaitTimeoutMs / 60_000);
    await onProgress(`step7b: waiting for AI Writing score (up to ${aiWaitMin} min — will skip if not ready)`);
    const aiReady = await waitForAiWritingScore(page, titleBase, aiWaitTimeoutMs, pollIntervalMs, onProgress);

    // ── Steps 8+9: download from viewer ───────────────────────────────────────
    await onProgress(`step8${aiReady ? "+9" : ""}: opening viewer for "${titleBase}" and downloading`);
    const { similarityPdf, aiPdf } = await downloadBothReports(page, ctx, titleBase, aiReady, onProgress);

    return { similarityPdf, aiPdf, submissionId };

  } finally {
    // Refresh the session cache with the latest cookies from this job so the
    // NEXT job for the same account skips login entirely.
    if (ctxRef) {
      try {
        sessionCache.set(accountId, await ctxRef.storageState());
      } catch { /* ignore — stale cache is acceptable */ }
    }
    await browser?.close().catch(() => {});
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Wait for AI Writing score in our specific row ─────────────────────────────
// Reloads the page and checks if our row's AI Writing column shows *% or a number%.
// Returns false after aiWaitTimeoutMs without throwing — a missing AI score is not fatal.
async function waitForAiWritingScore(
  page: Page,
  titleBase: string,
  timeoutMs: number,
  pollMs: number,
  onProgress: Logger,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let lastLogAt = 0;

  while (Date.now() < deadline) {
    try { await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }); } catch { /* ignore */ }

    // Detect AI Writing score in our specific row.
    // Valid AI scores: 0% (no AI), *% (low/special), 20-100% (AI detected).
    // We find the "AI Wri" column index from the header to avoid confusing
    // the AI Writing cell with the Similarity cell in the same row.
    const aiReady = await page.evaluate((title) => {
      // Locate the AI Writing column index
      let aiColIndex = -1;
      const headerCells = Array.from(document.querySelectorAll(
        "thead th, thead [role=columnheader], tr:first-child th, tr:first-child [role=columnheader]",
      ));
      for (let i = 0; i < headerCells.length; i++) {
        if (/ai\s*wri/i.test(headerCells[i].textContent ?? "")) { aiColIndex = i; break; }
      }

      const rows = Array.from(document.querySelectorAll("tbody tr, tr:not(thead *), [role=row]"));
      for (const row of rows) {
        if (!(row.textContent ?? "").toLowerCase().includes(title.toLowerCase())) continue;

        if (aiColIndex >= 0) {
          const cells = Array.from(row.querySelectorAll("td, [role=cell]"));
          const cell = cells[aiColIndex];
          if (cell) {
            const t = (cell.textContent ?? "").trim();
            // Ready: any value that is not "--", not empty, not a loading placeholder
            return t !== "--" && t !== "" && t !== "..." && t !== "—";
          }
        }

        // Fallback: *% is unambiguous — only the AI Writing column uses this format
        return /\*%/.test(row.textContent ?? "");
      }
      return false;
    }, titleBase).catch(() => false);

    if (aiReady) {
      await onProgress("step7b: AI Writing score visible in our row");
      return true;
    }

    const remaining = Math.round((deadline - Date.now()) / 60_000);
    if (Date.now() - lastLogAt > 60_000) {
      await onProgress(`step7b: AI Writing not ready yet — ${remaining} min remaining before skip`);
      lastLogAt = Date.now();
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  await onProgress(`step7b: AI Writing score did not appear within ${Math.round(timeoutMs / 60_000)} min — similarity-only report will be saved`);
  return false;
}

// ── Download both reports (or similarity only) from the Turnitin viewer ───────
// Always clicks OUR specific row's similarity link (matched by titleBase)
// to avoid accidentally opening another submission's report.
async function downloadBothReports(
  page: Page,
  ctx: BrowserContext,
  titleBase: string,
  includeAi: boolean,
  onProgress: Logger,
): Promise<{ similarityPdf: Buffer; aiPdf: Buffer | null }> {
  const viewer = await openViewerForOwnRow(page, ctx, titleBase, onProgress);

  // ── Similarity Report ──────────────────────────────────────────────────────
  await onProgress("viewer: downloading Similarity Report");
  const similarityPdf = await downloadFromViewerMenu(
    viewer, SEL.downloadSimilarityReport,
    "the Similarity Report option in the Download popup", onProgress,
  );

  // ── AI Writing Report (only if score was ready) ───────────────────────────
  let aiPdf: Buffer | null = null;
  if (includeAi) {
    await onProgress("viewer: downloading AI Writing Report");
    aiPdf = await downloadAiFromViewerMenu(viewer, onProgress);
  } else {
    await onProgress("viewer: AI Writing score was not ready — skipping AI download");
  }

  return { similarityPdf, aiPdf };
}

// Open the Turnitin viewer by clicking the similarity % link IN OUR SPECIFIC ROW.
// Matches the row by titleBase so other rows with % values are not accidentally clicked.
async function openViewerForOwnRow(
  page: Page,
  ctx: BrowserContext,
  titleBase: string,
  onProgress: Logger,
): Promise<Page> {
  await onProgress(`viewer: opening viewer for row matching "${titleBase}"`);
  const newPagePromise = ctx.waitForEvent("page", { timeout: 60_000 }).catch(() => null);

  // Method 1: Playwright row-scoped locator
  let clicked = false;
  try {
    // Find the row containing our title, then the similarity link within it
    const rowLoc = page.locator(`tr:has-text("${titleBase}"), [role=row]:has-text("${titleBase}")`).first();
    const count = await rowLoc.count().catch(() => 0);
    if (count > 0) {
      const simLoc = rowLoc.locator(SEL.similarityCell).first();
      if ((await simLoc.count().catch(() => 0)) > 0) {
        const box = await simLoc.boundingBox().catch(() => null);
        if (box) {
          await page.mouse.move(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
          await page.waitForTimeout(200);
          await page.mouse.click(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
          clicked = true;
          await onProgress("viewer: clicked similarity link in our row");
        }
      }
    }
  } catch { /* fall through */ }

  // Method 2: JS evaluation to get the href and navigate directly
  if (!clicked) {
    const href = await page.evaluate((title) => {
      const rows = Array.from(document.querySelectorAll("tr, [role=row]"));
      for (const row of rows) {
        if (!(row.textContent ?? "").toLowerCase().includes(title.toLowerCase())) continue;
        const link = row.querySelector('a[href*="submission-viewer"], a[href*="reports-ap"], a[href*="ev.turnitin"]');
        if (link) return (link as HTMLAnchorElement).href;
        const pctLink = Array.from(row.querySelectorAll("a"))
          .find((a) => /\d+\s*%|\*%/.test(a.textContent ?? ""));
        if (pctLink) return (pctLink as HTMLAnchorElement).href;
      }
      return null;
    }, titleBase).catch(() => null);

    if (href) {
      await onProgress(`viewer: navigating directly to viewer URL for our row: ${href.slice(0, 80)}`);
      await page.goto(href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      clicked = true;
    }
  }

  // Method 3: AI fallback
  if (!clicked) {
    const ai = await findElementWithAI(page,
      `the similarity percentage link (e.g. "11%") for our specific submission titled "${titleBase}" in the student submission table`);
    if (ai) {
      await onProgress(`[warn] [ai-fallback] viewer link via AI: ${ai.selector}`);
      await tryClickInAnyFrame(page, ai.selector, 5_000);
      clicked = true;
    }
  }

  if (!clicked) {
    await dumpPageControls(page, onProgress);
    throw new Error(`Cannot find similarity link for our submission "${titleBase}" — see [diag].`);
  }

  let viewer = await newPagePromise;
  if (!viewer) {
    await page.waitForURL(/reports-ap\.integrity\.turnitin\.com|ev\.turnitin\.com/, { timeout: 30_000 }).catch(() => {});
    viewer = page;
  }

  await viewer.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => {});
  await onProgress(`viewer loaded: ${viewer.url().slice(0, 80)}`);
  await viewer.waitForTimeout(6_000);
  return viewer;
}

async function downloadFromViewerMenu(
  viewer: Page,
  reportOptionSelector: string,
  reportOptionIntent: string,
  onProgress: Logger,
): Promise<Buffer> {
  const downloadPromise = viewer.waitForEvent("download", { timeout: 120_000 });
  downloadPromise.catch(() => {});

  const menuOpened = await openViewerDownloadMenu(viewer, onProgress);
  if (!menuOpened) {
    await dumpPageControls(viewer, onProgress);
    throw new Error("Could not open viewer Download menu — see [diag].");
  }

  const optionClicked = await clickMenuOption(viewer, reportOptionSelector, reportOptionIntent, onProgress);
  if (!optionClicked) {
    await dumpPageControls(viewer, onProgress);
    throw new Error(`Could not click "${reportOptionIntent}" in Download menu — see [diag].`);
  }

  const download = await downloadPromise;
  const dlPath = await download.path();
  if (!dlPath) throw new Error("Download completed but no file path returned.");
  await onProgress("report downloaded");
  return await readFile(dlPath);
}

async function downloadAiFromViewerMenu(viewer: Page, onProgress: Logger): Promise<Buffer | null> {
  try {
    const downloadPromise = viewer.waitForEvent("download", { timeout: 120_000 });
    downloadPromise.catch(() => {});

    const menuOpened = await openViewerDownloadMenu(viewer, onProgress);
    if (!menuOpened) { await onProgress("[warn] ai-dl: Download menu failed — AI marked failed"); return null; }

    const clicked = await clickMenuOption(viewer, SEL.downloadAiWritingReport,
      "the AI Writing Report option in the Download popup", onProgress);
    if (!clicked) { await onProgress("[warn] ai-dl: AI Writing Report option not found — marked failed"); return null; }

    const download = await downloadPromise;
    const dlPath = await download.path();
    if (!dlPath) { await onProgress("[warn] ai-dl: no download path — marked failed"); return null; }
    await onProgress("ai-dl: AI Writing Report downloaded");
    return await readFile(dlPath);
  } catch (err) {
    await onProgress(`[warn] ai-dl: ${err instanceof Error ? err.message : String(err)} — marked failed`);
    return null;
  }
}

async function openViewerDownloadMenu(viewer: Page, onProgress: Logger): Promise<boolean> {
  const DL_MENU = /similarity report|ai writing report/i;

  async function menuVisible(): Promise<boolean> {
    for (const fr of viewer.frames()) {
      const txt = await fr.evaluate(() => document.body.innerText).catch(() => "");
      if (DL_MENU.test(txt)) return true;
    }
    return false;
  }

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await menuVisible()) return true;

    for (const frame of viewer.frames()) {
      const loc = frame.locator(SEL.viewerDownloadButton).first();
      if ((await loc.count().catch(() => 0)) === 0) continue;
      const box = await loc.boundingBox().catch(() => null);
      if (!box) continue;
      await viewer.mouse.move(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
      await viewer.waitForTimeout(300);
      await viewer.mouse.click(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
      await viewer.waitForTimeout(1_500);
      if (await menuVisible()) return true;
    }

    const ai = await findElementWithAI(viewer, "the Download button at the top right of the Turnitin viewer that opens a popup with Similarity Report and AI Writing Report options");
    if (ai) {
      await onProgress(`[warn] [ai-fallback] Download button via AI: ${ai.selector}`);
      await tryClickInAnyFrame(viewer, ai.selector, 5_000);
      await viewer.waitForTimeout(1_500);
      if (await menuVisible()) return true;
    }
    await viewer.waitForTimeout(1_000);
  }
  return false;
}

async function clickMenuOption(viewer: Page, selector: string, intent: string, onProgress: Logger): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const frame of viewer.frames()) {
      const loc = frame.locator(selector).first();
      if ((await loc.count().catch(() => 0)) === 0) continue;
      const box = await loc.boundingBox().catch(() => null);
      if (box) {
        await viewer.mouse.move(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
        await viewer.waitForTimeout(200);
        await viewer.mouse.click(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
        return true;
      }
      await loc.click({ timeout: 3_000 }).catch(() => {});
      return true;
    }
    const ai = await findElementWithAI(viewer, intent);
    if (ai) {
      await onProgress(`[warn] [ai-fallback] menu option via AI: ${ai.selector}`);
      await tryClickInAnyFrame(viewer, ai.selector, 5_000);
      return true;
    }
    await viewer.waitForTimeout(400);
  }
  return false;
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

// Dump a targeted summary of assignment page: rows, buttons, and iframes.
// This runs once after page settle so we can read the exact selectors from the logs.
async function dumpAssignmentPageControls(page: Page, onProgress: Logger): Promise<void> {
  try {
    await onProgress(`[diag] url=${page.url()}`);
    await onProgress(`[diag] frames=${page.frames().length}, title="${await page.title().catch(() => "?")}"`);

    for (const f of page.frames()) {
      const fUrl = f.url().slice(0, 80);

      // Summarise all table rows
      const rowSummaries = await f.evaluate(() => {
        const rows = Array.from(document.querySelectorAll("tr, [role=row]")).slice(0, 20);
        return rows.map((r) => ({
          tag: r.tagName,
          text: (r.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80),
          children: r.children.length,
        }));
      }).catch(() => [] as {tag:string;text:string;children:number}[]);

      if (rowSummaries.length) {
        await onProgress(`[diag] frame(${fUrl}) rows (${rowSummaries.length}):`);
        for (const r of rowSummaries) {
          await onProgress(`[diag]   <${r.tag} children=${r.children}> "${r.text}"`);
        }
      }

      // Dump every button on the page with all its attributes
      const buttons = await f.evaluate(() => {
        const els = Array.from(document.querySelectorAll(
          "button, [role=button], [aria-haspopup], [aria-label], [data-testid], [data-pc-section]"
        )).slice(0, 60);
        return els.map((e) => {
          const el = e as HTMLElement;
          return [
            el.tagName.toLowerCase(),
            el.getAttribute("type")          ? `type=${el.getAttribute("type")}` : "",
            el.getAttribute("aria-label")    ? `aria-label="${el.getAttribute("aria-label")}"` : "",
            el.getAttribute("aria-haspopup") ? `aria-haspopup="${el.getAttribute("aria-haspopup")}"` : "",
            el.getAttribute("aria-controls") ? `aria-controls="${el.getAttribute("aria-controls")}"` : "",
            el.getAttribute("title")         ? `title="${el.getAttribute("title")}"` : "",
            el.getAttribute("data-testid")   ? `data-testid="${el.getAttribute("data-testid")}"` : "",
            el.getAttribute("data-pc-section") ? `data-pc-section="${el.getAttribute("data-pc-section")}"` : "",
            el.className                     ? `class="${el.className.toString().slice(0, 60)}"` : "",
            (el.textContent ?? "").trim()    ? `txt="${(el.textContent ?? "").trim().replace(/\s+/g," ").slice(0, 40)}"` : "",
          ].filter(Boolean).join(" ");
        });
      }).catch(() => [] as string[]);

      if (buttons.length) {
        await onProgress(`[diag] frame(${fUrl}) interactive elements (${buttons.length}):`);
        for (const b of buttons) await onProgress(`[diag]   <${b}>`);
      }
    }
  } catch (e) {
    await onProgress(`[diag] dump error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Navigate to the assignment submit_url and wait for the SPA to actually render.
// The Turnitin assignment page is a slow client-rendered SPA that can take
// 1–15s to paint the student submission table after the document loads, so
// `domcontentloaded`/`load` alone fire too early. We additionally wait for
// network to settle and for the submission table (or the ⋮ More button) to
// appear, with a hard cap so a quiet page still proceeds.
async function gotoAssignmentPage(page: Page, url: string, onProgress: Logger): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("load", { timeout: 60_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

  // Wait up to 30s for the student table / ⋮ controls to render.
  // The student rows + ⋮ "More actions" buttons sit BELOW the fold, so we scroll
  // down on each poll to bring them into view (lazy/virtualised rows only render
  // once scrolled). Scroll the main page and every frame body.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await scrollAllFrames(page);
    const rowCount = await page.locator("table tbody tr, [role=row], tii-grn-submission-row").count().catch(() => 0);
    const ready =
      (await locateInAnyFrame(page, SEL.moreDotsButton)) !== null ||
      (await locateInAnyFrame(page, SEL.submitFileMenuItem)) !== null ||
      (await locateInAnyFrame(page, SEL.resubmitMenuItem)) !== null ||
      (await locateInAnyFrame(page, 'button.options-dropdown, button:has-text("More actions")')) !== null ||
      rowCount > 1;
    if (ready) {
      await onProgress(`assignment page ready (${rowCount} rows): ${page.url().slice(0, 90)}`);
      // Dump all buttons/interactive elements on the page so we can see exactly
      // what selectors to use for the ⋮ button in this Turnitin UI version.
      await dumpAssignmentPageControls(page, onProgress);
      return;
    }
    // If we got bounced back to a login form, stop waiting — caller handles it.
    if (await locateInAnyFrame(page, SEL.emailInput)) return;
    await page.waitForTimeout(1_000);
  }
  await onProgress(`assignment page settle timeout — dumping page controls for diagnosis:`);
  await dumpAssignmentPageControls(page, onProgress);
}

// Scroll the main page and every child frame to the bottom, then partway back up.
// The submission table / ⋮ buttons render below the fold and only paint once
// scrolled into view; this nudges lazy/virtualised rows to materialise.
async function scrollAllFrames(page: Page): Promise<void> {
  for (const f of page.frames()) {
    await f.evaluate(() => {
      const docEl = document.scrollingElement || document.documentElement || document.body;
      if (docEl) docEl.scrollTop = docEl.scrollHeight;
      // Also scroll any inner scrollable containers (the table often lives in one)
      document.querySelectorAll<HTMLElement>("*").forEach((el) => {
        if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 0) {
          el.scrollTop = el.scrollHeight;
        }
      });
    }).catch(() => {});
  }
  await page.mouse.wheel(0, 1200).catch(() => {});
}

// ── evaluate-based ⋮ / menu helpers ─────────────────────────────────────────────
// Playwright's locator() CSS matching has proven unreliable against this page's
// markup (it returns 0 even when the button demonstrably exists in the [diag]
// dump). These helpers drive detection + clicking through in-page evaluate /
// querySelectorAll — exactly what the diag uses, and which reliably sees them.

// Tag every candidate ⋮ "More actions" button in a frame with data-tii-dot=N and
// return how many were found. Excludes the "Instructor"/"English" nav decoys.
async function tagDotsInFrame(frame: Frame): Promise<number> {
  return await frame.evaluate(() => {
    const all = Array.from(document.querySelectorAll("button, [role=button], tii-grn-button")) as HTMLElement[];
    let n = 0;
    for (const el of all) {
      el.removeAttribute("data-tii-dot");
      const cls = (el.className && el.className.toString()) || "";
      const txt = (el.innerText || el.textContent || "").trim().toLowerCase();
      const hp  = el.getAttribute("aria-haspopup");
      const isDot =
        cls.includes("options-dropdown") ||
        txt.includes("more actions") ||
        (hp === "true" && txt === "more");
      if (isDot) { el.setAttribute("data-tii-dot", String(n)); n++; }
    }
    return n;
  }).catch(() => 0);
}

// Click the ⋮ button previously tagged with data-tii-dot=idx in this frame.
async function clickDotInFrame(frame: Frame, idx: number): Promise<boolean> {
  return await frame.evaluate((i) => {
    const el = document.querySelector(`[data-tii-dot="${i}"]`) as HTMLElement | null;
    if (!el) return false;
    el.scrollIntoView({ block: "center", inline: "center" });
    el.click();
    return true;
  }, idx).catch(() => false);
}

// Find the frame currently showing a dropdown menu item matching any needle.
// Strategy (in order of reliability):
//   1. tii-grn-dropdown-menu-item-alpha title/label attrs  (LIGHT DOM — always readable)
//   2. tii-grn-dropdown-menu-item-alpha shadowRoot text    (works for open shadow roots)
//   3. Presence of ANY tii-grn-dropdown-menu-item-alpha    (these elements are unique
//      to the submission row action menu — if they exist, the right menu is open)
//   4. Standard innerText/textContent on other elements
async function menuItemFrame(page: Page, needles: string[]): Promise<Frame | null> {
  for (const f of page.frames()) {
    const found = await f.evaluate((ns) => {
      // 1 & 2 & 3: tii-grn-dropdown-menu-item-alpha (Turnitin web component)
      const tiiItems = Array.from(
        document.querySelectorAll("tii-grn-dropdown-menu-item-alpha"),
      ) as HTMLElement[];
      if (tiiItems.length > 0) {
        for (const el of tiiItems) {
          // Light-DOM attributes (most reliable — title is set to the label text)
          const attrs = [
            el.getAttribute("title")      || "",
            el.getAttribute("label")      || "",
            el.getAttribute("aria-label") || "",
            el.getAttribute("data-label") || "",
            el.innerText                  || "",
            el.textContent                || "",
          ].join(" ").toLowerCase();
          // Shadow-root text (works when shadow root is open)
          let shadowText = "";
          try {
            shadowText = (el.shadowRoot?.textContent || el.shadowRoot?.querySelector(".button-label, .label, [part=label]")?.textContent || "").toLowerCase();
          } catch { /* closed shadow root — ignore */ }
          const full = attrs + " " + shadowText;
          if (ns.some((n) => full.includes(n))) return true;
        }
        // Fallback 3: any tii-grn items present → this IS the submission menu
        // (these elements only appear in row action dropdowns)
        if (ns.some((n) => ["resubmit", "submit", "submit file", "confirm"].includes(n))) {
          return true;
        }
      }
      // 4. Standard text search on other element types
      const els = Array.from(document.querySelectorAll(
        "[role=menuitem], li, a, button, span, div[slot=title]",
      )) as HTMLElement[];
      return els.some((el) => {
        const t = (el.innerText || el.textContent || "").trim().toLowerCase();
        return t.length < 60 && ns.some((n) => t.includes(n));
      });
    }, needles).catch(() => false);
    if (found) return f;
  }
  return null;
}

// Click the first dropdown menu item matching any needle.
// Same attribute-priority strategy as menuItemFrame.
async function clickMenuItem(page: Page, needles: string[]): Promise<boolean> {
  for (const f of page.frames()) {
    const clicked = await f.evaluate((ns) => {
      // Try tii-grn-dropdown-menu-item-alpha first (title attr is most reliable)
      const tiiItems = Array.from(
        document.querySelectorAll("tii-grn-dropdown-menu-item-alpha"),
      ) as HTMLElement[];
      for (const el of tiiItems) {
        const attrs = [
          el.getAttribute("title")      || "",
          el.getAttribute("label")      || "",
          el.getAttribute("aria-label") || "",
          el.getAttribute("data-label") || "",
          el.innerText                  || "",
          el.textContent                || "",
        ].join(" ").toLowerCase();
        let shadowText = "";
        try { shadowText = (el.shadowRoot?.textContent || "").toLowerCase(); } catch { /* */ }
        if (ns.some((n) => (attrs + " " + shadowText).includes(n))) {
          el.scrollIntoView({ block: "center" });
          el.click();
          return true;
        }
      }
      // Position-based fallback for tii-grn items (known menu order:
      // 0=Open report, 1=Copy submission, 2=Resubmit, 3=Grant extension, 4=Download)
      if (tiiItems.length > 0 && ns.some((n) => n.includes("resubmit"))) {
        const target = tiiItems[2] || tiiItems[tiiItems.length - 1];
        target.scrollIntoView({ block: "center" });
        target.click();
        return true;
      }
      if (tiiItems.length > 0 && ns.some((n) => n.includes("submit"))) {
        // "Submit file" — pick first item that isn't obviously wrong
        (tiiItems[0] || tiiItems[0]).click();
        return true;
      }
      // Standard fallback
      const els = Array.from(document.querySelectorAll(
        "[role=menuitem], li, a, button, div[slot=title]",
      )) as HTMLElement[];
      for (const el of els) {
        const t = (el.innerText || el.textContent || "").trim().toLowerCase();
        if (t.length < 60 && ns.some((n) => t.includes(n))) {
          const clickable = (el.closest("button, a, [role=menuitem], tii-grn-dropdown-menu-item-alpha") as HTMLElement) || el;
          clickable.scrollIntoView({ block: "center" });
          clickable.click();
          return true;
        }
      }
      return false;
    }, needles).catch(() => false);
    if (clicked) return true;
  }
  return false;
}

async function locateInAnyFrame(page: Page, selector: string): Promise<Frame | null> {
  for (const f of page.frames()) {
    if ((await f.locator(selector).count().catch(() => 0)) > 0) return f;
  }
  return null;
}

async function fillInAnyFrame(page: Page, selector: string, value: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = await locateInAnyFrame(page, selector);
    if (frame) {
      try { await frame.locator(selector).first().fill(value, { timeout: 5_000 }); return true; } catch { /* retry */ }
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
      try { await frame.locator(selector).first().click({ timeout: 5_000 }); return; } catch { /* retry */ }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`No element matched ${selector} within ${timeoutMs}ms`);
}

async function tryClickInAnyFrame(page: Page, selector: string, timeoutMs: number): Promise<boolean> {
  try { await clickInAnyFrame(page, selector, timeoutMs); return true; } catch { return false; }
}

async function setFileInAnyFrame(page: Page, selector: string, filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      const loc = f.locator(selector).first();
      if ((await loc.count().catch(() => 0)) > 0) {
        try { await loc.setInputFiles(filePath, { timeout: 5_000 }); return true; } catch { /* retry */ }
      }
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function setTitleIfEmpty(page: Page, selector: string, value: string, onProgress: Logger): Promise<void> {
  const frame = await locateInAnyFrame(page, selector);
  if (!frame) {
    await smartFill(page, selector, value, "the submission title input in the Submit file dialog", onProgress, 5_000);
    return;
  }
  try {
    const loc = frame.locator(selector).first();
    const current = (await loc.inputValue({ timeout: 3_000 }).catch(() => "")) ?? "";
    if (!current.trim() || /^(untitled|file name)$/i.test(current.trim())) {
      await loc.fill(value, { timeout: 5_000 });
      await onProgress(`submission title set: ${value}`);
    }
  } catch { /* best effort */ }
}

async function waitForTextInAnyFrame(page: Page, text: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      if ((await f.locator(`text=${text}`).count().catch(() => 0)) > 0) return true;
      const body = await f.evaluate(() => document.body.innerText).catch(() => "");
      if (body.toLowerCase().includes(text.toLowerCase())) return true;
    }
    await page.waitForTimeout(400);
  }
  return false;
}

async function dumpPageControls(page: Page, onProgress: Logger): Promise<string[]> {
  const lines: string[] = [];
  try {
    const header = `[diag] url=${page.url()} title=${await page.title().catch(() => "?")} frames=${page.frames().length}`;
    await onProgress(header); lines.push(header);
    for (const f of page.frames()) {
      const controls = await f.$$eval(
        "input, button, a[href], select, textarea, [role=button], [role=menuitem], li",
        (els) => els.slice(0, 80).map((e) => {
          const a = e as HTMLInputElement;
          return [
            a.tagName.toLowerCase(),
            a.type        ? `type=${a.type}` : "",
            a.name        ? `name=${a.name}` : "",
            a.id          ? `id=${a.id}` : "",
            a.getAttribute("aria-label")  ? `aria=${a.getAttribute("aria-label")}` : "",
            a.getAttribute("data-testid") ? `testid=${a.getAttribute("data-testid")}` : "",
            a.placeholder ? `ph=${a.placeholder}` : "",
            a.className   ? `cls=${a.className.toString().slice(0, 80)}` : "",
            (a.textContent || "").trim()  ? `txt=${(a.textContent || "").trim().slice(0, 40)}` : "",
          ].filter(Boolean).join(" ");
        }),
      ).catch(() => [] as string[]);
      if (controls.length) {
        const fh = `[diag] frame(${f.url().slice(0, 80)}):`;
        await onProgress(fh); lines.push(fh);
        for (const c of controls) { const l = `[diag]   <${c}>`; await onProgress(l); lines.push(l); }
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
      const url = f.url();
      const m = url.match(/trn:oid::[\d:]+/) ?? url.match(/oid=(\d+)/) ?? url.match(/submission[_-]?id=(\d+)/i);
      if (m) return m[0];
      const href = await f.locator('a[href*="oid="]').first().getAttribute("href", { timeout: 2_000 }).catch(() => null);
      if (href) { const hm = href.match(/oid=(\d+)/); if (hm) return hm[1]; }
    }
  } catch { /* best-effort */ }
  return null;
}

// Wait for OUR row's similarity score to appear. Matches by titleBase so other
// rows with pre-existing % values are ignored.
async function waitForSimilarity(
  page: Page,
  titleBase: string,
  timeoutMs: number,
  pollMs: number,
  onProgress: Logger,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let submissionId: string | null = null;

  while (Date.now() < deadline) {
    try { await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }); } catch { /* ignore */ }

    submissionId = submissionId ?? await extractSubmissionIdFromPage(page);

    // Look for a % in our specific row (by title)
    const found = await page.evaluate((title) => {
      const rows = Array.from(document.querySelectorAll("tr, [role=row]"));
      for (const row of rows) {
        const rowText = (row.textContent ?? "").toLowerCase();
        if (!rowText.includes(title.toLowerCase())) continue;
        // Find a similarity link (a[href] with % text, or coloured badge)
        const simLink = row.querySelector('a[href*="submission-viewer"], a[href*="reports-ap"]');
        if (simLink && /\d+\s*%/.test(simLink.textContent ?? "")) return simLink.textContent?.trim() ?? null;
        // Fallback: any % text in the row
        const pctEl = Array.from(row.querySelectorAll("a, span, div, td"))
          .find((el) => /\d+\s*%/.test(el.textContent ?? "") && !(el.textContent ?? "").includes(title));
        if (pctEl) return (pctEl.textContent ?? "").trim();
      }
      return null;
    }, titleBase).catch(() => null);

    if (found) {
      await onProgress(`step7a: similarity score for our row: ${found}`);
      return submissionId;
    }

    await onProgress(`step7a: similarity not yet ready — sleeping ${Math.round(pollMs / 1000)}s`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error("Timed out waiting for similarity score");
}
