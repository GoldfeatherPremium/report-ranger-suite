import type { Page, Frame } from "playwright";

export type AiElementResult = {
  selector: string;
  reasoning: string;
};

type ElementInfo = {
  index: number;
  tag: string;
  text: string;
  id: string;
  name: string;
  type: string;
  ariaLabel: string;
  placeholder: string;
  dataTestId: string;
};

const GEMINI_MODEL = "gemini-2.5-flash";
const API_TIMEOUT_MS = 15_000;

/**
 * Ask Gemini to identify which element on the page best matches `intent`.
 *
 * Uses plain fetch (no SDK) so it adds zero npm dependencies.
 * Returns null when:
 *   - GEMINI_API_KEY is not set
 *   - The model can't identify a match
 *   - Any network / parse error occurs
 * All errors are swallowed — a missing or broken key must never crash a job.
 */
export async function findElementWithAI(
  page: Page,
  intent: string,
  opts?: { frame?: Frame },
): Promise<AiElementResult | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const evaluator = opts?.frame ?? page;

  // ── Extract a compact, structured element list from the live DOM ─────────────
  // We capture text + key attributes only — no screenshots, no full HTML.
  // Stays well inside free-tier token limits even for large pages.
  let elements: ElementInfo[] = [];
  try {
    elements = await (evaluator as Page).evaluate(() => {
      const els = Array.from(
        document.querySelectorAll('button, a, input, textarea, select, [role="button"]'),
      );
      return els
        .slice(0, 80)
        .map((el, index) => {
          const e = el as HTMLElement & HTMLInputElement;
          const text = ((e.textContent ?? "") + (e.value ?? "")).trim().slice(0, 80);
          const id        = e.id || "";
          const name      = e.getAttribute("name") || "";
          const ariaLabel = e.getAttribute("aria-label") || "";
          const testId    = e.getAttribute("data-testid") || "";
          // Skip truly invisible elements with no identifying attributes
          if (!text && !id && !name && !ariaLabel && !testId) return null;
          return {
            index,
            tag: e.tagName.toLowerCase(),
            text,
            id,
            name,
            type:        e.getAttribute("type") || "",
            ariaLabel,
            placeholder: e.getAttribute("placeholder") || "",
            dataTestId:  testId,
          } satisfies ElementInfo;
        })
        .filter((x): x is ElementInfo => x !== null);
    });
  } catch {
    return null;
  }

  if (elements.length === 0) return null;

  // ── Build the prompt ──────────────────────────────────────────────────────────
  const systemPrompt = [
    "You are helping a browser automation script.",
    `The script wants to: "${intent}".`,
    "Below is the list of interactive elements on the current page.",
    'Return ONLY a JSON object: {"index": number, "css_selector": string, "reasoning": string}',
    "that identifies the best matching element.",
    'If no element matches, return {"index": -1, "css_selector": "", "reasoning": "no match found"}.',
    "Do not include any text outside the JSON object.",
  ].join(" ");

  const userContent = `${systemPrompt}\n\nElements:\n${JSON.stringify(elements, null, 2)}`;

  const requestBody = {
    contents: [{ parts: [{ text: userContent }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0,
      maxOutputTokens: 256,
    },
  };

  // ── Call Gemini ───────────────────────────────────────────────────────────────
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  type GeminiMatch = { index: number; css_selector: string; reasoning: string };
  let parsed: GeminiMatch | null = null;
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      },
    );
    clearTimeout(timer);

    if (!resp.ok) return null;

    const data = await resp.json() as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!raw) return null;

    parsed = JSON.parse(raw) as GeminiMatch;
  } catch {
    clearTimeout(timer);
    return null;
  }

  if (!parsed || parsed.index === -1 || !parsed.css_selector) return null;

  // ── Build the strongest possible selector from the element's attributes ───────
  // Prefer stable, semantic attributes over the model's suggested selector.
  const el = elements.find((e) => e.index === parsed!.index);
  if (!el) return null;

  let selector: string;
  if (el.dataTestId)  selector = `[data-testid="${el.dataTestId}"]`;
  else if (el.id)     selector = `#${CSS.escape(el.id)}`;
  else if (el.name)   selector = `${el.tag}[name="${el.name}"]`;
  else if (el.ariaLabel) selector = `[aria-label="${el.ariaLabel}"]`;
  else                selector = parsed.css_selector || el.tag;

  return { selector, reasoning: parsed.reasoning };
}
