/**
 * Test the download flow only.
 * Logs in via the slot's credentials, navigates to the dashboard URL,
 * finds the similarity %, clicks through to the viewer, and downloads the PDF.
 *
 * Usage:
 *   npx tsx src/test-download.ts [slot_id]
 *
 * slot_id is optional — first active slot is used when omitted.
 * Output: test-download-output.pdf in the worker directory.
 */
import "dotenv/config";
import { chromium } from "playwright";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { supabase, getSlotInfo } from "./supabase.js";

// The dashboard page that already has a similarity score
const DASHBOARD_URL =
  "https://www.turnitin.com/assignment/type/paper/dashboard/167064674?lang=en_us";
const OUT_FILE = join(process.cwd(), "test-download-output.pdf");
const HEADLESS = (process.env.HEADLESS ?? "true") === "true";

const SEL_SIMILARITY = [
  ".or-link", "[data-similarity]", ".similarity-score",
  'a[href*="viewer"]', 'a[href*="ev.turnitin"]',
  'a:has-text("%")', 'div[class*="similarity" i]',
].join(", ");
const SEL_DOWNLOAD = [
  '[class*="tii-icon-download"]',
  '[class*="sidebar-download-button"]',
  '[class*="sidebar-download" i]',
  '[title="Download"]',
  '[aria-label="Download"]',
  '[aria-label*="download" i]',
  'button[data-testid*="download" i]',
  'button[class*="download" i]',
].join(", ");
const SEL_CURRENT_VIEW = [
  'button:has-text("Current View")', 'a:has-text("Current View")',
  'li:has-text("Current View")', 'span:has-text("Current View")',
  '[data-testid*="current-view" i]',
].join(", ");

type Page = import("playwright").Page;
type Frame = import("playwright").Frame;

function log(msg: string) {
  console.log(`[${new Date().toTimeString().slice(0, 8)}] ${msg}`);
}

async function locateInAnyFrame(page: Page, sel: string): Promise<Frame | null> {
  for (const f of page.frames()) {
    const n = await f.locator(sel).count().catch(() => 0);
    if (n > 0) return f;
  }
  return null;
}

// Use real mouse coordinates so Turnitin's event.isTrusted check passes.
async function mouseClick(page: Page, sel: string): Promise<boolean> {
  const frame = page.mainFrame();
  const n = await frame.locator(sel).count().catch(() => 0);
  if (n === 0) return false;
  const box = await frame.locator(sel).first().boundingBox().catch(() => null);
  if (!box) return false;
  const cx = Math.round(box.x + box.width / 2);
  const cy = Math.round(box.y + box.height / 2);
  await page.mouse.move(cx, cy);
  await page.waitForTimeout(300);
  await page.mouse.click(cx, cy);
  return true;
}

