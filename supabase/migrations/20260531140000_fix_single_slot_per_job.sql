-- Fix: one document → one slot, forever.
--
-- When a job has already been submitted to Turnitin (turnitin_submission_id IS NOT NULL),
-- retries must reuse the same slot instead of picking a new one.  This requires:
--
--   1. claim_next_job: Priority-1 path claims pre-submitted jobs WITHOUT assigning a
--      new slot, so they always go back to the same assignment dashboard.
--
--   2. requeue_stuck_jobs: keeps slot_id and the slot_usage row intact for jobs that
--      were already submitted, so the slot is not freed/reassigned.

-- ── 1. Updated claim_next_job ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.claim_next_job(p_worker_id text)
RETURNS public.jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_slot_id uuid;
  v_job     public.jobs;
BEGIN
  -- ── Priority 1: resume a job that was already submitted to Turnitin ──────────
  -- The document is already there; we just need to keep polling the same
  -- assignment dashboard for the similarity score.
  -- Do NOT assign a new slot and do NOT create a new turnitin_slot_usage row.
  UPDATE public.jobs j
  SET status        = 'processing',
      worker_id     = p_worker_id,
      started_at    = now(),
      last_polled_at = now(),
      attempts      = j.attempts + 1,
      updated_at    = now()
  WHERE j.id = (
    SELECT id FROM public.jobs
    WHERE  status                 = 'queued'
      AND  turnitin_submission_id IS NOT NULL
      AND  slot_id                IS NOT NULL
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING * INTO v_job;

  IF v_job.id IS NOT NULL THEN
    RETURN v_job;
  END IF;

  -- ── Priority 2: fresh job — pick a free slot and the oldest unsubmitted job ──
  SELECT s.id INTO v_slot_id
  FROM   public.turnitin_slots   s
  JOIN   public.turnitin_accounts a ON a.id = s.account_id
  WHERE  s.is_active AND a.is_active
    AND  NOT EXISTS (
           SELECT 1 FROM public.turnitin_slot_usage u
           WHERE  u.slot_id     = s.id
             AND  u.submitted_at > now() - make_interval(hours => s.cooldown_hours)
         )
  ORDER BY s.created_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_slot_id IS NULL THEN RETURN NULL; END IF;

  UPDATE public.jobs j
  SET status        = 'processing',
      slot_id       = v_slot_id,
      worker_id     = p_worker_id,
      started_at    = now(),
      last_polled_at = now(),
      attempts      = j.attempts + 1,
      updated_at    = now()
  WHERE j.id = (
    SELECT id FROM public.jobs
    WHERE  status                 = 'queued'
      AND  turnitin_submission_id IS NULL   -- only fresh/unsubmitted jobs
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


-- ── 2. Updated requeue_stuck_jobs ────────────────────────────────────────────
-- For already-submitted jobs, preserve slot_id so the next claim re-uses the
-- same slot.  Only free the slot_usage row for jobs that never got submitted.
CREATE OR REPLACE FUNCTION public.requeue_stuck_jobs(p_max_age_minutes int DEFAULT 45)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE n int;
BEGIN
  -- Re-queue stuck jobs; keep slot_id when document was already submitted.
  WITH stuck AS (
    UPDATE public.jobs
    SET status    = 'queued',
        worker_id = null,
        slot_id   = CASE
                      WHEN turnitin_submission_id IS NOT NULL THEN slot_id  -- preserve
                      ELSE NULL                                              -- free
                    END,
        error     = coalesce(error,'') || ' [watchdog requeued]',
        updated_at = now()
    WHERE status        = 'processing'
      AND last_polled_at < now() - make_interval(mins => p_max_age_minutes)
    RETURNING id, turnitin_submission_id
  ),
  -- Only free slot_usage for jobs that were NOT yet submitted.
  freed AS (
    UPDATE public.turnitin_slot_usage
    SET freed_at = now()
    WHERE job_id IN (SELECT id FROM stuck WHERE turnitin_submission_id IS NULL)
      AND freed_at IS NULL
  )
  SELECT count(*) INTO n FROM stuck;

  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.requeue_stuck_jobs(int) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.requeue_stuck_jobs(int) TO service_role;
