import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

// Run the actual extension methods with GNOME objects supplied by the fixture.
// No shell session, display configuration, or user settings are touched.
const source = readFileSync(new URL('../monitor-window-guard@khamis/extension.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export default class', 'class');

function fixture({dynamic = false, pin = true, collect = true, count = 8, active = 2} = {}) {
    const windows = [];
    const tasks = new Map();
    const logs = [];
    let nextId = 0;
    let appended = 0;
    let finished = false;
    const workspaces = Array.from({length: count}, (_, index) => ({
        index() {return workspaces.indexOf(this);},
        list_windows() {return windows.filter(w => w.sticky || w.get_workspace() === this);},
        get_work_area_for_monitor: () => ({x: 0, y: 0, width: 1920, height: 1200}),
    }));
    const wsm = {
        get_n_workspaces: () => workspaces.length,
        get_workspace_by_index: i => workspaces[i],
        get_active_workspace: () => workspaces[active],
        append_new_workspace() {
            appended++;
            const index = workspaces.length;
            const ws = {index() {return workspaces.indexOf(this);}, list_windows: () => []};
            workspaces.push(ws);
            return ws;
        },
    };
    const global = {display: {list_all_windows: () => windows}, workspace_manager: wsm,
        get_current_time: () => 0};
    const GLib = {PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false,
        timeout_add(_p, _ms, callback) {tasks.set(++nextId, callback); return nextId;},
        timeout_add_seconds(_p, _s, callback) {tasks.set(++nextId, callback); return nextId;},
        Source: {remove: id => tasks.delete(id)}};
    const Guard = new Function('Extension', 'Meta', 'GLib', 'Gio', 'Main', 'global',
        `${source}\nreturn MonitorWindowGuardExtension;`)(class {},
        {WindowType: {NORMAL: 0, DIALOG: 1, MODAL_DIALOG: 2}}, GLib, {}, {}, global);
    const guard = new Guard();
    guard._settings = {get_boolean: key => key === 'pin-on-connect' ? pin : collect,
        get_int: key => key === 'max-restore-attempts' ? 3 : 150};
    guard._mutterSettings = {get_boolean: () => dynamic};
    guard._cache = new Map();
    guard._isManaged = w => !w.closed;
    guard._log = msg => logs.push(msg);
    guard._finishRestore = () => {finished = true;};
    guard._clampToWorkArea = () => {};
    guard._dumpCache = guard._dumpLive = guard._pruneCache = guard._reseed = () => {};
    const mons = {byConnector: new Map([['eDP-1', {index: 0}]]),
        byIndex: new Map([[0, 'eDP-1']]), primaryIndex: 0};
    guard._monitors = mons;
    guard._snapshotMonitors = () => mons;
    guard._restoring = false;
    guard._restorePending = false;
    for (const name of ['_settleId', '_phase2Id', '_verifyId', '_thawId']) guard[name] = 0;
    function window(connector, wsIndex, {monitor = 0, ws = wsIndex, sticky = false,
        explicitSticky = false} = {}) {
        const win = {monitor, ws, sticky, assignments: 0,
            get_monitor() {return this.monitor;},
            get_workspace() {return workspaces[this.ws];},
            is_on_all_workspaces() {return this.sticky;},
            unstick() {this.sticky = false;}, stick() {this.sticky = true;},
            change_workspace_by_index(i) {this.assignments++; this.ws = i;},
        };
        windows.push(win);
        guard._cache.set(win, {connector, wsIndex, explicitSticky, title: 'fixture'});
        return win;
    }
    function next() {
        const [id, callback] = tasks.entries().next().value;
        tasks.delete(id);
        callback();
    }
    return {guard, mons, windows, window, tasks, next, logs, wsm, workspaces,
        get appended() {return appended;}, get finished() {return finished;}};
}

test('static workspaces preserve gaps and absolute numbers', () => {
    const f = fixture();
    for (const i of [0, 3, 7]) f.window('eDP-1', i);
    assert.deepEqual(f.guard._buildRestorePlan(f.mons).survivors.map(w => w.wsTarget), [0, 3, 7]);
});
test('dynamic workspaces retain ranking', () => {
    const f = fixture({dynamic: true});
    for (const i of [0, 3, 7]) f.window('eDP-1', i);
    assert.deepEqual(f.guard._buildRestorePlan(f.mons).survivors.map(w => w.wsTarget), [0, 1, 2]);
});
test('observe-only builds no plan and creates no workspace', () => {
    const f = fixture({pin: false, collect: false});
    f.window('DP-1', null);
    assert.equal(f.guard._buildRestorePlan(f.mons), null);
    assert.equal(f.appended, 0);
});
test('static orphan collection uses an empty existing workspace', () => {
    const f = fixture(); f.window('DP-1', null);
    assert.equal(f.guard._buildRestorePlan(f.mons).survivors[0].wsTarget, 7);
    assert.equal(f.appended, 0);
});
test('static orphan collection avoids survivor destinations even if currently empty', () => {
    const f = fixture(); f.window('eDP-1', 7, {ws: 0}); f.window('DP-1', null);
    assert.equal(f.guard._buildRestorePlan(f.mons).survivors.find(w => w.orphan).wsTarget, 6);
    assert.equal(f.appended, 0);
});
test('a full static grid collects onto the active workspace without appending', () => {
    const f = fixture();
    for (let i = 0; i < 8; i++) f.window('eDP-1', i);
    f.window('DP-1', null);
    assert.equal(f.guard._buildRestorePlan(f.mons).survivors.find(w => w.orphan).wsTarget, 2);
    assert.equal(f.appended, 0);
});
test('dynamic orphan collection appends once when the final workspace is occupied', () => {
    const f = fixture({dynamic: true, pin: false});
    f.window('eDP-1', 7); f.window('DP-1', null);
    const plan = f.guard._buildRestorePlan(f.mons);
    assert.equal(plan.survivors[0].wsTarget, 8);
    assert.equal(f.appended, 1);
});
test('dynamic orphan collection respects the workspace limit', () => {
    const f = fixture({dynamic: true, pin: false, count: 36});
    f.window('eDP-1', 35); f.window('DP-1', null);
    assert.equal(f.guard._buildRestorePlan(f.mons).survivors[0].wsTarget, 2);
    assert.equal(f.appended, 0);
});
test('collect-disabled leaves orphan windows out of the plan', () => {
    const f = fixture({collect: false}); f.window('DP-1', null);
    assert.equal(f.guard._buildRestorePlan(f.mons).survivors.length, 0);
});
test('orphan workspace assignment is retried and verified', () => {
    const f = fixture(); const w = f.window('DP-1', null, {ws: 0});
    // Model a dropped first workspace assignment.
    w.change_workspace_by_index = function(i) {if (++this.assignments > 1) this.ws = i;};
    const plan = f.guard._buildRestorePlan(f.mons);
    f.guard._converge(plan, 1); assert.equal(f.finished, false);
    f.next(); assert.equal(f.finished, false);
    f.next(); assert.equal(f.finished, true);
    assert.equal(w.ws, 7); assert.equal(w.assignments, 2);
    assert(f.logs.includes('converged after 3 attempt(s)'));
    assert.equal(f.appended, 0);
});
test('failed orphan assignment reports failure instead of convergence', () => {
    const f = fixture(); const w = f.window('DP-1', null, {ws: 0});
    w.change_workspace_by_index = () => {};
    f.guard._converge(f.guard._buildRestorePlan(f.mons), 1);
    f.next(); f.next();
    assert(f.logs.some(s => s.includes('gave up after 3')));
    assert(!f.logs.some(s => s.startsWith('converged')));
});
test('orphan monitor placement precedes workspace assignment', () => {
    const f = fixture(); const w = f.window('DP-1', null, {monitor: 1, ws: 0, sticky: true});
    const placements = [];
    f.guard._placeOnMonitor = (win, entry) => placements.push([win, entry.connector]);
    const plan = f.guard._buildRestorePlan(f.mons);
    f.guard._converge(plan, 1);
    assert.equal(w.assignments, 0); assert.equal(placements[0][1], 'eDP-1');
    w.monitor = 0; w.sticky = false;
    f.next(); assert.equal(w.ws, 7);
    f.next(); assert.equal(f.finished, true);
});
test('a window closed during restoration no longer blocks convergence', () => {
    const f = fixture(); const w = f.window('DP-1', null, {ws: 0});
    const plan = f.guard._buildRestorePlan(f.mons); w.closed = true;
    f.guard._converge(plan, 1); assert.equal(f.finished, true);
});
test('static assignment never appends outside the grid', () => {
    const f = fixture(); const w = f.window('eDP-1', 7);
    f.guard._assignWorkspace(w, {}, 8); assert.equal(f.appended, 0); assert.equal(w.ws, 7);
});
test('static target is bounded if the grid was reduced during reconfiguration', () => {
    const f = fixture({count: 4}); f.window('eDP-1', 7, {ws: 0});
    assert.equal(f.guard._buildRestorePlan(f.mons).survivors[0].wsTarget, 3);
});
test('explicit stickiness is preserved when the primary monitor disappears', () => {
    const f = fixture(); const w = f.window('DP-1', null, {ws: 0, explicitSticky: true});
    f.guard._converge(f.guard._buildRestorePlan(f.mons), 1);
    assert.equal(w.sticky, true); assert.equal(w.assignments, 0);
    f.next(); assert.equal(f.finished, true);
});
test('a new monitor change cancels stale restore and verification callbacks', () => {
    const f = fixture(); let stale = false;
    for (const key of ['_settleId', '_phase2Id', '_verifyId']) {
        const id = 100 + f.tasks.size; f.tasks.set(id, () => {stale = true;}); f.guard[key] = id;
    }
    f.guard._freezeCache();
    assert.equal(f.tasks.size, 1); f.next(); assert.equal(stale, false);
    assert.equal(f.guard._restoring, false);
});
test('a mode-only event after hotplug still restores the original cache', () => {
    const f = fixture(); f.window('eDP-1', 7);
    f.guard._restorePending = true;
    f.guard._freezeCache(); f.guard._onMonitorsChanged();
    assert.notEqual(f.guard._settleId, 0);
    assert.equal(f.guard._restoring, true);
});

test('a sticky survivor does not occupy every static workspace', () => {
    const f = fixture();
    f.window('eDP-1', null, {ws: 0, sticky: true, explicitSticky: true});
    f.window('DP-1', null);
    assert.equal(f.guard._buildRestorePlan(f.mons).survivors.find(w => w.orphan).wsTarget, 7);
    assert.equal(f.appended, 0);
});
test('a sticky survivor does not force dynamic workspace creation', () => {
    const f = fixture({dynamic: true});
    f.window('eDP-1', null, {ws: 0, sticky: true, explicitSticky: true});
    f.window('DP-1', null);
    assert.equal(f.guard._buildRestorePlan(f.mons).survivors.find(w => w.orphan).wsTarget, 7);
    assert.equal(f.appended, 0);
});
test('dynamic orphan targets survive lower-workspace removal without bouncing', () => {
    const f = fixture({dynamic: true, pin: false, count: 4, active: 0});
    const w = f.window('DP-1', null, {ws: 0});
    const plan = f.guard._buildRestorePlan(f.mons);
    const target = plan.survivors[0].workspaceTarget;
    f.guard._converge(plan, 1);
    assert.equal(w.ws, 3);
    // Emulate WorkspaceTracker pruning an empty lower workspace.
    f.workspaces.splice(1, 1); w.ws--;
    assert.equal(target.index(), 2);
    f.next();
    assert.equal(f.finished, true);
    assert.equal(w.assignments, 1);
    assert.equal(w.get_workspace(), target);
    assert(f.logs.includes('converged after 2 attempt(s)'));
});
