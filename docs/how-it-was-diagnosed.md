# Why GNOME Scatters Your Windows When You Plug In a Monitor (and How to Stop It)

*Ubuntu 25.10 · GNOME Shell 49 · Wayland · mutter 17*

> **Working extension and full step-by-step guide:**
> **https://github.com/M4E5TR0-MUN1R/gnome-monitor-window-guard**
>
> This article is the narrative — how the problem was diagnosed and what it taught.
> The repository has the installable fix, every diagnostic command, a troubleshooting
> section, and a headless test rig you can run without unplugging anything.

You plug in an external monitor and your desktop detonates. Windows you had carefully
parked on workspace 3 are suddenly on the new monitor. Windows from four different
workspaces are stacked on top of each other, all visible at once. You unplug at the end
of the day and everything lands in a heap on whichever workspace happened to be active.

You wanted the new monitor to show up *empty*, so you could drag things onto it yourself.
Instead GNOME made a decision on your behalf, and it made the wrong one.

This is about why that happens, why the obvious fix is a trap, and — the part that took
by far the longest — why several *correct-looking* fixes silently do nothing.

---

## The setup that triggers it

A laptop (`eDP-1`, 1920×1200) with an external monitor (`HDMI-1`, portrait-rotated). The
external sits physically to the **left** of the laptop, so it is configured that way.

From `~/.config/monitors.xml`:

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

Note the coordinates. `HDMI-1` is at `x=0`. The laptop is at `x=1080, y=491`.

That single detail is the root of the whole mess.

---

## Cause 1: your laptop screen moves

Mutter keeps all window geometry in one **global logical coordinate space**, normalised so
the leftmost edge is `x=0` and the topmost is `y=0`.

With only the laptop connected, `eDP-1` owns `x ∈ [0, 1920)`. A window at `x=200` is 200px
from the left edge of your laptop screen.

Plug the external in on the left, and `HDMI-1` claims `x ∈ [0, 1080)`. The laptop gets
pushed to `x ∈ [1080, 3000)`.

Your window is still at `x=200`. But `x=200` is no longer on your laptop — it is on the
external monitor. The window didn't move. **The coordinate space moved underneath it.**

The *index* changes too. With the external on the left it becomes logical monitor `0` and
the laptop becomes `1`. So anything caching monitor indices across a hotplug is broken by
construction — remember that, because mutter does exactly this.

Mutter does try to compensate: `meta_window_update_for_monitors_changed()` moves each
window relative to its old monitor's new rect. But it is working against windows whose
stored geometry now points somewhere else, during a reconfiguration where indices are in
flux, and it does not reliably win. Measured on hardware: **two of five windows followed
their monitor correctly and three were swept onto the new screen** — same event, same code.

## Cause 2: `workspaces-only-on-primary`

A GNOME default, and it's on:

```console
$ gsettings get org.gnome.mutter workspaces-only-on-primary
true
```

Workspaces exist *only* on the primary monitor. Secondary monitors sit outside the
workspace system: whatever is on them is visible on **every** workspace. That's a
deliberate design choice, and plenty of people like it — the second screen becomes a fixed
dashboard that doesn't change as you switch workspaces.

Combined with Cause 1 it's destructive. From mutter's source:

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

A window that lands on a non-primary monitor becomes *implicitly* sticky. So when Cause 1
sweeps windows onto the new screen, every one becomes visible on every workspace at once.
They didn't gather there — they became omnipresent.

On unplug it runs in reverse. Those windows are sticky, their monitor ceases to exist,
mutter must give each a real workspace, and it picks the active one. Your entire external
screen empties onto whatever workspace you're looking at.

There's a second-order effect here that turned out to matter more than the first: **setting
a workspace on a sticky window is silently dropped.** No error, no warning, no return
value. The call just does nothing. Hold that thought.

## Cause 3: mutter loses track of monitor indices

The journal from an unplug is full of:

```
meta_monitor_manager_get_logical_monitor_from_number: assertion
  '(unsigned int) number < g_list_length (manager->logical_monitors)' failed
meta_workspace_get_work_area_for_monitor: assertion 'logical_monitor != NULL' failed
meta_display_get_monitor_in_fullscreen: assertion
  'monitor >= 0 && monitor < n_logical_monitors' failed
```

Something is asking for monitor #1 after the list shrank to one entry. When
`get_work_area_for_monitor` fails, placement gets computed against garbage geometry. This
is why the breakage is *non-deterministic* — the classic "sometimes fine, sometimes chaos".

