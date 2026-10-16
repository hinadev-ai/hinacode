#!/usr/bin/env bash
# Usage: seed-repo.sh <dir>
# Creates a throwaway git repo on `main` with one commit and an untracked, gitignored .env,
# so worktree setup scripts have something to copy. Put it inside the user data dir so cleanup.sh removes it
# (worktrees land next to it in <parent>/.hinacode-worktrees/<repo-name>/).
set -euo pipefail
dir=${1:?target dir, e.g. /tmp/kk-verify-userdata/repo}
[[ -e "$dir" ]] && { echo "$dir already exists" >&2; exit 1; }
mkdir -p "$dir"
cd "$dir"
git init -q -b main
printf '# kk verify\n' >README.md
printf '.env\n' >.gitignore
printf 'VERIFY_SECRET=from-root\n' >.env
git add README.md .gitignore
git -c user.name=kk-verify -c user.email=kk-verify@localhost commit -qm "chore: seed"
echo "$dir"
