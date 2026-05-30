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
#   SUPABASE_SERVICE_ROLE_KEY=<get from Lovable Cloud → Backend → Settings → Service role key>
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

## Tuning the Turnitin flow

The default selectors in `worker/src/turnitin.ts` cover the standard
turnitin.com student UI. If your accounts use a different theme (Feedback
Studio variants, institutional skins), tweak the selectors at the top of the
file — they're all in one block. Run with `HEADLESS=false` on a desktop with a
display to debug visually.
