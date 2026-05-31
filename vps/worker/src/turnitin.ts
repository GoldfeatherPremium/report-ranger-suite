import { chromium, Browser, Page, Frame } from "playwright";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SlotInfo } from "./supabase.js";

// === Selectors — adjust here if Turnitin UI shifts ===
const SEL = {
  emailInput: 'input[name="email"], input#email, input[type="email"], input[name="user_email"], input[autocomplete="username"]',
  passwordInput: 'input[name="password"], input[name="user_password"], input#password, input#user_password, input[type="password"]',
  loginButton: 'button[type="submit"], input[type="submit"], button:has-text("Log in"), input[value="Log in"], input[value="Login"], #login',
  // Assignment dashboard -> opens the "Submit File" modal.
  uploadSubmissionButton: 'button:has-text("Upload Submission"), a:has-text("Upload Submission")',
  // Inside the "Submit File" modal.
  submissionTitle: 'input[placeholder="Untitled" i], input[name="title" i], input[aria-label*="title" i]',
  fileInput: 'input[type="file"]',
  uploadAndReviewButton: 'button:has-text("Upload and Review")',
  submitToTurnitinButton: 'button:has-text("Submit to Turnitin")',
  closeModal: 'button[aria-label="Close" i], button[title="Close" i], button.close',
  // Report retrieval (mapped in a later iteration).
  similarityCell: '[data-similarity], .similarity-score, .or-link',
  downloadReportButton: 'a:has-text("Download"), button:has-text("Download")',
};

export type SubmissionResult = {
  // null = the document was submitted but no report PDF was downloaded yet.
  pdf: Buffer | null;
  submissionId: string | null;
};

export async function submitToTurnitin(opts: {
  slot: SlotInfo;
  fileBytes: Buffer;
  originalName: string;
  headless: boolean;
  submissionTimeoutMs: number;
  pollIntervalMs: number;
  onProgress: (msg: string) => Promise<void>;
}): Promise<SubmissionResult> {
  const { slot, fileBytes, originalName, headless, submissionTimeoutMs, pollIntervalMs, onProgress } = opts;

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

    // The slot's Submit URL must be the assignment dashboard, e.g.
    //   https://www.turnitin.com/assignment/type/paper/dashboard/<id>?lang=en_us
    // Going straight there skips the class/assignment navigation.
    if (!slot.submit_url) {
      throw new Error(
        "This slot has no Submit URL. Set it to the Turnitin assignment dashboard URL (…/assignment/type/paper/dashboard/<id>).",
      );
    }
    await onProgress(`opening assignment: ${slot.submit_url}`);
    await page.goto(slot.submit_url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("load", { timeout: 60_000 }).catch(() => {});
    await onProgress(`assignment page: url=${page.url()} title=${await page.title().catch(() => "?")}`);

    // 1) Open the "Submit File" modal.
    await onProgress("clicking Upload Submission");
    try {
      await clickInAnyFrame(page, SEL.uploadSubmissionButton, 45_000);
    } catch {
      await dumpPageControls(page, onProgress);
      throw new Error("Could not find the 'Upload Submission' button on the assignment dashboard — see [diag] lines.");
    }

    // 2) Fill the submission title (defaults to the file name) and attach the file.
    await onProgress("filling submission form");
    await fillInAnyFrame(page, SEL.submissionTitle, originalName, 20_000).catch(() => {});
    const fileFrame = await waitForFrameWith(page, SEL.fileInput, 30_000);
    if (!fileFrame) {
      await dumpPageControls(page, onProgress);
      throw new Error("No file input appeared in the Submit File modal — see [diag] lines.");
    }
    await fileFrame.locator(SEL.fileInput).first().setInputFiles(filePath);
    await onProgress("file attached");

    // 3) Upload & review (large files take longer).
    await clickInAnyFrame(page, SEL.uploadAndReviewButton, 30_000);
    await onProgress("uploading, waiting for the review step");

    // 4) Confirm the submission. The review step can take a while to render
    //    while the file uploads/processes.
    await clickInAnyFrame(page, SEL.submitToTurnitinButton, Math.min(submissionTimeoutMs, 600_000));
    await onProgress("clicked Submit to Turnitin, waiting for confirmation");

    // 5) Wait for "Submission Complete!".
    const completed = await waitForTextInAnyFrame(page, /submission complete/i, 120_000);
    if (!completed) {
      await dumpPageControls(page, onProgress);
      throw new Error("Did not see 'Submission Complete' after submitting — see [diag] lines.");
    }
    await onProgress("submission complete");

    // Close the modal (best effort; not fatal).
    await clickInAnyFrame(page, SEL.closeModal, 5_000).catch(() => page.keyboard.press("Escape").catch(() => {}));

    // NOTE: report retrieval (wait for Similarity %, open the report, download
    // the PDF) is not mapped yet, so we stop here with the document submitted.
    // Returning pdf=null tells the caller to mark the job done WITHOUT trying
    // to download a report — and, importantly, without resubmitting on retry.
    await onProgress("document submitted to Turnitin (report download pending — not yet implemented)");
    void pollIntervalMs; // reserved for the report-polling step

    return { pdf: null, submissionId: null };
  } finally {
    await browser?.close().catch(() => {});
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function clickWhenVisible(page: Page, selector: string, timeoutMs: number) {
  await page.locator(selector).first().waitFor({ state: "visible", timeout: timeoutMs });
  await page.locator(selector).first().click();
}

// Return the first frame (main page or any iframe) that currently contains the
// selector, or null. Turnitin sometimes renders the login inside an iframe.
async function locateInAnyFrame(page: Page, selector: string): Promise<Frame | null> {
  for (const f of page.frames()) {
    const n = await f.locator(selector).count().catch(() => 0);
    if (n > 0) return f;
  }
  return null;
}

// Poll until some frame (main page or iframe) contains the selector.
async function waitForFrameWith(page: Page, selector: string, timeoutMs: number): Promise<Frame | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const f = await locateInAnyFrame(page, selector);
    if (f) return f;
    await page.waitForTimeout(500);
  }
  return null;
}

