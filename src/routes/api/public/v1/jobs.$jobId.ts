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
          .select("id,status,external_ref,attempts,pipeline,ai_report_status,similarity_percent,turnitin_submission_id,started_at,finished_at,error,created_at,user_id")
          .eq("id", params.jobId)
          .eq("api_client_id", auth.client.id)
          .maybeSingle();
        if (error) return apiError("internal_error", error.message, 500);
        if (!job) return apiError("not_found", "Job not found", 404);

        const j = job as typeof job & { pipeline?: string; ai_report_status?: string | null };

        let reportUrl: string | null = null;
        let reportExpiresAt: string | null = null;
        let aiReportUrl: string | null = null;
        let aiReportExpiresAt: string | null = null;

        if (j.status === "completed") {
          const { data: reps } = await supabaseAdmin
            .from("reports")
            .select("kind,storage_path,file_name")
            .eq("job_id", j.id);
          const expIso = new Date(Date.now() + 3600_000).toISOString();
          for (const r of reps ?? []) {
            const { data: signed } = await supabaseAdmin
              .storage.from("reports")
              .createSignedUrl(r.storage_path, 3600, { download: r.file_name });
            if (!signed) continue;
            if (r.kind === "ai") { aiReportUrl = signed.signedUrl; aiReportExpiresAt = expIso; }
            else                 { reportUrl   = signed.signedUrl; reportExpiresAt   = expIso; }
          }
        }

        return jsonResponse({
          job_id: j.id,
          status: j.status,
          external_ref: j.external_ref,
          attempts: j.attempts,
          pipeline: j.pipeline ?? "student",
          report_type: (j.pipeline ?? "student") === "instructor" ? "similarity_ai" : "similarity",
          similarity_percent: j.similarity_percent,
          submitted_to_turnitin_at: j.started_at,
          finished_at: j.finished_at,
          error: j.error,
          report_url: reportUrl,
          report_expires_at: reportExpiresAt,
          ai_report_url: aiReportUrl,
          ai_report_expires_at: aiReportExpiresAt,
          ai_report_status: j.ai_report_status ?? null,
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
