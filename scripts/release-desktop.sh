#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP_REPO="${DESKTOP_REPO:-$ROOT/../slash-desktop}"
SERVER_REPO="${SERVER_REPO:-$ROOT/../slash-server}"
REPO_FULL_NAME="${REPO_FULL_NAME:-okzhu-al/slash-desktop}"

VERSION=""
RUN_CHECKS=1
WAIT_FOR_ACTIONS=1
PUBLISH_SERVER=1

usage() {
  cat <<'EOF'
Usage: scripts/release-desktop.sh -v <version> [options]

Runs the full desktop release loop:
  1. Update desktop version files and update.json in the main repo.
  2. Run local checks.
  3. Commit and push the main repo.
  4. Publish split repos.
  5. Commit the desktop mirror, push only the release tag, and wait for Actions.
  6. Fetch generated updater signatures, update both update.json files.
  7. Push slash-desktop/main and commit/push the main repo updater metadata.

Options:
  -v, --version       Version to release, for example 0.1.3.
  --skip-checks       Skip local build/type/cargo/sensitive checks.
  --no-wait           Stop after pushing the tag. Finalize later manually.
  --skip-server       Do not sync, commit, or push the server mirror.
  -h, --help          Show this help.

Environment:
  DESKTOP_REPO        Path to the slash-desktop mirror. Default: ../slash-desktop
  SERVER_REPO         Path to the slash-server mirror. Default: ../slash-server
  REPO_FULL_NAME      GitHub desktop repo. Default: okzhu-al/slash-desktop
EOF
}

log() {
  printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

run() {
  echo "+ $*"
  "$@"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

git_dirty() {
  [ -n "$(git -C "$1" status --porcelain)" ]
}

commit_if_dirty() {
  local repo="$1"
  local message="$2"
  if git_dirty "$repo"; then
    run git -C "$repo" add -A
    run git -C "$repo" commit -m "$message"
  else
    echo "No changes to commit in $repo"
  fi
}

push_if_has_remote() {
  local repo="$1"
  local branch="$2"
  if git -C "$repo" remote get-url origin >/dev/null 2>&1; then
    run git -C "$repo" push origin "$branch"
  else
    echo "No origin remote in $repo; skipping push"
  fi
}

validate_version() {
  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]] || \
    die "Version must look like 0.1.2 or 0.1.2-beta.1"
}

ensure_repos() {
  [ -d "$ROOT/.git" ] || die "Main repo is not a git repo: $ROOT"
  [ -d "$DESKTOP_REPO/.git" ] || die "Desktop mirror is not a git repo: $DESKTOP_REPO"
  if [ "$PUBLISH_SERVER" -eq 1 ]; then
    [ -d "$SERVER_REPO/.git" ] || die "Server mirror is not a git repo: $SERVER_REPO"
  fi
}

ensure_tag_available() {
  local tag="v$VERSION"
  if git -C "$DESKTOP_REPO" rev-parse "$tag" >/dev/null 2>&1; then
    die "Local desktop tag already exists: $tag"
  fi
  if git -C "$DESKTOP_REPO" ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; then
    die "Remote desktop tag already exists: $tag"
  fi
}

update_versions() {
  log "Updating version metadata to $VERSION"
  VERSION="$VERSION" ROOT="$ROOT" REPO_FULL_NAME="$REPO_FULL_NAME" python3 <<'PY'
import json
import os
from pathlib import Path

root = Path(os.environ["ROOT"])
version = os.environ["VERSION"]
repo = os.environ["REPO_FULL_NAME"]

package_path = root / "apps/desktop/package.json"
package = json.loads(package_path.read_text())
package["version"] = version
package_path.write_text(json.dumps(package, indent=2) + "\n")

tauri_path = root / "apps/desktop/src-tauri/tauri.conf.json"
tauri = json.loads(tauri_path.read_text())
tauri["version"] = version
tauri_path.write_text(json.dumps(tauri, indent=2) + "\n")

update_path = root / "update.json"
update = json.loads(update_path.read_text())
update["version"] = version
update["notes"] = f"Slash v{version} release."
update["pub_date"] = os.environ.get("PUB_DATE") or __import__("datetime").datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
update["platforms"]["darwin-aarch64"]["url"] = f"https://github.com/{repo}/releases/download/v{version}/Slash.app.tar.gz"
update["platforms"]["windows-x86_64"]["url"] = f"https://github.com/{repo}/releases/download/v{version}/Slash_{version}_x64-setup.exe"
update_path.write_text(json.dumps(update, indent=2) + "\n")
PY
}

