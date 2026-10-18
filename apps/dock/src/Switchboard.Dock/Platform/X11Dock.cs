using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Switchboard.Dock.Platform;

/// <summary>
/// Reserves a strip at the left or right edge of the primary monitor as an X11 dock window, as the dock runs under XWayland on GNOME (mechanics
/// M39). Its type, <c>_NET_WM_WINDOW_TYPE_DOCK</c>, makes Mutter keep it above other windows, below a full-screen one, on every workspace and out of
/// the taskbar, and lets it lie inside a strut, where Mutter moves a normal window out; <c>_NET_WM_STRUT_PARTIAL</c> reserves the strip, so maximized
/// windows fill the rest. Struts are measured from the X screen's edges (<see cref="DockPlacement.Strut"/>).
/// </summary>
[SupportedOSPlatform("linux")]
internal sealed partial class X11Dock : IDisposable
{
    const string Library = "libX11.so.6";
    const int PropModeReplace = 0;
    const int RevertToParent = 2;
    const nint CurrentTime = 0;
    const int ClientMessageType = 33;
    const nint SubstructureNotifyMask = 1 << 19;
    const nint SubstructureRedirectMask = 1 << 20;

    /// <summary>An <c>XClientMessageEvent</c> with <c>_NET_WM_STATE</c>'s data, padded to the size of an <c>XEvent</c> on 64-bit Linux.</summary>
    [StructLayout(LayoutKind.Explicit, Size = 192)]
    struct ClientMessage
    {
        [FieldOffset(0)] public int Type;
        [FieldOffset(32)] public nint Window;
        [FieldOffset(40)] public nint MessageType;
        [FieldOffset(48)] public int Format;
        [FieldOffset(56)] public nint Action;
        [FieldOffset(64)] public nint First;
        [FieldOffset(80)] public nint Source;
    }

    readonly nint display;
    readonly nint window;

    X11Dock(nint display, nint window)
    {
        this.display = display;
        this.window = window;
    }

    /// <summary>Makes the X window <paramref name="window"/> a dock window, which Mutter reads when the window maps; null when no X display opens.</summary>
    public static X11Dock? Create(nint window)
    {
        var display = XOpenDisplay(null);

        if (display == 0)
        {
            return null;
        }

        var dock = new X11Dock(display, window);

        dock.Set("_NET_WM_WINDOW_TYPE", "ATOM", [dock.Atom("_NET_WM_WINDOW_TYPE_DOCK")]);
        XFlush(display);

        return dock;
    }

    /// <summary>Reserves <paramref name="strip"/>, in X screen pixels, at <paramref name="edge"/>.</summary>
    public void Reserve(DockEdge edge, PixelRect strip)
    {
        var strut = DockPlacement.Strut(edge, strip, XDisplayWidth(display, XDefaultScreen(display)));

        Set("_NET_WM_STRUT_PARTIAL", "CARDINAL", strut);
        // For window managers that read only the older property.
        Set("_NET_WM_STRUT", "CARDINAL", strut[..4]);
        XFlush(display);
    }

    /// <summary>Gives the window the keyboard focus, which Mutter does not do for a dock window on a click, but follows when the window takes it.</summary>
    public void Focus()
    {
        XSetInputFocus(display, window, RevertToParent, CurrentTime);
        XFlush(display);
    }

    /// <summary>
    /// Asks the window manager to keep the window below others, or above them again, through <c>_NET_WM_STATE_BELOW</c>: Mutter keeps a dock window
    /// above a full-screen one otherwise. Only for a mapped window.
    /// </summary>
    public void Below(bool below)
    {
        var message = new ClientMessage
        {
            Type = ClientMessageType,
            Window = window,
            MessageType = Atom("_NET_WM_STATE"),
            Format = 32,
            Action = below ? 1 : 0,
            First = Atom("_NET_WM_STATE_BELOW"),
            // From an application, not a pager.
            Source = 1,
        };

        XSendEvent(display, XDefaultRootWindow(display), false, SubstructureNotifyMask | SubstructureRedirectMask, ref message);
        XFlush(display);
    }

    nint Atom(string name) => XInternAtom(display, name, false);

    // A 32-bit property is passed as C longs, 64 bits each on 64-bit Linux.
    void Set(string property, string type, nint[] values) => XChangeProperty(display, window, Atom(property), Atom(type), 32, PropModeReplace, values, values.Length);

    public void Dispose() => XCloseDisplay(display);

    [LibraryImport(Library, StringMarshalling = StringMarshalling.Utf8)]
    private static partial nint XOpenDisplay(string? name);

    [LibraryImport(Library)]
    private static partial int XCloseDisplay(nint display);

    [LibraryImport(Library, StringMarshalling = StringMarshalling.Utf8)]
    private static partial nint XInternAtom(nint display, string name, [MarshalAs(UnmanagedType.Bool)] bool onlyIfExists);

    [LibraryImport(Library)]
    private static partial int XChangeProperty(nint display, nint window, nint property, nint type, int format, int mode, nint[] data, int count);

    [LibraryImport(Library)]
    private static partial int XFlush(nint display);

    [LibraryImport(Library)]
    private static partial int XSetInputFocus(nint display, nint window, int revertTo, nint time);

    [LibraryImport(Library)]
    private static partial int XSendEvent(nint display, nint window, [MarshalAs(UnmanagedType.Bool)] bool propagate, nint mask, ref ClientMessage message);

    [LibraryImport(Library)]
    private static partial nint XDefaultRootWindow(nint display);

    [LibraryImport(Library)]
    private static partial int XDefaultScreen(nint display);

    [LibraryImport(Library)]
    private static partial int XDisplayWidth(nint display, int screen);
}
