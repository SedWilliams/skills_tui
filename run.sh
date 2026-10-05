#!/bin/sh
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
if [ ! -d "$here/node_modules" ]; then
    (cd "$here" && npm install)
fi
# Rebuild when any source file is newer than the last build.
if [ ! -f "$here/dist/cli.js" ] || [ -n "$(find "$here/src" -newer "$here/dist/cli.js" -name '*.ts*' | head -n 1)" ]; then
    (cd "$here" && npm run --silent build)
fi
# Stay in the caller's directory so relative --root and --project paths work.
exec node "$here/dist/cli.js" "$@"
