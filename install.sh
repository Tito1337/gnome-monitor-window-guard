#!/bin/bash
#
# Install Monitor Window Guard into the current user's GNOME Shell extensions directory.
#
#   ./install.sh
#
# Does not enable actuation -- the extension installs in observe-only mode so you can read
# the log and confirm it sees your windows correctly before it starts moving them. See the
# README for how to turn it on.

set -euo pipefail

UUID="monitor-window-guard@khamis"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

if [ ! -d "$SRC" ]; then
    echo "error: cannot find extension source at $SRC" >&2
    exit 1
fi

SHELL_MAJOR="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || echo '?')"
if [ "$SHELL_MAJOR" != "49" ]; then
    echo "warning: built and tested against GNOME Shell 49; you have $SHELL_MAJOR." >&2
    echo "         It may still work -- add your version to metadata.json shell-version." >&2
fi

if [ "${XDG_SESSION_TYPE:-}" != "wayland" ]; then
    echo "warning: this targets Wayland; XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-unset}." >&2
fi

echo "installing $UUID -> $DEST"
mkdir -p "$DEST"
cp -r "$SRC/." "$DEST/"

echo "compiling schemas"
glib-compile-schemas "$DEST/schemas/"

echo "enabling extension"
gnome-extensions enable "$UUID" 2>/dev/null \
    || python3 - "$UUID" <<'PY'
# The shell only learns about a brand-new extension directory at startup, so
# `gnome-extensions enable` can fail with "not installed". Stage it in gsettings
# instead; it will come up enabled after the next login.
import ast, subprocess, sys
uuid = sys.argv[1]
cur = subprocess.run(['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'],
                     capture_output=True, text=True).stdout.strip()
lst = [] if cur in ('@as []', '[]') else ast.literal_eval(cur.replace('@as ', ''))
if uuid not in lst:
    lst.append(uuid)
    subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions',
                    '[' + ', '.join("'%s'" % x for x in lst) + ']'], check=True)
    print('staged in enabled-extensions; will load after login')
else:
    print('already in enabled-extensions')
PY

cat <<'EOF'

Installed in OBSERVE-ONLY mode (it will log, but not move any window).

Next:
  1. Log out and log back in.  Wayland cannot reload extension source in place, and
     lock/unlock is not enough -- it re-runs enable() without re-importing the module.
  2. Confirm it loaded:
       journalctl --user -b -o cat | grep -oE 'monitor-window-guard\] enabled v[0-9.a-z-]*' | tail -1
  3. Plug and unplug your external monitor, then read the log:
       journalctl --user -b -o cat | grep monitor-window-guard | tail -40
  4. When the cached state looks right, turn it on (no logout needed):
       EXT=~/.local/share/gnome-shell/extensions/monitor-window-guard@khamis
       gsettings --schemadir $EXT/schemas \
         set org.gnome.shell.extensions.monitor-window-guard pin-on-connect true
       gsettings --schemadir $EXT/schemas \
         set org.gnome.shell.extensions.monitor-window-guard collect-on-disconnect true

To remove:
  gnome-extensions disable monitor-window-guard@khamis
EOF
