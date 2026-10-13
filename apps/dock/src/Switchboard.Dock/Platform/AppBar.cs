using System.Runtime.Versioning;

namespace Switchboard.Dock.Platform;

/// <summary>
/// Reserves a strip at the left or right edge of a monitor as a Windows app bar, so maximized windows fill the rest (switcher spike Q3),
/// or registers as that edge's auto-hide bar, which reserves nothing.
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
    // Whether ABM_SETPOS reserved a strip, and the edge and monitor the bar is registered as auto-hide on.
    bool reserved;
    (DockEdge Edge, nint Monitor)? autoHidden;

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

    /// <summary>
    /// Places the bar <paramref name="widthPixels"/> wide at <paramref name="at"/> of <paramref name="on"/> and returns its bounds, which the window takes.
    /// It reserves the strip, or with <paramref name="autoHide"/> reserves nothing and registers as the auto-hide bar of that edge (PRD R71).
    /// </summary>
    public Native.Rect Dock(DockEdge at, nint on, int widthPixels, bool autoHide)
    {
        if (autoHidden is { } registered && (!autoHide || registered != (at, on)))
        {
            SetAutoHide(registered.Edge, registered.Monitor, false);
            autoHidden = null;
        }

        // A bar keeps its reserved strip until it registers again.
        if (autoHide && reserved)
        {
            var old = Data();

            Native.SHAppBarMessage(Native.AbmRemove, ref old);
            Register();
            reserved = false;
        }

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

        if (autoHide)
        {
            // Refused when another auto-hide bar, such as the taskbar, holds the edge; the dock still hides itself.
            if (autoHidden is null && SetAutoHide(edge, monitor, true))
            {
                autoHidden = (edge, monitor);
            }
        }
        else
        {
            Native.SHAppBarMessage(Native.AbmSetPos, ref data);
            reserved = true;
        }

        return data.Bounds;
    }

    bool SetAutoHide(DockEdge at, nint on, bool register)
    {
        var data = Data();

        data.Edge = at == DockEdge.Left ? Native.AbeLeft : Native.AbeRight;
        data.Bounds = Native.RectOf(Native.Bounds(on));
        data.Param = register ? 1 : 0;

        return Native.SHAppBarMessage(Native.AbmSetAutoHideBarEx, ref data) != 0;
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
            reserved = false;
            autoHidden = null;
            Moved?.Invoke();
        }
        else if (message == Native.WmDisplayChange)
        {
            Moved?.Invoke();
        }
        else if (message == Native.WmDpiChanged && Strip is not null && !Native.IsIconic(hwnd))
        {
            var result = Native.DefSubclassProc(hwnd, message, wParam, lParam);

            // Avalonia takes the new scale here and sizes the window to Windows' suggestion, which the strip holds back to the same size, so no WM_SIZE
            // follows and Avalonia keeps the size it computed at the old scale; a WM_SIZE at the current size makes it lay out at the new scale.
            Native.GetClientRect(hwnd, out var client);
            Native.SendMessage(hwnd, Native.WmSize, Native.SizeRestored, SizeParam(client));

            return result;
        }
        else if (message == Native.WmActivate || message == Native.WmWindowPosChanged)
        {
            var data = Data();

            Native.SHAppBarMessage(message == Native.WmActivate ? Native.AbmActivate : Native.AbmWindowPosChanged, ref data);
        }

        return Native.DefSubclassProc(hwnd, message, wParam, lParam);
    }

    /// <summary>A client area's width and height packed into a WM_SIZE lParam.</summary>
    internal static nint SizeParam(Native.Rect client) => ((client.Bottom - client.Top) << 16) | ((client.Right - client.Left) & 0xFFFF);

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
        if (autoHidden is { } registered)
        {
            SetAutoHide(registered.Edge, registered.Monitor, false);
        }

        var data = Data();

        Native.SHAppBarMessage(Native.AbmRemove, ref data);
        Native.RemoveWindowSubclass(window, subclass, 1);
    }
}