async function clickAnywhere(page: Page, sel: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await mouseClick(page, sel)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function dump(page: Page) {
  log(`[diag] url=${page.url()}  frames=${page.frames().length}`);
  for (const f of page.frames()) {
    const items = await f.$$eval(
      "input, button, a[href], [role=button]",
      (els) => els.slice(0, 80).map((el) => {
        const e = el as HTMLInputElement;
        return [
          e.tagName.toLowerCase(),
          e.type ? `type=${e.type}` : "",
          e.name ? `name=${e.name}` : "",
          e.id ? `id=${e.id}` : "",
          e.getAttribute("aria-label") ? `aria=${e.getAttribute("aria-label")}` : "",
          e.getAttribute("href") ? `href=${(e.getAttribute("href") ?? "").slice(0, 60)}` : "",
          (e.textContent ?? "").trim().slice(0, 40)
            ? `txt=${(e.textContent ?? "").trim().slice(0, 40)}` : "",
        ].filter(Boolean).join("  ");
      }),
    ).catch(() => [] as string[]);
    if (items.length) {
      log(`[diag] frame: ${f.url().slice(0, 90)}`);
      items.forEach((i) => log(`[diag]   <${i}>`));
    }
  }
}

async function main() {
  // Resolve slot
  let slotId = process.argv[2] ?? "";
  if (!slotId) {
    const { data, error } = await supabase
      .from("turnitin_slots")
      .select("id, label")
      .eq("is_active", true)
      .limit(1)
      .single();
    if (error || !data) {
      log(`ERROR: no active slot — ${error?.message}`);
      process.exit(1);
    }
    slotId = data.id as string;
    log(`Using first active slot: ${data.label} (${slotId})`);
  }

  const slot = await getSlotInfo(slotId);
  log(`Slot:      ${slot.slot_label}`);
  log(`Email:     ${slot.email}`);
  log(`Login URL: ${slot.login_url}`);
  log(`Dashboard: ${DASHBOARD_URL}`);
  log("─".repeat(60));

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({
    acceptDownloads: true,
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
  });
  const page = await ctx.newPage();

  try {
    // ── Login ─────────────────────────────────────────────────────────────────
    log(`opening login: ${slot.login_url}`);
    await page.goto(slot.login_url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("load", { timeout: 30_000 }).catch(() => {});

    const emailSel = 'input[name="email"], input#email, input[type="email"], input[name="user_email"], input[autocomplete="username"]';
    const pwdSel = 'input[name="password"], input#password, input[name="user_password"], input[type="password"]';
    const btnSel = 'button[type="submit"], input[type="submit"], button:has-text("Log in"), input[value="Log in"], input[name="Submit"]';

    // fill email
    let ok = false;
    const t1 = Date.now() + 30_000;
    while (Date.now() < t1 && !ok) {
      for (const f of page.frames()) {
        const n = await f.locator(emailSel).count().catch(() => 0);
        if (n > 0) { try { await f.locator(emailSel).first().fill(slot.email, { timeout: 5_000 }); ok = true; break; } catch { /**/ } }
      }
      if (!ok) await page.waitForTimeout(500);
    }
    if (!ok) { await dump(page); throw new Error("email field not found — see [diag]"); }
    log("email filled");

    // fill password
    ok = false;
    const t2 = Date.now() + 15_000;
    while (Date.now() < t2 && !ok) {
      for (const f of page.frames()) {
        const n = await f.locator(pwdSel).count().catch(() => 0);
        if (n > 0) { try { await f.locator(pwdSel).first().fill(slot.password, { timeout: 5_000 }); ok = true; break; } catch { /**/ } }
      }
      if (!ok) await page.waitForTimeout(500);
    }
    if (!ok) { await dump(page); throw new Error("password field not found — see [diag]"); }
    log("password filled");

    await Promise.all([
      page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {}),
      clickAnywhere(page, btnSel, 10_000).catch(async () => { await page.keyboard.press("Enter"); }),
    ]);
    log(`logged in — url: ${page.url()}`);

    // ── Go to dashboard ───────────────────────────────────────────────────────
    log(`navigating to dashboard: ${DASHBOARD_URL}`);
    await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    log(`dashboard loaded — url: ${page.url()}`);

    // ── Find similarity % ─────────────────────────────────────────────────────
    log("looking for similarity % in all frames…");
    let simText = "";
    for (const f of page.frames()) {
      const txt = await f.locator(SEL_SIMILARITY).first().innerText({ timeout: 3_000 }).catch(() => "");
      if (/\d+\s*%/.test(txt)) { simText = txt; break; }
    }
    if (!simText) {
      log("similarity % not found — dumping page:");
      await dump(page);
      throw new Error("Similarity % not visible — share [diag] output above");
    }
    log(`similarity: "${simText.trim()}"`);

    // ── Click % → viewer tab ──────────────────────────────────────────────────
    log("clicking similarity link…");
    const newTabPromise = ctx.waitForEvent("page", { timeout: 60_000 }).catch(() => null);
    await page.locator(SEL_SIMILARITY).first().click({ timeout: 15_000 }).catch(async (e: unknown) => {
      await dump(page);
      throw new Error(`click failed: ${e instanceof Error ? e.message : String(e)}`);
    });

    let viewer = await newTabPromise;
    if (!viewer) {
      log("no new tab — waiting for same-tab navigation to ev.turnitin.com…");
      await page.waitForURL(/ev\.turnitin\.com/, { timeout: 30_000 }).catch(() => {});
      viewer = page;
    }
    await viewer.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => {});
    log(`viewer: ${viewer.url()}`);

    log("waiting 6 s for viewer SPA to render…");
    await viewer.waitForTimeout(6_000);

    // Hover right panel so any auto-hiding toolbar becomes visible.
    await viewer.mouse.move(1280, 450).catch(() => {});
    await viewer.waitForTimeout(1_000);

    // ── Download icon ─────────────────────────────────────────────────────────
    log("clicking download icon…");
    if (!(await clickAnywhere(viewer, SEL_DOWNLOAD, 15_000))) {
      await dump(viewer);
      throw new Error("Download icon not found — share [diag] output above");
    }
    log("download popup open");
    await viewer.waitForTimeout(1_000);

    // ── Current View ──────────────────────────────────────────────────────────
    log("clicking 'Current View'…");
    const dlEvent = viewer.waitForEvent("download", { timeout: 60_000 });
    if (!(await clickAnywhere(viewer, SEL_CURRENT_VIEW, 15_000))) {
      await dump(viewer);
      throw new Error("'Current View' not found — share [diag] output above");
    }

    const dl = await dlEvent;
    const dlPath = await dl.path();
    if (!dlPath) throw new Error("download event fired but no file path");

    const bytes = await readFile(dlPath);
    await writeFile(OUT_FILE, bytes);
    log("─".repeat(60));
    log(`SUCCESS — ${OUT_FILE}  (${(bytes.length / 1024).toFixed(1)} KB)`);

  } catch (err) {
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

main();