run_checks() {
  if [ "$RUN_CHECKS" -eq 0 ]; then
    log "Skipping local checks"
    return
  fi

  log "Running local release checks"
  run pnpm --dir "$ROOT/packages/js-editor-core" build
  run pnpm --dir "$ROOT/apps/desktop" exec tsc --noEmit
  run cargo check --manifest-path "$ROOT/Cargo.toml"
  run "$ROOT/scripts/check-sensitive.sh"
}

publish_mirrors() {
  log "Publishing split repos"
  if [ "$PUBLISH_SERVER" -eq 1 ]; then
    run "$ROOT/scripts/publish-all.sh"
  else
    run "$ROOT/scripts/publish-desktop.sh"
  fi
  [ ! -d "$DESKTOP_REPO/apps/server" ] || die "apps/server leaked into desktop mirror"
}

commit_and_tag_desktop() {
  local tag="v$VERSION"
  log "Committing desktop mirror and pushing release tag only"
  commit_if_dirty "$DESKTOP_REPO" "release: sync desktop $tag"
  run git -C "$DESKTOP_REPO" tag "$tag"
  run git -C "$DESKTOP_REPO" push origin "$tag"
}

publish_server_if_needed() {
  if [ "$PUBLISH_SERVER" -eq 0 ]; then
    log "Skipping server mirror push"
    return
  fi

  log "Committing and pushing server mirror if changed"
  commit_if_dirty "$SERVER_REPO" "release: sync server v$VERSION"
  push_if_has_remote "$SERVER_REPO" "$(git -C "$SERVER_REPO" branch --show-current)"
}

fetch_run_id() {
  local tag="v$VERSION"
  local sha
  sha="$(git -C "$DESKTOP_REPO" rev-parse "$tag")"
  for _ in $(seq 1 60); do
    local run_id
    run_id="$(curl -fsSL "https://api.github.com/repos/$REPO_FULL_NAME/actions/runs?per_page=20" | \
      jq -r --arg tag "$tag" --arg sha "$sha" '
        .workflow_runs[]
        | select(.event == "push" and .head_branch == $tag and .head_sha == $sha)
        | .id
      ' | head -n 1)"
    if [ -n "$run_id" ]; then
      echo "$run_id"
      return 0
    fi
    sleep 5
  done
  return 1
}

wait_for_actions() {
  if [ "$WAIT_FOR_ACTIONS" -eq 0 ]; then
    log "Tag pushed. Stop here because --no-wait was requested."
    return
  fi

  log "Waiting for GitHub Actions release run"
  local run_id
  run_id="$(fetch_run_id)" || die "Could not find Actions run for v$VERSION"
  echo "Actions run: https://github.com/$REPO_FULL_NAME/actions/runs/$run_id"

  while true; do
    local state
    state="$(curl -fsSL "https://api.github.com/repos/$REPO_FULL_NAME/actions/runs/$run_id" | \
      jq -r '[.status, (.conclusion // "")] | @tsv')"
    echo "Run state: $state"

    local status conclusion
    status="$(echo "$state" | cut -f1)"
    conclusion="$(echo "$state" | cut -f2)"

    curl -fsSL "https://api.github.com/repos/$REPO_FULL_NAME/actions/runs/$run_id/jobs?per_page=20" | \
      jq -r '.jobs[] | [.name, .status, (.conclusion // "")] | @tsv'

    if [ "$status" = "completed" ]; then
      [ "$conclusion" = "success" ] || die "Actions failed with conclusion: $conclusion"
      break
    fi
    sleep 60
  done
}

download_signature() {
  local url="$1"
  for _ in $(seq 1 120); do
    local sig
    sig="$(curl -fsSL "$url" 2>/dev/null || true)"
    if [ -n "$sig" ]; then
      printf '%s' "$sig"
      return 0
    fi
    sleep 15
  done
  return 1
}

