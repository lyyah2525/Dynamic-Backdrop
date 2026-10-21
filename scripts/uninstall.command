#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

resolve_hermes_home() {
  # Hermes Desktop desktop-plugins is app-level, not profile-scoped.
  if [ -n "${HERMES_DESKTOP_HOME:-}" ]; then
    printf '%s' "$HERMES_DESKTOP_HOME"
    return
  fi
  if [ -n "${HERMES_HOME:-}" ]; then
    local profile_parent
    profile_parent="$(dirname "$HERMES_HOME")"
    if [ "$(basename "$profile_parent")" = "profiles" ]; then
      printf '%s' "$(dirname "$profile_parent")"
    else
      printf '%s' "$HERMES_HOME"
    fi
    return
  fi
  printf '%s' "$HOME/.hermes"
}

HERMES_HOME="$(resolve_hermes_home)"
TARGET="$HERMES_HOME/desktop-plugins/dynamic-backdrop"
MARKER="$TARGET/.dynamic-backdrop"

fail() { printf '\n卸载失败：%s\n' "$1" >&2; exit 1; }

[ -d "$TARGET" ] || fail "找不到插件目录：$TARGET"
[ -f "$TARGET/plugin.js" ] || fail "目标目录不是有效的 dynamic-backdrop 插件"
[ -f "$MARKER" ] || fail "缺少插件标识文件，已停止以避免误删"

printf '即将卸载：\n%s\n' "$TARGET"
printf '卸载前需要请求 Hermes Desktop 正常退出。继续吗？ [y/N] '
read -r answer
case "$answer" in
  y|Y|yes|YES) ;;
  *) printf '已取消。\n'; exit 0 ;;
esac

WAS_RUNNING=0
if pgrep -f '/Hermes\.app/Contents/MacOS/Hermes' >/dev/null 2>&1; then
  WAS_RUNNING=1
fi

osascript -e 'tell application "Hermes" to quit' >/dev/null 2>&1 || true

for _ in $(seq 1 30); do
  if ! pgrep -f '/Hermes\.app/Contents/MacOS/Hermes' >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if pgrep -f '/Hermes\.app/Contents/MacOS/Hermes' >/dev/null 2>&1; then
  fail "Hermes 仍在运行，未删除插件。请完成任务或在 Hermes 提示中确认关闭后重新运行卸载脚本。"
fi

rm -rf "$TARGET"
[ ! -e "$TARGET" ] || fail "删除后仍检测到插件目录"
printf '卸载完成。Hermes 原有文件和用户外部媒体未被删除。\n'

if [ "$WAS_RUNNING" -eq 1 ]; then
  printf 'Hermes 卸载前正在运行，正在重新启动 Hermes...\n'
  open -b "${HERMES_BUNDLE_ID:-com.nousresearch.hermes}"
  sleep 2
  if pgrep -f '/Hermes\.app/Contents/MacOS/Hermes' >/dev/null 2>&1; then
    printf 'Hermes 已重新启动。\n'
  else
    printf '插件已卸载，但 Hermes 未能自动重新启动，请手动打开。\n' >&2
  fi
fi
