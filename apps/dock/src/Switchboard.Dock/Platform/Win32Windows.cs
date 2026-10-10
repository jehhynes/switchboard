using System.Diagnostics;
using System.Runtime.Versioning;
using Switchboard.Dock.Hub;
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
    Native.WinEventProc? windowProc;
    nint nameHook;
    nint destroyHook;
    readonly WindowNames names = new();

    /// <summary>
    /// Calls <paramref name="changed"/> with the title of each window that comes to the front, however it got there: the taskbar, Alt+Tab or a click.
    /// Windows calls it on this thread, which must run a message loop.
    /// </summary>
    public void WatchForeground(Action<string> changed)
    {
        foregroundProc = (_, _, window, _, _, _, _) => changed(Native.Title(window));
        foregroundHook = Native.SetWinEventHook(Native.EventSystemForeground, Native.EventSystemForeground, 0, foregroundProc, 0, 0, Native.WinEventOutOfContext);
    }

    /// <summary>
    /// Calls <paramref name="closed"/> with the name of each item window that is destroyed, keeping each window's name from its title as it changes,
    /// because a destroyed window's title can no longer be read. Windows calls it on this thread.
    /// </summary>
    public void WatchClosed(Action<string> closed)
    {
        foreach (var (window, name) in ItemWindows())
        {
            names.Set(window, name);
        }

        windowProc = (_, eventType, window, objectId, childId, _, _) =>
        {
            if (objectId != Native.ObjIdWindow || childId != Native.ChildIdSelf)
            {
                return;
            }

            if (eventType == Native.EventObjectNameChange)
            {
                names.Set(window, ItemName(window, Native.Title(window)));
            }
            else if (names.Destroyed(window) is { } name)
            {
                closed(name);
            }
        };
        nameHook = Native.SetWinEventHook(Native.EventObjectNameChange, Native.EventObjectNameChange, 0, windowProc, 0, 0, Native.WinEventOutOfContext);
        destroyHook = Native.SetWinEventHook(Native.EventObjectDestroy, Native.EventObjectDestroy, 0, windowProc, 0, 0, Native.WinEventOutOfContext);
    }

    /// <summary>The monitor the dock is docked on, where item windows are placed; 0 places them on the primary monitor.</summary>
    public nint DockMonitor { get; set; }

    public void Dispose()
    {
        foreach (var hook in new[] { foregroundHook, nameHook, destroyHook })
        {
            if (hook != 0)
            {
                Native.UnhookWinEvent(hook);
            }
        }

        foregroundHook = nameHook = destroyHook = 0;
    }

    public nint Find(string name) => ItemWindows().FirstOrDefault((entry) => entry.Name == name).Window;

    /// <summary>The visible top-level VS Code windows whose titles name an item window, from the front.</summary>
    static List<(nint Window, string Name)> ItemWindows()
    {
        var found = new List<(nint Window, string Name)>();

        Native.EnumWindows(
            (window, _) =>
            {
                if (Native.IsWindowVisible(window) && Native.GetWindow(window, Native.GwOwner) == 0 && ItemName(window, Native.Title(window)) is { } name)
                {
                    found.Add((window, name));
                }

                return true;
            },
            0);

        return found;
    }

    /// <summary>The item window name in a VS Code window's title, or null; the process is looked up only for a title that names one.</summary>
    static string? ItemName(nint window, string title) => DockWindow.NameOf(title) is { } name && IsVsCode(window) ? name : null;

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
    /// Moves a window on another monitor into the work area of the dock's monitor, so maximizing fills the space beside the dock.
    /// VS Code opens a new window on the monitor of the VS Code window used last.
    /// </summary>
    void MoveToDockMonitor(nint window)
    {
        var target = DockMonitor == 0 ? Native.PrimaryMonitor() : DockMonitor;

        if (Native.MonitorFromWindow(window, Native.MonitorDefaultToNearest) == target)
        {
            return;
        }

        var monitor = new Native.MonitorInfo { Size = System.Runtime.InteropServices.Marshal.SizeOf<Native.MonitorInfo>() };

        Native.GetMonitorInfo(target, ref monitor);

        // A maximized window stays on its monitor; restored, it moves, and maximizing then fills the new monitor's work area.
        if (Native.IsZoomed(window))
        {
            Native.ShowWindow(window, Native.SwRestore);
        }

        var work = monitor.Work;

        Native.SetWindowPos(window, 0, work.Left, work.Top, work.Right - work.Left, work.Bottom - work.Top, Native.SwpNoZOrder | Native.SwpNoActivate);
    }

    public nint FindVsCode()
    {
        nint found = 0;

        // EnumWindows lists top-level windows from the front.
        Native.EnumWindows(
            (window, _) =>
            {
                if (!Native.IsWindowVisible(window) || Native.GetWindow(window, Native.GwOwner) != 0 || Native.Title(window) == "" || !IsVsCode(window))
                {
                    return true;
                }

                found = window;
                return false;
            },
            0);

        return found;
    }

    static bool IsVsCode(nint window)
    {
        Native.GetWindowThreadProcessId(window, out var process);

        try
        {
            using var owner = Process.GetProcessById((int)process);

            return owner.ProcessName.Equals("Code", StringComparison.OrdinalIgnoreCase);
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    public void OpenUrl(string url) => Process.Start(new ProcessStartInfo(url) { UseShellExecute = true })?.Dispose();
}
