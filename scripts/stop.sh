#!/bin/bash
# Free the dev ports so `bun run dev` can bind them.
#
# The numbers are identity.json's (#459). package.json is static JSON and cannot
# read the file, so the lookup lives here instead of as a pair of literals in a
# script line — stale ones would kill nothing and leave `dev` failing on an
# address already in use, which reads as a port conflict rather than a stale
# number. Checked the same way build.sh checks its fields: a missing key would
# otherwise expand to nothing and `fuser -k` would take the remaining argument
# as its target.
set -e

cd "$(dirname "$0")/.."

PORTS=$(bun -e 'const id = await Bun.file("identity.json").json();
  const need = (k) => {
    const v = id[k];
    if (!Number.isInteger(v) || v <= 0) {
      console.error(`identity.json: ${k} is missing or not a positive integer`);
      process.exit(1);
    }
    return v;
  };
  console.log(`${need("devPort")}/tcp ${need("frontendDevPort")}/tcp`);')

fuser -k $PORTS 2>/dev/null || true
