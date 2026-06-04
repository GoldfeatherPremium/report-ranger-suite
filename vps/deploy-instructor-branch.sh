#!/usr/bin/env bash
# deploy-instructor-branch.sh — pull the instructor feature branch and redeploy
# the instructor worker (similarity + AI pipeline).
#
# Use this while the instructor pipeline still lives on the feature branch
# `claude/turnitin-document-download-SxZs2` (not yet merged to main). Once it
# IS merged, switch back to `sudo bash vps/full-update.sh`.
#
# What it does:
#   1. git fetch + hard-reset to the feature branch (keeps your untracked .env)
#   2. npm install → build → prune dev deps for the instructor worker
#   3. refresh the systemd unit and restart the service
#   4. tail the last log lines so you can confirm it picked up
#
# Usage:
#   sudo bash vps/deploy-instructor-branch.sh
#   sudo bash vps/deploy-instructor-branch.sh --both   # also rebuild student worker
#   sudo BRANCH=some/other-branch bash vps/deploy-instructor-branch.sh

set -euo pipefail

if [[ "$EUID" -ne 0 ]]; then
  echo "Run as root: sudo bash vps/deploy-instructor-branch.sh $*"
  exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STUDENT_DIR="$REPO_DIR/vps/worker"
INSTRUCTOR_DIR="$REPO_DIR/vps/worker-instructor"
BRANCH="${BRANCH:-claude/turnitin-document-download-SxZs2}"

BOTH=0
for arg in "$@"; do
  case "$arg" in
    --both) BOTH=1 ;;
  esac
done

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
ok()   { echo "[$(date '+%H:%M:%S')] ✓  $*"; }
warn() { echo "[$(date '+%H:%M:%S')] ⚠  $*"; }
sep()  { echo ""; echo "══════════════════════════════════════════════════"; }

# ── 1. PULL FEATURE BRANCH ──────────────────────────────────────────────────────
sep
log "Fetching branch: $BRANCH"
cd "$REPO_DIR"
for attempt in 1 2 3 4; do
  if git fetch origin "$BRANCH" 2>&1 | tail -2; then break; fi
  warn "fetch failed (attempt $attempt) — retrying in $((2**attempt))s"
  sleep $((2**attempt))
done

LOCAL=$(git rev-parse HEAD 2>/dev/null || echo none)
REMOTE=$(git rev-parse "origin/$BRANCH")
if [[ "$LOCAL" != "$REMOTE" ]]; then
  log "New commits:"
  git log --oneline "${LOCAL}".."origin/$BRANCH" 2>/dev/null | sed 's/^/    /' || true
fi
git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
git reset --hard "origin/$BRANCH"
ok "Code at $(git rev-parse --short HEAD) ($BRANCH)"

# ── helpers ─────────────────────────────────────────────────────────────────────
build_worker() {
  local dir="$1" label="$2"
  log "[$label] npm install"
  cd "$dir" && npm install --prefer-offline 2>&1 | grep -E "added|updated|warn|error" | head -5 || true
  log "[$label] build"
  npm run build 2>&1
  log "[$label] prune dev deps"
  npm prune --omit=dev 2>&1 | head -3 || true
  ok "[$label] build done"
}

install_unit() {
  local template="$1" unit="$2" dir="$3"
  sed "s|__WORKER_DIR__|${dir}|g" "$template" > "/etc/systemd/system/${unit}.service"
  systemctl daemon-reload
  systemctl enable "$unit" --quiet
  ok "[$unit] systemd unit refreshed"
}

restart_svc() {
  local unit="$1"
  systemctl reset-failed "$unit" 2>/dev/null || true
  systemctl restart "$unit"
  sleep 3
  local state; state=$(systemctl is-active "$unit" 2>/dev/null || echo "unknown")
  if [[ "$state" == "active" ]]; then ok "[$unit] running";
  else warn "[$unit] state=$state — check: journalctl -u $unit -n 40 --no-pager"; fi
}

