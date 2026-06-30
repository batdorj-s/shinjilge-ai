#!/bin/bash
# refresh-meta-tokens-cron.sh
# Cron wrapper for Meta token refresh. Expected to run once per day.
# Install via: crontab -e
#   PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin
#   0 6 * * * /Users/batdorjsukhbaatar/shinjilge_ai/llm_agent_mcp-main/scripts/refresh-meta-tokens-cron.sh >> /tmp/meta-token-refresh.log 2>&1

set -euo pipefail

PROJECT_DIR="/Users/batdorjsukhbaatar/shinjilge_ai/llm_agent_mcp-main"
LOG_FILE="/tmp/meta-token-refresh.log"

export PATH="/opt/homebrew/bin:/opt/homebrew/opt/coreutils/libexec/gnubin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NODE_ENV=production

cd "$PROJECT_DIR"
echo "--- [$(date -u +%Y-%m-%dT%H:%M:%SZ)] Token refresh started ---"
npm run refresh-tokens 2>&1
RESULT=$?
echo "--- [$(date -u +%Y-%m-%dT%H:%M:%SZ)] Token refresh finished (exit=$RESULT) ---"
exit $RESULT
