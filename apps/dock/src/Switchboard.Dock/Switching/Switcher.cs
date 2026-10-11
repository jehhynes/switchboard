using System.Text.Json.Nodes;
using Switchboard.Dock.Hub;

namespace Switchboard.Dock.Switching;

/// <summary>What a click on a row does (PRD R71): the session first, then the item window to the front, opened when it is not open.</summary>
public sealed class Switcher(IHub hub, IWindows windows, IVsCode vsCode, Func<TimeSpan, Task>? delay = null) : IDockActions
{
    /// <summary>How long Open in Claude or Codex waits for the stopped session to end; a stop itself times out at 15 seconds.</summary>
    public static readonly TimeSpan StopWait = TimeSpan.FromSeconds(20);

    /// <summary>How long a new item window may take to appear.</summary>
    public static readonly TimeSpan OpenWait = TimeSpan.FromSeconds(20);

    static readonly TimeSpan Poll = TimeSpan.FromMilliseconds(100);

    readonly Func<TimeSpan, Task> wait = delay ?? Task.Delay;

    // Stops under way by session ID, so a later click on the same question waits for the stop already sent instead of sending another.
    readonly Dictionary<string, Task<string?>> stopping = [];

    /// <summary>
    /// Runs the click; returns what to tell the operator when it did not finish, or null. A cancelled click, one a later click replaced, stops
    /// before its next request or switch and returns null.
    /// </summary>
    public async Task<string?> Click(DockRow row, CancellationToken cancel = default)
    {
        if (row.Window is not { } window)
        {
            return row.Open is { Type: "url", Url: { } url } ? OpenUrl(windows, url) : null;
        }

        if (FileOf(window) is not { } file)
        {
            return Older;
        }

        var open = row.Open;

        if (open is { Type: "question", WorkItemId: { } workItemId, SessionId: { } question })
        {
            if (!stopping.TryGetValue(question, out var stop))
            {
                stop = Stop(row.Key, workItemId, question, open.Provider == "codex" ? "Codex" : "Claude");
                stopping[question] = stop;
            }

            string? failed;

            try
            {
                failed = await stop;
            }
            finally
            {
                // A stop that already ended, even one that failed at once, leaves the next click free to send its own.
                if (stopping.TryGetValue(question, out var kept) && kept == stop)
                {
                    stopping.Remove(question);
                }
            }

            if (cancel.IsCancellationRequested)
            {
                return null;
            }

            if (failed is not null)
            {
                return failed;
            }

            open = open with { Type = "session" };
        }

        if (open is { Type: "session", SessionId: { } sessionId, Cwd: { } cwd } && await hub.Open(sessionId, cwd, file) is { } refused)
        {
            return cancel.IsCancellationRequested ? null : refused;
        }

        if (cancel.IsCancellationRequested)
        {
            return null;
        }

        var handle = windows.Find(window.Name);

        if (handle != 0)
        {
            return await Switch(window, file, handle, cancel);
        }

        // A window the click opens shows the ticket, its links and its report in tabs (PRD R72); a hub that refuses only leaves them out.
        var tabs = await hub.Window(new JsonObject { ["type"] = "openTabs" }, file);

        return await Withdrawn(tabs, cancel.IsCancellationRequested ? null : await Switch(window, file, handle, cancel), cancel);
    }

    /// <summary>Open in Claude's or Codex's stop (PRD R70): asks the hub to stop the session, then waits for the row to offer the ended session; returns why not, or null.</summary>
    async Task<string?> Stop(string rowKey, int workItemId, string sessionId, string agent)
    {
        if (await hub.Act(new JsonObject { ["type"] = "open-question", ["workItemId"] = workItemId, ["nativeSessionId"] = sessionId }) is { } refused)
        {
            return refused;
        }

        var ended = await hub.Until((view) => RowOf(view, rowKey)?.Open is { Type: "session" } next && next.SessionId == sessionId, StopWait);

        return ended is null ? $"The session did not stop within {StopWait.TotalSeconds:0} seconds, so it was not opened in {agent}." : null;
    }

