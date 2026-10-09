using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;

namespace Switchboard.Dock.Platform;

[SupportedOSPlatform("windows")]
static partial class Native
{
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect
    {
        public int Left, Top, Right, Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct AppBarData
    {
        public int Size;
        public nint Window;
        public uint CallbackMessage;
        public uint Edge;
        public Rect Bounds;
        public nint Param;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MonitorInfo
    {
        public int Size;
        public Rect Monitor;
        public Rect Work;
        public uint Flags;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct WindowPos
    {
        public nint Window;
        public nint InsertAfter;
        public int X, Y, Width, Height;
        public uint Flags;
    }

    public delegate bool EnumProc(nint window, nint param);

    public delegate nint SubclassProc(nint window, uint message, nint wParam, nint lParam, nuint id, nuint data);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumProc callback, nint param);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(nint window, StringBuilder text, int max);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(nint window);

    [DllImport("user32.dll")]
    public static extern nint GetWindow(nint window, uint command);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(nint window);

    [DllImport("user32.dll")]
    public static extern bool IsZoomed(nint window);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(nint window, int command);

    [DllImport("user32.dll")]
    public static extern nint GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(nint window);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern uint RegisterWindowMessage(string name);

    [DllImport("user32.dll")]
    public static extern nint MonitorFromPoint(System.Drawing.Point point, uint flags);

    [DllImport("user32.dll")]
    public static extern bool GetMonitorInfo(nint monitor, ref MonitorInfo info);

    [DllImport("user32.dll")]
    public static extern nint MonitorFromWindow(nint window, uint flags);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(nint window, nint after, int x, int y, int width, int height, uint flags);

    public delegate void WinEventProc(nint hook, uint eventType, nint window, int objectId, int childId, uint thread, uint time);

    [DllImport("user32.dll")]
    public static extern nint SetWinEventHook(uint eventMin, uint eventMax, nint module, WinEventProc proc, uint process, uint thread, uint flags);

    [DllImport("user32.dll")]
    public static extern bool UnhookWinEvent(nint hook);

    [DllImport("shell32.dll")]
    public static extern nuint SHAppBarMessage(uint message, ref AppBarData data);

    [DllImport("comctl32.dll")]
    public static extern bool SetWindowSubclass(nint window, SubclassProc proc, nuint id, nuint data);

    [DllImport("comctl32.dll")]
    public static extern bool RemoveWindowSubclass(nint window, SubclassProc proc, nuint id);

    [DllImport("comctl32.dll")]
    public static extern nint DefSubclassProc(nint window, uint message, nint wParam, nint lParam);

    public const int SwMaximize = 3;
    public const int SwRestore = 9;
    public const uint GwOwner = 4;
    public const uint MonitorDefaultToPrimary = 1, MonitorDefaultToNearest = 2;
    public const uint SwpNoSize = 0x1, SwpNoMove = 0x2, SwpNoZOrder = 0x4, SwpNoActivate = 0x10;
    public const uint EventSystemForeground = 3, WinEventOutOfContext = 0;
    public const uint AbmNew = 0, AbmRemove = 1, AbmQueryPos = 2, AbmSetPos = 3, AbmActivate = 6, AbmWindowPosChanged = 9;
    public const uint AbeLeft = 0;
    public const int AbnPosChanged = 1, AbnFullScreenApp = 2;
    public const uint WmActivate = 0x0006, WmWindowPosChanging = 0x0046, WmWindowPosChanged = 0x0047;

    public static string Title(nint window)
    {
        var text = new StringBuilder(1024);

        GetWindowText(window, text, text.Capacity);

        return text.ToString();
    }
}