Tempting to blame extensions; per-monitor state is exactly what a tiling extension or a
per-monitor dock caches. But reproducing this in a clean headless shell with **no other
extensions loaded at all** still produced the `get_monitor_in_fullscreen` assertion. At
least part of it is upstream mutter.

---

## The obvious fix, and why it's a trap

If the problem is that your laptop isn't at the coordinate origin, put it there. Drag the
displays in Settings so the laptop is top-left. Now `eDP-1` is permanently at `(0,0)`, its
coordinate space never shifts, and Cause 1 evaporates.

This genuinely works. And you should probably not do it.

It works by making your *software* layout serve a bug workaround, which then dictates your
*physical* desk layout — if the monitor is configured to your right but sitting on your
left, your mouse travels the wrong way. Worse, it isn't a fix, it's a coincidence: it holds
only as long as your laptop happens to be the top-left monitor. Add a third display on the
left and you're back where you started.

The fix should be indifferent to how many monitors you have and where they sit.

---

## A fix that doesn't care about your layout

Two ideas, both about *what you store*.

**Key windows by connector name, not monitor index.** Indices are positional — index 1
means something different before and after a hotplug, which is precisely Cause 3.
Connector names (`eDP-1`, `HDMI-1`, `DP-2`) are stable identities.

**Store positions relative to the monitor's origin, not absolutely.** A window at relative
`(40, 60)` on `eDP-1` is at absolute `(40, 60)` when the laptop is at the origin, and at
`(1120, 551)` when it's been pushed right. Same window, same visual spot, and the layout
shift becomes a non-event. This — not rearranging your desk — is what kills Cause 1.

So the cache entry per window is:

```js
{
  connector,          // "eDP-1" — a stable identity, not an index
  wsIndex,            // null when on a secondary monitor: implicitly sticky, so no workspace
  relX, relY,         // offset from THAT monitor's origin
  width, height,
  maxFlags, fullscreen,
}
```

### Freeze before mutter touches anything

You have to record this *before* the change. My first attempt kept a continuously-warm
cache, updated on `position-changed` and friends, on the assumption that it would still
hold pre-change state when `monitors-changed` fired.

It doesn't. Mutter relocates windows *before* that signal reaches extension code, so by
the time you look, your "before" snapshot is really mid-transition. The corruption is
visible in the log: windows cached as `ws=null` — implicitly sticky, because mutter had
already moved them to the secondary monitor — and with sizes matching the *external*
monitor. Their real workspaces were gone before I looked at them.

I had written, confidently, that mutter offers no "monitors are about to change" hook.
That was wrong. `MetaMonitorManager::monitors-changing` exists, is emitted before the
monitor set is rebuilt, and GNOME Shell itself doesn't use it:

```js
imports.gi.versions.Meta = '17';
const {Meta, GObject} = imports.gi;
print(GObject.signal_lookup('monitors-changing', Meta.MonitorManager.$gtype));  // 24
```

Freezing the cache there gives a genuinely pre-change snapshot. Lesson: "there's no API for
this" is a claim worth actually checking.

---

## The part that took the longest

Everything above is architecture. What actually consumed the time was a class of bug where
the code looks right, runs without error, and does nothing.

### Mutter's window operations are queued, not applied inline

Immediately after `move_resize_frame()` or `move_to_monitor()`, the window still reports
its **old** monitor. Read state back in the same tick and you conclude nothing happened:

```
"window": mon=1 ws=0 sticky=true -> mon=1 ws=0 sticky=true (target mon=0 ws=1)
--- live state AFTER restore (settled) ---
"window": mon=0(eDP-1) ws=1 sticky=false          # it did work, 400ms later
```

I spent a cycle debugging a "failure" that was my own logging lying to me.

### Geometry must go in one batch; the workspace must not

`unmaximize()` → `move_resize_frame()` → `move_to_monitor()` → `maximize()` have to be
issued **together**; mutter coalesces them into the intended final geometry. I split the
`maximize()` into a later pass, reasoning it belonged with the workspace restore — and lost
the entire move. The queued `unmaximize()` hadn't landed when the move was evaluated, so
mutter clamped the move to the *old* monitor's work area and the window never left.

