import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  apiError, authenticateApiClient, jsonResponse, optionsResponse,
} from "@/lib/api-public";

export const Route = createFileRoute("/api/public/v1/jobs/$jobId")({
  server: {
    handlers: {
      OPTIONS: async () => optionsResponse(),

      GET: async ({ request, params }) => {
        const auth = await authenticateApiClient(request);
        if (!auth.ok) return auth.response;

        const { data: job, error } = await supabaseAdmin
          .from("jobs")
          .select("id,status,external_ref,attempts,similarity_percent,turnitin_submission_id,started_at,finished_at,error,created_at,user_id")
          .eq("id", params.jobId)
          .eq("api_client_id", auth.client.id)
          .maybeSingle();
        if (error) return apiError("internal_error", error.message, 500);
        if (!job) return apiError("not_found", "Job not found", 404);

        let reportUrl: string | null = null;
        let reportExpiresAt: string | null = null;
        if (job.status === "completed") {
          const path = `${job.user_id ?? "api"}/${job.id}.pdf`;
          const { data: signed } = await supabaseAdmin
            .storage.from("reports")
            .createSignedUrl(path, 3600);
          if (signed) {
            reportUrl = signed.signedUrl;
            reportExpiresAt = new Date(Date.now() + 3600_000).toISOString();
          }
        }

        return jsonResponse({
          job_id: job.id,
          status: job.status,
          external_ref: job.external_ref,
          attempts: job.attempts,
          similarity_percent: job.similarity_percent,
          submitted_to_turnitin_at: job.started_at,
          finished_at: job.finished_at,
          error: job.error,
          report_url: reportUrl,
          report_expires_at: reportExpiresAt,
        });
      },

      DELETE: async ({ request, params }) => {
        const auth = await authenticateApiClient(request);
        if (!auth.ok) return auth.response;

        const { data: job, error: e1 } = await supabaseAdmin
          .from("jobs")
          .select("id,status")
          .eq("id", params.jobId)
          .eq("api_client_id", auth.client.id)
          .maybeSingle();
        if (e1) return apiError("internal_error", e1.message, 500);
        if (!job) return apiError("not_found", "Job not found", 404);
        if (job.status !== "queued") {
          return apiError("invalid_input", `Cannot cancel a job in status '${job.status}'`, 400);
        }
        const { error: e2 } = await supabaseAdmin
          .from("jobs")
          .update({ status: "cancelled" as const, finished_at: new Date().toISOString() })
          .eq("id", job.id);
        if (e2) return apiError("internal_error", e2.message, 500);
        return jsonResponse({ job_id: job.id, status: "cancelled" });
      },
    },
  },
});
