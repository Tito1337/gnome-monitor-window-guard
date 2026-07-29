// Test window for the hotplug rig.
//
//   gjs win.js <title> [max]
//
// Opens a GTK4 window with the given title, optionally maximized. Runs until killed.
// Intended to be launched against the rig's own Wayland display, NOT your session --
// see hotplug-rig.sh, which sets WAYLAND_DISPLAY and unsets DISPLAY before spawning.

imports.gi.versions.Gtk = '4.0';
const {Gtk, GLib} = imports.gi;

const title = ARGV[0] || 'rig-window';
const maximize = ARGV[1] === 'max';

Gtk.init();

const win = new Gtk.Window({title, default_width: 400, default_height: 300});
win.set_child(new Gtk.Label({label: title}));
if (maximize)
    win.maximize();
win.present();

new GLib.MainLoop(null, false).run();
