-- Slot live-lock concurrency: remove 24h cooldown gate, add reassign_job_slot RPC.
--
-- Problems addressed:
--   The previous claim_next_job blocked a slot for cooldown_hours after ANY use,
--   even if the job failed before submitting anything to Turnitin.  This made it
--   impossible to immediately reuse a slot after a transient failure.
--
-- New slot availability rule:
--   A slot is blocked ONLY while a worker is actively using it (freed_at IS NULL).
--   As soon as the worker finishes (success, failure, or reassignment) and sets
--   freed_at, the slot is immediately available to the next job.
--
-- New RPC:
--   reassign_job_slot(p_job_id, p_exclude_slot_ids) — used by the worker when
--   Turnitin explicitly refuses a resubmission on the current slot.  Atomically
--   frees the current slot and assigns the next available one.

-- ── claim_next_job v5: live-lock only, prefer longest-idle slot ───────────────
CREATE OR REPLACE FUNCTION public.claim_next_job(p_worker_id text)
RETURNS public.jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_slot_id uuid;
  v_job     public.jobs;
BEGIN
  -- ── Priority 1: resume a job already submitted to Turnitin ──────────────────
  -- The document is already there; only need to poll for the similarity score.
  -- Do NOT assign a new slot, do NOT create a usage row, do NOT increment attempts.
  UPDATE public.jobs j
  SET status         = 'processing',
      worker_id      = p_worker_id,
      started_at     = now(),
      last_polled_at = now(),
      updated_at     = now()
  WHERE j.id = (
    SELECT id FROM public.jobs
    WHERE  status                 = 'queued'
      AND  turnitin_submission_id IS NOT NULL
      AND  slot_id                IS NOT NULL
      AND  (queued_at IS NULL OR queued_at <= now())
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING * INTO v_job;

  IF v_job.id IS NOT NULL THEN
    RETURN v_job;
  END IF;

  -- ── Priority 2: fresh job — pick a free slot ─────────────────────────────────
  -- A slot is available when no worker currently holds it (freed_at IS NULL check).
  -- Prefer slots that were freed longest ago to avoid hot-spotting one slot.
  SELECT s.id INTO v_slot_id
  FROM   public.turnitin_slots   s
  JOIN   public.turnitin_accounts a ON a.id = s.account_id
  WHERE  s.is_active AND a.is_active
    AND  NOT EXISTS (
           SELECT 1 FROM public.turnitin_slot_usage u
           WHERE  u.slot_id   = s.id
             AND  u.freed_at IS NULL   -- blocked only while actively in use
         )
  ORDER BY (
    SELECT COALESCE(MAX(u2.freed_at), '1970-01-01'::timestamptz)
    FROM   public.turnitin_slot_usage u2
    WHERE  u2.slot_id = s.id
  ) ASC  -- prefer slots freed longest ago
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_slot_id IS NULL THEN RETURN NULL; END IF;

  UPDATE public.jobs j
  SET status         = 'processing',
      slot_id        = v_slot_id,
      worker_id      = p_worker_id,
      started_at     = now(),
      last_polled_at = now(),
      attempts       = j.attempts + 1,
      updated_at     = now()
  WHERE j.id = (
    SELECT id FROM public.jobs
    WHERE  status                 = 'queued'
      AND  turnitin_submission_id IS NULL
      AND  (queued_at IS NULL OR queued_at <= now())
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING * INTO v_job;

  IF v_job.id IS NULL THEN RETURN NULL; END IF;

  INSERT INTO public.turnitin_slot_usage(slot_id, job_id) VALUES (v_slot_id, v_job.id);
  RETURN v_job;
END $$;

REVOKE ALL ON FUNCTION public.claim_next_job(text) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_next_job(text) TO service_role;


-- ── reassign_job_slot: atomically swap to the next available slot ─────────────
-- Called by the worker when Turnitin explicitly denies a resubmission on the
-- current slot.  Frees the current usage row and assigns the next free slot
-- that is not in p_exclude_slot_ids.  Returns the new slot_id or NULL if none
-- is available.
CREATE OR REPLACE FUNCTION public.reassign_job_slot(
  p_job_id           uuid,
  p_exclude_slot_ids uuid[]
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_new_slot_id uuid;
BEGIN
  -- Free the current usage row for this job
  UPDATE public.turnitin_slot_usage
  SET freed_at = now()
  WHERE job_id = p_job_id AND freed_at IS NULL;

  -- Pick the next available slot (not in exclude list, not actively in use)
  SELECT s.id INTO v_new_slot_id
  FROM   public.turnitin_slots   s
  JOIN   public.turnitin_accounts a ON a.id = s.account_id
  WHERE  s.is_active AND a.is_active
    AND  NOT (s.id = ANY(p_exclude_slot_ids))
    AND  NOT EXISTS (
           SELECT 1 FROM public.turnitin_slot_usage u
           WHERE  u.slot_id   = s.id
             AND  u.freed_at IS NULL
         )
  ORDER BY (
    SELECT COALESCE(MAX(u2.freed_at), '1970-01-01'::timestamptz)
    FROM   public.turnitin_slot_usage u2
    WHERE  u2.slot_id = s.id
  ) ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_new_slot_id IS NULL THEN RETURN NULL; END IF;

  -- Assign the new slot to the job and record the usage
  UPDATE public.jobs
  SET slot_id = v_new_slot_id, updated_at = now()
  WHERE id = p_job_id;

  INSERT INTO public.turnitin_slot_usage(slot_id, job_id) VALUES (v_new_slot_id, p_job_id);

  RETURN v_new_slot_id;
END $$;

REVOKE ALL ON FUNCTION public.reassign_job_slot(uuid, uuid[]) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.reassign_job_slot(uuid, uuid[]) TO service_role;
