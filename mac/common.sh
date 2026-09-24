#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
CONFIG_FILE="$SCRIPT_DIR/config.sh"
[[ -f "$CONFIG_FILE" ]] || { print -u2 "缺少 $CONFIG_FILE；请先从 config.example.sh 创建配置文件。"; exit 2; }
source "$CONFIG_FILE"

[[ -n "${SPLITTER_DIR:-}" && -n "${QUEUE_ROOT:-}" && -n "${NODE_BIN:-}" && -x "$NODE_BIN" ]] || { print -u2 'config.sh 配置无效'; exit 2; }
[[ -f "$SPLITTER_DIR/bin/chapter-split" ]] || { print -u2 "找不到 chapter-split：$SPLITTER_DIR"; exit 2; }

INBOX_DIR="$QUEUE_ROOT/inbox"
JOBS_DIR="$QUEUE_ROOT/jobs"
OUTPUT_DIR="$QUEUE_ROOT/output"

valid_job_id() { [[ "$1" =~ '^[A-Za-z0-9_-]{12,80}$' ]]; }
status_file() { print -r -- "$JOBS_DIR/$1.json"; }
write_status() { "$NODE_BIN" "$SCRIPT_DIR/write-status.js" "$(status_file "$1")" "$2" "$3" "${4:-}"; }

find_input() {
  local job_id="$1" input
  for input in "$INBOX_DIR/$job_id.pdf" "$INBOX_DIR/$job_id.epub"; do
    [[ -f "$input" ]] && { print -r -- "$input"; return 0; }
  done
  return 1
}
