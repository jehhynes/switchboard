using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;

namespace Switchboard.PaneHelper;

/// <summary>
/// The Chrome pane's Win32 calls (mechanics M103) and its window events: moves and destructions in the page's Chrome process, and the
/// foreground anywhere. Its hooks call back on the thread that made them, the message loop's. Every call checks its result rather than assume it.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class Win32PaneNative : IPaneNative, IDisposable
{
    const uint EventObjectLocationChange = 0x800B;
    const int GwlpHwndParent = -8;
    const uint DwmwaExtendedFrameBounds = 9;
    const int SwHide = 0;
    const int SwShowNoActivate = 4;
    const uint SwpNoOwnerZOrder = 0x200;

    readonly string logPath;
    // Kept in fields so the delegates outlive every call Windows makes to them.
    readonly Native.WinEventProc foregroundProc;
    readonly Native.WinEventProc processProc;
    readonly nint foregroundHook;
    nint moveHook;
    nint destroyHook;
    uint watched;

    public event Action<nint>? Moved;
    public event Action<nint>? Destroyed;
    public event Action<nint>? Foreground;

    public Win32PaneNative(string switchboardHome)
    {
        logPath = Path.Combine(switchboardHome, "chrome-pane.log");
        foregroundProc = (_, _, window, _, _, _, _) => Foreground?.Invoke(window);
        processProc = (_, eventType, window, objectId, childId, _, _) =>
        {
            if (objectId != Native.ObjIdWindow || childId != Native.ChildIdSelf)
            {
                return;
            }

            (eventType == EventObjectLocationChange ? Moved : Destroyed)?.Invoke(window);
        };
        foregroundHook = Native.SetWinEventHook(Native.EventSystemForeground, Native.EventSystemForeground, 0, foregroundProc, 0, 0, Native.WinEventOutOfContext);
    }

    /// <summary>The top-level Chrome windows, front first, as the search compares them.</summary>
    static List<ChromeWindow> ChromeWindows()
    {
        var windows = new List<ChromeWindow>();

        Native.EnumWindows(
            (window, _) =>
            {
                if (ClassOf(window) == "Chrome_WidgetWin_1")
                {
                    windows.Add(new ChromeWindow(window, ProcessOf(window), Native.Title(window), Native.IsWindowVisible(window), Native.GetWindow(window, Native.GwOwner) != 0, AppUserModel.Of(window)));
                }

                return true;
            },
            0);

        return windows;
    }

    public nint FindPane(string marker)
    {
        var (pane, byTitle) = PaneTitles.PickPane(ChromeWindows(), marker);

        if (pane is not null && byTitle)
        {
            Log($"pane: took the pane window {pane.Handle:X} by its title \"{pane.Title}\", which lacks marker {marker}: the only one in the page's browser");
        }

        return pane?.Handle ?? 0;
    }

    public bool IsVisible(nint window) => Native.IsWindowVisible(window);

    public nint FindApp(string marker, nint pane)
    {
        var windows = ChromeWindows();
        var paneWindow = windows.FirstOrDefault((window) => window.Handle == pane);
        var page = PaneTitles.PickPage(windows, marker, paneWindow);

        if (page is not null && paneWindow is not null && !PaneTitles.PageMarked(page.Title, marker))
        {
            var count = PaneTitles.PageCandidates(windows, paneWindow);

            Log($"pane: took the page's window {page.Handle:X} by its title \"{page.Title}\", which lacks marker {marker}{(count > 1 ? $", the front one of {count}" : "")}");
        }

        return page?.Handle ?? 0;
    }

    static uint ProcessOf(nint window)
    {
        Native.GetWindowThreadProcessId(window, out var process);
        return process;
    }

    public string Survey(string marker)
    {
        var lines = new List<string>();
        var names = new Dictionary<uint, string>();

        string NameOf(uint process)
        {
            if (!names.TryGetValue(process, out var name))
            {
                try
                {
                    using var running = Process.GetProcessById((int)process);
                    name = running.ProcessName;
                }
                catch (Exception error) when (error is ArgumentException or InvalidOperationException)
                {
                    name = "?";
                }

                names[process] = name;
            }

            return name;
        }

        Native.EnumWindows(
            (window, _) =>
            {
                var title = Native.Title(window);
                var marked = title.Contains("[sb-pane ", StringComparison.Ordinal) || title.Contains("Switchboard pane", StringComparison.Ordinal);

                if (ClassOf(window) != "Chrome_WidgetWin_1" && !marked)
                {
                    return true;
                }

                // Titles name the operator's pages; only a marked one, or the page's app name, is written out.
                var process = ProcessOf(window);
                var shown = marked ? $"\"{title}\"" : $"{title.Length} chars";

                var named = PaneTitles.PageNamed(title) || PaneTitles.PaneAny(title);

                if (named)
                {
                    shown = $"\"{title}\"";
                }

                lines.Add($"{window:X} {NameOf(process)}#{process} {(Native.IsWindowVisible(window) ? "visible" : "hidden")}{(Native.GetWindow(window, Native.GwOwner) != 0 ? " owned" : "")} {ClassOf(window)} {shown}{(title.Contains(marker, StringComparison.Ordinal) ? " (this marker)" : "")} app id {AppUserModel.Of(window) ?? "none"}");
                return true;
            },
            0);

        return lines.Count == 0 ? "no Chrome windows" : $"windows: {string.Join("; ", lines)}";
    }

    static nint FindChrome(Func<nint, string, bool> test, bool visibleOnly = true)
    {
        nint found = 0;

        Native.EnumWindows(
            (window, _) =>
            {
                if ((!visibleOnly || Native.IsWindowVisible(window)) && ClassOf(window) == "Chrome_WidgetWin_1" && test(window, Native.Title(window)))
                {
                    found = window;
                    return false;
                }

                return true;
            },
            0);

        return found;
    }

    static string ClassOf(nint window)
    {
        var name = new StringBuilder(256);

        GetClassName(window, name, name.Capacity);
        return name.ToString();
    }

    public bool IsAlive(nint window) => window != 0 && IsWindow(window);

    public bool IsIconic(nint window) => Native.IsIconic(window);

    public bool IsZoomed(nint window) => Native.IsZoomed(window);

    public Box Frame(nint window) =>
        DwmGetWindowAttribute(window, DwmwaExtendedFrameBounds, out var rect, Marshal.SizeOf<Native.Rect>()) == 0 ? new Box(rect.Left, rect.Top, rect.Right, rect.Bottom) : Bounds(window);

    public Box Bounds(nint window) => Native.GetWindowRect(window, out var rect) ? new Box(rect.Left, rect.Top, rect.Right, rect.Bottom) : default;

    public bool Own(nint pane, nint owner)
    {
        SetWindowLongPtr(pane, GwlpHwndParent, owner);
        return Native.GetWindow(pane, Native.GwOwner) == owner;
    }

    public bool Raise(nint pane) => Native.SetWindowPos(pane, 0, 0, 0, 0, 0, Native.SwpNoMove | Native.SwpNoSize | Native.SwpNoActivate);

    public bool Resize(nint pane, int width, int height) => Native.SetWindowPos(pane, 0, 0, 0, width, height, Native.SwpNoMove | Native.SwpNoZOrder | Native.SwpNoActivate | SwpNoOwnerZOrder);

    public bool Move(nint pane, int left, int top) => Native.SetWindowPos(pane, 0, left, top, 0, 0, Native.SwpNoSize | Native.SwpNoZOrder | Native.SwpNoActivate | SwpNoOwnerZOrder);

    // DWM refuses to cloak another process's window (E_ACCESSDENIED, mechanics M103), so the pane is hidden and shown with ShowWindow.
    public bool Hide(nint pane, bool hidden)
    {
        Native.ShowWindow(pane, hidden ? SwHide : SwShowNoActivate);

        var done = Native.IsWindowVisible(pane) != hidden;

        if (!done)
        {
            Log($"pane: Windows did not {(hidden ? "hide" : "show")} {pane:X}");
        }

        return done;
    }

    public bool Transitions(nint pane, bool on)
    {
        var value = on ? 0 : 1;
        var result = Native.DwmSetWindowAttribute(pane, Native.DwmwaTransitionsForceDisabled, ref value, sizeof(int));

        if (result != 0)
        {
            Log($"pane: DWM refused to turn {(on ? "on" : "off")} the animations of {pane:X}: 0x{result:X8}");
        }

        return result == 0;
    }

    public void Restore(nint pane) => Native.ShowWindow(pane, SwShowNoActivate);

    public CompositorCheck CheckCompositor(nint pane)
    {
        var child = CompositorWindow(pane);

        if (child == 0)
        {
            return CompositorCheck.Missing;
        }

        if (Offset(pane, child) == 0)
        {
            return CompositorCheck.InPlace;
        }

        // A child's position is relative to its parent's client area, so 0,0 is where Chrome keeps it.
        Native.SetWindowPos(child, 0, 0, 0, 0, 0, Native.SwpNoSize | Native.SwpNoZOrder | Native.SwpNoActivate);

        return Offset(pane, child) == 0 ? CompositorCheck.Repaired : CompositorCheck.Failed;
    }

    static nint CompositorWindow(nint pane)
    {
        nint found = 0;

        EnumChildWindows(pane, (window, _) =>
        {
            if (ClassOf(window) == "Intermediate D3D Window")
            {
                found = window;
                return false;
            }

            return true;
        }, 0);

        return found;
    }

    static int Offset(nint pane, nint child)
    {
        var origin = new Native.Point();

        ClientToScreen(pane, ref origin);
        Native.GetWindowRect(child, out var rect);

        return Math.Abs(rect.Left - origin.X) + Math.Abs(rect.Top - origin.Y);
    }

    public void Watch(nint app)
    {
        Native.GetWindowThreadProcessId(app, out var process);

        if (process == watched)
        {
            return;
        }

        Unwatch();
        watched = process;
        moveHook = Native.SetWinEventHook(EventObjectLocationChange, EventObjectLocationChange, 0, processProc, process, 0, Native.WinEventOutOfContext);
        destroyHook = Native.SetWinEventHook(Native.EventObjectDestroy, Native.EventObjectDestroy, 0, processProc, process, 0, Native.WinEventOutOfContext);
    }

    void Unwatch()
    {
        foreach (var hook in new[] { moveHook, destroyHook })
        {
            if (hook != 0)
            {
                Native.UnhookWinEvent(hook);
            }
        }

        moveHook = destroyHook = 0;
        watched = 0;
    }

    /// <summary>Appends to <c>&lt;Switchboard home&gt;/chrome-pane.log</c>, which starts over past 1 MB.</summary>
    public void Log(string line)
    {
        try
        {
            if (File.Exists(logPath) && new FileInfo(logPath).Length > 1_000_000)
            {
                File.Delete(logPath);
            }

            File.AppendAllText(logPath, $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss.fff} {line}{Environment.NewLine}");
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            Debug.WriteLine(line);
        }
    }

    public void Dispose()
    {
        Unwatch();

        if (foregroundHook != 0)
        {
            Native.UnhookWinEvent(foregroundHook);
        }
    }

    [DllImport("user32.dll")]
    static extern bool IsWindow(nint window);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetClassName(nint window, StringBuilder name, int max);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    static extern nint SetWindowLongPtr(nint window, int index, nint value);

    [DllImport("user32.dll")]
    static extern bool EnumChildWindows(nint parent, Native.EnumProc callback, nint param);

    [DllImport("user32.dll")]
    static extern bool ClientToScreen(nint window, ref Native.Point point);

    [DllImport("dwmapi.dll")]
    static extern int DwmGetWindowAttribute(nint window, uint attribute, out Native.Rect value, int size);
}
