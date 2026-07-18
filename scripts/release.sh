#!/usr/bin/env bash
#
# release.sh — one-command version bump + zip rebuild + preflight for JobBot / AutoApplier.
#
# This repo has no build system, so shipping a version means keeping THREE things in
# lock-step by hand: extension/manifest.json, version.json, and the committed
# jobbot-extension.zip. Forgetting any one silently breaks the update checker or ships
# a stale zip. This script does all of it in one shot and refuses to finish if any of
# the same checks CI runs would fail — so you catch problems before you push, not after.
#
# It touches ONLY version fields, notes, and the zip. It never edits extension source,
# api/, or any locked agent code.
#
# Usage:
#   scripts/release.sh <patch|minor|major|X.Y.Z> [options]
#   scripts/release.sh --check          # run preflight against the current tree, change nothing
#
# Options:
#   -n, --notes "<text>"   Release notes -> version.json "notes" (shown in the update card).
#   -c, --commit           git add the touched files + commit ("Release vX.Y.Z").
#   -t, --tag              git tag vX.Y.Z (implies --commit).
#   -p, --push             git push the current branch (and the tag if --tag). Implies --commit.
#       --dry-run          Show what would change; write nothing.
#       --check            Preflight only: syntax + JSON + version-sync + zip-match. No bump.
#   -h, --help             This help.
#
# Examples:
#   scripts/release.sh patch -n "Fix Naukri Gulf pagination"
#   scripts/release.sh 1.6.0 -n "Bayt multi-step forms" --commit --tag
#   scripts/release.sh --check
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MANIFEST="extension/manifest.json"
VERSION="version.json"
ZIP="jobbot-extension.zip"

# ── tiny output helpers ──────────────────────────────────────────────────────
if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; Z=$'\033[0m'; else B=; G=; Y=; R=; Z=; fi
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$G" "$Z" "$*"; }
warn() { printf '%s!%s %s\n' "$Y" "$Z" "$*"; }
die()  { printf '%s✗ %s%s\n' "$R" "$*" "$Z" >&2; exit 1; }
head() { printf '\n%s── %s ──%s\n' "$B" "$*" "$Z"; }

# ── args ─────────────────────────────────────────────────────────────────────
BUMP=""; NOTES=""; NOTES_SET=0
DO_COMMIT=0; DO_TAG=0; DO_PUSH=0; DRY=0; CHECK_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    -n|--notes)  NOTES="${2:-}"; NOTES_SET=1; shift 2 ;;
    -c|--commit) DO_COMMIT=1; shift ;;
    -t|--tag)    DO_TAG=1; DO_COMMIT=1; shift ;;
    -p|--push)   DO_PUSH=1; DO_COMMIT=1; shift ;;
    --dry-run)   DRY=1; shift ;;
    --check)     CHECK_ONLY=1; shift ;;
    -h|--help)   sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)          die "unknown option: $1  (see --help)" ;;
    *)           [ -z "$BUMP" ] || die "unexpected extra argument: $1"; BUMP="$1"; shift ;;
  esac
done

command -v node >/dev/null 2>&1 || die "node is required"
command -v zip  >/dev/null 2>&1 || die "zip is required"
command -v unzip >/dev/null 2>&1 || die "unzip is required"
[ -f "$MANIFEST" ] || die "$MANIFEST not found — run from the repo root"

CUR="$(node -p "require('./$MANIFEST').version")"

