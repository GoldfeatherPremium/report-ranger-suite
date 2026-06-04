import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  CORS, apiError, authenticateApiClient, jsonResponse, optionsResponse,
} from "@/lib/api-public";

const MAX_SIZE = 40 * 1024 * 1024; // 40 MB

const Schema = z.object({
  filename: z.string().min(1).max(255),
  size_bytes: z.number().int().min(1).max(MAX_SIZE),
  mime_type: z.string().min(1).max(255).optional(),
});

export const Route = createFileRoute("/api/public/v1/jobs/upload-url")({
  server: {
    handlers: {
      OPTIONS: async () => optionsResponse(),
      POST: async ({ request }) => {
        const auth = await authenticateApiClient(request);
        if (!auth.ok) return auth.response;

        let body: unknown;
        try { body = await request.json(); } catch {
          return apiError("invalid_input", "Body must be JSON", 400);
        }
        const parsed = Schema.safeParse(body);
        if (!parsed.success) {
          return apiError("invalid_input", parsed.error.issues.map((i) => i.message).join("; "), 400);
        }

        const ext = parsed.data.filename.includes(".")
          ? parsed.data.filename.slice(parsed.data.filename.lastIndexOf("."))
          : "";
        const day = new Date().toISOString().slice(0, 10);
        const sourcePath = `incoming/${day}/${randomUUID()}${ext}`;

        const { data, error } = await supabaseAdmin.storage
          .from("documents")
          .createSignedUploadUrl(sourcePath);
        if (error || !data) {
          return apiError("internal_error", error?.message ?? "could not create upload URL", 500);
        }

        return jsonResponse({
          upload_url: data.signedUrl,
          upload_token: data.token,
          source_path: sourcePath,
          expires_in: 600,
        }, 201, { ...CORS });
      },
    },
  },
});
