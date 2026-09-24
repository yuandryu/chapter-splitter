#!/bin/zsh
set -euo pipefail
SCRIPT_DIR=${0:A:h}
source "$SCRIPT_DIR/common.sh"

JOB_ID="${1:-}"
valid_job_id "$JOB_ID" || { print -u2 '非法任务 ID'; exit 2; }
mkdir -p "$INBOX_DIR" "$JOBS_DIR" "$OUTPUT_DIR"
[[ -f "$(status_file "$JOB_ID")" ]] || write_status "$JOB_ID" queued '已入队，等待 Mac 开始处理。'
nohup "$SCRIPT_DIR/run-job.sh" "$JOB_ID" >"$JOBS_DIR/$JOB_ID.log" 2>&1 < /dev/null &
print -r -- "$JOB_ID"
