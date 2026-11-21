using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;

namespace Switchboard.PaneHelper;

/// <summary>The Win32 calls the pane and its message loop share.</summary>
[SupportedOSPlatform("windows")]
static class Native
{
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect
    {
        public int Left, Top, Right, Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct Point
    {
        public int X, Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct Message
    {
        public nint Window;
        public uint Id;
        public nint WParam;
        public nint LParam;
        public uint Time;
        public Point Cursor;
        public uint Private;
    }

    public delegate bool EnumProc(nint window, nint param);

    public delegate void WinEventProc(nint hook, uint eventType, nint window, int objectId, int childId, uint thread, uint time);

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
    public static extern bool GetWindowRect(nint window, out Rect rect);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(nint window, nint after, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll")]
    public static extern nint SetWinEventHook(uint eventMin, uint eventMax, nint module, WinEventProc proc, uint process, uint thread, uint flags);

    [DllImport("user32.dll")]
    public static extern bool UnhookWinEvent(nint hook);

    [DllImport("user32.dll")]
    public static extern int GetMessage(out Message message, nint window, uint min, uint max);

    [DllImport("user32.dll")]
    public static extern bool PeekMessage(out Message message, nint window, uint min, uint max, uint remove);

    [DllImport("user32.dll")]
    public static extern bool TranslateMessage(ref Message message);

    [DllImport("user32.dll")]
    public static extern nint DispatchMessage(ref Message message);

    [DllImport("user32.dll")]
    public static extern bool PostThreadMessage(uint thread, uint message, nint wParam, nint lParam);

    [DllImport("user32.dll")]
    public static extern void PostQuitMessage(int code);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    public const uint GwOwner = 4;
    public const uint SwpNoSize = 0x1, SwpNoMove = 0x2, SwpNoZOrder = 0x4, SwpNoActivate = 0x10;
    public const uint EventSystemForeground = 3, EventObjectDestroy = 0x8001, WinEventOutOfContext = 0;
    public const int ObjIdWindow = 0, ChildIdSelf = 0;
    public const uint WmApp = 0x8000, PmNoRemove = 0;

    public static string Title(nint window)
    {
        var text = new StringBuilder(1024);

        GetWindowText(window, text, text.Capacity);

        return text.ToString();
    }
}
