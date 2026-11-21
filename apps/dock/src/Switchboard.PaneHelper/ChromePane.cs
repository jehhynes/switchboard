using System.Text.Json.Nodes;

namespace Switchboard.PaneHelper;

/// <summary>What the compositor check found: Chrome's <c>Intermediate D3D Window</c> in place, put back, missing, or not put back.</summary>
public enum CompositorCheck
{
    InPlace,
    Repaired,
    Missing,
    Failed,
}

/// <summary>The Win32 calls the Chrome pane makes (mechanics M103), so its logic runs against a fake in tests.</summary>
public interface IPaneNative
{
    /// <summary>
    /// The Chrome window whose title holds <c>Switchboard pane &lt;marker&gt;</c>, the extension's pane window, visible or not, since a helper that
    /// stopped without letting go leaves it hidden; 0 for none.
    /// </summary>
    nint FindPane(string marker);

    /// <summary>
    /// The installed page's window, visible, unowned and not the pane: the one whose title holds <c>[sb-pane &lt;marker&gt;]</c>, or else, since
    /// Chrome titles an app window with the app's name rather than the page's title (mechanics M103), the front one of the pane's process titled
    /// with the page's app name; 0 for none.
    /// </summary>
    nint FindApp(string marker, nint pane);

    /// <summary>What a search saw, for the log: each Chrome window with its process and whether it is visible and owned, and its title only where it
    /// holds a pane marker.</summary>
    string Survey(string marker);

    bool IsAlive(nint window);

    bool IsVisible(nint window);

    bool IsIconic(nint window);

    bool IsZoomed(nint window);

    /// <summary>The visible frame (<c>DWMWA_EXTENDED_FRAME_BOUNDS</c>).</summary>
    Box Frame(nint window);

    /// <summary><c>GetWindowRect</c>, with the invisible borders.</summary>
    Box Bounds(nint window);

    /// <summary>Makes <paramref name="owner"/> the pane's owner, or none with 0; true when <c>GetWindow(GW_OWNER)</c> then says so.</summary>
    bool Own(nint pane, nint owner);

    /// <summary>Puts the pane at the top of the z-order without activating it.</summary>
    bool Raise(nint pane);

    bool Resize(nint pane, int width, int height);

    bool Move(nint pane, int left, int top);

    /// <summary>Hides the pane, keeping its place, or shows it again without activating it; true when it is then hidden or shown.</summary>
    bool Hide(nint pane, bool hidden);

    /// <summary>Restores a maximized pane without activating it.</summary>
    void Restore(nint pane);

    /// <summary>
    /// The accepted risk (mechanics M103): checks the pane's child <c>Intermediate D3D Window</c>, which Chrome's GPU process places, and moves it
    /// back to the client area's origin when it is offset. The only call that touches a window Chrome owns inside the pane.
    /// </summary>
    CompositorCheck CheckCompositor(nint pane);

    /// <summary>Starts reporting the process's window moves and destructions for the app's process.</summary>
    void Watch(nint app);

    void Log(string line);
}

/// <summary>
/// The Chrome pane (PRD R113, architecture.md § Pane helper): finds the installed page's window and the extension's pane window by the hub's marker,
/// makes the pane owned by the page's window, raises it once, keeps it on the page's right column with separate resize and move calls, settles
/// 300 ms after the last change with the compositor check, hides it, and lets it go on failure. Windows only; every call runs on
/// the helper's message loop thread, which delivers the window events.
/// </summary>
public sealed class ChromePane(IPaneNative native, Action<JsonObject> report, Func<TimeSpan, Action, IDisposable> after)
{
    /// <summary>How long after the last change the pane settles.</summary>
    public static readonly TimeSpan SettleDelay = TimeSpan.FromMilliseconds(300);
    /// <summary>
    /// The search for the windows: every 250 ms for the first 10 seconds, then every second up to a minute, since the extension's service worker
    /// may have to wake and Chrome to open the window before the pane window's title holds the marker.
    /// </summary>
    public static readonly TimeSpan SearchEvery = TimeSpan.FromMilliseconds(250);
    public const int SearchFastTries = 40;
    public static readonly TimeSpan SearchSlowEvery = TimeSpan.FromSeconds(1);
    public const int SearchTries = SearchFastTries + 50;
    /// <summary>Settles in a row whose compositor check fails before the pane is let go.</summary>
    public const int FailuresAllowed = 3;
    /// <summary>How much wider than the column the pane may stay, in pixels, before Chrome's minimum width counts as a failure.</summary>
    public const int WidthSlack = 2;

