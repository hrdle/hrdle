#!/bin/bash
# Start an isolated stack for working on the steward.
#
# The steward watches every workspace and sends input to them, so pointing it
# at the default herdr server means pointing it at the user's own sessions -
# one of which is usually the session doing the work. Three things have to be
# separated for that to be safe, and only all three together are enough:
#
#   1. herdr    `--session <name>` is the only thing that isolates state. It
#               gives the server its own socket AND its own session.json;
#               HERDR_SOCKET_PATH alone moves the socket while the state
#               directory still follows $HOME, so a second server comes up
#               holding the user's workspaces.
#   2. data dir The dev backend otherwise shares the installed service's data
#               directory, which is where the steward store lives - dev runs
#               would write into what the real glasses read.
#   3. port     Already handled by devPort, same as dev-backend.sh.
#
# Usage:
#   scripts/dev-steward.sh            start the herdr dev server, dummy
#                                     workspaces and the backend (foreground)
#   scripts/dev-steward.sh --stop     stop the herdr dev server
#   scripts/dev-steward.sh --env      print the environment, to eval in a shell
#                                     that runs herdr commands against the dev
#                                     server
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSION="steward-dev"
HERDR_STATE_DIR="$HOME/.config/herdr/sessions/$SESSION"
SOCKET="$HERDR_STATE_DIR/herdr.sock"

# Read from identity.json rather than spelled out: a literal here stops matching
# after a rename, and the failure is silent - the variable sets nothing and the
# dev run writes into the real data directory. Same reasoning as dev-backend.sh
# and the test suite's use of IDENTITY.dataDirEnv.
eval "$(cd "$ROOT" && bun -e 'const id = await Bun.file("identity.json").json();
  const need = ["devPort", "dataDirEnv", "dataDirName", "binaryName"];
  for (const k of need) {
    if (!id[k]) { console.error(`identity.json: ${k} is missing`); process.exit(1); }
  }
  console.log(`DEV_PORT=${id.devPort}`);
  console.log(`DATA_DIR_ENV=${id.dataDirEnv}`);
  console.log(`DEV_DATA_DIR=$HOME/${id.dataDirName}-dev`);
  console.log(`STEWARD_ENV=${id.binaryName.toUpperCase()}_STEWARD`);')"

if [ "$1" = "--env" ]; then
  # HERDR_SESSION rather than HERDR_SOCKET_PATH: hrdle resolves the socket from
  # the session name and takes the name itself as "this is not the default
  # server", which is what keeps the steward's own session out of the user's.
  echo "export HERDR_SESSION=$SESSION"
  echo "export $DATA_DIR_ENV=$DEV_DATA_DIR"
  echo "export $STEWARD_ENV=1"
  exit 0
fi

if [ "$1" = "--stop" ]; then
  herdr --session "$SESSION" server stop 2>/dev/null || true
  echo "stopped the herdr dev server ($SESSION)"
  exit 0
fi

# Same as `bun run dev`: free the port first. Without it the new process finds
# the old one answering /health, reports "already running" and exits, so an
# edit-and-restart silently keeps testing the previous build.
bash "$ROOT/scripts/stop.sh"

if [ ! -S "$SOCKET" ]; then
  echo "starting herdr dev server ($SESSION)"
  herdr --session "$SESSION" server &
  for _ in $(seq 1 50); do
    [ -S "$SOCKET" ] && break
    sleep 0.1
  done
  if [ ! -S "$SOCKET" ]; then
    echo "herdr dev server did not come up at $SOCKET" >&2
    exit 1
  fi
fi

export HERDR_SESSION="$SESSION"
export HERDR_SOCKET_PATH="$SOCKET"

# Something for the steward to observe. Only created on a fresh state
# directory, so a restart keeps whatever the previous run left behind.
if [ "$(herdr workspace list 2>/dev/null | grep -c workspace_id)" = "0" ]; then
  echo "creating dummy workspaces"
  herdr workspace create --cwd "$ROOT" --label "steward-dev A" --no-focus >/dev/null
  herdr workspace create --cwd "$ROOT" --label "steward-dev B" --no-focus >/dev/null
fi

mkdir -p "$DEV_DATA_DIR"
export "$DATA_DIR_ENV=$DEV_DATA_DIR"
export "$STEWARD_ENV=1"

echo "herdr session: $HERDR_SESSION"
echo "data dir     : $DEV_DATA_DIR"
echo "steward      : on"

# staticRoot resolves relative to the working directory, same as dev-backend.sh.
cd "$ROOT/backend"
exec bun run --watch src/index.ts -p "$DEV_PORT" "$@"
