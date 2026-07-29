#!/bin/bash
# Start the backend dev server on the dev port.
#
# The port has to be passed in. `bun run --watch src/index.ts` does not put
# `--watch` into the child's argv, so a dev check inside the CLI that looks for
# it is always false and the server falls back to the production port — which
# is the port the installed service is already serving on. package.json is
# static JSON and cannot read identity.json, so the lookup lives here, same as
# stop.sh. Checked the same way too: a missing key would expand to nothing and
# `-p` would swallow the next argument.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PORT=$(cd "$ROOT" && bun -e 'const id = await Bun.file("identity.json").json();
  const v = id.devPort;
  if (!Number.isInteger(v) || v <= 0) {
    console.error("identity.json: devPort is missing or not a positive integer");
    process.exit(1);
  }
  console.log(v);')

# staticRoot is resolved relative to the working directory, so the server has to
# run from backend/ the way `bun run --filter backend dev` used to start it.
cd "$ROOT/backend"
exec bun run --watch src/index.ts -p "$PORT" "$@"
