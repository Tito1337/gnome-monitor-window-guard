#!/bin/bash
#
# Simulate monitor hotplug against a headless GNOME Shell, with no physical cables and
# without touching your own session.
#
#   ./test/hotplug-rig.sh
#
# How it works:
#   * `gnome-shell --headless --wayland --virtual-monitor WxH` gives synthetic monitors.
#     (In GNOME 49 there is no `--nested` flag any more; nested is the default when you
#     do not pass --display-server.)
#   * `org.gnome.Mutter.DisplayConfig.ApplyMonitorsConfig` applies a layout. Apply one
#     that OMITS a monitor and you have simulated an unplug; apply one that includes it
#     again and you have simulated a plug-in. Method `1` means temporary, so nothing is
#     written to disk. (`org.gnome.Mutter.DebugControl` only exposes HDR/blending/cursor
#     toggles, no monitor manipulation.)
#   * XDG_CONFIG_HOME is redirected so dconf is isolated -- the rig cannot disturb your
#     real settings, and gets its own extension configuration.
#   * The rig runs with ONLY this extension enabled, which is how we established that the
#     `meta_display_get_monitor_in_fullscreen` assertion on unplug is an upstream mutter
#     bug rather than an interaction with gTile/blur-my-shell/etc.
#
# The layout below deliberately reproduces the awkward case: the external monitor sits to
# the LEFT of the laptop, so plugging it in shifts the laptop's logical origin from (0,0)
# to (1080,491) and every window's stored coordinates start meaning something different.

set -u

UUID="monitor-window-guard@khamis"
SCHEMA="org.gnome.shell.extensions.monitor-window-guard"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT="${EXT_DIR:-$HOME/.local/share/gnome-shell/extensions/$UUID}"

if [ ! -d "$EXT" ]; then
    echo "error: extension not found at $EXT" >&2
    echo "       run ./install.sh first, or set EXT_DIR=/path/to/$UUID" >&2
    exit 1
fi

# Re-exec ourselves inside a private D-Bus session with an isolated config dir. Doing it
# this way (rather than passing a function through `bash -c`) keeps every variable in scope.
if [ -z "${MWG_RIG_INNER:-}" ]; then
    RIG="$(mktemp -d /tmp/mwg-rig.XXXXXX)"
    mkdir -p "$RIG/config"
    echo "rig dir: $RIG"
    export MWG_RIG_INNER=1
    export MWG_RIG_DIR="$RIG"
    export XDG_CONFIG_HOME="$RIG/config"
    export EXT_DIR="$EXT"
    exec timeout 220 dbus-run-session -- "$0" "$@"
fi

RIG="$MWG_RIG_DIR"
LOG="$RIG/shell.log"

gsettings set org.gnome.shell enabled-extensions "['$UUID']"
gsettings set org.gnome.mutter workspaces-only-on-primary true
gsettings set org.gnome.mutter dynamic-workspaces true
gsettings --schemadir "$EXT/schemas" set "$SCHEMA" pin-on-connect true
gsettings --schemadir "$EXT/schemas" set "$SCHEMA" collect-on-disconnect true
gsettings --schemadir "$EXT/schemas" set "$SCHEMA" debug-log true

D="--session --dest org.gnome.Mutter.DisplayConfig --object-path /org/gnome/Mutter/DisplayConfig"

serial() {
    gdbus call $D --method org.gnome.Mutter.DisplayConfig.GetCurrentState \
        | sed -E 's/^\(uint32 ([0-9]+).*/\1/'
}
apply() {
    gdbus call $D --method org.gnome.Mutter.DisplayConfig.ApplyMonitorsConfig \
        "$(serial)" 1 "$1" "@a{sv} {}" >/dev/null 2>&1
}

# (x, y, scale, transform, primary, [(connector, mode, props)])
LAPTOP_ONLY="[(0, 0, 1.0, uint32 0, true, [('Meta-0', '1920x1080@60.000', @a{sv} {})])]"
EXTERNAL_LEFT="[(1080, 491, 1.0, uint32 0, true,  [('Meta-0', '1920x1080@60.000', @a{sv} {})]),
                (0,    0,   1.0, uint32 1, false, [('Meta-1', '1920x1080@60.000', @a{sv} {})])]"

gnome-shell --headless --wayland --wayland-display rigwl \
            --virtual-monitor 1920x1080 --virtual-monitor 1920x1080 > "$LOG" 2>&1 &
SHELL_PID=$!
sleep 14

# Children MUST talk to the rig compositor. Without this they inherit WAYLAND_DISPLAY from
# your session and open windows on your real desktop.
unset DISPLAY
export WAYLAND_DISPLAY=rigwl GDK_BACKEND=wayland

echo "== A: external present; spawn two maximized windows =="
apply "$EXTERNAL_LEFT"; sleep 3
gjs "$HERE/win.js" rig-mA max >/dev/null 2>&1 & sleep 3
gjs "$HERE/win.js" rig-mB max >/dev/null 2>&1 & sleep 3

echo "== B: UNPLUG external -> orphans collected onto a new workspace =="
apply "$LAPTOP_ONLY"; sleep 7

echo "== C: REPLUG external -> windows must stay off it, keeping their workspace =="
apply "$EXTERNAL_LEFT"; sleep 8

pkill -f "$HERE/win.js" 2>/dev/null
kill $SHELL_PID 2>/dev/null
wait $SHELL_PID 2>/dev/null

echo
echo "===== extension log ====="
grep -oE "\[monitor-window-guard\].*" "$LOG" | sed 's/^\[monitor-window-guard\] //'

echo
echo "===== summary ====="
printf '  %-18s %s\n' "converged:"      "$(grep -c 'converged after' "$LOG")"
printf '  %-18s %s\n' "gave up:"        "$(grep -c 'gave up after' "$LOG")"
printf '  %-18s %s\n' "JS warn/err:"    "$(grep -c 'JS WARNING\|JS ERROR' "$LOG")"
printf '  %-18s %s\n' "mutter asserts:" "$(grep -c 'assertion.*failed' "$LOG")"
echo
echo "Expected: converged >= 2, gave up 0, JS warn/err 0."
echo "mutter asserts > 0 is normal -- that is the upstream bug described in the README."
echo
echo "full shell log: $LOG"
