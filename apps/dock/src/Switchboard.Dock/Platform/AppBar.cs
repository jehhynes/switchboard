using System.Runtime.Versioning;

namespace Switchboard.Dock.Platform;

/// <summary>
/// Reserves a strip at the left or right edge of a monitor as a Windows app bar, so maximized windows fill the rest (switcher spike Q3).
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
    DockEdge edge;
    nint monitor;

    /// <summary>
    /// The strip the window must keep, in physical pixels, or null before the first placement. Any move or resize, Avalonia's own included,
    /// is held to it, because Avalonia moves a window it resizes into the work area, which starts at the dock's own right edge.
    /// </summary>
    public Native.Rect? Strip { get; set; }

    /// <summary>
    /// Raised when the bar has to be placed again: another app bar moved, Explorer restarted, or the displays changed, which can remove the monitor
    /// the bar was on, so the owner resolves its monitor again and calls <see cref="Dock"/>.
    /// </summary>
    public event Action? Moved;

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

    Native.AppBarData Data() => new() { Size = System.Runtime.InteropServices.Marshal.SizeOf<Native.AppBarData>(), Window = window, CallbackMessage = callback, Edge = edge == DockEdge.Left ? Native.AbeLeft : Native.AbeRight };

    /// <summary>The monitor the strip is on, where item windows are placed.</summary>
    public nint Monitor => monitor;

    /// <summary>Reserves a strip <paramref name="widthPixels"/> wide at <paramref name="at"/> of <paramref name="on"/> and returns its bounds, which the window takes.</summary>
    public Native.Rect Dock(DockEdge at, nint on, int widthPixels)
    {
        edge = at;
        monitor = on;

        var proposed = DockPlacement.Strip(edge, Native.Bounds(monitor), widthPixels);
        var data = Data();

        data.Bounds = new Native.Rect { Left = proposed.Left, Top = proposed.Top, Right = proposed.Right, Bottom = proposed.Bottom };
        // Windows moves the proposed strip off a taskbar on the same edge; the width is then set again from the outer edge it keeps.
        Native.SHAppBarMessage(Native.AbmQueryPos, ref data);

        if (edge == DockEdge.Left)
        {
            data.Bounds.Right = data.Bounds.Left + widthPixels;
        }
        else
        {
            data.Bounds.Left = data.Bounds.Right - widthPixels;
        }

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
                Moved?.Invoke();
            }
            else if (wParam == Native.AbnFullScreenApp)
            {
                FullScreen?.Invoke(lParam != 0);
            }
        }
        else if (message == taskbarCreated)
        {
            Register();
            Moved?.Invoke();
        }
        else if (message == Native.WmDisplayChange)
        {
            Moved?.Invoke();
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
