#!/bin/zsh
set -euo pipefail
SCRIPT_DIR=${0:A:h}
source "$SCRIPT_DIR/common.sh"

JOB_ID="${1:-}"
valid_job_id "$JOB_ID" || exit 2
mkdir -p "$INBOX_DIR" "$JOBS_DIR" "$OUTPUT_DIR"
write_status "$JOB_ID" waiting '等待 iCloud Drive 同步输入文件。'

INPUT=''
for _ in {1..120}; do
  INPUT="$(find_input "$JOB_ID" || true)"
  [[ -n "$INPUT" ]] && break
  sleep 5
done
if [[ -z "$INPUT" ]]; then
  write_status "$JOB_ID" failed '等待输入文件超时（10 分钟）。'
  exit 1
fi

RESULT_DIR="$OUTPUT_DIR/$JOB_ID"
if [[ -e "$RESULT_DIR" ]]; then
  write_status "$JOB_ID" failed '结果目录已存在；请创建一个新任务。'
  exit 1
fi
mkdir -p "$RESULT_DIR"
write_status "$JOB_ID" running '正在识别章节并切分文件。'
if ! "$NODE_BIN" "$SPLITTER_DIR/bin/chapter-split" "$INPUT" --out "$RESULT_DIR"; then
  write_status "$JOB_ID" failed '拆分失败；请查看同名 .log 文件。'
  exit 1
fi

ARCHIVE="$OUTPUT_DIR/$JOB_ID.zip"
if ! (cd "$OUTPUT_DIR" && /usr/bin/zip -X -q -r "$ARCHIVE" "$JOB_ID"); then
  write_status "$JOB_ID" failed '章节已生成，但无法打包 ZIP。'
  exit 1
fi
write_status "$JOB_ID" succeeded '处理完成。' "output/$JOB_ID.zip"
