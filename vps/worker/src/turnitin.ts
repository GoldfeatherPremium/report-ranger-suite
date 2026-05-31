import { chromium, Browser, Page, Frame, type Locator } from "playwright";
import { writeFile, mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SlotInfo } from "./supabase.js";

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
    'button:has-text("Submit")',
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

  // ── Submission Complete modal — close it ─────────────────────────────────────
  closeModalButton: [
    'button[aria-label="Close" i]',
    'button[title="Close" i]',
    '[data-dismiss="modal"]',
    '.modal button.close',
    'button:has-text("×")',
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
  downloadButton: [
    'button[aria-label="Download"]',
    'button[aria-label*="download" i]',
    'button[title*="Download" i]',
    'button[data-testid*="download" i]',
    'button[class*="download" i]',
    '[aria-label="Download report"]',
    'a[aria-label*="download" i]',
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
    const ctx = await browser.newContext({
      acceptDownloads: true,
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
      locale: "en-US",
    });
    const page = await ctx.newPage();

    // ── Login ────────────────────────────────────────────────────────────────
    await onProgress(`opening login: ${slot.login_url}`);
    await page.goto(slot.login_url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("load", { timeout: 60_000 }).catch(() => {});

    await onProgress(`login page loaded: url=${page.url()} title=${await page.title().catch(() => "?")}`);

    // Find and fill the email field anywhere on the page (including iframes).
    const emailOk = await fillInAnyFrame(page, SEL.emailInput, slot.email, 30_000);
    if (!emailOk) {
      await dumpPageControls(page, onProgress);
      throw new Error(
        "Could not find the Turnitin email field. The [diag] lines above list every input/button on the page — share them and I'll set the exact selectors. (The login URL may also be wrong for these accounts.)",
      );
    }
    const passwordOk = await fillInAnyFrame(page, SEL.passwordInput, slot.password, 15_000);
    if (!passwordOk) {
      await dumpPageControls(page, onProgress);
      throw new Error("Found the email field but not the password field — see the [diag] lines above.");
    }

    await Promise.all([
      page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {}),
      clickInAnyFrame(page, SEL.loginButton, 15_000).catch(() => page.keyboard.press("Enter")),
    ]);
    await onProgress(`after login submit: url=${page.url()} title=${await page.title().catch(() => "?")}`);

    // If the email field is still present, the login almost certainly failed
    // (wrong credentials, captcha, or an unexpected page) — surface it clearly.
    if (await locateInAnyFrame(page, SEL.emailInput)) {
      await dumpPageControls(page, onProgress);
      throw new Error("Still on a login form after submitting — login likely failed (check credentials/captcha; see [diag] lines).");
    }
    await onProgress("logged in");

    // ── Go to the assignment dashboard ─────────────────────────────────────────
    // submit_url should be the .../assignment/type/paper/dashboard/<id> URL,
    // i.e. the page with the "Upload Submission" button.
    if (slot.submit_url) {
      await onProgress(`opening assignment dashboard: ${slot.submit_url}`);
      await page.goto(slot.submit_url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForLoadState("load", { timeout: 60_000 }).catch(() => {});
    } else {
      await onProgress("WARNING: slot has no submit_url; staying on the post-login page");
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

    // ── Step 1: open the Submit File modal ─────────────────────────────────────
    await onProgress("step1: clicking 'Upload Submission'");
    if (!(await tryClickInAnyFrame(page, SEL.uploadSubmissionButton, 30_000))) {
      await dumpPageControls(page, onProgress);
      throw new Error(
        "Could not find the 'Upload Submission' button on the assignment dashboard. " +
        "Check that the slot's submit_url is the assignment dashboard URL " +
        "(turnitin.com/assignment/type/paper/dashboard/<id>). See [diag] lines.",
      );
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
    if (!(await tryClickInAnyFrame(page, SEL.uploadAndReviewButton, 30_000))) {
      await dumpPageControls(page, onProgress);
      throw new Error("Could not find the 'Upload and Review' button — see [diag] lines.");
    }

    // ── Step 5: wait for the review screen, then Submit to Turnitin ─────────────
    // Uploading can take 15s–5min depending on file size, so wait generously for
    // the "Submit to Turnitin" button to appear.
    await onProgress(`step5: waiting for review screen, then 'Submit to Turnitin' (up to ${Math.round(uploadTimeoutMs / 1000)}s)`);
    if (!(await tryClickInAnyFrame(page, SEL.submitToTurnitinButton, uploadTimeoutMs))) {
      await dumpPageControls(page, onProgress);
      throw new Error("Could not find the 'Submit to Turnitin' button on the review screen — see [diag] lines.");
    }

    // ── Step 6: confirm completion and close the modal ─────────────────────────
    await onProgress("step6: waiting for 'Submission Complete!'");
    const completed = await waitForTextInAnyFrame(page, "Submission Complete", 120_000);
    if (!completed) {
      await onProgress("did not see 'Submission Complete!' text within 2 min — continuing anyway");
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
  const frame = await locateInAnyFrame(page, selector);
  if (!frame) {
    await onProgress("no submission-title field found (continuing — Turnitin may auto-fill it)");
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

// Log every input/button/link on the page (and in each iframe) so we can see
// the real DOM and pick correct selectors without a browser on the VPS.
async function dumpPageControls(page: Page, onProgress: (m: string) => Promise<void>) {
  try {
    await onProgress(`[diag] url=${page.url()} title=${await page.title().catch(() => "?")} frames=${page.frames().length}`);
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
              (a.textContent || "").trim() ? `txt=${(a.textContent || "").trim().slice(0, 30)}` : "",
            ]
              .filter(Boolean)
              .join(" ");
          }),
        )
        .catch(() => [] as string[]);
      if (controls.length) {
        await onProgress(`[diag] frame(${f.url().slice(0, 70)}):`);
        for (const c of controls) await onProgress(`[diag]   <${c}>`);
      }
    }
  } catch (e) {
    await onProgress(`[diag] dump failed: ${e instanceof Error ? e.message : String(e)}`);
  }
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

  // Broad selector for any download-menu option across Turnitin viewer versions.
  // Covers: "Current View", "Current Page", role="menuitem" variants, data attrs.
  const SEL_DL_OPTION = [
    '[role="menuitem"]:has-text("Current")',
    '[role="option"]:has-text("Current")',
    'li:has-text("Current View")',
    'li:has-text("Current Page")',
    'button:has-text("Current View")',
    'button:has-text("Current Page")',
    'a:has-text("Current View")',
    'a:has-text("Current Page")',
    'span:has-text("Current View")',
    'span:has-text("Current Page")',
    '[role="menuitem"]:has-text("PDF")',
    '[role="menuitem"]:has-text("Similarity")',
    '[data-testid*="current-view" i]',
    '[data-testid*="current-page" i]',
    '[class*="download-option" i]',
  ].join(", ");

  // ── Step 1: open the similarity viewer ──────────────────────────────────────
  await onProgress("dl-step1: clicking similarity score link to open viewer");
  const newPagePromise = ctx.waitForEvent("page", { timeout: 60_000 }).catch(() => null);

  await page.locator(SEL.similarityCell).first().click({ timeout: 15_000 }).catch(async (e: unknown) => {
    await onProgress(`similarity cell click failed (${e instanceof Error ? e.message : String(e)}), dumping page`);
    await dumpPageControls(page, onProgress);
    throw new Error("Cannot click similarity cell — check [diag] lines above for correct selector");
  });

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

  // ── Steps 2+3: find download button → open menu → click download option ─────
  // Register the download listener NOW, before any clicking, so we never miss it.
  const downloadPromise = viewer.waitForEvent("download", { timeout: 120_000 });

  await onProgress("dl-step2: looking for download button");

  // First try attribute-based selectors (fast path).
  let menuOpened = await tryClickInAnyFrame(viewer, SEL.downloadButton, 8_000);

  if (!menuOpened) {
    // Probe fallback: click every button in the viewer one by one.
    // After each click, check if a download-menu option appeared anywhere.
    // This handles SVG-only icon buttons that have no aria-label or title.
    await onProgress("dl-step2: no labelled button found — probing all buttons for download menu");
    outer: for (const f of viewer.frames()) {
      const btns = await f.locator("button").all().catch(() => [] as Locator[]);
      for (const btn of btns) {
        try {
          await btn.click({ timeout: 2_000 });
          await viewer.waitForTimeout(1_200);
          for (const fr of viewer.frames()) {
            if ((await fr.locator(SEL_DL_OPTION).count().catch(() => 0)) > 0) {
              menuOpened = true;
              break outer;
            }
          }
        } catch { /* not interactable or stale — try next */ }
      }
    }
  }

  if (!menuOpened) {
    await dumpPageControls(viewer, onProgress);
    throw new Error(
      "Probed all buttons in the Turnitin viewer but no download menu appeared. " +
      "See [diag] lines above.",
    );
  }

  await viewer.waitForTimeout(500);

  // ── Step 3: click the download option inside the menu ───────────────────────
  await onProgress(`dl-step3: clicking download option in menu`);
  if (!(await tryClickInAnyFrame(viewer, SEL_DL_OPTION, 15_000))) {
    await dumpPageControls(viewer, onProgress);
    throw new Error(
      "Download menu opened but no recognised option found. " +
      "See [diag] lines above.",
    );
  }

  const download = await downloadPromise;
  const dlPath = await download.path();
  if (!dlPath) throw new Error("Turnitin download completed but no file path was returned");

  await onProgress("download received, reading file");
  return await readFile(dlPath);
}
