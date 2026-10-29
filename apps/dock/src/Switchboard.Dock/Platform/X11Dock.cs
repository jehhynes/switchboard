using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Switchboard.Dock.Platform;

/// <summary>
/// Reserves a strip at the left or right edge of a monitor as an X11 dock window, as the dock runs under XWayland on GNOME (mechanics
/// M39). Its type, <c>_NET_WM_WINDOW_TYPE_DOCK</c>, makes Mutter keep it above other windows, below a full-screen one, on every workspace and out of
/// the taskbar, and lets it lie inside a strut, where Mutter moves a normal window out; <c>_NET_WM_STRUT_PARTIAL</c> reserves the strip, so maximized
/// windows fill the rest. Struts are measured from the X screen's edges (<see cref="DockPlacement.Strut"/>).
/// </summary>
[SupportedOSPlatform("linux")]
internal sealed partial class X11Dock : IX11Edge
{
    const string Library = "libX11.so.6";
    const string ShapeLibrary = "libXext.so.6";
    const int ShapeBounding = 0;
    const int ShapeInput = 2;
    const nint PointerRoot = 1;
    const int ShapeSet = 0;
    const int Unsorted = 0;
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

    /// <summary>The start of an <c>XWindowAttributes</c> on 64-bit Linux, through <c>override_redirect</c>, padded to its full size.</summary>
    [StructLayout(LayoutKind.Explicit, Size = 136)]
    struct WindowAttributes
    {
        [FieldOffset(120)] public int OverrideRedirect;
    }

    struct XRectangle
    {
        public short X;
        public short Y;
        public ushort Width;
        public ushort Height;
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

        try
        {
            dock.CanShape = XShapeQueryExtension(display, out _, out _);
        }
        catch (DllNotFoundException)
        {
        }

        dock.Set("_NET_WM_WINDOW_TYPE", "ATOM", [dock.Atom("_NET_WM_WINDOW_TYPE_DOCK")]);
        XFlush(display);

        return dock;
    }

    /// <summary>Reserves <paramref name="strip"/>, in X screen pixels, at <paramref name="edge"/>.</summary>
    public void Reserve(DockEdge edge, PixelRect strip)
    {
        // XDisplayWidth keeps the width the screen had when the connection opened; the root window's geometry follows monitor changes.
        XGetGeometry(display, XDefaultRootWindow(display), out _, out _, out _, out var width, out _, out _, out _);

        var strut = DockPlacement.Strut(edge, strip, (int)width);

        Set("_NET_WM_STRUT_PARTIAL", "CARDINAL", strut);
        // For window managers that read only the older property.
        Set("_NET_WM_STRUT", "CARDINAL", strut[..4]);
        XFlush(display);
    }

    /// <summary>Reserves nothing; other windows may then cover the dock's strip.</summary>
    public void Release()
    {
        Set("_NET_WM_STRUT_PARTIAL", "CARDINAL", new nint[12]);
        Set("_NET_WM_STRUT", "CARDINAL", new nint[4]);
        XFlush(display);
    }

    /// <summary>
    /// Each monitor's work area on the current workspace, from Mutter's <c>_GTK_WORKAREAS_D</c> property; empty when the window manager does not
    /// set it. <c>_NET_WORKAREA</c> has one work area for all monitors.
    /// </summary>
    public IReadOnlyList<PixelRect> WorkAreas()
    {
        var desktop = Get("_NET_CURRENT_DESKTOP", "CARDINAL") is [var current, ..] ? current : 0;
        var values = Get($"_GTK_WORKAREAS_D{desktop}", "CARDINAL");

        return [.. values.Chunk(4).Where((each) => each.Length == 4).Select((each) => new PixelRect((int)each[0], (int)each[1], (int)(each[0] + each[2]), (int)(each[1] + each[3])))];
    }

    /// <summary>Whether the X server has the Shape extension, which auto-hide needs.</summary>
    public bool CanShape { get; private set; }

    /// <summary>
    /// Limits the window's drawing and input to the <paramref name="width"/> pixels at its <paramref name="edge"/>, through the X Shape extension.
    /// The sliver runs past the window's bottom, which the X server clips, so it holds when the window grows taller.
    /// </summary>
    public void ClipToSliver(DockEdge edge, int width)
    {
        XGetGeometry(display, window, out _, out _, out _, out var windowWidth, out _, out _, out _);
        Shape(new XRectangle { X = (short)(edge == DockEdge.Left ? 0 : (int)windowWidth - width), Width = (ushort)width, Height = (ushort)short.MaxValue });
    }

    /// <summary>
    /// Gives the window its whole rectangle again. Mutter kept drawing only the sliver when the shape was removed, so the shape becomes a rectangle
    /// larger than any window instead (mechanics M49).
    /// </summary>
    public void Unclip() => Shape(new XRectangle { Width = (ushort)short.MaxValue, Height = (ushort)short.MaxValue });

    void Shape(XRectangle rectangle)
    {
        XShapeCombineRectangles(display, window, ShapeBounding, 0, 0, ref rectangle, 1, ShapeSet, Unsorted);
        XShapeCombineRectangles(display, window, ShapeInput, 0, 0, ref rectangle, 1, ShapeSet, Unsorted);
        XFlush(display);
    }