# ── preflight: the exact checks CI runs, locally ─────────────────────────────
preflight() {
  head "Preflight (same checks as CI)"

  node -e "new Function(require('fs').readFileSync('extension/content.js','utf8'))" \
    && ok "content.js parses (IIFE)" || die "content.js syntax error"

  for f in extension/background.js extension/popup.js extension/linkedin_autoapply.js; do
    [ -f "$f" ] || continue
    node --check "$f" && ok "$f" || die "$f syntax error"
  done

  for f in api/*.js; do
    [ -e "$f" ] || break
    node --input-type=module --check < "$f" && ok "$f" || die "$f syntax error"
  done

  for j in "$MANIFEST" "$VERSION" vercel.json; do
    [ -f "$j" ] || continue
    node -e "JSON.parse(require('fs').readFileSync('$j','utf8'))" && ok "$j is valid JSON" || die "$j is invalid JSON"
  done

  local m v
  m="$(node -p "require('./$MANIFEST').version")"
  v="$(node -p "require('./$VERSION').version")"
  [ "$m" = "$v" ] && ok "version sync: manifest=$m == version.json=$v" \
    || die "version out of sync: manifest=$m version.json=$v"

  [ -f "$ZIP" ] || die "$ZIP is missing"
  local tmp; tmp="$(mktemp -d)"
  unzip -q "$ZIP" -d "$tmp"
  if diff -rq extension "$tmp/extension" >/dev/null 2>&1; then
    ok "$ZIP matches extension/ source"
  else
    diff -r extension "$tmp/extension" || true
    rm -rf "$tmp"
    die "$ZIP is stale — it does not match extension/. Run a real release (not --check) to rebuild."
  fi
  rm -rf "$tmp"
}

if [ "$CHECK_ONLY" = 1 ]; then
  preflight
  head "Result"; ok "Tree is release-clean at v$CUR."
  exit 0
fi

# ── compute the new version ──────────────────────────────────────────────────
[ -n "$BUMP" ] || die "specify a bump: patch | minor | major | X.Y.Z   (or --check). See --help."

if printf '%s' "$BUMP" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  NEW="$BUMP"
else
  case "$BUMP" in
    major|minor|patch)
      IFS=. read -r MA MI PA <<EOF
$CUR
EOF
      case "$BUMP" in
        major) MA=$((MA+1)); MI=0; PA=0 ;;
        minor) MI=$((MI+1)); PA=0 ;;
        patch) PA=$((PA+1)) ;;
      esac
      NEW="$MA.$MI.$PA"
      ;;
    *) die "bump must be patch|minor|major or X.Y.Z, got: $BUMP" ;;
  esac
fi

# strict monotonic guard (avoids fat-finger downgrades that the update checker would ignore)
node -e '
  const c=process.argv[1].split(".").map(Number), n=process.argv[2].split(".").map(Number);
  const cmp=(a,b)=>{for(let i=0;i<3;i++){if((a[i]||0)!==(b[i]||0))return (a[i]||0)<(b[i]||0)?-1:1;}return 0;};
  if(cmp(n,c)<=0){console.error("new version "+process.argv[2]+" is not greater than current "+process.argv[1]);process.exit(1);}
' "$CUR" "$NEW" || die "refusing to bump: $NEW ≤ $CUR"

head "Release plan"
say "  current : v$CUR"
say "  new     : ${B}v$NEW${Z}"
if [ "$NOTES_SET" = 1 ]; then say "  notes   : $NOTES"; else say "  notes   : ${Y}(unchanged)${Z}"; fi
say "  files   : $MANIFEST, $VERSION, $ZIP"
[ "$DO_COMMIT" = 1 ] && say "  git     : commit${DO_TAG:+ + tag v$NEW}${DO_PUSH:+ + push}" || say "  git     : (none — files left staged for you)"

if [ "$DRY" = 1 ]; then head "Dry run"; warn "no files written."; exit 0; fi

# ── write manifest.json + version.json (node = safe JSON, key order preserved) ─
node -e '
  const fs=require("fs");
  const f=process.argv[1], nv=process.argv[2];
  const j=JSON.parse(fs.readFileSync(f,"utf8"));
  j.version=nv;
  fs.writeFileSync(f, JSON.stringify(j,null,2)+"\n");
' "$MANIFEST" "$NEW"
ok "manifest.json -> v$NEW"

node -e '
  const fs=require("fs");
  const f=process.argv[1], nv=process.argv[2], notesSet=process.argv[3]==="1", notes=process.argv[4];
  const j=JSON.parse(fs.readFileSync(f,"utf8"));
  j.version=nv;
  if(notesSet) j.notes=notes;
  fs.writeFileSync(f, JSON.stringify(j,null,2)+"\n");
' "$VERSION" "$NEW" "$NOTES_SET" "$NOTES"
ok "version.json -> v$NEW$([ "$NOTES_SET" = 1 ] && echo ' (+notes)')"

# ── rebuild the zip from source (deterministic-ish: drop the old first) ───────
rm -f "$ZIP"
zip -rq "$ZIP" extension
ok "$ZIP rebuilt from extension/"

# ── verify what we just produced ─────────────────────────────────────────────
preflight

# ── optional git steps ───────────────────────────────────────────────────────
if [ "$DO_COMMIT" = 1 ]; then
  head "Git"
  git add "$MANIFEST" "$VERSION" "$ZIP"
  git commit -m "Release v$NEW" >/dev/null
  ok "committed: Release v$NEW"
  if [ "$DO_TAG" = 1 ]; then
    git tag "v$NEW"
    ok "tagged v$NEW"
  fi
  if [ "$DO_PUSH" = 1 ]; then
    branch="$(git rev-parse --abbrev-ref HEAD)"
    git push -u origin "$branch"
    [ "$DO_TAG" = 1 ] && git push origin "v$NEW"
    ok "pushed $branch$([ "$DO_TAG" = 1 ] && echo ' + tag')"
  fi
else
  head "Next"
  say "  Files updated & staged-able. To finish:"
  say "    git add $MANIFEST $VERSION $ZIP && git commit -m \"Release v$NEW\""
  say "  Or re-run with --commit (and --tag / --push)."
fi

head "Done"; ok "Released v$NEW locally."