// Poll until any frame's visible text matches the regex.
async function waitForTextInAnyFrame(page: Page, re: RegExp, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      const body = await f.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
      if (re.test(body)) return true;
    }
    await page.waitForTimeout(1_000);
  }
  return false;
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
      await frame.locator(selector).first().click({ timeout: 5_000 });
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`No element matched ${selector} within ${timeoutMs}ms`);
}

// Log every input/button/link on the page (and in each iframe) so we can see
// the real DOM and pick correct selectors without a browser on the VPS.
async function dumpPageControls(page: Page, onProgress: (m: string) => Promise<void>) {
  try {
    await onProgress(`[diag] url=${page.url()} title=${await page.title().catch(() => "?")} frames=${page.frames().length}`);
    for (const f of page.frames()) {
      const controls = await f
        .$$eval("input, button, a[href], select, textarea", (els) =>
          els.slice(0, 50).map((e) => {
            const a = e as HTMLInputElement;
            return [
              a.tagName.toLowerCase(),
              a.type ? `type=${a.type}` : "",
              a.name ? `name=${a.name}` : "",
              a.id ? `id=${a.id}` : "",
              a.placeholder ? `ph=${a.placeholder}` : "",
              (a.textContent || "").trim() ? `txt=${(a.textContent || "").trim().slice(0, 25)}` : "",
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

async function waitForSimilarity(page: Page, timeoutMs: number, pollMs: number, onProgress: (m: string) => Promise<void>): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let submissionId: string | null = null;

  while (Date.now() < deadline) {
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch { /* ignore */ }

    // Try to extract submission id from URL or a hidden field
    const url = page.url();
    const m = url.match(/oid=(\d+)/) ?? url.match(/submission[_-]?id=(\d+)/i);
    if (m) submissionId = m[1];

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

async function downloadSimilarityPdf(page: Page): Promise<Buffer> {
  // Open the similarity report viewer, then trigger PDF download.
  // Turnitin's report viewer opens in a new tab; capture both contexts.
  const ctx = page.context();
  const newPagePromise = ctx.waitForEvent("page", { timeout: 30_000 }).catch(() => null);

  await page.locator(SEL.similarityCell).first().click().catch(() => {});
  const viewer = (await newPagePromise) ?? page;
  await viewer.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => {});

  const downloadPromise = viewer.waitForEvent("download", { timeout: 120_000 });
  await viewer.locator(SEL.downloadReportButton).first().click({ timeout: 30_000 }).catch(async () => {
    // Some skins use a menu — try opening it first
    await viewer.keyboard.press("d").catch(() => {});
  });
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("No download path");
  const { readFile } = await import("node:fs/promises");
  return await readFile(path);
}