    /// <summary>
    /// Whether the pointer is over the dock or a window it owns, or one of them has the keyboard focus. Its owned dialogs are
    /// <c>WM_TRANSIENT_FOR</c> it, and its menus and tooltips are override-redirect windows of its process, which Avalonia does not mark with an owner
    /// (mechanics M49). The pointer's windows are each window under it from the root down, and the focus's are the focus window and its ancestors,
    /// as a window manager can put a window in a frame.
    /// </summary>
    public bool KeptOpen()
    {
        if (HasFocus())
        {
            return true;
        }

        var root = XDefaultRootWindow(display);

        for (var at = root; XQueryPointer(display, at, out _, out var child, out _, out _, out _, out _, out _) && child != 0; at = child)
        {
            if (Ours(child))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>Whether the dock or a window it owns, such as a menu, has the keyboard focus; see <see cref="KeptOpen"/>.</summary>
    public bool HasFocus()
    {
        if (XGetInputFocus(display, out var focus, out _) != 0 && focus > PointerRoot)
        {
            for (var at = focus; at != 0; at = Parent(at))
            {
                if (Ours(at))
                {
                    return true;
                }
            }
        }

        return false;
    }

    bool Ours(nint at) =>
        HideDelay.OwnedBy(at, window, (each) => XGetTransientForHint(display, each, out var owner) != 0 ? owner : 0)
        || (XGetWindowAttributes(display, at, out var attributes) != 0 && attributes.OverrideRedirect != 0 && Get(at, "_NET_WM_PID", "CARDINAL") is [var pid, ..] && pid == Environment.ProcessId);

    /// <summary>The window's parent; 0 for the root window or a window that is gone.</summary>
    nint Parent(nint at)
    {
        if (XQueryTree(display, at, out var root, out var parent, out var children, out _) == 0)
        {
            return 0;
        }

        if (children != 0)
        {
            XFree(children);
        }

        return parent == root ? 0 : parent;
    }

    /// <summary>The pointer on the X screen; null when it is on another X screen.</summary>
    public Avalonia.PixelPoint? Pointer() =>
        XQueryPointer(display, XDefaultRootWindow(display), out _, out _, out var x, out var y, out _, out _, out _) ? new Avalonia.PixelPoint(x, y) : null;

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

    /// <summary>A 32-bit property of the root window, at most 64 values; empty when it is missing or of another type.</summary>
    nint[] Get(string property, string type) => Get(XDefaultRootWindow(display), property, type);

    /// <summary>A 32-bit property of <paramref name="of"/>, at most 64 values; empty when it is missing or of another type.</summary>
    nint[] Get(nint of, string property, string type)
    {
        if (XGetWindowProperty(display, of, Atom(property), 0, 64, false, Atom(type), out _, out var format, out var count, out _, out var data) != 0 || data == 0)
        {
            return [];
        }

        try
        {
            var values = new nint[format == 32 ? (int)count : 0];

            Marshal.Copy(data, values, 0, values.Length);
            return values;
        }
        finally
        {
            XFree(data);
        }
    }

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
    private static partial int XGetWindowProperty(nint display, nint window, nint property, nint offset, nint length, [MarshalAs(UnmanagedType.Bool)] bool delete, nint type, out nint actualType, out int actualFormat, out nuint count, out nuint bytesAfter, out nint data);

    [LibraryImport(Library)]
    private static partial int XFree(nint data);

    [LibraryImport(Library)]
    private static partial int XSetInputFocus(nint display, nint window, int revertTo, nint time);

    [LibraryImport(Library)]
    private static partial int XSendEvent(nint display, nint window, [MarshalAs(UnmanagedType.Bool)] bool propagate, nint mask, ref ClientMessage message);

    [LibraryImport(Library)]
    private static partial nint XDefaultRootWindow(nint display);

    [LibraryImport(Library)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool XQueryPointer(nint display, nint window, out nint root, out nint child, out int rootX, out int rootY, out int windowX, out int windowY, out uint mask);

    [LibraryImport(Library)]
    private static partial int XGetInputFocus(nint display, out nint focus, out int revertTo);

    [LibraryImport(Library)]
    private static partial int XGetTransientForHint(nint display, nint window, out nint owner);

    [LibraryImport(Library)]
    private static partial int XGetWindowAttributes(nint display, nint window, out WindowAttributes attributes);

    [LibraryImport(Library)]
    private static partial int XQueryTree(nint display, nint window, out nint root, out nint parent, out nint children, out uint count);

    [LibraryImport(ShapeLibrary)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool XShapeQueryExtension(nint display, out int eventBase, out int errorBase);

    [LibraryImport(ShapeLibrary)]
    private static partial void XShapeCombineRectangles(nint display, nint window, int kind, int x, int y, ref XRectangle rectangles, int count, int operation, int ordering);

    [LibraryImport(Library)]
    private static partial int XGetGeometry(nint display, nint drawable, out nint root, out int x, out int y, out uint width, out uint height, out uint border, out uint depth);
}
