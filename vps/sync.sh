#!/usr/bin/env bash
# sync.sh — pull latest from repo and install/update everything on this VPS.
#
# Works for both a fresh VPS and an existing install.
# Safe to re-run at any time — idempotent.
#
# Usage:
#   sudo bash vps/sync.sh                        # default branch (see BRANCH below)
#   sudo BRANCH=main bash vps/sync.sh            # explicit branch
#   sudo bash vps/sync.sh --student-only         # skip instructor worker
#   sudo bash vps/sync.sh --instructor-only      # skip student worker
#   sudo bash vps/sync.sh --force                # rebuild even if already at latest

set -euo pipefail

# ─── Configuration ─────────────────────────────────────────────────────────────
# Change this to 'main' once the instructor pipeline PR is merged.
DEFAULT_BRANCH="claude/turnitin-document-download-SxZs2"
# ───────────────────────────────────────────────────────────────────────────────

if [[ "$EUID" -ne 0 ]]; then
  echo "Run as root: sudo bash vps/sync.sh $*"
  exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STUDENT_DIR="$REPO_DIR/vps/worker"
INSTRUCTOR_DIR="$REPO_DIR/vps/worker-instructor"
BRANCH="${BRANCH:-$DEFAULT_BRANCH}"

FORCE=0; STUDENT_ONLY=0; INSTRUCTOR_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --force)            FORCE=1 ;;
    --student-only)     STUDENT_ONLY=1 ;;
    --instructor-only)  INSTRUCTOR_ONLY=1 ;;
  esac
done

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
ok()   { echo "[$(date '+%H:%M:%S')] ✓  $*"; }
warn() { echo "[$(date '+%H:%M:%S')] ⚠  $*"; }
err()  { echo "[$(date '+%H:%M:%S')] ✗  $*" >&2; }
sep()  { echo ""; echo "══════════════════════════════════════════════════"; }

# ── 0. Prerequisites ───────────────────────────────────────────────────────────
sep
log "Checking prerequisites"

# Node.js
if ! command -v node &>/dev/null; then
  log "Installing Node.js 20.x"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - 2>&1 | tail -3
  apt-get install -y nodejs 2>&1 | tail -3
fi
ok "Node $(node --version)"

# Playwright / Chromium (for Turnitin browser automation)
if ! node -e "require('playwright')" &>/dev/null 2>&1; then
  log "Installing Playwright (global)"
  npm install -g playwright 2>&1 | tail -3
fi
if ! command -v chromium-browser &>/dev/null && ! command -v google-chrome &>/dev/null; then
  log "Installing Playwright Chromium"
  npx playwright install chromium 2>&1 | tail -5
  npx playwright install-deps chromium 2>&1 | tail -5
fi
ok "Playwright ready"

# ── 1. Pull latest code ────────────────────────────────────────────────────────
sep
log "Fetching branch: $BRANCH"
cd "$REPO_DIR"

for attempt in 1 2 3 4; do
  if git fetch origin "$BRANCH" 2>&1 | tail -2; then break; fi
  warn "git fetch failed (attempt $attempt) — retrying in $((2**attempt))s"
  sleep $((2**attempt))
done

LOCAL=$(git rev-parse HEAD 2>/dev/null || echo none)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [[ "$LOCAL" == "$REMOTE" && "$FORCE" -eq 0 ]]; then
  log "Already at latest ($(git rev-parse --short HEAD))"
  log "Pass --force to rebuild anyway. Continuing with current code."
  FORCE=1
else
  if [[ "$LOCAL" != "$REMOTE" ]]; then
    log "New commits:"
    git log --oneline "${LOCAL}".."origin/$BRANCH" 2>/dev/null | sed 's/^/    /' || true
  fi
  git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
  git reset --hard "origin/$BRANCH"
  ok "Code at $(git rev-parse --short HEAD)"
fi

# ── Helpers ────────────────────────────────────────────────────────────────────
build_worker() {
  local dir="$1" label="$2"
  log "[$label] npm install"
  cd "$dir" && npm install --prefer-offline 2>&1 | grep -E "added|updated|warn|error" | head -5 || true
  log "[$label] build"
  npm run build 2>&1
  log "[$label] prune dev deps"
  npm prune --omit=dev 2>&1 | head -3 || true
  cd "$REPO_DIR"
  ok "[$label] build done"
}

install_unit() {
  local template="$1" unit="$2" dir="$3"
  sed "s|__WORKER_DIR__|${dir}|g" "$template" > "/etc/systemd/system/${unit}.service"
  systemctl daemon-reload
  systemctl enable "$unit" --quiet
  ok "[$unit] systemd unit installed/refreshed"
}

restart_svc() {
  local unit="$1"
  systemctl reset-failed "$unit" 2>/dev/null || true
  systemctl restart "$unit"
  sleep 3
  local state; state=$(systemctl is-active "$unit" 2>/dev/null || echo "unknown")
  if [[ "$state" == "active" ]]; then
    ok "[$unit] running"
  else
    warn "[$unit] state=$state"
    warn "Check logs: journalctl -u $unit -n 40 --no-pager"
  fi
}

