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
  submitFileButton: 'a:has-text("Submit"), button:has-text("Submit"), input[value="Submit" i], [title*="Submit" i], [aria-label*="Submit" i]',
  fileInput: 'input[type="file"]',
  confirmSubmit: 'button:has-text("Confirm"), input[value="Confirm"]',
  similarityCell: '[data-similarity], .similarity-score, .or-link',
  downloadReportButton: 'a:has-text("Download"), button:has-text("Download")',
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

    // Navigate to the slot's submit URL if provided, otherwise rely on the
    // default class list view.
    if (slot.submit_url) {
      await onProgress(`navigating to submit_url: ${slot.submit_url}`);
      await page.goto(slot.submit_url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForLoadState("load", { timeout: 60_000 }).catch(() => {});
    } else {
      await onProgress("no submit_url set on this slot — staying on the post-login home page");
    }
    await onProgress(`submit page: url=${page.url()} title=${await page.title().catch(() => "?")}`);

    await onProgress("opening submit form");
    try {
      await clickInAnyFrame(page, SEL.submitFileButton, 30_000);
    } catch {
      await dumpPageControls(page, onProgress);
      throw new Error(
        "Could not find a 'Submit' control after login. The [diag] lines above list every link/button on this page — share them and I'll map the class -> assignment -> submit navigation. (If the slot has no submit_url, set it to the assignment's submission page.)",
      );
    }

    await onProgress("uploading file");
    const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 30_000 }).catch(() => null);
    const directInput = await page.$(SEL.fileInput);
    if (directInput) {
      await directInput.setInputFiles(filePath);
    } else {
      const chooser = await fileChooserPromise;
      if (!chooser) throw new Error("No file chooser appeared");
      await chooser.setFiles(filePath);
    }
    await clickWhenVisible(page, SEL.confirmSubmit, 60_000).catch(() => {});

    await onProgress("waiting for similarity score");
    const submissionId = await waitForSimilarity(page, submissionTimeoutMs, pollIntervalMs, onProgress);

    await onProgress("downloading similarity PDF");
    const pdf = await downloadSimilarityPdf(page);

    return { pdf, submissionId };
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
