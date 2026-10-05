/* Monitor Window Guard
 *
 * Problem this solves on this machine (GNOME 49 / Wayland, laptop eDP-1 plus a
 * portrait Dell on HDMI-1 positioned to the LEFT of the laptop):
 *
 *   1. The laptop is not the layout origin. HDMI-1 sits at x=0 and eDP-1 at
 *      x=1080,y=491, so plugging in shifts the laptop's whole logical coordinate
 *      space. Window geometry lives in that global space, so windows appear to
 *      jump between monitors.
 *   2. `workspaces-only-on-primary = true` means any window on a non-primary
 *      monitor is implicitly on-all-workspaces. Windows that land on the Dell show
 *      up on every workspace, and on unplug mutter has to give them a real
 *      workspace, so it dumps them all onto whichever one is active.
 *   3. Something in the stack keeps a stale monitor index across an unplug
 *      (meta_monitor_manager_get_logical_monitor_from_number assertion failures),
 *      so window placement is computed against garbage work-area geometry.
 *
 * The fix is to keep a continuously-updated record of where each window is, keyed
 * by MONITOR CONNECTOR NAME rather than monitor index, and replay it after a
 * monitor change. Connector names are stable no matter how the monitors are
 * arranged or how many there are; indices are not. Positions are stored relative
 * to their monitor's origin, which is what neutralises (1).
 *
 * We deliberately restore AFTER a short settle delay. Mutter and other extensions
 * relocate windows first; we apply on top, last writer wins. That is also what
 * absorbs the non-determinism from (3).
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TAG = 'monitor-window-guard';

// Window types we manage. Everything else (docks, desktop, tooltips, the DING
// desktop icons window) is left entirely alone.
// Upper bound when re-creating workspaces that dynamic-workspaces pruned. Purely a
// runaway guard; real sessions never approach it.
const MAX_WORKSPACES = 36;

// How long to wait for 'monitors-changed' after 'monitors-changing' before assuming the
// reconfiguration was abandoned and unfreezing the cache.
const FREEZE_WATCHDOG_S = 5;

// How long to let a queued monitor move land before assigning workspaces. Until it does,
// the window still reports its old monitor and stays implicitly on-all-workspaces, and a
// workspace assignment on a sticky window is silently dropped.
const MONITOR_SETTLE_MS = 250;

// How long to let the second pass land before reading state back and re-seeding the cache
// from it.
const VERIFY_DELAY_MS = 400;

const MANAGED_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
];

export default class MonitorWindowGuardExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});

        // Meta.Window -> cached placement. Plain Map; entries are removed on
        // 'unmanaged' so this cannot keep windows alive past their lifetime.
        this._cache = new Map();
        this._winSignals = new Map();
        this._displaySignals = [];
        this._layoutSignals = [];
        this._monitorSignals = [];
        this._settleId = 0;
        this._thawId = 0;
        this._phase2Id = 0;
        this._verifyId = 0;

        // True while a monitor change is in flight, so neither mutter's relocation nor
        // our own move_resize_frame calls overwrite the pre-change state we intend to
        // replay. See _freezeCache() for why this must latch early.
        this._restoring = false;
        this._restorePending = false;

        this._monitors = this._snapshotMonitors();

        // Freeze on mutter's 'monitors-changing', which is emitted BEFORE the monitor
        // set is rebuilt. Relying on layoutManager's 'monitors-changed' is too late:
        // mutter has already relocated windows by then, position-changed has already
        // fired, and the cache no longer holds pre-change state. Observed on hardware
        // as windows cached with ws=null (implicitly sticky because mutter had moved
        // them to the secondary monitor) instead of their real workspace.
        this._monitorManager = global.backend.get_monitor_manager();
        this._monitorSignals.push(this._monitorManager.connect('monitors-changing',
            () => this._freezeCache()));

        this._layoutSignals.push(Main.layoutManager.connect('monitors-changed',
            () => this._onMonitorsChanged()));

        this._displaySignals.push(global.display.connect('window-created',
            (_d, win) => this._trackWindow(win)));

        for (const win of global.display.list_all_windows())
            this._trackWindow(win);

        this._log(`enabled v${this.metadata['version-name'] ?? '?'}; ` +
                  `monitors=[${[...this._monitors.byConnector.keys()].join(', ')}] ` +
                  `primary=${this._monitors.byIndex.get(this._monitors.primaryIndex) ?? '?'} ` +
                  `tracking ${this._cache.size} window(s)`);
        this._log(`actuation: pin-on-connect=${this._settings.get_boolean('pin-on-connect')} ` +
                  `collect-on-disconnect=${this._settings.get_boolean('collect-on-disconnect')}`);
    }

    disable() {
        if (this._settleId) {
            GLib.Source.remove(this._settleId);
            this._settleId = 0;
        }
        if (this._thawId) {
            GLib.Source.remove(this._thawId);
            this._thawId = 0;
        }
        if (this._phase2Id) {
            GLib.Source.remove(this._phase2Id);
            this._phase2Id = 0;
        }
        if (this._verifyId) {
            GLib.Source.remove(this._verifyId);
            this._verifyId = 0;
        }
        for (const id of this._monitorSignals) {
            try {
                this._monitorManager.disconnect(id);
            } catch {
                // monitor manager already gone
            }
        }
        for (const id of this._layoutSignals)
            Main.layoutManager.disconnect(id);
        for (const id of this._displaySignals)
            global.display.disconnect(id);
        for (const [win, ids] of this._winSignals) {
            for (const id of ids) {
                try {
                    win.disconnect(id);
                } catch {
                    // window already finalized
                }
            }
        }
        this._layoutSignals = [];
        this._displaySignals = [];
        this._monitorSignals = [];
        this._monitorManager = null;
        this._winSignals.clear();
        this._cache.clear();
        this._monitors = null;
        this._settings = null;
        this._mutterSettings = null;
        this._log('disabled');
    }

    /* Latch the cache against further writes because a monitor reconfiguration has
     * begun. Everything mutter does to windows from here until we restore is transient
     * and must not be recorded.
     *
     * A watchdog is essential: 'monitors-changing' is not guaranteed to be followed by
     * 'monitors-changed' (a configuration can be rejected or rolled back), and a stuck
     * freeze would silently stop the cache tracking windows for the rest of the
     * session — turning the extension into a slow-motion version of the bug it fixes.
     */
    _freezeCache() {
        if (!this._restoring)
            this._log('monitors-changing: cache frozen');
        this._restoring = true;

        // A new layout invalidates every index in an in-flight restore plan. Keep the
        // original cache, but cancel its callbacks and plan again after the new layout.
        for (const key of ['_settleId', '_phase2Id', '_verifyId']) {
            if (this[key]) {
                GLib.Source.remove(this[key]);
                this[key] = 0;
            }
        }

        if (this._thawId)
            GLib.Source.remove(this._thawId);
        this._thawId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, FREEZE_WATCHDOG_S, () => {
            this._thawId = 0;
            if (this._restoring && !this._settleId && !this._phase2Id && !this._verifyId) {
                this._log('WARNING: no monitors-changed followed monitors-changing; thawing cache');
                this._thaw();
                this._reseed();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _thaw() {
        if (this._thawId) {
            GLib.Source.remove(this._thawId);
            this._thawId = 0;
        }
        this._restoring = false;
        this._restorePending = false;
    }

    /* ---------------------------------------------------------------- monitors */

    /* Build connector <-> index maps for the monitors that are currently active.
     *
     * MonitorManager.get_monitors() enumerates every known monitor including
     * inactive ones; get_monitor_for_connector() returns -1 for those, which is
     * how we filter down to the live set. */
    _snapshotMonitors() {
        const byConnector = new Map();
        const byIndex = new Map();
        const n = global.display.get_n_monitors();
        const primaryIndex = global.display.get_primary_monitor();

        let mm = null;
        let monitors = [];
        try {
            mm = global.backend.get_monitor_manager();
            monitors = mm.get_monitors() ?? [];
        } catch (e) {
            this._log(`monitor manager unavailable (${e.message}); falling back to indices`);
        }

        for (const mon of monitors) {
            let connector = null;
            try {
                connector = mon.get_connector();
            } catch {
                continue;
            }
            if (!connector || !mm)
                continue;

            const index = mm.get_monitor_for_connector(connector);
            if (index < 0 || index >= n)
                continue; // not currently driving a logical monitor

            const g = global.display.get_monitor_geometry(index);
            byConnector.set(connector, {
                index, x: g.x, y: g.y, width: g.width, height: g.height,
            });
            byIndex.set(index, connector);
        }

        // Fallback: no usable connector names. Synthesise stable-ish keys from
        // geometry so the extension degrades instead of misbehaving. This loses
        // the layout-independence property, so it is logged loudly.
        if (byIndex.size !== n) {
            if (byIndex.size > 0)
                this._log(`WARNING: mapped ${byIndex.size}/${n} monitors by connector; using geometry keys for the rest`);
            for (let i = 0; i < n; i++) {
                if (byIndex.has(i))
                    continue;
                const g = global.display.get_monitor_geometry(i);
                const key = `geom:${g.width}x${g.height}@${g.x},${g.y}`;
                byConnector.set(key, {index: i, x: g.x, y: g.y, width: g.width, height: g.height});
                byIndex.set(i, key);
            }
        }

        return {byConnector, byIndex, primaryIndex, count: n};
    }

    /* ----------------------------------------------------------------- tracking */

    _isManaged(win) {
        if (!win)
            return false;
        try {
            if (win.is_override_redirect() || win.is_skip_taskbar())
                return false;
            // Windows mutter forces sticky regardless of monitor (desktop, docks).
            // Not ours to move.
            if (win.is_always_on_all_workspaces())
                return false;
            // Desktop-icon windows from ding@rastersoft.com. On Wayland these are
            // ordinary NORMAL windows (it emulates the DESKTOP type in JS), one per
            // monitor, and its GTK skip-taskbar hint does not reach mutter — so
            // nothing above filters them out. This is the marker DING itself uses to
            // recognise its own windows, set directly on the Meta.Window.
            if (win.customJS_ding)
                return false;
            if (!MANAGED_TYPES.includes(win.get_window_type()))
                return false;

            const ignored = this._settings?.get_strv('ignore-wm-classes') ?? [];
            if (ignored.length) {
                const wmClass = win.get_wm_class() ?? '';
                if (ignored.includes(wmClass))
                    return false;
            }
            return true;
        } catch {
            return false; // window went away mid-check
        }
    }

    _trackWindow(win) {
        if (!win || this._winSignals.has(win))
            return;

        const ids = [];
        const recapture = () => this._capture(win);
        for (const sig of ['position-changed', 'size-changed', 'workspace-changed',
                           'notify::maximized-horizontally', 'notify::maximized-vertically',
                           'notify::fullscreen']) {
            try {
                ids.push(win.connect(sig, recapture));
            } catch {
                // signal not present on this window type
            }
        }
        try {
            ids.push(win.connect('unmanaged', () => this._untrackWindow(win)));
        } catch {
            // ignore
        }

        this._winSignals.set(win, ids);
        this._capture(win);
    }

    _untrackWindow(win) {
        const ids = this._winSignals.get(win);
        if (ids) {
            for (const id of ids) {
                try {
                    win.disconnect(id);
                } catch {
                    // already finalized
                }
            }
            this._winSignals.delete(win);
        }
        this._cache.delete(win);
    }

    /* Record where this window currently is. Called on every geometry change so
     * that the cache holds the pre-change state when monitors-changing freezes it. */
    _capture(win) {
        if (this._restoring || !this._monitors)
            return;
        if (!this._isManaged(win)) {
            // A window can become unmanaged after we first saw it: DING sets its
            // customJS_ding marker on 'map', which is after window-created. Drop any
            // entry captured before that, or it lingers in the cache forever.
            this._cache.delete(win);
            return;
        }

        let monIndex, rect, sticky, onPrimary, maxFlags, fullscreen, title, ws;
        try {
            monIndex = win.get_monitor();
            rect = win.get_frame_rect();
            sticky = win.is_on_all_workspaces();
            onPrimary = win.is_on_primary_monitor();
            maxFlags = win.get_maximize_flags();
            fullscreen = win.is_fullscreen();
            title = win.get_title();
            ws = win.get_workspace();
        } catch {
            return;
        }

        const connector = this._monitors.byIndex.get(monIndex);
        if (connector === undefined) {
            // Stale/out-of-range monitor index — exactly the condition behind the
            // assertion failures in the journal. Refuse to poison the cache with it.
            return;
        }
        const mon = this._monitors.byConnector.get(connector);

        // Mutter's monitor assignment can lag a window's geometry while a
        // reconfiguration is in flight, reporting monitor A for a window that has
        // already been placed over monitor B. Caching that pair yields a garbage
        // relative offset (observed as rel=-1014,780 in testing) which then gets
        // replayed on restore. If the window's centre is not inside the monitor it
        // claims, keep the previous good entry instead.
        const centreX = rect.x + rect.width / 2;
        const centreY = rect.y + rect.height / 2;
        if (centreX < mon.x || centreX >= mon.x + mon.width ||
            centreY < mon.y || centreY >= mon.y + mon.height)
            return;

        // Second consistency check, on identity rather than geometry. If the connector
        // we resolved is the primary monitor but the window itself reports it is not on
        // the primary (or vice versa), the index-to-connector mapping was taken against
        // a monitor set that no longer matches reality. The centre check above cannot
        // catch this: on hardware, windows already relocated to HDMI-1 still had their
        // centre inside eDP-1's old rectangle, and were cached as eDP-1/ws=null.
        if ((monIndex === this._monitors.primaryIndex) !== onPrimary)
            return;

        // With workspaces-only-on-primary=true a window on a secondary monitor is
        // implicitly on-all-workspaces, so its workspace is meaningless. Only a
        // sticky window sitting on the PRIMARY monitor was stuck deliberately.
        const explicitSticky = sticky && onPrimary;

        this._cache.set(win, {
            connector,
            wsIndex: sticky ? null : (ws ? ws.index() : null),
            explicitSticky,
            relX: rect.x - mon.x,
            relY: rect.y - mon.y,
            width: rect.width,
            height: rect.height,
            maxFlags,
            fullscreen,
            title: title ?? '',
            wmClass: (() => {
                try {
                    return win.get_wm_class() ?? '';
                } catch {
                    return '';
                }
            })(),
        });
    }

    /* ---------------------------------------------------------- monitor changes */

    _onMonitorsChanged() {
        const oldMons = this._monitors;
        const newMons = this._snapshotMonitors();
        this._monitors = newMons;

        const oldConns = [...oldMons.byConnector.keys()];
        const newConns = [...newMons.byConnector.keys()];
        const added = newConns.filter(c => !oldMons.byConnector.has(c));
        const removed = oldConns.filter(c => !newMons.byConnector.has(c));

        this._log(`monitors-changed: added=[${added.join(', ') || '-'}] ` +
                  `removed=[${removed.join(', ') || '-'}] now=[${newConns.join(', ')}]`);

        this._restorePending ||= added.length > 0 || removed.length > 0;
        if (!this._restorePending) {
            // Resolution or position change only. Nothing to put back, but the cache is
            // frozen and holds offsets against the previous geometry, so thaw and
            // re-record against the new layout instead of leaving it latched.
            this._log('no connector set change (mode/position only); nothing to do');
            this._thaw();
            this._reseed();
            return;
        }

        this._pruneCache();
        this._dumpCache('cached state from BEFORE the change');

        // Already frozen by 'monitors-changing'; this only covers the case where that
        // signal did not arrive for some reason.
        this._freezeCache();
        if (this._settleId)
            GLib.Source.remove(this._settleId);

        const delay = this._settings.get_int('settle-delay-ms');
        this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._settleId = 0;
            this._dumpLive('live state AFTER the change, BEFORE restore');

            let plan = null;
            try {
                plan = this._buildRestorePlan(this._monitors);
            } catch (e) {
                console.error(`[${TAG}] building restore plan failed: ${e}\n${e.stack ?? ''}`);
            }

            if (!plan) {
                this._thaw();
                this._reseed();
                return GLib.SOURCE_REMOVE;
            }

            this._converge(plan, 1);
            return GLib.SOURCE_REMOVE;
        });
    }

    /* Apply the plan, wait, check what actually took, re-apply the rest. Repeat.
     *
     * A single pass is not enough, for two independently verified reasons:
     *
     *   - Mutter's window operations are QUEUED. A geometry batch can simply fail to
     *     apply; on hardware two of five windows stayed on the wrong monitor while the
     *     other three moved, from identical code on the same event.
     *   - dynamic-workspaces RENUMBERS workspaces. Assigning a window to workspace 3
     *     and then having an emptied workspace pruned leaves it on workspace 2. Observed
     *     on hardware: every window landed one workspace lower than intended.
     *
     * So convergence is the only honest model: state what the target is, keep nudging
     * reality towards it, and report if it does not get there.
     */
    _converge(plan, attempt) {
        let outstanding = 0;

        for (const item of plan.survivors) {
            const {win, entry, monIndex} = item;
            // Dynamic workspace objects survive renumbering when lower empty
            // workspaces disappear. Static targets retain their absolute numbers.
            const wsTarget = item.workspaceTarget ? item.workspaceTarget.index() : item.wsTarget;
            if (!this._isManaged(win))
                continue;

            let monOk, wsOk;
            try {
                monOk = win.get_monitor() === monIndex;
                wsOk = entry.explicitSticky ? win.is_on_all_workspaces() :
                    wsTarget === null ||
                    (!win.is_on_all_workspaces() && (item.workspaceTarget ?
                        win.get_workspace() === item.workspaceTarget :
                        win.get_workspace()?.index() === wsTarget));
            } catch {
                continue; // window vanished
            }

            if (monOk && item.orphan) {
                try {
                    const wsm = global.workspace_manager;
                    const ws = wsTarget === null ? wsm.get_active_workspace() :
                        wsm.get_workspace_by_index(wsTarget);
                    if (ws)
                        this._clampToWorkArea(win, ws, monIndex);
                } catch (e) {
                    outstanding++;
                    this._log(`  attempt ${attempt}: clamping "${entry.title.slice(0, 32)}" failed: ${e.message}`);
                    continue;
                }
            }
            if (monOk && wsOk)
                continue;
            outstanding++;

            try {
                if (!monOk) {
                    // Monitor first. While mutter thinks the window is on a secondary
                    // monitor it is implicitly on-all-workspaces, and a workspace
                    // assignment on a sticky window is silently dropped.
                    this._placeOnMonitor(win, entry, plan.mons);
                } else {
                    this._assignWorkspace(win, entry, wsTarget);
                }
            } catch (e) {
                this._log(`  attempt ${attempt}: "${entry.title.slice(0, 32)}" failed: ${e.message}`);
            }
        }

        const maxAttempts = this._settings.get_int('max-restore-attempts');
        if (outstanding === 0) {
            this._log(`converged after ${attempt} attempt(s)`);
            this._finishRestore();
            return;
        }
        if (attempt >= maxAttempts) {
            this._log(`WARNING: gave up after ${attempt} attempt(s) with ${outstanding} ` +
                      `window(s) still off target`);
            this._finishRestore();
            return;
        }

        this._log(`attempt ${attempt}: ${outstanding} window(s) off target, retrying`);
        this._phase2Id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MONITOR_SETTLE_MS, () => {
            this._phase2Id = 0;
            this._converge(plan, attempt + 1);
            return GLib.SOURCE_REMOVE;
        });
    }

    _finishRestore() {
        this._verifyId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, VERIFY_DELAY_MS, () => {
            this._verifyId = 0;
            this._dumpLive('live state AFTER restore (settled)');
            this._thaw();
            this._reseed();
            return GLib.SOURCE_REMOVE;
        });
    }

    /* Work out what the end state should be. Computed ONCE from the frozen cache so that
     * every convergence attempt aims at the same target; recomputing per attempt would
     * chase the very renumbering we are trying to correct for. */
    _buildRestorePlan(mons) {
        const pin = this._settings.get_boolean('pin-on-connect');
        const collect = this._settings.get_boolean('collect-on-disconnect');

        const survivors = [];
        const orphans = [];

        // Classify against the CURRENT monitor set rather than against the
        // added/removed diff. Several monitor changes can coalesce inside one settle
        // window (docking stations, a fast replug), and each diff is computed against
        // the previous snapshot — so a monitor removed by an earlier change would
        // never show up in the latest diff. "Cached connector is not present now"
        // is the definition of an orphan and is immune to that.
        for (const win of global.display.list_all_windows()) {
            const entry = this._cache.get(win);
            if (!entry || !this._isManaged(win))
                continue;
            if (mons.byConnector.has(entry.connector))
                survivors.push([win, entry]);
            else
                orphans.push([win, entry]);
        }

        this._log(`restore: ${survivors.length} survivor(s), ${orphans.length} orphan(s) ` +
                  `[pin=${pin} collect=${collect}]`);

        if (!pin && !collect) {
            this._log('OBSERVE-ONLY: both actuation keys are false, no windows will be moved');
            return null;
        }

        const dynamic = this._mutterSettings.get_boolean('dynamic-workspaces');

        // Dynamic workspaces can be renumbered; static workspaces keep their identity.
        //
        // With dynamic-workspaces the live workspaces are exactly "those holding windows"
        // plus one trailing empty, so absolute indices are not a stable identity — they
        // shift whenever a workspace is pruned. Preserving the relative ORDER of the
        // occupied workspaces is both what the user perceives ("one window per workspace,
        // in this order") and immune to renumbering.
        const wsRank = new Map();
        if (pin) {
            const occupied = [...new Set(
                survivors.map(([, e]) => e.wsIndex).filter(i => i !== null))].sort((a, b) => a - b);
            occupied.forEach((idx, rank) => wsRank.set(idx, dynamic ? rank :
                Math.min(idx, global.workspace_manager.get_n_workspaces() - 1)));
            if (occupied.length)
                this._log(`workspace targets: ${occupied.map(i => `${i}->${wsRank.get(i)}`).join(' ')}`);
        }

        const plannedSurvivors = pin ? survivors.map(([win, entry]) => ({
            win,
            entry,
            monIndex: mons.byConnector.get(entry.connector).index,
            wsTarget: entry.explicitSticky || entry.wsIndex === null
                ? null
                : wsRank.get(entry.wsIndex),
        })) : [];

        if (collect && orphans.length) {
            const wsm = global.workspace_manager;
            const orphanSet = new Set(orphans.map(([win]) => win));
            const reserved = new Set(plannedSurvivors.map(item => item.wsTarget));
            const ws = this._targetWorkspace(wsm, orphanSet, reserved, dynamic);
            const connector = mons.byIndex.get(mons.primaryIndex);
            const mon = mons.byConnector.get(connector);
            this._log(`collecting ${orphans.length} orphan(s) onto workspace index ${ws.index()}`);
            for (const [win, entry] of orphans) {
                plannedSurvivors.push({
                    win,
                    entry: {...entry, connector},
                    monIndex: mon.index,
                    wsTarget: entry.explicitSticky ? null : ws.index(),
                    workspaceTarget: dynamic && !entry.explicitSticky ? ws : null,
                    orphan: true,
                });
            }
        }

        return {mons, survivors: plannedSurvivors};
    }

    /* Put a window's frame onto the target monitor. Idempotent — the convergence loop
     * calls this repeatedly until mutter agrees.
     *
     * Geometry drives the monitor, not the other way round: mutter derives a window's
     * monitor from where its frame actually is, and move_to_monitor() alone was measured
     * to be a no-op for maximized windows it had already reassigned. So unmaximize,
     * place the frame, then re-apply the size state.
     *
     * All of it goes in ONE synchronous batch. Mutter queues and coalesces these
     * operations, so unmaximize/move/maximize issued together resolve to the intended
     * final geometry; splitting the maximize into a later pass was measured to lose the
     * whole move, because the queued unmaximize had not landed when the move was
     * evaluated and the move got clamped back to the old monitor's work area.
     */
    _placeOnMonitor(win, entry, mons) {
        const mon = mons.byConnector.get(entry.connector);

        // NB: maximize()/unmaximize() take NO arguments in Meta 17 — passing
        // MaximizeFlags logged "Too many arguments" and was ignored. Direction is set
        // separately via set_unmaximize_flags()/set_maximize_flags().
        if (win.is_fullscreen())
            win.unmake_fullscreen();
        if (win.get_maximize_flags()) {
            win.set_unmaximize_flags(Meta.MaximizeFlags.BOTH);
            win.unmaximize();
        }

        win.move_resize_frame(false,
            mon.x + entry.relX, mon.y + entry.relY, entry.width, entry.height);

        if (win.get_monitor() !== mon.index)
            win.move_to_monitor(mon.index);

        if (entry.fullscreen) {
            win.make_fullscreen();
        } else if (entry.maxFlags) {
            win.set_maximize_flags(entry.maxFlags);
            win.maximize();
        }
    }

    /* Move a window to a workspace by index, creating workspaces if needed. Only
     * meaningful once the window is off any secondary monitor — while mutter considers it
     * implicitly on-all-workspaces this is silently dropped, which is why the convergence
     * loop only calls this after the monitor check passes. */
    _assignWorkspace(win, entry, wsTarget) {
        if (entry.explicitSticky) {
            win.stick();
            return;
        }
        if (wsTarget === null || wsTarget < 0)
            return;
        const wsm = global.workspace_manager;

        while (this._mutterSettings.get_boolean('dynamic-workspaces') &&
               wsm.get_n_workspaces() <= wsTarget && wsm.get_n_workspaces() < MAX_WORKSPACES)
            wsm.append_new_workspace(false, global.get_current_time());

        if (win.is_on_all_workspaces())
            win.unstick();

        if (wsTarget < wsm.get_n_workspaces()) {
            const cur = win.get_workspace();
            if (!cur || cur.index() !== wsTarget)
                win.change_workspace_by_index(wsTarget, false);
        }
    }

    /* Prefer an empty workspace that no survivor is about to return to. Dynamic
     * workspaces may append; a static grid must keep its existing workspace count.
     * If the grid is full, use the active workspace for disconnected-screen windows. */
    _targetWorkspace(wsm, excludeSet, reserved, dynamic) {
        const count = wsm.get_n_workspaces();
        for (let i = count - 1; i >= (dynamic ? count - 1 : 0); i--) {
            const ws = wsm.get_workspace_by_index(i);
            const occupied = ws.list_windows()
                .some(w => this._isManaged(w) && !excludeSet.has(w) &&
                           !w.is_on_all_workspaces());
            if (!reserved.has(i) && !occupied)
                return ws;
        }
        if (dynamic && count < MAX_WORKSPACES)
            return wsm.append_new_workspace(false, global.get_current_time());
        return wsm.get_active_workspace();
    }

    _clampToWorkArea(win, ws, monIndex) {
        if (win.is_fullscreen() || win.is_maximized())
            return;
        if (monIndex < 0 || monIndex >= global.display.get_n_monitors())
            return; // never ask for a work area with an index we cannot vouch for

        const wa = ws.get_work_area_for_monitor(monIndex);
        const r = win.get_frame_rect();
        const width = Math.min(r.width, wa.width);
        const height = Math.min(r.height, wa.height);
        const x = Math.max(wa.x, Math.min(r.x, wa.x + wa.width - width));
        const y = Math.max(wa.y, Math.min(r.y, wa.y + wa.height - height));

        if (x !== r.x || y !== r.y || width !== r.width || height !== r.height)
            win.move_resize_frame(false, x, y, width, height);
    }

    /* Drop entries for windows that are no longer ours to manage.
     *
     * A window can be cached at creation and only later reveal itself as off-limits:
     * DING sets its customJS_ding marker on 'map', and its GTK skip-taskbar hint reaches
     * mutter later still. If such a window never moves again, no capture re-evaluates it
     * and the entry lingers. _restore() re-checks _isManaged so this was never able to
     * move anything, but a cache that disagrees with reality makes the logs misleading. */
    _pruneCache() {
        for (const win of [...this._cache.keys()]) {
            if (!this._isManaged(win))
                this._cache.delete(win);
        }
    }

    _reseed() {
        for (const win of global.display.list_all_windows()) {
            this._trackWindow(win);
            this._capture(win);
        }
        this._log(`re-seeded cache: ${this._cache.size} window(s)`);
    }

    /* ------------------------------------------------------------------ logging */

    _log(msg) {
        if (!this._settings || this._settings.get_boolean('debug-log'))
            console.log(`[${TAG}] ${msg}`);
    }

    _dumpCache(label) {
        if (!this._settings.get_boolean('debug-log'))
            return;
        this._log(`--- ${label} (${this._cache.size} window(s)) ---`);
        for (const entry of this._cache.values()) {
            this._log(`    "${entry.title.slice(0, 40)}" [${entry.wmClass}] on=${entry.connector} ` +
                      `ws=${entry.wsIndex} rel=${entry.relX},${entry.relY} ${entry.width}x${entry.height} ` +
                      `max=${entry.maxFlags} fs=${entry.fullscreen} sticky=${entry.explicitSticky}`);
        }
    }

    _dumpLive(label) {
        if (!this._settings.get_boolean('debug-log'))
            return;
        const lines = [];
        for (const win of global.display.list_all_windows()) {
            if (!this._isManaged(win))
                continue;
            try {
                const r = win.get_frame_rect();
                const idx = win.get_monitor();
                const ws = win.get_workspace();
                lines.push(`    "${(win.get_title() ?? '').slice(0, 40)}" ` +
                           `[${win.get_wm_class() ?? ''}/type${win.get_window_type()}` +
                           `${win.is_skip_taskbar() ? '/skiptb' : ''}] ` +
                           `mon=${idx}(${this._monitors.byIndex.get(idx) ?? 'STALE'}) ` +
                           `ws=${ws ? ws.index() : 'none'} abs=${r.x},${r.y} ${r.width}x${r.height} ` +
                           `sticky=${win.is_on_all_workspaces()}`);
            } catch {
                // window vanished mid-dump
            }
        }
        this._log(`--- ${label} (${lines.length} window(s)) ---`);
        for (const line of lines)
            this._log(line);
    }
}