    string? marker;
    PaneRect? rect;
    nint app;
    nint pane;
    bool found;
    bool raised;
    bool hidden;
    bool focused;
    bool failed;
    string? reported;
    int failures;
    int tries;
    IDisposable? settle;
    IDisposable? search;

    public nint App => app;

    public nint Pane => pane;

    /// <summary>The hub's <c>pane</c> event.</summary>
    public void Order(PaneOrder order)
    {
        if (order.Marker != marker)
        {
            Release();
            marker = order.Marker;
            failed = false;
            tries = 0;
            rect = order.Rect;

            if (marker is not null)
            {
                Search();
            }

            return;
        }

        rect = order.Rect;
        Apply();
    }

    /// <summary>A window of the app's process moved or changed size.</summary>
    public void Moved(nint window)
    {
        if (!found || failed)
        {
            return;
        }

        if (window == app)
        {
            Align();
            Settle();
        }
        else if (window == pane)
        {
            Settle();
        }
    }

    /// <summary>A window was destroyed: the page's or the pane's means finding both again under a new marker.</summary>
    public void Destroyed(nint window)
    {
        if (found && (window == app || window == pane))
        {
            Lost();
        }
    }

    /// <summary>A window came to the front; the pane's foreground counts as the page's focus in the hub.</summary>
    public void Foreground(nint window)
    {
        var now = found && !failed && window == pane;

        if (now != focused)
        {
            focused = now;
            Report(hidden ? "hidden" : "shown", force: true);
        }
    }

    void Search()
    {
        search?.Dispose();
        search = null;

        if (marker is null || found)
        {
            return;
        }

        var foundPane = native.FindPane(marker);
        var foundApp = native.FindApp(marker, foundPane);

        if (foundApp == 0 || foundPane == 0)
        {
            ++tries;

            if (tries == SearchFastTries || tries >= SearchTries)
            {
                native.Log($"pane: looked {tries} times for marker {marker}: page's window {(foundApp == 0 ? "missing" : "found")}, pane window {(foundPane == 0 ? "missing" : "found")}; {native.Survey(marker)}");
            }

            if (tries >= SearchTries)
            {
                Fail(foundPane == 0
                    ? "Switchboard did not find the pane window the Chrome extension opens. Reload the page to try again."
                    : "Switchboard did not find the installed page's window. Reload the page to try again.");
            }
            else
            {
                search = after(tries < SearchFastTries ? SearchEvery : SearchSlowEvery, Search);
            }

            return;
        }

        app = foundApp;
        pane = foundPane;

        if (!native.Own(pane, app))
        {
            Fail("Windows did not let Switchboard attach the pane to the page's window.");
            return;
        }

        found = true;
        // A helper that crashed or was killed while the pane was hidden left it so; the next column shows it.
        hidden = !native.IsVisible(pane);
        native.Watch(app);
        native.Log($"pane found: app {app:X}, pane {pane:X}");
        Report("found", force: true);
        Apply();
    }

    void Apply()
    {
        if (!found || failed)
        {
            return;
        }

        if (!native.IsAlive(app) || !native.IsAlive(pane))
        {
            Lost();
            return;
        }

        if (rect is null)
        {
            if (!hidden)
            {
                if (!native.Hide(pane, true))
                {
                    Fail("Windows did not hide the pane.");
                    return;
                }

                hidden = true;
            }

            Report("hidden");
            return;
        }

        if (hidden)
        {
            if (!native.Hide(pane, false))
            {
                Fail("Windows did not show the pane again.");
                return;
            }

            hidden = false;
        }

        // Owning does not reorder windows: raised once, the pane then stays directly above the page's window. A refused raise is tried again.
        if (!raised)
        {
            raised = native.Raise(pane);

            if (!raised)
            {
                native.Log("pane: Windows did not raise the pane; trying again when it settles");
            }
        }

        Align();
        Report("shown");
        Settle();
    }