The workspace assignment is the exact opposite: it must wait until the monitor move has
landed, because of the silent-drop behaviour from Cause 2. Get this ordering backwards and
every workspace collapses into one — which is precisely the symptom you set out to fix, now
caused by your own code.

### `dynamic-workspaces` renumbers workspaces underneath you

Assign windows to workspaces 3 and 2; an emptied workspace gets pruned; they end up on 2
and 1. **Workspace indices are no more stable an identity than monitor indices** — the same
mistake I'd already diagnosed and fixed one layer up, made again without noticing.

The fix is to target workspaces by *rank*: sort the occupied ones and map them to
`0..n-1`, preserving relative order. Under `dynamic-workspaces` the live workspaces are
exactly "those holding windows" plus one trailing empty, so ranking matches what GNOME
settles on anyway.

### Sometimes mutter just drops the batch

Two of five windows stayed on the wrong monitor while the other three moved. Identical
code, same event, no distinguishing signal in any state I could read.

At that point the honest conclusion is that a single pass is not a valid model. So: state
the target, apply, wait, re-check, re-apply what didn't take, and say so if it never gets
there.

```
attempt 1: 3 window(s) off target, retrying
attempt 2: 2 window(s) off target, retrying
converged after 3 attempt(s)
```

That convergence loop fixed both the dropped batches and the workspace renumbering at once
— which is usually a sign you've finally found the right shape for the problem.

### Desktop icons are not what they look like

Ubuntu's desktop icons (`ding@rastersoft.com`) are ordinary `NORMAL` windows on Wayland;
the extension emulates the `DESKTOP` type in JavaScript. Its GTK `skip_taskbar` hint
doesn't reach mutter until after `map`, so filtering on type and skip-taskbar misses them
on first sight and catches them later, leaving stale cache entries that never update. DING
marks its own windows with a property on the `Meta.Window`:

```js
if (win.customJS_ding)
    return false;   // desktop icons: not ours to move
```

Two general lessons: "is this window mine to manage?" can change over a window's lifetime,
so a filter that runs only at creation isn't enough; and when another component owns
something, look for the marker *it* uses rather than inventing a heuristic.

---

## Testing without touching your cables

The part worth stealing regardless of what you're building.

Iterating on a Wayland GNOME Shell extension is miserable: you can't restart the shell in
place, so every source change needs a full log out and back in. And this extension only
does anything when a monitor is physically plugged or unplugged.

You can get around both.

**`--nested` is gone.** In GNOME 49, nested is the default when you don't pass
`--display-server`. What you want is a headless shell with synthetic monitors:

```sh
gnome-shell --headless --wayland --wayland-display rigwl \
            --virtual-monitor 1920x1080 --virtual-monitor 1920x1080
```

Name the display explicitly, or any app you launch inherits `WAYLAND_DISPLAY` and opens on
your real desktop. (Ask me how I know.)

**Isolate the configuration.** Point `XDG_CONFIG_HOME` at a scratch directory and dconf
follows, so the rig gets its own settings and can't disturb yours:

```sh
export XDG_CONFIG_HOME=/tmp/rig/config
dbus-run-session -- ./rig.sh
```

**Now hotplug it.** `--debug-control` exposes `org.gnome.Mutter.DebugControl`, but that
only offers HDR and cursor toggles — no monitor manipulation. The lever is
`ApplyMonitorsConfig` on `org.gnome.Mutter.DisplayConfig`. Apply a configuration that omits
a monitor and you've simulated an unplug; include it again and you've simulated a plug-in.
Method `1` is temporary, so nothing is written to disk:

```sh
D="--session --dest org.gnome.Mutter.DisplayConfig \
   --object-path /org/gnome/Mutter/DisplayConfig"

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

A full hotplug cycle in three commands, on a shell that can't touch your session. A
packaged version is [`test/hotplug-rig.sh`](https://github.com/M4E5TR0-MUN1R/gnome-monitor-window-guard/blob/main/test/hotplug-rig.sh)
in the repo.

It's worth being clear about the rig's limits, because I over-trusted it. It reproduced
some failures faithfully and completely missed others — the dropped-geometry-batch problem
only ever appeared on real hardware, with real applications, at real window counts. A rig
that passes is evidence, not proof.

### Check the API instead of remembering it

GNOME's JS API churns between releases, and a wrong guess costs a full logout to discover.
`gjs` can interrogate the typelib directly, using the same introspection layer the shell
uses:

```sh
GI_TYPELIB_PATH=/usr/lib/x86_64-linux-gnu/mutter-17 gjs -c '
imports.gi.versions.Meta = "17";
const {Meta} = imports.gi;
for (const m of ["get_maximize_flags", "get_maximized", "maximize", "unmaximize"])
    print(m.padEnd(20) + (typeof Meta.Window.prototype[m] === "function"
        ? "OK (args: " + Meta.Window.prototype[m].length + ")" : "MISSING"));