# Copy any GEMINI_API_KEYS / GEMINI_API_KEY lines from the student .env into the
# instructor .env if they aren't already present there. Used both when creating
# a fresh instructor .env and to backfill an existing one.
sync_gemini_keys() {
  [[ -f "$STUDENT_DIR/.env" ]] || return 0
  for var in GEMINI_API_KEYS GEMINI_API_KEY; do
    local line; line=$(grep "^${var}=" "$STUDENT_DIR/.env" | head -1 || true)
    [[ -z "$line" ]] && continue
    if grep -q "^${var}=" "$INSTRUCTOR_DIR/.env" 2>/dev/null; then continue; fi
    echo "$line" >> "$INSTRUCTOR_DIR/.env"
    ok "Copied $var into instructor .env (from student worker)"
  done
}

ensure_instructor_env() {
  if [[ -f "$INSTRUCTOR_DIR/.env" ]]; then
    sync_gemini_keys   # backfill Gemini keys into an existing instructor .env
    return 0
  fi

  warn "Instructor .env not found — creating from student worker keys."
  if [[ ! -f "$STUDENT_DIR/.env" ]]; then
    err "Student .env not found either. Create $INSTRUCTOR_DIR/.env manually:"
    echo ""
    echo "  cat > $INSTRUCTOR_DIR/.env <<'EOF'"
    echo "  SUPABASE_URL=https://your-project.supabase.co"
    echo "  SUPABASE_SERVICE_ROLE_KEY=eyJ..."
    echo "  WORKER_ID=instructor-1"
    echo "  CONCURRENCY=5"
    echo "  HEADLESS=true"
    echo "  JOB_TIMEOUT_MS=3600000"
    echo "  AI_WRITING_TIMEOUT_MS=1200000"
    echo "  SUBMISSION_TIMEOUT_MS=900000"
    echo "  UPLOAD_TIMEOUT_MS=600000"
    echo "  POLL_INTERVAL_MS=30000"
    echo "  CLAIM_IDLE_MS=10000"
    echo "  HEARTBEAT_MS=30000"
    echo "  EOF"
    echo ""
    echo "  Then re-run: sudo bash vps/sync.sh --instructor-only"
    return 1
  fi

  local url; url=$(grep '^SUPABASE_URL=' "$STUDENT_DIR/.env" || true)
  local key; key=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' "$STUDENT_DIR/.env" || true)
  if [[ -z "$url" || -z "$key" ]]; then
    err "Could not read SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY from student .env."
    err "Create $INSTRUCTOR_DIR/.env manually, then re-run."
    return 1
  fi

  cat > "$INSTRUCTOR_DIR/.env" <<ENVEOF
$url
$key
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
  sync_gemini_keys   # also copy GEMINI_API_KEYS / GEMINI_API_KEY
  ok "Created $INSTRUCTOR_DIR/.env (SUPABASE + Gemini keys copied from student worker)"
}

# ── 2. Student worker ──────────────────────────────────────────────────────────
if [[ "$INSTRUCTOR_ONLY" -eq 0 ]]; then
  sep
  log "Student worker (similarity pipeline)"
  build_worker "$STUDENT_DIR" "student"
  install_unit "$REPO_DIR/vps/turnitin-worker.service" \
               "turnitin-worker" "$STUDENT_DIR"
  restart_svc  "turnitin-worker"
fi

# ── 3. Instructor worker ───────────────────────────────────────────────────────
if [[ "$STUDENT_ONLY" -eq 0 ]]; then
  sep
  if ensure_instructor_env; then
    log "Instructor worker (similarity + AI pipeline)"
    build_worker "$INSTRUCTOR_DIR" "instructor"
    install_unit "$REPO_DIR/vps/turnitin-instructor-worker.service" \
                 "turnitin-instructor-worker" "$INSTRUCTOR_DIR"
    restart_svc  "turnitin-instructor-worker"
  fi
fi

# ── 4. Final status ────────────────────────────────────────────────────────────
sep
log "Deployed: $(git rev-parse --short HEAD) (branch: $BRANCH)"
echo ""
log "Service status:"
for svc in turnitin-worker turnitin-instructor-worker; do
  if systemctl list-unit-files "$svc.service" --no-pager -q 2>/dev/null | grep -q "$svc"; then
    state=$(systemctl is-active "$svc" 2>/dev/null || echo unknown)
    enabled=$(systemctl is-enabled "$svc" 2>/dev/null || echo unknown)
    printf "  %-40s %s  (enabled: %s)\n" "$svc" "$state" "$enabled"
  fi
done
echo ""
log "Live logs:"
log "  Student:    journalctl -u turnitin-worker -f --no-pager"
log "  Instructor: journalctl -u turnitin-instructor-worker -f --no-pager"