    /// <summary>Puts the pane on the column: resize, then move, never both in one call, which leaves Chrome's compositor window offset.</summary>
    bool Align()
    {
        if (!found || failed || rect is null || hidden || native.IsIconic(app) || native.IsIconic(pane))
        {
            return true;
        }

        if (native.IsZoomed(pane))
        {
            native.Restore(pane);
        }

        var bounds = native.Bounds(pane);
        var target = Target(bounds);
        var place = PaneGeometry.Placement(target, native.Frame(pane), bounds);
        var ok = true;

        if (place.Width != bounds.Width || place.Height != bounds.Height)
        {
            ok &= native.Resize(pane, place.Width, place.Height);
        }

        if (place.Left != bounds.Left || place.Top != bounds.Top)
        {
            ok &= native.Move(pane, place.Left, place.Top);
        }

        return ok;
    }

    /// <summary>Where the pane's visible frame goes now: the page's column, kept clear of the page window's right and bottom resize borders.</summary>
    Box Target(Box paneBounds)
    {
        var appFrame = native.Frame(app);

        return PaneGeometry.Inset(PaneGeometry.Column(appFrame, rect!), appFrame, native.Frame(pane), paneBounds, native.IsZoomed(app));
    }

    void Settle()
    {
        settle?.Dispose();
        settle = after(SettleDelay, Settled);
    }

    /// <summary>300 ms after the last change: align again, check the compositor window, and check that Chrome let the pane be as narrow as the column.</summary>
    void Settled()
    {
        settle = null;

        if (!found || failed || rect is null || hidden || native.IsIconic(app) || native.IsIconic(pane))
        {
            return;
        }

        if (!native.IsAlive(app) || !native.IsAlive(pane))
        {
            Lost();
            return;
        }

        // A raise Windows refused is tried again here, and three refusals in a row let the pane go.
        if (!raised)
        {
            raised = native.Raise(pane);

            if (!raised)
            {
                if (++failures >= FailuresAllowed)
                {
                    Fail("Windows did not put the pane above the page's window.");
                }
                else
                {
                    Settle();
                }

                return;
            }
        }

        var aligned = Align();
        var check = native.CheckCompositor(pane);

        if (check == CompositorCheck.Repaired)
        {
            native.Log("pane: moved Chrome's compositor window back into place");
        }

        if (!aligned || check is CompositorCheck.Missing or CompositorCheck.Failed)
        {
            native.Log(aligned ? $"pane: compositor window {check.ToString().ToLowerInvariant()}" : "pane: a move or resize failed");

            if (++failures >= FailuresAllowed)
            {
                Fail(aligned ? "Chrome's drawing surface could not be kept in place; this Chrome version may not support the pane." : "Windows refused to move or resize the pane.");
            }
            else
            {
                Settle();
            }

            return;
        }

        failures = 0;

        var target = Target(native.Bounds(pane));

        if (native.Frame(pane).Width > target.Width + WidthSlack)
        {
            Fail("The column is narrower than Chrome lets the pane be. Widen the window.");
        }
    }

    /// <summary>Stops gluing: the pane, when it still exists, is no longer owned and shows as a plain Chrome window.</summary>
    void Release()
    {
        settle?.Dispose();
        search?.Dispose();
        settle = search = null;

        if (pane != 0 && native.IsAlive(pane))
        {
            if (hidden)
            {
                native.Hide(pane, false);
            }

            native.Own(pane, 0);
        }

        app = pane = 0;
        found = raised = hidden = focused = false;
        failures = 0;
        reported = null;
    }

    void Lost()
    {
        native.Log("pane: the page's window or the pane window was destroyed");

        var lost = marker;

        Release();
        Send(new JsonObject { ["state"] = "lost", ["marker"] = lost });
    }

    void Fail(string reason)
    {
        native.Log($"pane failed: {reason}");

        var stopped = marker;

        Release();
        failed = true;
        Send(new JsonObject { ["state"] = "failed", ["marker"] = stopped, ["reason"] = reason });
    }

    void Report(string state, bool force = false)
    {
        var key = $"{state}/{focused}";

        if (!force && key == reported)
        {
            return;
        }

        reported = key;
        Send(new JsonObject { ["state"] = state, ["marker"] = marker, ["focused"] = focused });
    }

    void Send(JsonObject body)
    {
        try
        {
            report(body);
        }
        catch (Exception error)
        {
            native.Log($"pane: report failed: {error.Message}");
        }
    }
}
