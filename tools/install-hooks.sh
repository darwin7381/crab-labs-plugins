#!/bin/sh
# Install repo git hooks (run once per clone; both mac-mini AND MBP).
cd "$(git rev-parse --show-toplevel)" || exit 1
cp tools/pre-push .git/hooks/pre-push && chmod +x .git/hooks/pre-push
echo "installed pre-push canary guard"
