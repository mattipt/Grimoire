#!/usr/bin/env bash
{
set -euo pipefail

# Rebuild fixes/upstream and fork/custom from the atomic Tier 1 and Tier 2
# topic branches (plus fork/provenance) after rebasing onto an updated main.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

TIER1_PATCHES=(
  "patch/01-acp-load-session-replay-guard"
  "patch/02-optimistic-user-bubble-and-turn-order"
  "patch/03-preserve-streaming-autoscroll"
  "patch/04-stable-scrollbar-gutter"
  "patch/05-slash-command-ranking"
  "patch/06-multi-option-permission-mode-toggle"
  "patch/07-open-links-in-main-editor"
  "patch/08-markdown-table-cell-wrapping"
  "patch/09-dataview-inline-formula-guard"
  "patch/10-windowed-step-folding"
)

TIER2_PATCHES=(
  "patch/11-antigravity-five-work-modes"
  "patch/12-antigravity-workflows-root"
  "patch/13-agy-background-continuation"
  "patch/14-full-width-assistant-layout"
  "patch/15-antigravity-hide-parallel-workers"
  "patch/16-user-message-chat-bubble"
  "patch/17-antigravity-neutralize-expanded-slash-tokens"
  "fork/provenance"
)

merge_branch() {
  local branch="$1"
  git update-index -q --refresh || true
  if ! git merge --no-ff --no-stat -m "merge: integrate ${branch}" "${branch}"; then
    sleep 1
    git update-index -q --refresh || true
    git merge --no-ff --no-stat -m "merge: integrate ${branch}" "${branch}"
  fi
}

git update-index -q --refresh || true
git checkout -B fixes/upstream main
for branch in "${TIER1_PATCHES[@]}"; do
  if git show-ref --verify --quiet "refs/heads/${branch}"; then
    merge_branch "${branch}"
  fi
done

git update-index -q --refresh || true
git checkout -B fork/custom fixes/upstream
for branch in "${TIER2_PATCHES[@]}"; do
  if git show-ref --verify --quiet "refs/heads/${branch}"; then
    merge_branch "${branch}"
  fi
done

echo "Rebuilt fixes/upstream and fork/custom cleanly from all topic branches and fork/provenance."
exit 0
}
