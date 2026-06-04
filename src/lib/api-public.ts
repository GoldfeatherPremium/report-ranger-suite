// Shared helpers for /api/public/v1/* routes — auth, error envelopes, CORS.
import { createHash, randomUUID } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
} as const;

export type ApiClient = {
  id: string;
  name: string;
  is_active: boolean;
  webhook_url: string | null;
  webhook_secret: string;
  daily_quota: number;
};

export function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extraHeaders },
  });
}

export function apiError(code: string, message: string, status: number, requestId?: string) {
  return jsonResponse(
    { error: { code, message, request_id: requestId ?? randomUUID() } },
    status,
  );
}

export function optionsResponse() {
  return new Response(null, { status: 204, headers: CORS });
}

/** Authenticate the partner via `Authorization: Bearer dh_live_xxx`. */
export async function authenticateApiClient(request: Request): Promise<
  { ok: true; client: ApiClient } | { ok: false; response: Response }
> {
  const auth = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/.exec(auth);
  if (!m) {
    return { ok: false, response: apiError("invalid_api_key", "Missing Bearer token", 401) };
  }
  const token = m[1];
  if (!token.startsWith("dh_live_")) {
    return { ok: false, response: apiError("invalid_api_key", "Malformed API key", 401) };
  }
  const hash = createHash("sha256").update(token).digest("hex");
  const { data, error } = await supabaseAdmin
    .from("api_clients")
    .select("id,name,is_active,webhook_url,webhook_secret,daily_quota")
    .eq("key_hash", hash)
    .maybeSingle();
  if (error || !data) {
    return { ok: false, response: apiError("invalid_api_key", "Unknown API key", 401) };
  }
  if (!data.is_active) {
    return { ok: false, response: apiError("invalid_api_key", "API key has been deactivated", 401) };
  }
  return { ok: true, client: data as ApiClient };
}

/** Best-effort daily quota check (UTC day window). */
export async function checkDailyQuota(clientId: string, quota: number) {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { count } = await supabaseAdmin
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("api_client_id", clientId)
    .gte("created_at", since.toISOString());
  return (count ?? 0) < quota;
}
