// Lists and brings forward VS Code's windows for the Switchboard dock, and tells it which monitors a full-screen window covers, because
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
      <arg name="monitor" type="s" direction="in"/>
      <arg name="found" type="b" direction="out"/>
    </method>
    <method name="FullScreen">
      <arg name="monitors" type="as" direction="out"/>
    </method>
    <signal name="FullScreenChanged">
      <arg name="monitors" type="as"/>
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
   * Brings the VS Code window forward on its workspace, unminimized and maximized on the monitor named by its connector, as the dock does on
   * Windows; an empty or unknown connector leaves it on its monitor. False when no VS Code window has the ID, so a caller cannot bring forward
   * other apps' windows.
   */
  Activate(id, monitor) {
    const window = vsCodeWindows().find((each) => each.get_id() === id);

    if (window === undefined) {
      return false;
    }

    Main.activateWindow(window);

    const index = monitor === '' ? -1 : global.backend.get_monitor_manager().get_monitor_for_connector(monitor);

    if (index >= 0 && window.get_monitor() !== index) {
      window.move_to_monitor(index);
    }

    if (window.can_maximize()) {
      window.maximize();
    }

    return true;
  },

  /**
   * The monitors a full-screen window covers, by connector, which XWayland uses as the RandR name; the dock goes below a full-screen window on
   * its monitor, as on Windows.
   */
  FullScreen() {
    return global.backend.get_monitor_manager().get_logical_monitors()
      .filter((logical) => global.display.get_monitor_in_fullscreen(logical.get_number()))
      .flatMap((logical) => logical.get_monitors().map((monitor) => monitor.get_connector()));
  },
};

export default class SwitchboardExtension extends Extension {
  enable() {
    this.exported = Gio.DBusExportedObject.wrapJSObject(INTERFACE, service);
    this.exported.export(Gio.DBus.session, PATH);
    this.owner = Gio.bus_own_name_on_connection(Gio.DBus.session, NAME, Gio.BusNameOwnerFlags.NONE, null, null);
    this.fullScreen = service.FullScreen().join('\n');
    // Also raised when nothing changed for the dock, so only a change in the monitors is sent.
    this.fullScreenWatch = global.display.connect('in-fullscreen-changed', () => {
      const monitors = service.FullScreen();

      if (monitors.join('\n') !== this.fullScreen) {
        this.fullScreen = monitors.join('\n');
        this.exported.emit_signal('FullScreenChanged', new GLib.Variant('(as)', [monitors]));
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