    /// <summary>
    /// Runs a control in VS Code (PRD R71): the hub keeps the command for the row's item window, which is brought forward or opened and runs it
    /// when it gains focus; for no row, or a row without a window, the VS Code window nearest the front runs it. Returns why not, or null.
    /// </summary>
    public async Task<string?> Run(DockRow? row, JsonObject command, CancellationToken cancel = default)
    {
        if (row?.Window is { } window)
        {
            if (FileOf(window) is not { } file)
            {
                return Older;
            }

            var left = await hub.Window(command, file);

            if (left.Error is { } refused)
            {
                return cancel.IsCancellationRequested ? null : refused;
            }

            return await Withdrawn(left, cancel.IsCancellationRequested ? null : await Switch(window, file, windows.Find(window.Name), cancel), cancel);
        }

        var any = windows.FindVsCode();

        if (any == 0)
        {
            return "Open a VS Code window first; this runs in VS Code.";
        }

        var forAny = await hub.Window(command, null);

        if (forAny.Error is { } failed)
        {
            return cancel.IsCancellationRequested ? null : failed;
        }

        return await Withdrawn(forAny, cancel.IsCancellationRequested || windows.Show(any) ? null : "Windows kept another window in front. Try again.", cancel);
    }

    /// <summary>
    /// After a cancelled or failed switch, withdraws the command, so the window that comes to the front next does not run it; returns the failure,
    /// or null for a switch that worked or was cancelled.
    /// </summary>
    async Task<string?> Withdrawn(WindowReply left, string? failure, CancellationToken cancel)
    {
        if ((failure is not null || cancel.IsCancellationRequested) && left.Id is { } id)
        {
            await hub.Withdraw(id);
        }

        return cancel.IsCancellationRequested ? null : failure;
    }

    /// <summary>The bookmark the dock adds to a link that has none, which the Chrome extension's <c>TAB_BOOKMARK</c> also holds (PRD R74).</summary>
    public const string TabBookmark = "#switchboard-tab";

    /// <summary>The query parameter the dock adds to a link that has a bookmark, which the extension's <c>TAB_PARAMETER</c> also holds.</summary>
    public const string TabParameter = "switchboard-tab=1";

    /// <summary>The URL with <see cref="TabBookmark"/> added, or, when it has a bookmark, <see cref="TabParameter"/> last in its query before the unchanged bookmark.</summary>
    public static string Marked(string url)
    {
        var hash = url.IndexOf('#');

        if (hash == -1)
        {
            return url + TabBookmark;
        }

        var target = url[..hash];

        return target + (target.Contains('?') ? "&" : "?") + TabParameter + url[hash..];
    }

    /// <summary>Opens a URL in the browser, marked so the Chrome extension puts its tab in the Switchboard group; returns why it could not, or null.</summary>
    public string? OpenUrl(string url) => OpenUrl(windows, url);

    public static string? OpenUrl(IWindows windows, string url)
    {
        try
        {
            windows.OpenUrl(Marked(url));
            return null;
        }
        catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return $"The browser did not open {url}: {error.Message}";
        }
    }

    /// <summary>Brings the window forward, opening it from <paramref name="file"/> when <paramref name="handle"/> is 0 because it was not found.</summary>
    async Task<string?> Switch(DockWindow window, string file, nint handle, CancellationToken cancel)
    {
        if (handle == 0)
        {
            try
            {
                vsCode.Open(file);
            }
            catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception or FileNotFoundException)
            {
                return $"VS Code did not start: {error.Message}";
            }

            for (var waited = TimeSpan.Zero; handle == 0 && waited < OpenWait; waited += Poll)
            {
                await wait(Poll);

                if (cancel.IsCancellationRequested)
                {
                    return null;
                }

                handle = windows.Find(window.Name);
            }

            if (handle == 0)
            {
                return $"VS Code did not open the window for {window.Name} within {OpenWait.TotalSeconds:0} seconds.";
            }
        }

        return windows.Show(handle) ? null : "Windows kept another window in front. Click the row again.";
    }

    const string Older = "The hub names no workspace file for this window. Reload a VS Code window to update the hub.";

    /// <summary>The window's workspace file, which the hub writes before it sends the view (architecture.md § Dock).</summary>
    static string? FileOf(DockWindow window) => string.IsNullOrEmpty(window.File) ? null : window.File;

    public static DockRow? RowOf(DockView view, string key) => view.Groups.SelectMany((group) => group.Rows).FirstOrDefault((row) => row.Key == key);
}
