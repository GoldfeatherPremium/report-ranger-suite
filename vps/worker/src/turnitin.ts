import { chromium, Browser, Page } from "playwright";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SlotInfo } from "./supabase.js";

// === Selectors — adjust here if Turnitin UI shifts ===
const SEL = {
  emailInput: 'input[name="email"], input#email, input[type="email"]',
  passwordInput: 'input[name="password"], input#password, input[type="password"]',
  loginButton: 'button[type="submit"], input[type="submit"]',
  submitFileButton: 'a:has-text("Submit"), button:has-text("Submit")',
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
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();

    await onProgress(`opening login: ${slot.login_url}`);
    await page.goto(slot.login_url, { waitUntil: "domcontentloaded", timeout: 60_000 });

    await page.fill(SEL.emailInput, slot.email);
    await page.fill(SEL.passwordInput, slot.password);
    await Promise.all([
      page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {}),
      page.click(SEL.loginButton),
    ]);
    await onProgress("logged in");

    // Navigate to the slot's submit URL if provided, otherwise rely on the
    // default class list view.
    if (slot.submit_url) {
      await page.goto(slot.submit_url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }

    await onProgress("opening submit form");
    await clickWhenVisible(page, SEL.submitFileButton, 30_000);

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
