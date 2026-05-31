# Report Ranger Suite — Full Setup (Lovable + Contabo VPS)

This project is a **Turnitin automation pipeline**. It has three parts that
work together:

| Part | Where it runs | What it does |
|------|---------------|--------------|
| **Web app** | Lovable (TanStack Start) | UI for users to upload documents and admins to manage accounts/slots. |
| **Database + Storage** | Supabase (Lovable Cloud) | Stores jobs, accounts, slots, and the uploaded/finished files. |
| **Worker** | Your **Contabo VPS** | Picks up jobs, logs into Turnitin with Playwright, submits the file, downloads the Similarity Report, uploads it back. |

The web app **never** drives a browser. All the Turnitin automation happens on
the VPS worker. The two sides only ever talk through the Supabase database.

```
User uploads file ─► [Web app] ─► job row in DB (status = queued)
                                        │
                          [VPS worker] claims the job ◄─┘
                                        │
                          logs in to Turnitin, submits, waits for score,
                          downloads the PDF, uploads to "reports" bucket,
                          marks job = completed
                                        │
User downloads report ◄─ [Web app] ◄────┘
```

---

## Step 1 — Database

The SQL in `supabase/migrations/` creates every table, the encryption
helpers, and the `claim_next_job` dispatcher. On **Lovable Cloud** these
migrations are applied automatically. If you run your own Supabase project,
apply them with the Supabase CLI:

```bash
supabase db push
```

Nothing else to configure here — the schema is complete.

## Step 2 — Make yourself an admin

1. Sign up / log in to the web app once (this creates your row in `users`).
2. In Supabase → Table Editor → `users`, set your row's `role` to `admin`.
3. Reload the app — the **Admin** section now appears in the sidebar.

## Step 3 — Add Turnitin accounts and slots

In the app, go to **Admin → Turnitin**:

1. **Add account** — the student login (label, email, password, login URL).
   The password is encrypted inside Postgres and never sent back to the
   browser.
2. Open the account → **Add slot** for each class/assignment you can submit
   to. A slot needs the **assignment dashboard URL** (the page with the blue
   "Upload Submission" button — open the class, click "Open" on the assignment,
   and copy that URL, e.g.
   `https://www.turnitin.com/assignment/type/paper/dashboard/<id>?lang=en_us`)
   and a `cooldown_hours` (default 24) so the same slot isn't reused too soon.

The worker only picks jobs when at least one **active account** has an
**active, off-cooldown slot**. No slots = jobs sit in `queued` forever.

## Step 4 — Set up the Contabo VPS worker

1. In the app, go to **Admin → VPS Credentials** and click **Reveal
   credentials**. Copy the full `.env` block (it includes your
   `SUPABASE_SERVICE_ROLE_KEY` — treat it like a password).

2. SSH into your Contabo box and bootstrap it:

   ```bash
   ssh root@<your-contabo-ip>

   # clone this repo (use YOUR repo URL)
   git clone https://github.com/goldfeatherpremium/report-ranger-suite.git /opt/dochub
   cd /opt/dochub/vps

   # one-shot install: Node 20, Chromium deps, Playwright, build, systemd unit
   bash install.sh
   ```

3. Paste the `.env` you copied in step 1:

   ```bash
   nano /opt/dochub/vps/worker/.env
   ```

4. Start the worker and watch its logs:

   ```bash
   systemctl restart turnitin-worker
   journalctl -u turnitin-worker -f
   ```

See `vps/README.md` for scaling to multiple workers and tuning the Turnitin
selectors.

## Step 5 — Verify it's connected

Back in the app, **Admin → Overview** has a **VPS Workers** panel. Within ~30s
of starting the worker you should see your `WORKER_ID` listed as **Online**.
If it stays empty, the worker isn't reaching the database — check
`journalctl -u turnitin-worker -f` on the VPS for errors (usually a wrong
`SUPABASE_SERVICE_ROLE_KEY` or a firewall blocking outbound HTTPS).

---

## Troubleshooting

- **Jobs stuck on `queued`** → no active slot is available, or no worker is
  online. Check the Workers panel and that you have an active account + slot.
- **Worker `Online` but jobs `failed`** → check `journalctl` for the
  Playwright error. The Turnitin selectors live in one block at the top of
  `vps/worker/src/turnitin.ts`; institutional skins may need tweaks. Run with
  `HEADLESS=false` on a desktop to watch the browser.
- **`Missing Supabase environment variable(s)`** in the web app → set
  `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` (already in `.env`) and
  the server-side `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`.
- **Worker won't build on the VPS** → re-run `bash install.sh`; it installs the
  TypeScript toolchain, compiles to `dist/`, then prunes dev dependencies.
</content>