# ── 2. OPTIONAL STUDENT WORKER ──────────────────────────────────────────────────
if [[ "$BOTH" -eq 1 ]]; then
  sep
  log "Student worker (similarity pipeline)"
  build_worker "$STUDENT_DIR" "student"
  install_unit "$REPO_DIR/vps/turnitin-worker.service" "turnitin-worker" "$STUDENT_DIR"
  restart_svc  "turnitin-worker"
fi

# Copy GEMINI_API_KEYS / GEMINI_API_KEY from student .env into instructor .env
# if not already present (backfills existing files too).
sync_gemini_keys() {
  [[ -f "$STUDENT_DIR/.env" ]] || return 0
  for var in GEMINI_API_KEYS GEMINI_API_KEY; do
    line=$(grep "^${var}=" "$STUDENT_DIR/.env" | head -1 || true)
    [[ -z "$line" ]] && continue
    if grep -q "^${var}=" "$INSTRUCTOR_DIR/.env" 2>/dev/null; then continue; fi
    echo "$line" >> "$INSTRUCTOR_DIR/.env"
    ok "Copied $var into instructor .env (from student worker)"
  done
}

# ── 3. INSTRUCTOR WORKER ────────────────────────────────────────────────────────
sep
if [[ ! -f "$INSTRUCTOR_DIR/.env" ]]; then
  warn "Instructor worker .env missing — creating from student worker keys."
  if [[ -f "$STUDENT_DIR/.env" ]]; then
    URL_LINE=$(grep '^SUPABASE_URL=' "$STUDENT_DIR/.env" || true)
    KEY_LINE=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' "$STUDENT_DIR/.env" || true)
    if [[ -n "$URL_LINE" && -n "$KEY_LINE" ]]; then
      cat > "$INSTRUCTOR_DIR/.env" <<ENVEOF
$URL_LINE
$KEY_LINE
WORKER_ID=instructor-1
CONCURRENCY=5
HEADLESS=true
JOB_TIMEOUT_MS=3600000
AI_WRITING_TIMEOUT_MS=1200000
SUBMISSION_TIMEOUT_MS=900000
UPLOAD_TIMEOUT_MS=600000
POLL_INTERVAL_MS=30000
CLAIM_IDLE_MS=10000
HEARTBEAT_MS=30000
ENVEOF
      sync_gemini_keys
      ok "Created $INSTRUCTOR_DIR/.env (copied SUPABASE + Gemini keys from student worker)"
    else
      warn "Could not read SUPABASE keys from $STUDENT_DIR/.env — create $INSTRUCTOR_DIR/.env manually."
      exit 1
    fi
  else
    warn "No student .env to copy from. Create $INSTRUCTOR_DIR/.env manually, then re-run."
    exit 1
  fi
else
  sync_gemini_keys   # backfill Gemini keys into existing instructor .env
fi

log "Instructor worker (similarity + AI pipeline)"
build_worker "$INSTRUCTOR_DIR" "instructor"
install_unit "$REPO_DIR/vps/turnitin-instructor-worker.service" "turnitin-instructor-worker" "$INSTRUCTOR_DIR"
restart_svc  "turnitin-instructor-worker"

# ── 4. STATUS + LOG TAIL ────────────────────────────────────────────────────────
sep
log "Deployed: $(git rev-parse --short HEAD) (branch: $BRANCH)"
echo ""
for svc in turnitin-worker turnitin-instructor-worker; do
  if systemctl list-unit-files "$svc.service" --no-pager -q 2>/dev/null | grep -q "$svc"; then
    state=$(systemctl is-active "$svc" 2>/dev/null || echo unknown)
    printf "  %-32s %s\n" "$svc" "$state"
  fi
done
echo ""
log "Recent instructor worker logs:"
journalctl -u turnitin-instructor-worker -n 20 --no-pager 2>/dev/null | sed 's/^/    /' || true
echo ""
log "Follow live: journalctl -u turnitin-instructor-worker -f --no-pager"
