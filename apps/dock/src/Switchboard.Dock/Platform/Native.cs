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

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct MonitorInfoEx
    {
        public int Size;
        public Rect Monitor;
        public Rect Work;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string Device;
    }

    public delegate bool EnumProc(nint window, nint param);

    public delegate bool MonitorEnumProc(nint monitor, nint hdc, nint rect, nint param);

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
    public static extern uint GetWindowThreadProcessId(nint window, out uint process);

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

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetMonitorInfoW")]
    public static extern bool GetMonitorInfoEx(nint monitor, ref MonitorInfoEx info);

    [DllImport("user32.dll")]
    public static extern bool EnumDisplayMonitors(nint hdc, nint clip, MonitorEnumProc callback, nint param);

    [DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(nint window, uint attribute, ref int value, int size);

    public const uint DwmwaTransitionsForceDisabled = 3, DwmwaCloak = 13;

    /// <summary>Hides a window from the screen while it keeps its size and position, or shows it again; Windows plays no animation for it.</summary>
    public static void Cloak(nint window, bool cloaked)
    {
        var value = cloaked ? 1 : 0;

        DwmSetWindowAttribute(window, DwmwaCloak, ref value, sizeof(int));
    }

    /// <summary>Turns off the animations Windows plays when the window opens, closes or is minimized.</summary>
    public static void NoTransitions(nint window)
    {
        var value = 1;

        DwmSetWindowAttribute(window, DwmwaTransitionsForceDisabled, ref value, sizeof(int));
    }

    [DllImport("shcore.dll")]
    public static extern int GetDpiForMonitor(nint monitor, int type, out uint dpiX, out uint dpiY);

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

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out System.Drawing.Point point);

    [DllImport("user32.dll")]
    public static extern bool GetClientRect(nint window, out Rect rect);

    [DllImport("user32.dll")]
    public static extern nint SendMessage(nint window, uint message, nint wParam, nint lParam);

    [DllImport("comctl32.dll")]
    public static extern nint DefSubclassProc(nint window, uint message, nint wParam, nint lParam);

    public const int SwMaximize = 3;
    public const int SwRestore = 9;
    public const uint GwOwner = 4;
    public const uint MonitorDefaultToPrimary = 1, MonitorDefaultToNearest = 2;
    public const uint SwpNoSize = 0x1, SwpNoMove = 0x2, SwpNoZOrder = 0x4, SwpNoActivate = 0x10;
    public const uint EventSystemForeground = 3, EventObjectDestroy = 0x8001, EventObjectNameChange = 0x800C, WinEventOutOfContext = 0;
    public const int ObjIdWindow = 0, ChildIdSelf = 0;
    public const uint AbmNew = 0, AbmRemove = 1, AbmQueryPos = 2, AbmSetPos = 3, AbmActivate = 6, AbmWindowPosChanged = 9;
    public const uint AbeLeft = 0, AbeRight = 2;
    public const int AbnPosChanged = 1, AbnFullScreenApp = 2;
    public const uint WmActivate = 0x0006, WmWindowPosChanging = 0x0046, WmWindowPosChanged = 0x0047, WmDisplayChange = 0x007E, WmSize = 0x0005, WmDpiChanged = 0x02E0;
    public const nint SizeRestored = 0;

    public static nint PrimaryMonitor() => MonitorFromPoint(new System.Drawing.Point(0, 0), MonitorDefaultToPrimary);

    /// <summary>A monitor's device name, such as <c>\\.\DISPLAY2</c>, which the dock keeps to dock there again.</summary>
    public static string MonitorName(nint monitor)
    {
        var info = new MonitorInfoEx { Size = Marshal.SizeOf<MonitorInfoEx>() };

        return GetMonitorInfoEx(monitor, ref info) ? info.Device : "";
    }

    /// <summary>The monitor with that device name, or the primary monitor when none has it, such as after it was unplugged.</summary>
    public static nint MonitorNamed(string? name)
    {
        nint found = 0;

        if (!string.IsNullOrEmpty(name))
        {
            EnumDisplayMonitors(0, 0, (monitor, _, _, _) =>
            {
                if (MonitorName(monitor) == name)
                {
                    found = monitor;
                    return false;
                }

                return true;
            }, 0);
        }

        return found == 0 ? PrimaryMonitor() : found;
    }

    public static PixelRect Pixels(Rect rect) => new(rect.Left, rect.Top, rect.Right, rect.Bottom);

    public static Rect RectOf(PixelRect rect) => new() { Left = rect.Left, Top = rect.Top, Right = rect.Right, Bottom = rect.Bottom };

    public static PixelRect Bounds(nint monitor)
    {
        var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };

        GetMonitorInfo(monitor, ref info);

        return new PixelRect(info.Monitor.Left, info.Monitor.Top, info.Monitor.Right, info.Monitor.Bottom);
    }

    /// <summary>The monitor's scale, such as 1.75 at 175%, from its effective DPI.</summary>
    public static double Scale(nint monitor) => GetDpiForMonitor(monitor, 0, out var dpi, out _) == 0 && dpi > 0 ? dpi / 96.0 : 1;

    public static string Title(nint window)
    {
        var text = new StringBuilder(1024);

        GetWindowText(window, text, text.Capacity);

        return text.ToString();
    }
}
