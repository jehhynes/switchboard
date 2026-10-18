// Lists and brings forward VS Code's windows for the Switchboard dock, and tells it when a full-screen window covers the primary monitor, because
// under GNOME on Wayland only GNOME Shell can see other apps' windows (architecture.md § Dock). Exports `switchboard.Shell` on the session bus.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { isListed } from './windows.js';

const NAME = 'switchboard.Shell';
const PATH = '/switchboard/Shell';
const INTERFACE = `
<node>
  <interface name="switchboard.Shell">
    <method name="Windows">
      <arg name="windows" type="a(ts)" direction="out"/>
    </method>
    <method name="Activate">
      <arg name="id" type="t" direction="in"/>
      <arg name="found" type="b" direction="out"/>
    </method>
    <method name="FullScreen">
      <arg name="fullscreen" type="b" direction="out"/>
    </method>
    <signal name="FullScreenChanged">
      <arg name="fullscreen" type="b"/>
    </signal>
  </interface>
</node>`;

/** VS Code's top-level windows, minimized ones and those on other workspaces included. */
function vsCodeWindows() {
  return global.display.list_all_windows().filter((window) => {
    const frame = window.get_frame_rect();

    return isListed({ normal: window.get_window_type() === Meta.WindowType.NORMAL, wmClass: window.get_wm_class(), width: frame.width, height: frame.height });
  });
}

const service = {
  /** VS Code's top-level windows, front first, by Mutter window ID and title. */
  Windows() {
    return global.display.sort_windows_by_stacking(vsCodeWindows()).reverse().map((window) => [window.get_id(), window.get_title() ?? '']);
  },

  /**
   * Brings the VS Code window forward on its workspace, unminimized and maximized, as the dock does on Windows; false when no VS Code window has
   * the ID, so a caller cannot bring forward other apps' windows.
   */
  Activate(id) {
    const window = vsCodeWindows().find((each) => each.get_id() === id);

    if (window === undefined) {
      return false;
    }

    Main.activateWindow(window);

    if (window.can_maximize()) {
      window.maximize();
    }

    return true;
  },

  /** Whether a full-screen window covers the primary monitor, where the dock goes below it, as on Windows. */
  FullScreen() {
    return global.display.get_monitor_in_fullscreen(global.display.get_primary_monitor());
  },
};

export default class SwitchboardExtension extends Extension {
  enable() {
    this.exported = Gio.DBusExportedObject.wrapJSObject(INTERFACE, service);
    this.exported.export(Gio.DBus.session, PATH);
    this.owner = Gio.bus_own_name_on_connection(Gio.DBus.session, NAME, Gio.BusNameOwnerFlags.NONE, null, null);
    this.fullScreen = service.FullScreen();
    // Raised for any monitor, so only a change on the primary one is sent.
    this.fullScreenWatch = global.display.connect('in-fullscreen-changed', () => {
      const fullScreen = service.FullScreen();

      if (fullScreen !== this.fullScreen) {
        this.fullScreen = fullScreen;
        this.exported.emit_signal('FullScreenChanged', new GLib.Variant('(b)', [fullScreen]));
      }
    });
  }

  disable() {
    global.display.disconnect(this.fullScreenWatch);
    Gio.bus_unown_name(this.owner);
    this.exported.unexport();
    this.exported = null;
  }
}