finalize_updater() {
  [ "$WAIT_FOR_ACTIONS" -eq 1 ] || return

  log "Fetching updater signatures and finalizing update.json"
  local tag="v$VERSION"
  local mac_url="https://github.com/$REPO_FULL_NAME/releases/download/$tag/Slash.app.tar.gz.sig"
  local win_url="https://github.com/$REPO_FULL_NAME/releases/download/$tag/Slash_${VERSION}_x64-setup.exe.sig"
  local mac_sig win_sig
  mac_sig="$(download_signature "$mac_url")" || die "Could not download macOS updater signature"
  win_sig="$(download_signature "$win_url")" || die "Could not download Windows updater signature"

  VERSION="$VERSION" ROOT="$ROOT" DESKTOP_REPO="$DESKTOP_REPO" REPO_FULL_NAME="$REPO_FULL_NAME" MAC_SIG="$mac_sig" WIN_SIG="$win_sig" python3 <<'PY'
import json
import os
from pathlib import Path

version = os.environ["VERSION"]
repo = os.environ["REPO_FULL_NAME"]
mac_sig = os.environ["MAC_SIG"]
win_sig = os.environ["WIN_SIG"]

for base in [Path(os.environ["ROOT"]), Path(os.environ["DESKTOP_REPO"])]:
    path = base / "update.json"
    data = json.loads(path.read_text())
    data["version"] = version
    data["platforms"]["darwin-aarch64"]["url"] = f"https://github.com/{repo}/releases/download/v{version}/Slash.app.tar.gz"
    data["platforms"]["darwin-aarch64"]["signature"] = mac_sig
    data["platforms"]["windows-x86_64"]["url"] = f"https://github.com/{repo}/releases/download/v{version}/Slash_{version}_x64-setup.exe"
    data["platforms"]["windows-x86_64"]["signature"] = win_sig
    path.write_text(json.dumps(data, indent=2) + "\n")
PY

  commit_if_dirty "$DESKTOP_REPO" "chore: auto-populate dual-platform updater signatures for $tag"
  push_if_has_remote "$DESKTOP_REPO" "$(git -C "$DESKTOP_REPO" branch --show-current)"

  commit_if_dirty "$ROOT" "chore: auto-populate dual-platform updater signatures for $tag"
  push_if_has_remote "$ROOT" "$(git -C "$ROOT" branch --show-current)"

  log "Verifying online updater metadata"
  curl -fsSL "https://raw.githubusercontent.com/$REPO_FULL_NAME/main/update.json" | \
    jq -r '{version, mac_url:.platforms["darwin-aarch64"].url, mac_sig_len:(.platforms["darwin-aarch64"].signature|length), win_url:.platforms["windows-x86_64"].url, win_sig_len:(.platforms["windows-x86_64"].signature|length)}'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -v|--version)
      opt="$1"
      shift
      [ "$#" -gt 0 ] || die "$opt requires a version value"
      [ -z "$VERSION" ] || die "Version was already set to $VERSION"
      VERSION="$1"
      ;;
    --skip-checks)
      RUN_CHECKS=0
      ;;
    --no-wait)
      WAIT_FOR_ACTIONS=0
      ;;
    --skip-server)
      PUBLISH_SERVER=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      die "Unknown option: $1"
      ;;
    *)
      [ -z "$VERSION" ] || die "Version was already set to $VERSION"
      VERSION="$1"
      ;;
  esac
  shift
done

[ -n "$VERSION" ] || { usage; exit 1; }
validate_version

require_cmd git
require_cmd python3
require_cmd curl
require_cmd jq
if [ "$RUN_CHECKS" -eq 1 ]; then
  require_cmd pnpm
  require_cmd cargo
fi

ensure_repos
ensure_tag_available

update_versions
run_checks

log "Committing and pushing main repo release preparation"
commit_if_dirty "$ROOT" "release: prepare v$VERSION"
push_if_has_remote "$ROOT" "$(git -C "$ROOT" branch --show-current)"

publish_mirrors
commit_and_tag_desktop
publish_server_if_needed
wait_for_actions
finalize_updater

log "Desktop release v$VERSION completed"
