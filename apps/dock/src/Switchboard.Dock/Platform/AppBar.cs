using System.Drawing;
using System.Runtime.Versioning;

namespace Switchboard.Dock.Platform;

/// <summary>
/// Reserves a strip at the left edge of the primary monitor as a Windows app bar, so maximized windows fill the rest (switcher spike Q3).
/// Registering moves every window on the monitor. Explorer forgets app bars when it restarts, so the bar registers again on <c>TaskbarCreated</c>.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class AppBar : IDisposable
{
    readonly nint window;
    readonly uint callback = Native.RegisterWindowMessage("Switchboard.Dock.AppBar");
    readonly uint taskbarCreated = Native.RegisterWindowMessage("TaskbarCreated");
    // Kept in a field so the delegate outlives every call Windows makes to it.
    readonly Native.SubclassProc subclass;
    int width;

    /// <summary>
    /// The strip the window must keep, in physical pixels, or null before the first placement. Any move or resize, Avalonia's own included,
    /// is held to it, because Avalonia moves a window it resizes into the work area, which starts at the dock's own right edge.
    /// </summary>
    public Native.Rect? Strip { get; set; }

    /// <summary>Raised with the strip's bounds in physical pixels whenever the bar has to be placed again, such as after another app bar moved.</summary>
    public event Action<Native.Rect>? Placed;

    /// <summary>Raised with true while a full-screen app covers the monitor, when the bar should not stay on top.</summary>
    public event Action<bool>? FullScreen;

    public AppBar(nint window)
    {
        this.window = window;
        subclass = Proc;
        Native.SetWindowSubclass(window, subclass, 1, 0);
        Register();
    }

    void Register()
    {
        var data = Data();

        Native.SHAppBarMessage(Native.AbmNew, ref data);
    }

    Native.AppBarData Data() => new() { Size = System.Runtime.InteropServices.Marshal.SizeOf<Native.AppBarData>(), Window = window, CallbackMessage = callback, Edge = Native.AbeLeft };

    /// <summary>Reserves a strip <paramref name="widthPixels"/> wide and returns its bounds, which the window takes.</summary>
    public Native.Rect Dock(int widthPixels)
    {
        width = widthPixels;

        var monitor = new Native.MonitorInfo { Size = System.Runtime.InteropServices.Marshal.SizeOf<Native.MonitorInfo>() };

        Native.GetMonitorInfo(Native.MonitorFromPoint(new Point(0, 0), Native.MonitorDefaultToPrimary), ref monitor);

        var data = Data();

        data.Bounds = new Native.Rect { Left = monitor.Monitor.Left, Top = monitor.Monitor.Top, Right = monitor.Monitor.Left + widthPixels, Bottom = monitor.Monitor.Bottom };
        // Windows moves the proposed strip off a taskbar on the same edge; the width is then set again from where it starts.
        Native.SHAppBarMessage(Native.AbmQueryPos, ref data);
        data.Bounds.Right = data.Bounds.Left + widthPixels;
        Native.SHAppBarMessage(Native.AbmSetPos, ref data);

        return data.Bounds;
    }

    nint Proc(nint hwnd, uint message, nint wParam, nint lParam, nuint id, nuint reference)
    {
        if (message == Native.WmWindowPosChanging && Strip is { } strip)
        {
            var position = System.Runtime.InteropServices.Marshal.PtrToStructure<Native.WindowPos>(lParam);

            if (Hold(ref position, strip))
            {
                System.Runtime.InteropServices.Marshal.StructureToPtr(position, lParam, false);
            }
        }
        else if (message == callback)
        {
            if (wParam == Native.AbnPosChanged)
            {
                Placed?.Invoke(Dock(width));
            }
            else if (wParam == Native.AbnFullScreenApp)
            {
                FullScreen?.Invoke(lParam != 0);
            }
        }
        else if (message == taskbarCreated)
        {
            Register();
            Placed?.Invoke(Dock(width));
        }
        else if (message == Native.WmActivate || message == Native.WmWindowPosChanged)
        {
            var data = Data();

            Native.SHAppBarMessage(message == Native.WmActivate ? Native.AbmActivate : Native.AbmWindowPosChanged, ref data);
        }

        return Native.DefSubclassProc(hwnd, message, wParam, lParam);
    }

    /// <summary>Holds a pending move or resize to the strip; returns whether it changed anything.</summary>
    internal static bool Hold(ref Native.WindowPos position, Native.Rect strip)
    {
        var held = position;

        if ((position.Flags & Native.SwpNoMove) == 0)
        {
            held.X = strip.Left;
            held.Y = strip.Top;
        }

        if ((position.Flags & Native.SwpNoSize) == 0)
        {
            held.Width = strip.Right - strip.Left;
            held.Height = strip.Bottom - strip.Top;
        }

        var changed = !held.Equals(position);

        position = held;

        return changed;
    }

    public void Dispose()
    {
        var data = Data();

        Native.SHAppBarMessage(Native.AbmRemove, ref data);
        Native.RemoveWindowSubclass(window, subclass, 1);
    }
}
