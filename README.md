# Monitor Window Guard

**Stop GNOME scattering your windows when you plug in an external monitor.**

You plug in a second screen and your desktop detonates. Windows you had parked on
workspace 3 are suddenly on the new monitor. Windows from four different workspaces are
stacked on top of each other, all visible at once. You unplug at the end of the day and
everything lands in a heap on whichever workspace happened to be active.

You wanted the new monitor to come up **empty**, so you could drag things onto it yourself.

This repository is two things:

1. **A guide** to diagnosing this on GNOME/Wayland — the three separate causes, how to
   confirm each one on your own machine, and the non-obvious mutter behaviours that make
   naive fixes fail silently. Start at [Diagnosing it yourself](#diagnosing-it-yourself).
2. **A working GNOME Shell extension** that fixes it. Jump to
   [Install](#install).

Built and tested against **GNOME Shell 49 / mutter 17 / Wayland** on Ubuntu 25.10.

---

## Table of contents

- [What it does](#what-it-does)
- [Install](#install)
- [Configuration](#configuration)
- [Reading the log](#reading-the-log)
- [Diagnosing it yourself](#diagnosing-it-yourself)
  - [Cause 1: your laptop screen moves](#cause-1-your-laptop-screen-moves)
  - [Cause 2: workspaces-only-on-primary](#cause-2-workspaces-only-on-primary)
  - [Cause 3: mutter loses track of monitor indices](#cause-3-mutter-loses-track-of-monitor-indices)
- [The fix that isn't](#the-fix-that-isnt)
- [How the extension works](#how-the-extension-works)
- [Five things that only show up when you run it](#five-things-that-only-show-up-when-you-run-it)
- [Testing without touching your cables](#testing-without-touching-your-cables)
- [Checking the API instead of guessing](#checking-the-api-instead-of-guessing)
- [Simpler alternative: just change the setting](#simpler-alternative-just-change-the-setting)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

---

## What it does

- **Plug in** → nothing moves. Every window stays on the monitor and workspace it was
  already on, so the new screen starts empty and you populate it by dragging.
- **Unplug** → windows that were on the removed screen are collected into a **single new
  workspace** appended at the end. Every pre-existing workspace is left untouched.

It does this without changing any GNOME setting and without dictating how you arrange your
monitors — an external screen can sit on the left, and you can add a third later.

---

## Install

Requires GNOME Shell 49 on Wayland, plus `gjs` and `glib-compile-schemas` (both present on
a normal GNOME install).

```bash
git clone https://github.com/M4E5TR0-MUN1R/gnome-monitor-window-guard.git
cd gnome-monitor-window-guard
./install.sh
```

Then **log out and log back in**. This is not optional and not skippable:

- Wayland cannot restart GNOME Shell in place, so extension source is only re-imported at
  login.
- **Lock/unlock is not enough.** It re-runs `enable()` but does not re-import the module,
  so you will keep running the old code.
- `org.gnome.Shell.Extensions.ReloadExtension` exists on the D-Bus interface but returns
  `NotSupported: ReloadExtension is deprecated and does not work`.

Confirm the build that is actually live — the version string is logged on every enable
specifically so this is unambiguous:

```bash
journalctl --user -b -o cat | grep -oE 'monitor-window-guard\] enabled v[0-9.a-z-]*' | tail -1
```

It installs in **observe-only** mode: it logs what it would do but moves nothing. Plug and
unplug once, read the log, and confirm the `cached state from BEFORE the change` block
shows sensible per-window workspace numbers. Then turn it on — this takes effect
immediately, no logout:

```bash
EXT=~/.local/share/gnome-shell/extensions/monitor-window-guard@khamis
gsettings --schemadir $EXT/schemas \
  set org.gnome.shell.extensions.monitor-window-guard pin-on-connect true
gsettings --schemadir $EXT/schemas \
  set org.gnome.shell.extensions.monitor-window-guard collect-on-disconnect true
```

### Uninstall

```bash
gnome-extensions disable monitor-window-guard@khamis
rm -rf ~/.local/share/gnome-shell/extensions/monitor-window-guard@khamis
```

No GNOME or mutter settings are modified by this extension, so there is nothing else to
revert.

---

## Configuration

The schema ships inside the extension directory, so `gsettings` needs `--schemadir`:

```bash
EXT=~/.local/share/gnome-shell/extensions/monitor-window-guard@khamis
SCHEMA=org.gnome.shell.extensions.monitor-window-guard

# read one key
gsettings --schemadir $EXT/schemas get $SCHEMA pin-on-connect

# read everything
gsettings --schemadir $EXT/schemas list-recursively $SCHEMA
```

| Key | Default | Meaning |
|---|---|---|
| `pin-on-connect` | `false` | On monitor connect, put windows back on their original monitor and workspace. |
| `collect-on-disconnect` | `false` | On monitor disconnect, gather that monitor's windows into one new workspace. |
| `settle-delay-ms` | `150` | Wait after a monitor change before restoring, letting mutter and other extensions finish first. |
| `max-restore-attempts` | `10` | How many convergence attempts to make (see [below](#five-things-that-only-show-up-when-you-run-it)). |
| `ignore-wm-classes` | `[]` | `WM_CLASS` values never to reposition, e.g. `"['Conky']"`. |
| `debug-log` | `true` | Log window state before/after each monitor change. |

Once you are happy, quiet it down:

```bash
gsettings --schemadir $EXT/schemas set $SCHEMA debug-log false
```

---

## Reading the log

```bash
journalctl --user -f -o cat | grep monitor-window-guard
```

Two warnings about `journalctl`:

- `-b` covers the **whole boot**, and logging out does not start a new boot. After a
  re-login the old session's lines are still there, above the new ones. Use `tail`, not
  `head`, or filter by time.
- Confirm the version first. A log from an older build will happily send you chasing a bug
  you already fixed.

```bash
# only the current shell process's lines, newest last
journalctl --user -b -o cat --since "$(ps -o lstart= -p "$(pgrep -x gnome-shell | head -1)")" \
  | grep monitor-window-guard | tail -40
```

A healthy plug-in cycle looks like this:

```
monitors-changing: cache frozen
monitors-changed: added=[HDMI-1] removed=[-] now=[eDP-1, HDMI-1]
--- cached state from BEFORE the change (3 window(s)) ---
    "Terminal" [org.gnome.Ptyxis] on=eDP-1 ws=0 rel=0,32 1920x1048 max=3 fs=false sticky=false
    "Editor" [code] on=eDP-1 ws=1 rel=0,32 1920x1048 max=3 fs=false sticky=false
    "Browser" [firefox] on=eDP-1 ws=2 rel=0,32 1920x1048 max=3 fs=false sticky=false
--- live state AFTER the change, BEFORE restore (3 window(s)) ---
    "Terminal" [.../type0] mon=0(HDMI-1) ws=0 abs=0,32 1920x1048 sticky=true
    "Editor"   [.../type0] mon=0(HDMI-1) ws=0 abs=0,32 1920x1048 sticky=true
    "Browser"  [.../type0] mon=0(HDMI-1) ws=0 abs=0,32 1920x1048 sticky=true
restore: 3 survivor(s), 0 orphan(s) [pin=true collect=true]
workspace targets: 0->0 1->1 2->2
attempt 1: 3 window(s) off target, retrying
converged after 2 attempt(s)
--- live state AFTER restore (settled) (3 window(s)) ---
    "Terminal" [.../type0] mon=1(eDP-1) ws=0 abs=1080,523 1920x1048 sticky=false
    "Editor"   [.../type0] mon=1(eDP-1) ws=1 abs=1080,523 1920x1048 sticky=false
    "Browser"  [.../type0] mon=1(eDP-1) ws=2 abs=1080,523 1920x1048 sticky=false
```

Reading it:

| Field | Meaning |
|---|---|
| `on=` / `mon=N(NAME)` | monitor, by connector name; `N` is the volatile logical index |
| `ws=` | workspace index; `null` means the window is on-all-workspaces so it has none |
| `rel=` | position **relative to its monitor's origin** — the value that makes this work |
| `abs=` | absolute position in the global logical coordinate space |
| `max=` | `Meta.MaximizeFlags`: `0` none, `1` horizontal, `2` vertical, `3` both |
| `sticky=` | on-all-workspaces |

**`converged after N attempt(s)`** is the success signal — every window reached its target.
`WARNING: gave up after N attempt(s) with M window(s) still off target` is a real failure;
see [Troubleshooting](#troubleshooting).

---

## Diagnosing it yourself

First establish what you are on:

```bash
echo "desktop : $XDG_CURRENT_DESKTOP"
echo "session : $XDG_SESSION_TYPE"
gnome-shell --version
```

List which physical connectors exist and which are live:

```bash
for f in /sys/class/drm/card*/status; do echo -n "$f: "; cat "$f"; done
```

### Cause 1: your laptop screen moves

Look at your saved layout:

```bash
cat ~/.config/monitors.xml
```

The telling part is the coordinates:

```xml
<logicalmonitor>
  <x>0</x> <y>0</y>
  <transform><rotation>left</rotation></transform>
  <monitor><monitorspec><connector>HDMI-1</connector></monitorspec></monitor>
</logicalmonitor>
<logicalmonitor>
  <x>1080</x> <y>491</y>
  <primary>yes</primary>
  <monitor><monitorspec><connector>eDP-1</connector></monitorspec></monitor>
</logicalmonitor>
```

`HDMI-1` is at `x=0`. The laptop is at `x=1080, y=491`. **That single detail is the root of
the whole mess.**

Mutter keeps all window geometry in one **global logical coordinate space**, normalised so
the leftmost edge is `x=0` and the topmost is `y=0`. With only the laptop connected,
`eDP-1` owns `x ∈ [0, 1920)`; a window at `x=200` is 200px from its left edge.

Plug in an external on the left and `HDMI-1` claims `x ∈ [0, 1080)`, pushing the laptop to
`x ∈ [1080, 3000)`. Your window is still at `x=200` — but `x=200` is now on the *external*
monitor. **The window did not move. The coordinate space moved underneath it.**

You can watch the live layout, in logical-monitor order:

```bash
gdbus call --session --dest org.gnome.Mutter.DisplayConfig \
  --object-path /org/gnome/Mutter/DisplayConfig \
  --method org.gnome.Mutter.DisplayConfig.GetCurrentState \
| python3 -c "
import sys, re
s = sys.stdin.read()
for i, m in enumerate(re.finditer(
        r\"\((-?\d+), (-?\d+), ([\d.]+), (?:uint32 )?(\d+), (true|false), \[\('([\w-]+)'\", s)):
    x, y, scale, tr, prim, conn = m.groups()
    print(f'index {i}: {conn:10s} at ({x},{y}) primary={prim} transform={tr}')
"
```

The **index** matters as much as the position. With the external on the left it becomes
logical monitor `0` and your laptop becomes `1` — so a window's monitor *index* changes too,
which is why anything that caches monitor indices across a hotplug is broken by
construction.

Mutter does try to compensate (`meta_window_update_for_monitors_changed()` moves each window
relative to its old monitor's new rect) but it is working against windows whose stored
geometry now points somewhere else, during a reconfiguration where indices are in flux, and
it does not reliably win.

### Cause 2: `workspaces-only-on-primary`

```bash
gsettings get org.gnome.mutter workspaces-only-on-primary   # true by default
```

This means workspaces exist **only on the primary monitor**. Secondary monitors sit outside
the workspace system entirely: whatever is on them is visible on *every* workspace. Plenty
of people want that — the second screen becomes a fixed dashboard.

But combined with Cause 1 it is destructive. From mutter's own source:

```c
static gboolean
should_be_on_all_workspaces (MetaWindow *window)
{
  return window->always_sticky ||
    window->on_all_workspaces_requested ||
    (meta_prefs_get_workspaces_only_on_primary () &&
     !meta_window_is_on_primary_monitor (window));
}
```

A window that lands on a non-primary monitor becomes **implicitly sticky**. So when Cause 1
sweeps a batch of windows onto the newly connected screen, every one of them becomes visible
on every workspace at once. They did not gather there — they became omnipresent.

On unplug it runs in reverse: those windows are sticky, their monitor ceases to exist, mutter
must give each a real workspace, and it picks the active one. Your entire external screen
empties onto whatever workspace you are looking at.

This also has a nasty second-order effect that bites any fix: **assigning a workspace to a
sticky window is silently dropped.** No error, no warning, no return value — the call just
does nothing. Any repair that sets the workspace before getting the window off the secondary
monitor appears to work and does not.

### Cause 3: mutter loses track of monitor indices

```bash
journalctl --user -b -o cat | grep -E "assertion.*failed" | sort | uniq -c | sort -rn
```

On an unplug you will likely see:

```
meta_monitor_manager_get_logical_monitor_from_number: assertion
  '(unsigned int) number < g_list_length (manager->logical_monitors)' failed
meta_workspace_get_work_area_for_monitor: assertion 'logical_monitor != NULL' failed
meta_display_get_monitor_in_fullscreen: assertion
  'monitor >= 0 && monitor < n_logical_monitors' failed
```

Something is asking for monitor #1 after the list shrank to one entry. When
`get_work_area_for_monitor` fails, placement is computed against garbage geometry. **This is
why the breakage is non-deterministic** — the classic "sometimes fine, sometimes chaos".

It is tempting to blame extensions; per-monitor state is exactly what a tiling extension or
per-monitor dock caches. But running the rig in this repo with **only this extension
enabled** still produces the `get_monitor_in_fullscreen` assertion, so at least part of it is
upstream mutter. The extension does not try to fix it — it restores *after* a settle delay so
that whatever mutter did wrong gets overwritten.

---

## The fix that isn't

If the problem is that your laptop is not at the coordinate origin, just put it there: drag
the displays in Settings so the laptop is top-left. Now `eDP-1` is permanently at `(0,0)`,
its coordinate space never shifts, and Cause 1 evaporates.

This genuinely works, and you should probably not do it.

It makes your *software* layout serve a bug workaround, which then dictates your *physical*
desk layout — if the monitor is configured to your right but sitting on your left, your mouse
travels the wrong way. And it is not a fix, it is a coincidence: it holds only while your
laptop happens to be the top-left monitor. Add a third display on the left and you are back
where you started.

A fix should be indifferent to how many monitors you have and where they sit.

---

## How the extension works

Two ideas, both about **what you store**.

**Key windows by connector name, not monitor index.** Monitor indices are positional —
index 1 means something different before and after a hotplug, which is exactly Cause 3.
Connector names (`eDP-1`, `HDMI-1`, `DP-2`) are stable identities.

**Store positions relative to the monitor's origin, not absolutely.** A window at relative
`(40,60)` on `eDP-1` is at absolute `(40,60)` when the laptop is at the origin and at
`(1120,551)` when it has been pushed right. Same window, same visual spot — and the layout
shift becomes a non-event. This, not rearranging your desk, is what kills Cause 1.

The cache entry per window:

```js
{
  connector,          // "eDP-1" — a stable identity, not an index
  wsIndex,            // null when on a secondary monitor: implicitly sticky, so no workspace
  relX, relY,         // offset from THAT monitor's origin
  width, height,
  maxFlags, fullscreen,
  explicitSticky,     // sticky while on the PRIMARY monitor == the user asked for it
}
```

### Freeze before mutter touches anything

The cache is frozen on mutter's **`monitors-changing`**, not GNOME Shell's
`monitors-changed`. This distinction is load-bearing: by the time `monitors-changed` reaches
extension code, mutter has already relocated windows and `position-changed` has already
fired, so the "pre-change" cache is really mid-transition state.

Measured symptom of getting this wrong: windows cached as `ws=null` — implicitly sticky,
because mutter had already moved them to the secondary monitor — and with sizes matching the
*external* monitor's dimensions. Their real workspaces were gone before we looked.

`monitors-changing` is not used by GNOME Shell itself. Confirm it exists on your version:

```bash
GI_TYPELIB_PATH=/usr/lib/x86_64-linux-gnu/mutter-17 gjs -c '
imports.gi.versions.Meta = "17";
const {Meta, GObject} = imports.gi;
for (const s of ["monitors-changing", "monitors-changed"])
    print(s + ": " + (GObject.signal_lookup(s, Meta.MonitorManager.$gtype) || "NOT FOUND"));
'
```

A watchdog thaws the cache if `monitors-changing` is not followed by `monitors-changed`,
since a rejected configuration would otherwise leave it latched for the rest of the session.

### Classify by absence, not by diff

The natural approach — diff old and new monitor sets, treat windows on removed connectors as
orphans — breaks on docking stations. Several `monitors-changed` events can land inside one
settle window, and each diff is computed against the previous snapshot, so a monitor removed
by an *earlier* event never appears in the *latest* diff.

```js
if (currentMonitors.byConnector.has(entry.connector))
    survivors.push(...);   // its monitor is still here
else
    orphans.push(...);     // its monitor is gone
```

"The connector I remember isn't present any more" *is* what orphan means.

### Restore late, and converge

Restoring happens after a settle delay, then re-checks and re-applies until reality matches
the target. See the next section for why one pass is not enough.

---

## Five things that only show up when you run it

Every one of these was found by running the thing, not by reasoning about it. They are the
real content of this repository.

### 1. Mutter's window operations are queued, not applied inline

Immediately after `move_resize_frame()` or `move_to_monitor()`, the window still reports its
**old** monitor. Read state back in the same tick and you will conclude nothing happened:

```
"window": mon=1 ws=0 sticky=true -> mon=1 ws=0 sticky=true (target mon=0 ws=1)
--- live state AFTER restore (settled) ---
"window": mon=0(eDP-1) ws=1 sticky=false          # it did work, 400ms later
```

An earlier version of this extension logged "nothing changed" when it had in fact worked.

### 2. Geometry must go in one batch; the workspace must not

`unmaximize()` → `move_resize_frame()` → `move_to_monitor()` → `maximize()` must be issued
**together**. Mutter coalesces them into the intended final geometry. Deferring the
`maximize()` to a later pass loses the whole move: the queued `unmaximize()` has not landed
when the move is evaluated, so mutter clamps the move to the *old* monitor's work area and
the window never leaves.

The workspace assignment is the opposite — it must wait until the monitor move has actually
landed, because of the silent-drop behaviour in Cause 2.

### 3. `dynamic-workspaces` renumbers workspaces underneath you

```bash
gsettings get org.gnome.mutter dynamic-workspaces   # true by default
```

Windows were assigned to workspaces 3 and 2; an emptied workspace was then pruned and they
ended up on 2 and 1. **Workspace indices are no more stable an identity than monitor
indices.**

So workspace targets are computed by **rank**: the occupied workspaces are sorted and mapped
to `0..n-1`, preserving relative order. Under `dynamic-workspaces` the live workspaces are
exactly "those holding windows" plus one trailing empty, so ranking matches what GNOME
settles on anyway.

### 4. Mutter sometimes just drops a geometry batch

On hardware, **two of five windows stayed on the wrong monitor while the other three moved**
— identical code, same event, no distinguishing signal. Retrying is the only fix. Hence
convergence:

```
attempt 1: 3 window(s) off target, retrying
attempt 2: 2 window(s) off target, retrying
converged after 3 attempt(s)
```

State the target, keep nudging reality towards it, and say so if it does not get there.

### 5. Desktop-icon windows look exactly like normal windows

Ubuntu's desktop icons (`ding@rastersoft.com`) are ordinary `NORMAL` windows on Wayland —
the extension emulates the `DESKTOP` type in JavaScript. Its GTK `skip_taskbar` hint does not
reach mutter until after `map`, so filtering on window type and skip-taskbar misses them on
first sight and catches them later, leaving stale cache entries that never update. DING marks
its own windows with a property on the `Meta.Window`, and that is the reliable signal:

```js
if (win.customJS_ding)
    return false;   // desktop icons: not ours to move
```

Two general lessons: "is this window mine to manage?" can change over a window's lifetime, so
a filter that only runs at creation is not enough; and when another extension owns something,
look for the marker *it* uses rather than inventing a heuristic.

---

## Testing without touching your cables

This is the part worth stealing regardless of what you are building.

Iterating on a Wayland GNOME Shell extension is miserable — every source change needs a full
log out and back in — and this extension only does anything when a monitor is physically
plugged or unplugged. You can get around both:

```bash
./test/hotplug-rig.sh
```

It boots a **headless** GNOME Shell with two synthetic monitors, drives real plug/unplug
cycles over D-Bus, and prints the extension's log plus a pass/fail summary. It runs in an
isolated `XDG_CONFIG_HOME`, so it cannot disturb your session or settings.

The pieces, if you want to build your own:

```bash
# 1. Headless shell with synthetic monitors. In GNOME 49 there is no --nested flag any
#    more; nested is the default when you omit --display-server. Name the display
#    explicitly, or child apps inherit WAYLAND_DISPLAY and open on your real desktop.
gnome-shell --headless --wayland --wayland-display rigwl \
            --virtual-monitor 1920x1080 --virtual-monitor 1920x1080

# 2. Isolate configuration so dconf cannot touch your real settings
export XDG_CONFIG_HOME=/tmp/rig/config
dbus-run-session -- ./rig.sh
```

```bash
# 3. Hotplug over D-Bus. Apply a config that OMITS a monitor -> simulated unplug;
#    include it again -> simulated plug-in. Method 1 = temporary, nothing hits disk.
D="--session --dest org.gnome.Mutter.DisplayConfig --object-path /org/gnome/Mutter/DisplayConfig"

serial() {
  gdbus call $D --method org.gnome.Mutter.DisplayConfig.GetCurrentState \
    | sed -E 's/^\(uint32 ([0-9]+).*/\1/'
}
apply() {
  gdbus call $D --method org.gnome.Mutter.DisplayConfig.ApplyMonitorsConfig \
    "$(serial)" 1 "$1" "@a{sv} {}"
}

# (x, y, scale, transform, primary, [(connector, mode, props)])
LAPTOP_ONLY="[(0, 0, 1.0, uint32 0, true, [('Meta-0', '1920x1080@60.000', @a{sv} {})])]"
EXTERNAL_LEFT="[(1080, 491, 1.0, uint32 0, true,  [('Meta-0', '1920x1080@60.000', @a{sv} {})]),
                (0,    0,   1.0, uint32 1, false, [('Meta-1', '1920x1080@60.000', @a{sv} {})])]"

apply "$EXTERNAL_LEFT"   # both screens, external on the left
apply "$LAPTOP_ONLY"     # unplug: laptop origin shifts 1080 -> 0
apply "$EXTERNAL_LEFT"   # replug:  laptop origin shifts 0 -> 1080
```

Note `--debug-control` exposes `org.gnome.Mutter.DebugControl`, but it only offers HDR,
blending and cursor toggles — no monitor manipulation. `ApplyMonitorsConfig` is the lever.

Also useful: `org.gnome.Shell.Eval` — the traditional way to poke at a live shell over D-Bus
— is disabled unless unsafe-mode is on. It returns `(false, '')` and tells you nothing.
Looking Glass (`Alt`+`F2` → `lg`) still works for interactive probing.

---

## Checking the API instead of guessing

GNOME's JS API churns between releases, and a wrong guess costs a full logout to discover.
`gjs` can interrogate the typelib directly, using the same introspection layer the shell uses:

```bash
GI_TYPELIB_PATH=/usr/lib/x86_64-linux-gnu/mutter-17 gjs -c '
imports.gi.versions.Meta = "17";
const {Meta} = imports.gi;
for (const m of ["get_maximize_flags", "get_maximized", "maximize", "unmaximize",
                 "set_maximize_flags", "is_on_primary_monitor", "move_to_monitor"])
    print(m.padEnd(24) +
          (typeof Meta.Window.prototype[m] === "function"
            ? "OK  (args: " + Meta.Window.prototype[m].length + ")"
            : "MISSING"));
'
```

```
get_maximize_flags      OK  (args: 0)
get_maximized           MISSING
maximize                OK  (args: 0)
unmaximize              OK  (args: 0)
set_maximize_flags      OK  (args: 1)
is_on_primary_monitor   OK  (args: 0)
move_to_monitor         OK  (args: 1)
```

Two traps in that output, both of which cost real debugging time here:

- `meta_window_get_maximized()` **does not exist** in mutter 17. It is `get_maximize_flags()`,
  returning `Meta.MaximizeFlags` (`HORIZONTAL: 1, VERTICAL: 2, BOTH: 3`).
- `maximize()` and `unmaximize()` take **zero** arguments. Passing `MaximizeFlags` logs
  `Too many arguments to method Meta.Window.maximize: expected 0, got 1` and the argument is
  **ignored** — direction is set separately via `set_maximize_flags()` /
  `set_unmaximize_flags()`. Check arity, not just existence.

Watch for those warnings in the journal; they are easy to miss among real output:

```bash
journalctl --user -b -o cat | grep "JS WARNING"
```

---

## Simpler alternative: just change the setting

Worth saying plainly: a lot of this pain comes from `workspaces-only-on-primary`, and you can
simply turn it off.

```bash
gsettings set org.gnome.mutter workspaces-only-on-primary false
```

Now workspaces span both monitors. A window on the external belongs to one workspace like any
other, so it cannot pile up across all of them, and on unplug each window returns to the
laptop *on its own workspace*. Causes 1 and 3 still exist, but the damage is much smaller.

The trade-off is that switching workspaces now changes both screens. If you use the second
monitor as a fixed reference surface — docs, logs, a dashboard that should stay put while you
move around — that is a real loss, and it is the reason to keep the setting on and compensate
for it instead. That is what this extension does.

Decide which you want first; the implementation follows from it.

```bash
# revert
gsettings reset org.gnome.mutter workspaces-only-on-primary
```

---

## Troubleshooting

**The log shows an old version string, or no `monitors-changing` line.**
The new code is not loaded. Log out and back in — not lock/unlock. To be certain, compare the
shell's start time against the file's mtime:

```bash
EXT=~/.local/share/gnome-shell/extensions/monitor-window-guard@khamis
SHELL_PID=$(pgrep -x gnome-shell | head -1)
echo "shell started: $(ps -o lstart= -p "$SHELL_PID")"
echo "extension.js : $(stat -c %y "$EXT/extension.js")"
```

If `extension.js` is newer than the shell's start time, you are running the old code.

**`WARNING: gave up after N attempt(s) with M window(s) still off target`.**
Convergence ran out of attempts. Raise them, then the settle delay:

```bash
EXT=~/.local/share/gnome-shell/extensions/monitor-window-guard@khamis
SCHEMA=org.gnome.shell.extensions.monitor-window-guard
gsettings --schemadir $EXT/schemas set $SCHEMA max-restore-attempts 15
gsettings --schemadir $EXT/schemas set $SCHEMA settle-delay-ms 400
```

Both take effect immediately. If `converged after N` reports a number close to your limit,
raise it — you are converging by luck.

**Windows come back on the right monitor but the wrong workspace.**
Check the `workspace targets:` line. Because targets are ranked, a gap in your workspaces
(a window on 0 and another on 3, with 1 and 2 empty) is compacted rather than preserved.

**Another extension re-tiles windows after the restore.**
Raise `settle-delay-ms`. Candidates that keep per-monitor state: `gTile`,
`tiling-assistant`, `blur-my-shell`, per-monitor docks. To bisect:

```bash
gnome-extensions list --enabled
gnome-extensions disable gTile@vibou       # then hotplug and compare
```

**An app manages its own placement and should be left alone.**

```bash
gsettings --schemadir $EXT/schemas set $SCHEMA ignore-wm-classes "['Conky', 'MyApp']"
```

Find a window's `WM_CLASS` in the `[...]` field of the log lines.

---

## Limitations

- **GNOME Shell 49 / mutter 17 only.** The API details above are version-specific. For other
  versions, add your version to `metadata.json` `shell-version` and re-check the API with the
  `gjs` snippet before trusting it.
- **Wayland-oriented.** The queued-operation and stickiness behaviours were characterised on
  Wayland. It is not tested on X11.
- **Ranked workspaces compact gaps.** See Troubleshooting.
- **Explicitly-stuck windows on a secondary monitor** cannot be distinguished from implicitly
  sticky ones, so a window you deliberately pinned to all workspaces *while it was on the
  external screen* loses that state.
- **Titles in the log are captured at freeze time** and may be stale by the time of the
  restore; the cache is keyed by window object, not title, so this is cosmetic only.

---

## License

MIT — see [LICENSE](LICENSE).
