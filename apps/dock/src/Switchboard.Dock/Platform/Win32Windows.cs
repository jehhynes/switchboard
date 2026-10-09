using System.Diagnostics;
using System.Runtime.Versioning;
using Switchboard.Dock.Switching;

namespace Switchboard.Dock.Platform;

/// <summary>
/// Windows' window calls, as the switcher spike verified them (.wip/spike-switcher/findings.md Q1, Q3): Windows lets the dock bring a window to the
/// front only while the operator's click on it is the latest input, so <see cref="Show"/> runs in the click handler and checks the result itself,
/// because VS Code's own focus flag can say true when Windows only flashed the taskbar button.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class Win32Windows : IWindows, IDisposable
{
    // Kept in a field so the delegate outlives every call Windows makes to it.
    Native.WinEventProc? foregroundProc;
    nint foregroundHook;

    /// <summary>
    /// Calls <paramref name="changed"/> with the title of each window that comes to the front, however it got there: the taskbar, Alt+Tab or a click.
    /// Windows calls it on this thread, which must run a message loop.
    /// </summary>
    public void WatchForeground(Action<string> changed)
    {
        foregroundProc = (_, _, window, _, _, _, _) => changed(Native.Title(window));
        foregroundHook = Native.SetWinEventHook(Native.EventSystemForeground, Native.EventSystemForeground, 0, foregroundProc, 0, 0, Native.WinEventOutOfContext);
    }

    public void Dispose()
    {
        if (foregroundHook != 0)
        {
            Native.UnhookWinEvent(foregroundHook);
            foregroundHook = 0;
        }
    }

    public nint Find(string titlePrefix)
    {
        nint found = 0;

        Native.EnumWindows(
            (window, _) =>
            {
                if (Native.IsWindowVisible(window) && Native.GetWindow(window, Native.GwOwner) == 0 && Native.Title(window).StartsWith(titlePrefix, StringComparison.Ordinal))
                {
                    found = window;
                    return false;
                }

                return true;
            },
            0);

        return found;
    }

    public bool Show(nint window)
    {
        // A maximized window fills the work area beside the dock exactly; a placed one would need the DWM frame correction.
        if (Native.IsIconic(window))
        {
            Native.ShowWindow(window, Native.SwRestore);
        }

        MoveToDockMonitor(window);

        if (!Native.IsZoomed(window))
        {
            Native.ShowWindow(window, Native.SwMaximize);
        }

        for (var attempt = 0; attempt < 2; attempt++)
        {
            Native.SetForegroundWindow(window);

            for (var check = Stopwatch.StartNew(); check.ElapsedMilliseconds < 100; Thread.Sleep(10))
            {
                if (Native.GetForegroundWindow() == window)
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// Moves a window on another monitor into the work area of the primary monitor, where the dock is, so maximizing fills the space beside the dock.
    /// VS Code opens a new window on the monitor of the VS Code window used last.
    /// </summary>
    static void MoveToDockMonitor(nint window)
    {
        var primary = Native.MonitorFromPoint(new System.Drawing.Point(0, 0), Native.MonitorDefaultToPrimary);

        if (Native.MonitorFromWindow(window, Native.MonitorDefaultToNearest) == primary)
        {
            return;
        }

        var monitor = new Native.MonitorInfo { Size = System.Runtime.InteropServices.Marshal.SizeOf<Native.MonitorInfo>() };

        Native.GetMonitorInfo(primary, ref monitor);

        // A maximized window stays on its monitor; restored, it moves, and maximizing then fills the new monitor's work area.
        if (Native.IsZoomed(window))
        {
            Native.ShowWindow(window, Native.SwRestore);
        }

        var work = monitor.Work;

        Native.SetWindowPos(window, 0, work.Left, work.Top, work.Right - work.Left, work.Bottom - work.Top, Native.SwpNoZOrder | Native.SwpNoActivate);
    }

    public void OpenUrl(string url) => Process.Start(new ProcessStartInfo(url) { UseShellExecute = true })?.Dispose();
}
