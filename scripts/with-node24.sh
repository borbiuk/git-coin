#!/usr/bin/env sh
# Runs a command with Node.js 24.22.1 first in PATH, for machines whose default Node is another version.
# The repository needs Node 24 (package.json "engines", ADR 0003). CI already uses Node 24.
# Usage: ./scripts/with-node24.sh npm run check
#        ./scripts/with-node24.sh git commit -m "Add the CSV writer"   (the pre-commit hook runs npm)
exec npx -y -p node@24.22.1 -- "$@"
