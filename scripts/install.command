#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE="$PROJECT_ROOT/dynamic-backdrop"

resolve_hermes_home() {
  # Hermes Desktop desktop-plugins is app-level, not profile-scoped.
  # HERMES_DESKTOP_HOME can override it explicitly. If the runtime exports a
  # profile-shaped HERMES_HOME, strip /profiles/<name> back to the app home.
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
MARKER="$SOURCE/.dynamic-backdrop"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="$HERMES_HOME/desktop-plugin-backups"
BACKUP="$BACKUP_ROOT/dynamic-backdrop-${STAMP}"
TEMP="${TARGET}.installing-${STAMP}"

fail() { printf '\n安装失败：%s\n' "$1" >&2; exit 1; }

[ -f "$SOURCE/plugin.js" ] || fail "找不到 dynamic-backdrop/plugin.js"
[ -f "$MARKER" ] || fail "找不到插件标识文件"
[ -d "$HERMES_HOME" ] || fail "找不到 HERMES_HOME：$HERMES_HOME"

# Check before copying, so a broken build never replaces a working install.
# The class check matters because the plugin injects its UI into the app's
# precompiled Tailwind bundle: a utility class the app never used simply does
# not exist there, and the element silently falls back to default layout.
if command -v node >/dev/null 2>&1; then
  node "$PROJECT_ROOT/tests/validate-package.mjs" || fail "包校验未通过"
  node "$PROJECT_ROOT/tests/validate-classes.mjs" || fail "样式类校验未通过"

# Behaviour tests. A static checker cannot see a broken closure or a skipped advance, and
# these tests used to live in a scratch directory that got cleaned away — putting them in
# the repo and running them here is what keeps that from happening again.
node "$PROJECT_ROOT/tests/behavior-probe.mjs" "$SOURCE/plugin.js" > /dev/null \
  || fail "行为测试未通过（单独运行看详情：node tests/behavior-probe.mjs dynamic-backdrop/plugin.js）"
fi

# The three earlier directory names this plugin used to install under
# (hermes-dynamic-backdrop -> live-wallpaper -> bg-video) are deliberately NOT
# handled here any more. Those builds are gone from every machine this ships to, so
# the checks were unreachable; if a directory under one of those names ever
# reappears, Hermes would load it alongside this one and the two would fight over
# the same tokens, so bring it back deliberately rather than by accident.
mkdir -p "$BACKUP_ROOT"
mkdir -p "$HERMES_HOME/desktop-plugins"
rm -rf "$TEMP"
mkdir -p "$TEMP"
cp "$SOURCE/plugin.js" "$TEMP/plugin.js"
cp "$MARKER" "$TEMP/.dynamic-backdrop"

# Every bundled video ships, not just the default: the bundle is the user's video
# library, and the picker resolves paths inside this directory. Copying only one
# name would install a folder that disagrees with what the project holds, and the
# missing ones would surface much later as "file not found" from the renderer.
shopt -s nullglob
VIDEOS=("$SOURCE"/*.mp4)
shopt -u nullglob
if [ ${#VIDEOS[@]} -eq 0 ]; then
  fail "dynamic-backdrop/ 下没有任何 .mp4"
fi
for video in "${VIDEOS[@]}"; do
  cp "$video" "$TEMP/$(basename "$video")"
done

# ---- back up the previous install -------------------------------------------
#
# Only plugin.js and the marker are backed up, NOT the videos.
#
# The old code moved the whole target directory into the backup, so every install
# wrote a fresh 39.6 MB copy — five .mp4 files that had not changed. Sixty-three of
# those had accumulated to 2.4 GB of pure duplication. The videos are bundled, not
# user content: the ones already in the target are identical to the ones about to be
# copied in, so a rollback that keeps them is a correct rollback.
#
# A backup that exists but holds no videos must NOT be restored over a directory that
# has them, which is why the restore path below copies files back instead of moving
# the directory.
if [ -e "$TARGET" ]; then
  printf '检测到已有插件，将备份到：\n%s\n' "$BACKUP"
  mkdir -p "$BACKUP"
  # Each file is optional: a half-installed target may be missing one.
  [ -f "$TARGET/plugin.js" ] && cp "$TARGET/plugin.js" "$BACKUP/plugin.js"
  [ -f "$TARGET/.dynamic-backdrop" ] && cp "$TARGET/.dynamic-backdrop" "$BACKUP/.dynamic-backdrop"
fi

# The target must NOT exist when the temp directory is moved into place.
#
# `$TEMP` is a SIBLING of `$TARGET` (dynamic-backdrop.installing-<stamp>). `mv dir1 dir2`
# puts dir1 INSIDE dir2 when dir2 already exists, so with the target still present the
# install landed at dynamic-backdrop/dynamic-backdrop.installing-<stamp>/ — the old
# plugin.js stayed in place and the new one was buried one level down.
#
# The previous code got away with it because it MOVED the target into the backup first,
# leaving the path free. Backing up by copying (so the videos are not duplicated) removed
# that side effect, so the removal has to be explicit here.
#
# It is safe: the plugin has already been copied to $BACKUP, and the videos in $TARGET
# are the same files about to be copied from $SOURCE.
rm -rf "$TARGET"

if ! mv "$TEMP" "$TARGET"; then
  # Put the old plugin.js back. The videos in $TARGET were never touched by the
  # failed move, so they are still there.
  if [ -f "$BACKUP/plugin.js" ]; then
    rm -rf "$TARGET"
    mkdir -p "$TARGET"
    cp "$BACKUP/plugin.js" "$TARGET/plugin.js"
    [ -f "$BACKUP/.dynamic-backdrop" ] && cp "$BACKUP/.dynamic-backdrop" "$TARGET/.dynamic-backdrop"
    for video in "${VIDEOS[@]}"; do
      cp "$video" "$TARGET/$(basename "$video")"
    done
  fi
  rm -rf "$TEMP"
  fail "无法替换插件目录，可能有文件被占用。旧版本已恢复。"
fi

printf '\n安装完成。\n插件位置：%s\n' "$TARGET"
printf 'Hermes 无需退出；如果插件没有自动出现，请执行：Cmd/Ctrl + K → Reload desktop plugins\n'
