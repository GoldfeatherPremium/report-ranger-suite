# Turnitin VPS Worker

Headless Playwright worker that runs on your Contabo VPS, claims jobs from the
Document Hub database, submits documents to Turnitin via a student account
slot, downloads the Similarity Report PDF, and uploads it back to the app's
`reports` bucket.

## What it does

1. Calls `claim_next_job(worker_id)` (atomic, cooldown-aware slot picker).
2. Downloads the source file from the `documents` bucket.
3. Logs into Turnitin with the slot's account (password decrypted server-side).
4. Uploads the file to the slot's class/assignment.
5. Polls the similarity page until the score is ready (default 30 min).
6. Downloads the Similarity Report PDF and uploads it to
   `reports/<user_id>/<job_id>.pdf`.
7. Marks the job `completed` (or `failed` after `max_attempts`).
8. Heartbeats `worker_health` every 30s.

Multiple workers can run side-by-side with distinct `WORKER_ID`s — the
database row-locks the next job and the next slot, so they won't collide.

---

## One-shot install on Contabo (Ubuntu 22.04 / 24.04)

```bash
ssh root@<your-contabo-ip>

# clone this repo (replace with your repo URL)
git clone https://github.com/<you>/<repo>.git /opt/dochub
cd /opt/dochub/vps

# run the bootstrap script
bash install.sh

# paste your secrets
nano /opt/dochub/vps/worker/.env
#   SUPABASE_URL=https://qxftygfzqouzhznnmrsq.supabase.co
#   SUPABASE_SERVICE_ROLE_KEY=<paste the JWT whose payload role is "service_role"; not the anon/publishable key>
#   WORKER_ID=contabo-1
#   HEADLESS=true
#   SUBMISSION_TIMEOUT_MS=1800000
#   POLL_INTERVAL_MS=15000

# start
systemctl restart turnitin-worker
systemctl status turnitin-worker
journalctl -u turnitin-worker -f
```

To run multiple workers on the same box, copy the systemd unit:

```bash
cp /etc/systemd/system/turnitin-worker.service /etc/systemd/system/turnitin-worker-2.service
# edit the Environment=WORKER_ID=contabo-2 line
systemctl daemon-reload
systemctl enable --now turnitin-worker-2
```

---

## Automatic updates (optional)

By default the VPS only changes when you re-run the deploy script. To make it
pull, rebuild, and restart itself whenever the tracked branch gets a new
commit (checked every ~5 min):

```bash
sudo bash /opt/dochub/vps/enable-auto-update.sh
```

It only redeploys on an actual new commit, so an up-to-date repo is a no-op
with no downtime. Manage it with:

```bash
journalctl -u turnitin-worker-update -f                 # watch auto-updates
systemctl list-timers turnitin-worker-update --no-pager # next scheduled run
systemctl disable --now turnitin-worker-update.timer    # turn it back off
```

---

## How the Turnitin flow works

The worker reproduces the exact manual student flow:

1. **Login** with the slot's account.
2. **Go to the assignment dashboard** — the slot's `submit_url` must be the
   `turnitin.com/assignment/type/paper/dashboard/<id>?lang=en_us` page (the one
   with the blue **"Upload Submission"** button).
3. Click **"Upload Submission"** → the *Submit File* modal opens.
4. Attach the file to the hidden `<input type=file>` (no OS dialog) and set the
   **Submission Title** (defaults to the file name).
5. Click **"Upload and Review"** and wait for the review screen (the upload can
   take 15s–5min — tuned by `UPLOAD_TIMEOUT_MS`).
6. Click **"Submit to Turnitin"**, wait for **"Submission Complete!"**, close
   the modal.
7. Poll the dashboard until the **Similarity %** appears
   (`SUBMISSION_TIMEOUT_MS`, polled every `POLL_INTERVAL_MS`).
8. Click the **%** to open the report viewer (`ev.turnitin.com/app/carta/e`),
   click the **download arrow**, then **"Current View"** to download the PDF.

## Tuning the selectors

All selectors live in one `SEL` block at the top of `worker/src/turnitin.ts`.
If any step can't find its element, the worker logs `[diag]` lines listing every
button/link/input on the page (and in each iframe) to the `worker_logs` table —
read those in **Admin → logs** and adjust the matching `SEL.*` entry. Run with
`HEADLESS=false` on a desktop with a display to watch the browser live.

---

## AI selector fallback (optional)

When Turnitin changes their HTML and a hardcoded selector stops working, the
worker can automatically recover using Google Gemini (free tier) — no human
intervention required for most UI changes.

**How it works:** every critical click and fill (`smartClick` / `smartFill`)
tries the hardcoded selector first with a short timeout. If that selector times
out, the worker extracts a compact list of interactive elements from the live
page (text + attributes only — no screenshots) and asks `gemini-2.5-flash` to
identify the right one. If Gemini returns a match, the worker retries with the
AI-derived selector and logs a `[warn]` entry so you know which `SEL.*` value
needs a permanent update.

**Enable it:**

1. Get a free API key at <https://aistudio.google.com/apikey> (no credit card).
2. Paste it into `/opt/dochub/vps/worker/.env`:
   ```
   GEMINI_API_KEY=AIza...
   ```
3. Restart the worker:
   ```bash
   systemctl restart turnitin-worker
   ```

**Monitor fallback events:**

```bash
# Live tail
journalctl -u turnitin-worker -f | grep ai-fallback

# Or in the app: Admin → Logs, filter level = warn
# Each line looks like:
#   [warn] [ai-fallback] intent="Upload and Review button" used selector=#btn-upload — update SEL
```

Use the logged selector to update the matching `SEL.*` entry in
`worker/src/turnitin.ts` so the next run uses it directly without an AI call.

**Free-tier capacity:** 1,500 requests/day per key — comfortably covers ~20
docs/day even with multiple fallbacks per job. The AI is only called when a
hardcoded selector fails, so normal runs make zero API calls.
