
-- API clients (partner sites like plagaiscans.com)
CREATE TABLE public.api_clients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  key_hash        text NOT NULL UNIQUE,
  key_prefix      text NOT NULL,
  webhook_url     text,
  webhook_secret  text NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  rate_limit_per_min int NOT NULL DEFAULT 60,
  daily_quota     int NOT NULL DEFAULT 500,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_clients TO authenticated;
GRANT ALL ON public.api_clients TO service_role;
ALTER TABLE public.api_clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY "api_clients_admin_all" ON public.api_clients
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE TRIGGER set_api_clients_updated_at BEFORE UPDATE ON public.api_clients
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Extend jobs for API-originated submissions
ALTER TABLE public.jobs
  ALTER COLUMN user_id DROP NOT NULL,
  ADD COLUMN api_client_id uuid REFERENCES public.api_clients(id) ON DELETE SET NULL,
  ADD COLUMN external_ref  text,
  ADD COLUMN callback_url  text,
  ADD COLUMN metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN similarity_percent int;
CREATE INDEX jobs_api_client_idx ON public.jobs(api_client_id) WHERE api_client_id IS NOT NULL;

-- Outgoing webhook queue
CREATE TABLE public.job_callbacks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  api_client_id   uuid REFERENCES public.api_clients(id) ON DELETE SET NULL,
  event           text NOT NULL,
  url             text NOT NULL,
  payload         jsonb NOT NULL,
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  last_status     int,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_callbacks_pending_idx
  ON public.job_callbacks (next_attempt_at)
  WHERE delivered_at IS NULL;
GRANT SELECT ON public.job_callbacks TO authenticated;
GRANT ALL ON public.job_callbacks TO service_role;
ALTER TABLE public.job_callbacks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "job_callbacks_admin_read" ON public.job_callbacks
  FOR SELECT TO authenticated USING (is_admin());

-- Admin: create an API client (returns plaintext key + secret ONCE)
CREATE OR REPLACE FUNCTION public.create_api_client(
  p_name text,
  p_webhook_url text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_secret         text;
  v_webhook_secret text;
  v_hash           text;
  v_prefix         text;
  v_id             uuid;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'admin only'; END IF;
  v_secret         := 'dh_live_' || encode(gen_random_bytes(24), 'hex');
  v_webhook_secret := encode(gen_random_bytes(32), 'hex');
  v_hash           := encode(digest(v_secret, 'sha256'), 'hex');
  v_prefix         := substring(v_secret from 1 for 16);
  INSERT INTO public.api_clients(name, key_hash, key_prefix, webhook_url, webhook_secret)
  VALUES (p_name, v_hash, v_prefix, p_webhook_url, v_webhook_secret)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object(
    'id', v_id,
    'api_key', v_secret,
    'webhook_secret', v_webhook_secret
  );
END $$;

-- Worker: enqueue outbound callback after a job changes state
CREATE OR REPLACE FUNCTION public.enqueue_job_callback(
  p_job_id uuid,
  p_event  text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.jobs;
  v_payload jsonb;
BEGIN
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id;
  IF v_job.callback_url IS NULL THEN RETURN; END IF;
  v_payload := jsonb_build_object(
    'event',              p_event,
    'job_id',             v_job.id,
    'external_ref',       v_job.external_ref,
    'status',             v_job.status,
    'similarity_percent', v_job.similarity_percent,
    'finished_at',        v_job.finished_at,
    'error',              v_job.error,
    'metadata',           v_job.metadata
  );
  INSERT INTO public.job_callbacks(job_id, api_client_id, event, url, payload)
  VALUES (p_job_id, v_job.api_client_id, p_event, v_job.callback_url, v_payload);
END $$;
