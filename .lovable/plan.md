## Goal

Turn the existing Document Hub into a full Turnitin automation pipeline:
customer uploads → job lands in DB → a worker running on your Contabo VPS
picks the job, logs into an available Turnitin student slot, submits the
file, waits for the Similarity Report, downloads the PDF, uploads it back
to the `reports` bucket, and marks the job `completed`. Admin manages
accounts + slots from the app.

---

## 1. Database changes (migration)

New tables (RLS: admin-only via existing `is_admin()`):

- **`turnitin_accounts`**
  - `id`, `label`, `email`, `password_encrypted` (bytea, pgsodium /
    pgcrypto with a key stored in `vault`), `login_url`, `notes`,
    `is_active`, timestamps.
- **`turnitin_slots`**
  - `id`, `account_id → turnitin_accounts`, `label` (e.g. "Class A /
    Assignment 1"), `submit_url` (deep link or class id), `cooldown_hours`
    (default 24), `is_active`, timestamps.
- **`turnitin_slot_usage`**
  - `id`, `slot_id`, `job_id`, `submitted_at`, `freed_at`,
    `turnitin_submission_id`. Used to compute "is this slot free right
    now?" and to enforce the 24h cooldown.

Extend **`jobs`**:
- `slot_id uuid null`, `turnitin_submission_id text null`,
  `worker_id text null`, `last_polled_at timestamptz null`.

Helper SQL function `claim_next_job(worker_id text)`:
- Inside a single transaction, locks one row in `jobs` where
  `status = 'queued'`, finds the first `turnitin_slots` row that is
  active AND has no `turnitin_slot_usage` row newer than
  `now() - cooldown_hours`, assigns it, flips job to `processing`,
  stamps `worker_id` + `started_at`, writes a `turnitin_slot_usage`
  row, returns the job. If no slot is free, returns null and leaves
  the job queued. This is the heart of the dispatcher.

Grants + RLS:
- `turnitin_accounts` / `turnitin_slots` / `turnitin_slot_usage`:
  admin-only via `is_admin()`; `GRANT` to `authenticated` +
  `service_role`. Service role bypasses RLS — that's what the VPS uses.

---

## 2. Admin UI

New routes under `/_authenticated/admin/`:

- **`turnitin.tsx`** — accounts list + "Add account" dialog
  (label, email, password, login URL). Password sent through a
  `createServerFn` that encrypts before insert; never round-trips in
  plaintext to the client after save.
- **`turnitin.$accountId.tsx`** — slots for one account. Add / edit /
  disable slots, see last usage + cooldown countdown, "free now"
  badge.

Sidebar gets a new "Turnitin" entry under the Admin group.

The existing `portal_configs` admin page stays but is no longer the
configuration source for Turnitin — it remains for any other portals.

---

## 3. Worker contract (what the VPS does)

The Lovable app does **not** drive the browser. The VPS worker loops:

1. Call `claim_next_job(worker_id)` via the Supabase service-role
   client. If null → sleep 10s, retry.
2. Download `source_path` from `documents` bucket to `/tmp`.
3. Look up the slot + account, decrypt password (RPC
   `decrypt_account_password(account_id)` that runs as
   security-definer using the vault key — only callable by service
   role).
4. Drive Turnitin with Playwright: log in, open the slot's
   `submit_url`, upload file, capture `turnitin_submission_id`, poll
   the similarity page until % is shown (timeout 30 min, configurable).
5. Download the Similarity Report PDF, upload to `reports/{user_id}/
   {job_id}.pdf`, insert a `reports` row.
6. Mark job `completed`, set `finished_at`, write `audit_logs` +
   `worker_logs` entries, heartbeat `worker_health`.
7. On any failure: `attempts += 1`. If `attempts < max_attempts`
   → back to `queued` and free the slot usage. Else `failed` with
   `error` populated.

Heartbeat: every 30s upsert `worker_health` row keyed by
`worker_id` with `last_seen = now()`.

---

## 4. Contabo VPS bootstrap

Ship a `vps/` folder in the repo containing:

- `vps/README.md` — step-by-step.
- `vps/install.sh` — one-shot Ubuntu 22.04 setup: apt update, install
  Node 20, install Chromium deps for Playwright, install pm2,
  create `turnitin` user, clone `vps/worker/`, `npm ci`,
  `npx playwright install --with-deps chromium`, write systemd unit,
  enable + start.
- `vps/worker/` — TypeScript worker package
  (`src/index.ts`, `src/turnitin.ts`, `src/supabase.ts`, `package.json`,
  `tsconfig.json`, `.env.example` with `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `WORKER_ID`, `HEADLESS=true`,
  `SUBMISSION_TIMEOUT_MS`, `POLL_INTERVAL_MS`).
- `vps/turnitin-worker.service` — systemd unit (auto-restart, logs to
  journald).

Operator workflow on the VPS:
```
ssh root@<contabo-ip>
curl -sSL https://raw.githubusercontent.com/<repo>/main/vps/install.sh | bash
nano /opt/turnitin-worker/.env   # paste SUPABASE_SERVICE_ROLE_KEY etc.
systemctl restart turnitin-worker
journalctl -u turnitin-worker -f
```

Worker can be scaled by running multiple systemd instances with
distinct `WORKER_ID`s; `claim_next_job` row-locks so they won't
collide on slots.

---

## 5. Frontend touch-ups

- Dashboard job rows already show `processing` — add a small
  "Slot: <label>" line once `slot_id` is set, plus an elapsed timer.
- History download button keeps using the existing
  `downloadReport(jobId)` signed-URL flow — no change needed since the
  worker writes into `reports` exactly like the current code expects.
- Admin Overview gets a "Workers" panel: list `worker_health` rows
  with `last_seen` freshness + active job count.

---

## Technical notes

- **Password encryption**: enable `pgsodium`; store keys in `vault`.
  Encryption/decryption happens in SQL functions so the key never
  leaves Postgres. The VPS calls
  `select decrypt_account_password($1)` via service role.
- **Slot freeness** computed live in SQL:
  `not exists (select 1 from turnitin_slot_usage u where u.slot_id =
  s.id and u.submitted_at > now() - make_interval(hours =>
  s.cooldown_hours))`.
- **No edge functions**, no TanStack server fns for the worker — the
  worker is a Node process on your VPS that talks to Postgres + Storage
  with the service-role key. The Lovable app stays pure UI + DB +
  Storage.
- **Secrets in the app**: none new — the service role key only lives
  on the VPS.
- **Idempotency**: `claim_next_job` is atomic; if the worker dies
  mid-submission, a watchdog query (`processing` jobs whose
  `last_polled_at` is older than the timeout) re-queues them.

---

## What I'll deliver in build mode

1. SQL migration (tables, grants, RLS, encryption fns, `claim_next_job`,
   watchdog fn).
2. Admin pages (`turnitin.tsx`, `turnitin.$accountId.tsx`) + sidebar
   entry + small Workers panel on `/admin`.
3. `vps/` folder with install script, systemd unit, full TypeScript
   Playwright worker, and a README with the Contabo step-by-step.

Confirm and I'll build it.