'
```

```
get_maximize_flags   OK (args: 0)
get_maximized        MISSING
maximize             OK (args: 0)
unmaximize           OK (args: 0)
```

`meta_window_get_maximized()` doesn't exist in mutter 17 — it's `get_maximize_flags()`. I
caught that one early. What I missed is in the same output: `maximize()` and `unmaximize()`
take **zero** arguments. I'd been passing `MaximizeFlags` to both, which logs
`Too many arguments to method Meta.Window.maximize: expected 0, got 1` and *ignores the
argument*. Direction is set separately via `set_maximize_flags()`.

Check arity, not just existence. And read the `JS WARNING` lines in the journal — mine were
there the whole time, buried in output I was skimming for something else:

```sh
journalctl --user -b -o cat | grep "JS WARNING"
```

### Two more time sinks worth naming

**`journalctl -b` covers the whole boot, and logging out doesn't start a new boot.** After
a re-login the old session's lines are still there, above the new ones. I told the user to
check with `head -20`, which showed pre-fix history, and we both briefly concluded a
working fix had failed. Use `tail`, and log a version string on startup so you can tell at
a glance which build produced a line.

**Lock/unlock re-runs `enable()` without re-importing the module.** So an extension can
appear to reload while still running old code. There is no way around the logout:
`org.gnome.Shell.Extensions.ReloadExtension` exists on the D-Bus interface but returns
`NotSupported: ReloadExtension is deprecated and does not work`. Also add
`"session-modes": ["user", "unlock-dialog"]` if your extension needs to survive the lock
screen — otherwise GNOME tears it down and any in-memory state dies with it.

---

## Should you just change the setting instead?

Worth saying plainly: a lot of this pain comes from `workspaces-only-on-primary`, and you
can simply turn it off.

```sh
gsettings set org.gnome.mutter workspaces-only-on-primary false
```

Now workspaces span both monitors. A window on the external belongs to one workspace like
any other, so it can't pile up across all of them, and on unplug each window returns to the
laptop *on its own workspace*. Causes 1 and 3 still exist, but the damage is much smaller.

The trade-off is that switching workspaces now changes both screens. If you use the second
monitor as a fixed reference surface — docs, logs, a dashboard that should stay put while
you move around — that's a real loss, and it's the reason to keep the setting on and
compensate for it instead.

There are two defensible answers here, and the right one depends on whether you want your
second screen to be *part of* your workspaces or *outside* them. Decide that first; the
implementation follows.

---

## Summary

| Symptom | Cause | Fix |
|---|---|---|
| Windows jump to the new monitor | Logical coordinate space shifts when a monitor is added left/top | Store positions relative to each monitor's origin |
| Windows from every workspace appear at once | `workspaces-only-on-primary` makes non-primary windows implicitly sticky | Restore the workspace *after* moving the window back to its monitor |
| Unplug dumps everything on the active workspace | Sticky windows need a real workspace and get the current one | Collect them onto a dedicated new workspace |
| Breakage is intermittent | Stale monitor indices in mutter; dropped geometry batches | Restore after a settle delay, then converge with retries |
| A fix appears to work but doesn't | Window ops are queued; workspace sets on sticky windows are silently dropped | Verify against target after settling, never inline |

Two things I'd carry to the next problem like this.

**Store stable identities and relative quantities, and reconcile late.** Indices and
absolute coordinates are only meaningful relative to a configuration, and the configuration
is the thing that changed. I made this mistake twice — once with monitor indices, then again
with workspace indices, in code written specifically to fix the first one.

**When an API silently does nothing, stop reasoning and start measuring.** Every real bug
here was found by logging actual before/after state and comparing it against the intended
target. None of them were found by thinking harder about the code, and two of my
confident explanations were flatly wrong until the log contradicted them.

---

*The extension is [monitor-window-guard](https://github.com/M4E5TR0-MUN1R/gnome-monitor-window-guard),
MIT licensed, built against GNOME Shell 49 / mutter 17 on Ubuntu 25.10.*
