#!/usr/bin/env bash
# Worker status & flow-settings inspector.
# Run from anywhere on the VPS: bash /root/report-ranger-suite/vps/status.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_DIR/vps/worker/.env"

RED='\033[0;31m'; YEL='\033[1;33m'; GRN='\033[0;32m'; CYN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

hr()  { echo -e "${CYN}────────────────────────────────────────────────────────────────${NC}"; }
hdr() { hr; echo -e "${BOLD}  $1${NC}"; hr; }

# ── Load .env ─────────────────────────────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  echo -e "${RED}ERROR: .env not found at $ENV_FILE${NC}"; exit 1
fi
# shellcheck disable=SC2046
export $(grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$' | xargs)

# ── Safe defaults (mirror envNum() in index.ts) ───────────────────────────────
SUBMISSION_TIMEOUT_MS=${SUBMISSION_TIMEOUT_MS:-900000}
UPLOAD_TIMEOUT_MS=${UPLOAD_TIMEOUT_MS:-600000}
POLL_INTERVAL_MS=${POLL_INTERVAL_MS:-30000}
CLAIM_IDLE_MS=${CLAIM_IDLE_MS:-10000}
HEARTBEAT_MS=${HEARTBEAT_MS:-30000}
HEADLESS=${HEADLESS:-true}
WORKER_ID=${WORKER_ID:-worker-unknown}

# Validate numbers (catch blank-string bug)
num_or_default() { local v; v=$(echo "$1" | tr -d '[:space:]'); [[ "$v" =~ ^[0-9]+$ && "$v" -gt 0 ]] && echo "$v" || echo "$2"; }
SUBMISSION_TIMEOUT_MS=$(num_or_default "$SUBMISSION_TIMEOUT_MS" 900000)
UPLOAD_TIMEOUT_MS=$(num_or_default     "$UPLOAD_TIMEOUT_MS"     600000)
POLL_INTERVAL_MS=$(num_or_default      "$POLL_INTERVAL_MS"       30000)
CLAIM_IDLE_MS=$(num_or_default         "$CLAIM_IDLE_MS"          10000)
HEARTBEAT_MS=$(num_or_default          "$HEARTBEAT_MS"           30000)

ms_to_human() {
  local ms=$1
  if   (( ms >= 60000 )); then echo "$((ms/60000)) min $((ms%60000/1000)) s"
  elif (( ms >= 1000  )); then echo "$((ms/1000)) s"
  else echo "${ms} ms"
  fi
}

echo ""
hdr "1. FLOW SETTINGS (.env → worker)"

echo -e "  Worker ID              : ${BOLD}$WORKER_ID${NC}"
echo -e "  Headless browser       : ${BOLD}$HEADLESS${NC}"
echo ""
echo -e "  Submission timeout     : ${BOLD}$(ms_to_human $SUBMISSION_TIMEOUT_MS)${NC}  (wait for similarity %)"
echo -e "  Upload timeout         : ${BOLD}$(ms_to_human $UPLOAD_TIMEOUT_MS)${NC}  (wait for 'Submit to Turnitin' button)"
echo -e "  Poll interval          : ${BOLD}$(ms_to_human $POLL_INTERVAL_MS)${NC}  (how often to reload dashboard)"
echo -e "  Claim idle sleep       : ${BOLD}$(ms_to_human $CLAIM_IDLE_MS)${NC}  (sleep when no job available)"
echo -e "  Heartbeat interval     : ${BOLD}$(ms_to_human $HEARTBEAT_MS)${NC}"

# Warn about blank values in .env
echo ""
for KEY in SUBMISSION_TIMEOUT_MS UPLOAD_TIMEOUT_MS POLL_INTERVAL_MS; do
  RAW=$(grep -E "^${KEY}[[:space:]]*=" "$ENV_FILE" | cut -d= -f2 | tr -d '[:space:]' || true)
  if [[ -z "$RAW" || "$RAW" == "0" ]]; then
    echo -e "  ${RED}WARNING: $KEY is blank/zero in .env — using fallback${NC}"
  fi
done

# ── Systemd service ───────────────────────────────────────────────────────────
hdr "2. WORKER SERVICE STATUS"
if systemctl is-active --quiet turnitin-worker 2>/dev/null; then
  echo -e "  Status  : ${GRN}RUNNING${NC}"
  systemctl status turnitin-worker --no-pager -l 2>/dev/null | grep -E "Active:|PID:|Memory:" | sed 's/^/  /'
else
  echo -e "  Status  : ${RED}NOT RUNNING${NC}"
  echo -e "  Start   : systemctl start turnitin-worker"
fi

# ── Git / build ───────────────────────────────────────────────────────────────
hdr "3. CODE VERSION"
cd "$REPO_DIR"
echo -e "  Branch  : $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
echo -e "  Commit  : $(git rev-parse --short HEAD 2>/dev/null || echo '?')"
echo -e "  Built   : $(stat -c '%y' "$REPO_DIR/vps/worker/dist/index.js" 2>/dev/null | cut -d. -f1 || echo 'not built')"

REMOTE_SHA=$(git rev-parse "origin/$(git rev-parse --abbrev-ref HEAD)" 2>/dev/null || echo '')
LOCAL_SHA=$(git rev-parse HEAD 2>/dev/null || echo '')
if [[ -n "$REMOTE_SHA" && "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
  echo -e "  ${YEL}Behind remote — run: git fetch origin && git reset --hard origin/$(git rev-parse --abbrev-ref HEAD)${NC}"
else
  echo -e "  Up to date with remote"
fi

# ── Query Supabase ─────────────────────────────────────────────────────────────
if [[ -z "${SUPABASE_URL:-}" || -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
  echo -e "${YEL}Skipping DB checks — SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set${NC}"
  exit 0
fi

API="$SUPABASE_URL/rest/v1"
AUTH=(-H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")

db_get() { curl -sf "${AUTH[@]}" -H "Accept: application/json" "$API/$1" 2>/dev/null || echo "[]"; }

# ── Turnitin slots ─────────────────────────────────────────────────────────────
hdr "4. TURNITIN SLOTS"
SLOTS=$(db_get "turnitin_slots?select=id,label,submit_url,cooldown_hours,is_active&order=created_at")
COUNT=$(echo "$SLOTS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d))" 2>/dev/null || echo "?")
echo -e "  Total slots: ${BOLD}$COUNT${NC}"
echo "$SLOTS" | python3 -c "
import sys, json
slots = json.load(sys.stdin)
for s in slots:
    active = '✓ active' if s.get('is_active') else '✗ disabled'
    url = (s.get('submit_url') or '—')[:60]
    print(f\"  [{active}] {s['label']}  cooldown={s['cooldown_hours']}h  url={url}\")
" 2>/dev/null || echo "  (could not parse slots)"

# ── Slot usage (in-use right now) ─────────────────────────────────────────────
hdr "5. SLOT USAGE (currently in use)"
USAGE=$(db_get "turnitin_slot_usage?select=slot_id,job_id,submitted_at,freed_at&freed_at=is.null&order=submitted_at.desc")
echo "$USAGE" | python3 -c "
import sys, json
rows = json.load(sys.stdin)
if not rows:
    print('  All slots are free')
else:
    for r in rows:
        print(f\"  slot={r['slot_id'][:8]}...  job={r['job_id'][:8]}...  since={r['submitted_at'][:19]}\")
" 2>/dev/null || echo "  (could not parse usage)"

# ── Current jobs ──────────────────────────────────────────────────────────────
hdr "6. CURRENT JOBS"
JOBS=$(db_get "jobs?select=id,status,original_name,attempts,max_attempts,error,created_at,turnitin_submission_id&order=created_at.desc&limit=15")
echo "$JOBS" | python3 -c "
import sys, json
jobs = json.load(sys.stdin)
if not jobs:
    print('  No jobs found')
    sys.exit()
# count by status
from collections import Counter
counts = Counter(j['status'] for j in jobs)
print('  Status summary (last 15):')
for s, n in sorted(counts.items()):
    print(f'    {s}: {n}')
print()
print('  Recent jobs:')
for j in jobs[:10]:
    name = (j.get('original_name') or '?')[:30]
    err  = ('  ERR: ' + j['error'][:50]) if j.get('error') else ''
    sub  = '  [submitted]' if j.get('turnitin_submission_id') else ''
    print(f\"  {j['status']:12}  {j['attempts']}/{j['max_attempts']} att  {name}{sub}{err}\")
" 2>/dev/null || echo "  (could not parse jobs)"

# ── Worker health ─────────────────────────────────────────────────────────────
hdr "7. WORKER HEALTH (DB heartbeat)"
HEALTH=$(db_get "worker_health?select=worker_id,last_seen,active_jobs,status")
echo "$HEALTH" | python3 -c "
import sys, json
from datetime import datetime, timezone
rows = json.load(sys.stdin)
if not rows:
    print('  No heartbeat recorded — worker may not have started yet')
    sys.exit()
for r in rows:
    try:
        last = datetime.fromisoformat(r['last_seen'].replace('Z','+00:00'))
        age  = int((datetime.now(timezone.utc) - last).total_seconds())
        age_str = f'{age}s ago' if age < 120 else f'{age//60}m ago'
        stale = '  ⚠ STALE' if age > 120 else ''
    except Exception:
        age_str = r['last_seen'][:19]; stale = ''
    print(f\"  worker={r['worker_id']}  status={r['status']}  active_jobs={r['active_jobs']}  last_seen={age_str}{stale}\")
" 2>/dev/null || echo "  (could not parse health)"

# ── Last 5 worker log lines ───────────────────────────────────────────────────
hdr "8. LAST 5 WORKER LOG LINES (from DB)"
LOGS=$(db_get "worker_logs?select=created_at,level,message&order=created_at.desc&limit=5")
echo "$LOGS" | python3 -c "
import sys, json
rows = json.load(sys.stdin)
for r in reversed(rows):
    ts  = r['created_at'][11:19]
    lvl = r['level'].upper()[:5]
    msg = (r.get('message') or '')[:100]
    print(f'  [{ts}] [{lvl}] {msg}')
" 2>/dev/null || echo "  (could not fetch logs)"

hr
echo ""
echo -e "  Full live logs  : ${BOLD}journalctl -u turnitin-worker -f${NC}"
echo -e "  Restart worker  : ${BOLD}systemctl restart turnitin-worker${NC}"
echo -e "  Pull latest code: ${BOLD}cd $REPO_DIR && git fetch origin && git reset --hard origin/\$(git rev-parse --abbrev-ref HEAD)${NC}"
echo ""
