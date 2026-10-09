using System.Text.Json.Nodes;
using Switchboard.Dock.Hub;

namespace Switchboard.Dock.Switching;

/// <summary>What a click on a row does (PRD R71): the session first, then the item window to the front, opened when it is not open.</summary>
public sealed class Switcher(string switchboardHome, IHub hub, IWindows windows, IVsCode vsCode, Func<TimeSpan, Task>? delay = null)
{
    /// <summary>How long Open in Claude waits for the stopped session to end; <c>claude stop</c> itself times out at 15 seconds.</summary>
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

        string file;

        try
        {
            file = WorkspaceFile.Write(switchboardHome, window);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return $"The workspace file for {window.Name} could not be written: {error.Message}";
        }

        var open = row.Open;

        if (open is { Type: "question", WorkItemId: { } workItemId, SessionId: { } question })
        {
            if (!stopping.TryGetValue(question, out var stop))
            {
                stop = Stop(row.Key, workItemId, question);
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

        return cancel.IsCancellationRequested ? null : await Switch(window, file, cancel);
    }

    /// <summary>Open in Claude's stop (PRD R70): asks the hub to stop the session, then waits for the row to offer the ended session; returns why not, or null.</summary>
    async Task<string?> Stop(string rowKey, int workItemId, string sessionId)
    {
        if (await hub.Act(new JsonObject { ["type"] = "open-question", ["workItemId"] = workItemId, ["nativeSessionId"] = sessionId }) is { } refused)
        {
            return refused;
        }

        var ended = await hub.Until((view) => RowOf(view, rowKey)?.Open is { Type: "session" } next && next.SessionId == sessionId, StopWait);

        return ended is null ? $"The session did not stop within {StopWait.TotalSeconds:0} seconds, so it was not opened in Claude." : null;
    }

    /// <summary>Opens a URL in the browser; returns why it could not, or null.</summary>
    public static string? OpenUrl(IWindows windows, string url)
    {
        try
        {
            windows.OpenUrl(url);
            return null;
        }
        catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return $"The browser did not open {url}: {error.Message}";
        }
    }

    async Task<string?> Switch(DockWindow window, string file, CancellationToken cancel)
    {
        var handle = windows.Find(window.TitlePrefix);

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

                handle = windows.Find(window.TitlePrefix);
            }

            if (handle == 0)
            {
                return $"VS Code did not open the window for {window.Name} within {OpenWait.TotalSeconds:0} seconds.";
            }
        }

        return windows.Show(handle) ? null : "Windows kept another window in front. Click the row again.";
    }

    public static DockRow? RowOf(DockView view, string key) => view.Groups.SelectMany((group) => group.Rows).FirstOrDefault((row) => row.Key == key);
}
