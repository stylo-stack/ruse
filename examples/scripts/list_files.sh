#!/usr/bin/env bash
# Deterministic step: list candidate files in a directory. No LLM involved.
# Usage: list_files.sh [dir] [glob]
set -euo pipefail
dir="${1:-.}"
glob="${2:-*}"
# shellcheck disable=SC2086
ls -1 "$dir"/$glob 2>/dev/null || true
