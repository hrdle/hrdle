#!/usr/bin/env bash
# Prepare bench fixtures used to compare CC Hub vs ssh+tmux throughput.
#
# Generates 100KB-class fixtures in /tmp:
#   bench-plain.txt  100KB ASCII (numeric)
#   bench-color.txt  100KB ANSI-colored lines (renderer-heavy)
#   bench-jp.txt     100KB Japanese text (CJK width-heavy)
#
# Usage:
#   bash scripts/prepare-bench-data.sh
#   # then on each client:
#   #   cat /tmp/bench-color.txt; echo __BENCH_END__
set -euo pipefail

OUT_DIR="${1:-/tmp}"
mkdir -p "$OUT_DIR"

# 1. Plain ASCII
seq 1 20000 > "$OUT_DIR/bench-plain.txt"

# 2. ANSI color
{
  for i in $(seq 1 5000); do
    printf '\e[3%dm行 %5d: foo bar baz qux quux corge grault garply\e[0m\n' \
      $((i % 7 + 1)) "$i"
  done
} > "$OUT_DIR/bench-color.txt"

# 3. Japanese (CJK). `yes | head -c` triggers SIGPIPE on `yes` which trips
# pipefail; tolerate that exit code with `|| true`.
{ yes 'あいうえおかきくけこさしすせそたちつてと日本語テキスト' | head -c 100000; } > "$OUT_DIR/bench-jp.txt" || true

# 4. Full-screen redraw burst (cursor moves + colors, mimics top/htop)
{
  for f in $(seq 1 200); do
    printf '\e[H\e[2J'  # home + clear
    for r in $(seq 1 24); do
      printf '\e[%d;1H\e[3%dm%-78s\e[0m\n' \
        "$r" $((r % 7 + 1)) "frame=$f row=$r $(date +%s%N)"
    done
  done
} > "$OUT_DIR/bench-redraw.txt"

ls -lh "$OUT_DIR"/bench-*.txt
echo
echo "Run on each client (ssh-termux / CC Hub):"
echo "  time (cat $OUT_DIR/bench-color.txt; echo __BENCH_END__)"
echo
echo "Frontend bench (DevTools console):"
echo "  __hrdle_bench.start()"
echo "  // run the cat command in CC Hub"
echo "  // report prints automatically when __BENCH_END__ is seen"
