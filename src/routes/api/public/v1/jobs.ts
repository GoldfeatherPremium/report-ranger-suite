import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  apiError, authenticateApiClient, checkDailyQuota, jsonResponse, optionsResponse,
} from "@/lib/api-public";

const CreateSchema = z.object({
  source_path: z.string().min(1).max(512).regex(/^incoming\//, "source_path must come from /jobs/upload-url"),
  original_name: z.string().min(1).max(255),
  external_ref: z.string().min(1).max(255).optional(),
  callback_url: z.string().url().max(2048).optional(),
  mime_type: z.string().min(1).max(255).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const Route = createFileRoute("/api/public/v1/jobs")({
  server: {
    handlers: {
      OPTIONS: async () => optionsResponse(),

      POST: async ({ request }) => {
        const auth = await authenticateApiClient(request);
        if (!auth.ok) return auth.response;
        const client = auth.client;

        if (!(await checkDailyQuota(client.id, client.daily_quota))) {
          return apiError("quota_exceeded", `Daily quota of ${client.daily_quota} reached`, 402);
        }

        let body: unknown;
        try { body = await request.json(); } catch {
          return apiError("invalid_input", "Body must be JSON", 400);
        }
        const parsed = CreateSchema.safeParse(body);
        if (!parsed.success) {
          return apiError("invalid_input", parsed.error.issues.map((i) => i.message).join("; "), 400);
        }
        const input = parsed.data;
        const callbackUrl = input.callback_url ?? client.webhook_url;

        // Verify the file actually landed in storage at the claimed path.
        const folder = input.source_path.slice(0, input.source_path.lastIndexOf("/"));
        const name = input.source_path.slice(input.source_path.lastIndexOf("/") + 1);
        const { data: list } = await supabaseAdmin.storage.from("documents").list(folder, { limit: 100, search: name });
        const found = list?.find((f) => f.name === name);
        if (!found) {
          return apiError("invalid_input", "source_path not found in storage — upload before creating the job", 400);
        }

        const insert = {
          status: "queued" as const,
          original_name: input.original_name,
          source_path: input.source_path,
          mime_type: input.mime_type ?? null,
          size_bytes: (found.metadata as { size?: number } | null)?.size ?? null,
          api_client_id: client.id,
          external_ref: input.external_ref ?? null,
          callback_url: callbackUrl ?? null,
          metadata: input.metadata ?? {},
          queued_at: new Date().toISOString(),
        };
        const { data: job, error } = await supabaseAdmin
          .from("jobs")
          .insert(insert as never)
          .select("id,status,external_ref,created_at")
          .single();
        if (error || !job) {
          return apiError("internal_error", error?.message ?? "insert failed", 500);
        }
        return jsonResponse({
          job_id: job.id,
          status: job.status,
          external_ref: job.external_ref,
          created_at: job.created_at,
          estimated_minutes: 8,
        }, 201);
      },

      GET: async ({ request }) => {
        const auth = await authenticateApiClient(request);
        if (!auth.ok) return auth.response;
        const url = new URL(request.url);
        const status = url.searchParams.get("status");
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
        const since = url.searchParams.get("since");

        let q = supabaseAdmin
          .from("jobs")
          .select("id,status,external_ref,original_name,similarity_percent,created_at,finished_at,error")
          .eq("api_client_id", auth.client.id)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (status) q = q.eq("status", status as never);
        if (since) q = q.gte("created_at", since);

        const { data, error } = await q;
        if (error) return apiError("internal_error", error.message, 500);
        return jsonResponse({ data: data ?? [] });
      },
    },
  },
});
