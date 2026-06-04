#!/usr/bin/env bash
# full-update.sh — pull ALL latest changes from GitHub and redeploy both workers.
#
# Handles everything in one run:
#   1. git pull (main or any branch via WORKER_BRANCH env)
#   2. Student worker: npm install → build → prune → systemd unit → restart
#   3. Instructor worker: same (skipped if .env not present, with setup hint)
#   4. Final status summary
#
# Usage:
#   sudo bash vps/full-update.sh
#   sudo WORKER_BRANCH=main bash vps/full-update.sh   # explicit branch
#   sudo bash vps/full-update.sh --force              # rebuild even if already up to date
#   sudo bash vps/full-update.sh --instructor-only    # skip student worker
#   sudo bash vps/full-update.sh --student-only       # skip instructor worker

set -euo pipefail

# ── root check ────────────────────────────────────────────────────────────────
if [[ "$EUID" -ne 0 ]]; then
  echo "Run as root: sudo bash vps/full-update.sh $*"
  exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STUDENT_DIR="$REPO_DIR/vps/worker"
INSTRUCTOR_DIR="$REPO_DIR/vps/worker-instructor"
BRANCH="${WORKER_BRANCH:-main}"

FORCE=0; STUDENT_ONLY=0; INSTRUCTOR_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --force)            FORCE=1 ;;
    --student-only)     STUDENT_ONLY=1 ;;
    --instructor-only)  INSTRUCTOR_ONLY=1 ;;
  esac
done

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
sep()  { echo ""; echo "══════════════════════════════════════════════════"; }
ok()   { echo "[$(date '+%H:%M:%S')] ✓  $*"; }
warn() { echo "[$(date '+%H:%M:%S')] ⚠  $*"; }

# ── 1. GIT PULL ───────────────────────────────────────────────────────────────
sep
log "Fetching branch: $BRANCH"
cd "$REPO_DIR"
git fetch origin "$BRANCH" 2>&1 | tail -3

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [[ "$LOCAL" == "$REMOTE" && "$FORCE" -eq 0 ]]; then
  log "Already at latest ($LOCAL)"
  log "Pass --force to rebuild anyway"
  FORCE=1  # still show status below
fi

if [[ "$LOCAL" != "$REMOTE" ]]; then
  log "New commits:"
  git log --oneline "$LOCAL".."origin/$BRANCH" | sed 's/^/    /'
  log "Applying $LOCAL → $REMOTE"
  git checkout "$BRANCH" 2>/dev/null || true
  git reset --hard "origin/$BRANCH"
  ok "Code updated to $(git rev-parse --short HEAD)"
fi

# ── helper functions ──────────────────────────────────────────────────────────
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
  local dest="/etc/systemd/system/${unit}.service"
  sed "s|__WORKER_DIR__|${dir}|g" "$template" > "$dest"
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
  if [[ "$state" == "active" ]]; then
    ok "[$unit] running"
  else
    warn "[$unit] state=$state — check: journalctl -u $unit -n 40 --no-pager"
  fi
}

# ── 2. STUDENT WORKER ─────────────────────────────────────────────────────────
if [[ "$INSTRUCTOR_ONLY" -eq 0 ]]; then
  sep
  log "Student worker (similarity pipeline)"
  build_worker "$STUDENT_DIR" "student"
  install_unit  "$REPO_DIR/vps/turnitin-worker.service" \
                "turnitin-worker" \
                "$STUDENT_DIR"
  restart_svc   "turnitin-worker"
fi

# ── 3. INSTRUCTOR WORKER ──────────────────────────────────────────────────────
if [[ "$STUDENT_ONLY" -eq 0 ]]; then
  sep
  if [[ ! -f "$INSTRUCTOR_DIR/.env" ]]; then
    warn "Instructor worker skipped — .env not found."
    echo ""
    echo "  To set it up (copies keys from working student .env):"
    echo ""
    echo "    URL=\$(grep '^SUPABASE_URL=' $STUDENT_DIR/.env)"
    echo "    KEY=\$(grep '^SUPABASE_SERVICE_ROLE_KEY=' $STUDENT_DIR/.env)"
    echo "    cat > $INSTRUCTOR_DIR/.env <<'ENVEOF'"
    echo "    \$URL"
    echo "    \$KEY"
    echo "    WORKER_ID=instructor-1"
    echo "    CONCURRENCY=5"
    echo "    HEADLESS=true"
    echo "    JOB_TIMEOUT_MS=3600000"
    echo "    AI_WRITING_TIMEOUT_MS=1200000"
    echo "    SUBMISSION_TIMEOUT_MS=900000"
    echo "    UPLOAD_TIMEOUT_MS=600000"
    echo "    POLL_INTERVAL_MS=30000"
    echo "    CLAIM_IDLE_MS=10000"
    echo "    HEARTBEAT_MS=30000"
    echo "    ENVEOF"
    echo ""
    echo "  Then re-run: sudo bash $REPO_DIR/vps/full-update.sh --instructor-only"
  else
    log "Instructor worker (similarity + AI pipeline)"
    build_worker "$INSTRUCTOR_DIR" "instructor"
    install_unit  "$REPO_DIR/vps/turnitin-instructor-worker.service" \
                  "turnitin-instructor-worker" \
                  "$INSTRUCTOR_DIR"
    restart_svc   "turnitin-instructor-worker"
  fi
fi

# ── 4. FINAL STATUS ───────────────────────────────────────────────────────────
sep
log "Deployed: $(git -C "$REPO_DIR" rev-parse --short HEAD) (branch: $BRANCH)"
echo ""
log "Service status:"
for svc in turnitin-worker turnitin-instructor-worker; do
  if systemctl list-unit-files "$svc.service" --no-pager -q 2>/dev/null | grep -q "$svc"; then
    state=$(systemctl is-active "$svc" 2>/dev/null || echo "unknown")
    enabled=$(systemctl is-enabled "$svc" 2>/dev/null || echo "unknown")
    printf "  %-38s  %s  (enabled: %s)\n" "$svc" "$state" "$enabled"
  fi
done
echo ""
log "Live logs:"
log "  Student:    journalctl -u turnitin-worker -f --no-pager"
log "  Instructor: journalctl -u turnitin-instructor-worker -f --no-pager"
