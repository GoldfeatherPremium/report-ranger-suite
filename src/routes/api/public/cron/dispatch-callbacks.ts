// Cron-invoked: drains pending job_callbacks rows, POSTs to partner webhook URL
// with an HMAC-SHA256 signature, and updates delivery state with backoff.
// Schedule via pg_cron + pg_net to call this every 30s (or call it manually).
import { createFileRoute } from "@tanstack/react-router";
import { createHmac } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { CORS, jsonResponse, optionsResponse } from "@/lib/api-public";

// Backoff schedule (seconds) for attempts 1..8
const BACKOFF_S = [0, 30, 120, 600, 3600, 21_600, 86_400, 86_400];
const MAX_ATTEMPTS = 8;
const BATCH = 20;

export const Route = createFileRoute("/api/public/cron/dispatch-callbacks")({
  server: {
    handlers: {
      OPTIONS: async () => optionsResponse(),
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
    },
  },
});

async function handle(_request: Request) {
  const { data: rows, error } = await supabaseAdmin
    .from("job_callbacks")
    .select("id,job_id,api_client_id,event,url,payload,attempts")
    .is("delivered_at", null)
    .lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at", { ascending: true })
    .limit(BATCH);

  if (error) {
    return jsonResponse({ error: error.message }, 500);
  }
  if (!rows || rows.length === 0) {
    return jsonResponse({ dispatched: 0 }, 200, { ...CORS });
  }

  let ok = 0;
  for (const row of rows) {
    try {
      const client = row.api_client_id
        ? (await supabaseAdmin
            .from("api_clients")
            .select("webhook_secret")
            .eq("id", row.api_client_id)
            .maybeSingle()).data
        : null;
      const secret = client?.webhook_secret;
      if (!secret) {
        await markDelivery(row.id, row.attempts, 0, "Missing webhook secret");
        continue;
      }

      // Refresh signed report URL inline so partners always get a fresh link.
      const payload = await withFreshReportUrl(row.payload as Record<string, unknown>, row.job_id);

      const body = JSON.stringify(payload);
      const t = Math.floor(Date.now() / 1000);
      const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

      const res = await fetch(row.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-DocHub-Event": String(payload.event ?? "job.event"),
          "X-DocHub-Delivery": row.id,
          "X-DocHub-Signature": `t=${t},v1=${sig}`,
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });

      if (res.status >= 200 && res.status < 300) {
        await supabaseAdmin
          .from("job_callbacks")
          .update({ delivered_at: new Date().toISOString(), last_status: res.status, attempts: row.attempts + 1 })
          .eq("id", row.id);
        ok++;
      } else {
        await markDelivery(row.id, row.attempts, res.status, `HTTP ${res.status}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await markDelivery(row.id, row.attempts, 0, msg);
    }
  }
  return jsonResponse({ dispatched: ok, attempted: rows.length });
}

async function markDelivery(id: string, attempts: number, status: number, error: string) {
  const next = attempts + 1;
  const backoff = BACKOFF_S[Math.min(next, MAX_ATTEMPTS) - 1] ?? BACKOFF_S[BACKOFF_S.length - 1];
  const nextAttemptAt = new Date(Date.now() + backoff * 1000).toISOString();
  const update: Record<string, unknown> = {
    attempts: next,
    last_status: status || null,
    last_error: error,
    next_attempt_at: nextAttemptAt,
  };
  if (next >= MAX_ATTEMPTS) {
    // Stop retrying — mark as a dead delivery by pushing next_attempt_at far out.
    update.next_attempt_at = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
  }
  await supabaseAdmin.from("job_callbacks").update(update as never).eq("id", id);
}

async function withFreshReportUrl(payload: Record<string, unknown>, jobId: string) {
  if (payload.status !== "completed") return payload;
  const { data: job } = await supabaseAdmin
    .from("jobs").select("user_id").eq("id", jobId).maybeSingle();
  const path = `${job?.user_id ?? "api"}/${jobId}.pdf`;
  const { data: signed } = await supabaseAdmin.storage.from("reports").createSignedUrl(path, 3600);
  return {
    ...payload,
    report_url: signed?.signedUrl ?? null,
    report_expires_at: signed ? new Date(Date.now() + 3600_000).toISOString() : null,
  };
}
