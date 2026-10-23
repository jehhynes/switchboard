using System.Text.Json.Nodes;
using Switchboard.Dock.Hub;

namespace Switchboard.Dock.Switching;

/// <summary>
/// What a click on a row does (PRD R71): the session first, then the item window to the front, opened when it is not open; with
/// <c>dock.openVSCode: review</c>, a session's terminal instead until its work is on review.
/// </summary>
public sealed class Switcher(IHub hub, IWindows windows, IVsCode vsCode, Func<TimeSpan, Task>? delay = null, ITerminal? terminal = null) : IDockActions
{
    /// <summary>How long Open in Claude or Codex waits for the stopped session to end; a stop itself times out at 15 seconds.</summary>
    public static readonly TimeSpan StopWait = TimeSpan.FromSeconds(20);

    /// <summary>How long a new item window may take to appear.</summary>
    public static readonly TimeSpan OpenWait = TimeSpan.FromSeconds(20);

    static readonly TimeSpan Poll = TimeSpan.FromMilliseconds(100);

    readonly Func<TimeSpan, Task> wait = delay ?? Task.Delay;

    // Stops under way by session ID, so a later click on the same question waits for the stop already sent instead of sending another.
    readonly Dictionary<string, Task<Stopped>> stopping = [];

    /// <summary>A stop's failure, or the row once its open offers the ended session.</summary>
    readonly record struct Stopped(string? Failure, DockRow? Row);

    /// <summary>
    /// Runs the click; returns what to tell the operator when it did not finish, or null. A cancelled click, one a later click replaced, stops
    /// before its next request or switch and returns null.
    /// </summary>
    public async Task<string?> Click(DockRow row, CancellationToken cancel = default)
    {
        switch (row.Open)
        {
            case { Type: "select" }:
                return null;
            case { Type: "terminal" } asked:
                return asked.Terminal is { } shown ? await Terminal(row, shown, cancel) : Older;
            // With dock.openVSCode: review, a row with a window but nothing to open in it yet opens its focus (PRD R71, R79).
            case { Type: "url", Url: { } url } when row.Window is not null:
                return OpenUrl(windows, url);
        }

        if (row.Window is not { } window)
        {
            return row.Open is { Type: "url", Url: { } url } ? OpenUrl(windows, url) : null;
        }

        // Checked before a question's stop, so a session is not stopped for a window the dock cannot open.
        if (FileOf(window) is null)
        {
            return Older;
        }

        var open = row.Open;

        if (open is { Type: "question", WorkItemId: { } workItemId, SessionId: { } question })
        {
            var stopped = await Stop(row.Key, workItemId, question, open.Provider == "codex" ? "Codex" : "Claude");

            if (cancel.IsCancellationRequested)
            {
                return null;
            }

            if (stopped.Failure is { } failed)
            {
                return failed;
            }

            open = open with { Type = "session" };
        }

        return await ItemWindow(window, open, cancel);
    }

    /// <summary>Leaves the session to open for the item window, then brings the window forward or opens it; returns why not, or null.</summary>
    async Task<string?> ItemWindow(DockWindow window, DockOpen? open, CancellationToken cancel)
    {
        if (FileOf(window) is not { } file)
        {
            return Older;
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
            return await BringForward(window, handle, cancel);
        }

        // A window the click opens shows the ticket, its links and its report in tabs (PRD R72); a hub that refuses only leaves them out.
        var tabs = await hub.Window(new JsonObject { ["type"] = "openTabs" }, file);
        var failure = cancel.IsCancellationRequested ? null : Launch(file);

        if (cancel.IsCancellationRequested || failure is not null)
        {
            return await Withdrawn(tabs, failure, cancel);
        }

        // VS Code has started, so the window it opens claims the tabs, even when a later click replaces this one or it appears after the wait.
        return await BringForward(window, handle, cancel);
    }

    /// <summary>
    /// Brings the session's terminal forward, or opens it (PRD R28, R71): after Open in Codex's stop for a Codex question, with the terminal the
    /// row then offers; a session resumed elsewhere whose terminal is not found shows in its item window instead, so it is never resumed twice.
    /// Returns why not, or null.
    /// </summary>
    public async Task<string?> Terminal(DockRow row, DockTerminal shown, CancellationToken cancel = default)
    {
        if (!windows.FindsTerminals || terminal is null)
        {
            return NoTerminals;
        }

        if (shown.Handoff is { } handoff)
        {
            var stopped = await Stop(row.Key, handoff.WorkItemId, handoff.SessionId, "Codex");

            if (cancel.IsCancellationRequested)
            {
                return null;
            }

            if (stopped.Failure is { } failed)
            {
                return failed;
            }

            // Work that awaits approval opens its item window once the session stopped, and keeps the terminal in its menu.
            if ((stopped.Row?.Open?.Terminal ?? stopped.Row?.Terminal) is not { Handoff: null } next || next.SessionId != shown.SessionId)
            {
                return $"The session stopped, but its row offers no terminal for {shown.Name}.";
            }

            shown = next;
        }

        var handle = windows.FindTerminal(shown.Name);

        if (handle != 0)
        {
            return windows.Show(handle) ? null : "Windows kept another window in front. Click the row again.";
        }

        if (shown.Active)
        {
            return row.Window is { } window
                ? await ItemWindow(window, new DockOpen("session", null, shown.SessionId, shown.Cwd, null, shown.Provider), cancel)
                : "The session runs in a window the dock cannot find.";
        }

        // A terminal still opening, such as for a click another click replaced, is waited for rather than opened twice.
        if (launching.TryGetValue(shown.Name, out var launch) && launch.IsCompleted)
        {
            launching.Remove(shown.Name);
            launch = null;
        }

        if (launch is null)
        {
            try
            {
                terminal.Open(shown);
            }
            catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception or IOException)
            {
                return $"The terminal did not start: {error.Message}";
            }

            launch = Appeared(shown.Name);
            launching[shown.Name] = launch;
        }

        await Task.WhenAny(launch, Task.Delay(Timeout.Infinite, cancel));

        if (cancel.IsCancellationRequested)
        {
            return null;
        }

        launching.Remove(shown.Name);
        handle = await launch;

        if (handle == 0)
        {
            return $"The terminal for {shown.Name} did not open within {OpenWait.TotalSeconds:0} seconds.";
        }

        return windows.Show(handle) ? null : "Windows kept another window in front. Click the row again.";
    }

    // Terminals opened and not yet found, by name.
    readonly Dictionary<string, Task<nint>> launching = [];

    /// <summary>The terminal window once it appears, looking every 100 ms for 20 seconds whatever happens to the click; 0 when it does not.</summary>
    async Task<nint> Appeared(string name)
    {
        nint handle = 0;

        for (var waited = TimeSpan.Zero; handle == 0 && waited < OpenWait; waited += Poll)
        {
            await wait(Poll);
            handle = windows.FindTerminal(name);
        }

        return handle;
    }

    const string NoTerminals = "Opening terminals needs Switchboard's GNOME Shell extension.";

    /// <summary>
    /// Open in Claude's or Codex's stop (PRD R70), shared by the clicks on one question: asks the hub to stop the session, then waits for the row to
    /// offer the ended session, in its item window or, with <c>dock.openVSCode: review</c>, in a terminal.
    /// </summary>
    async Task<Stopped> Stop(string rowKey, int workItemId, string sessionId, string agent)
    {
        if (!stopping.TryGetValue(sessionId, out var stop))
        {
            stop = Stopping(rowKey, workItemId, sessionId, agent);
            stopping[sessionId] = stop;
        }

        try
        {
            return await stop;
        }
        finally
        {
            // A stop that already ended, even one that failed at once, leaves the next click free to send its own.
            if (stopping.TryGetValue(sessionId, out var kept) && kept == stop)
            {
                stopping.Remove(sessionId);
            }
        }
    }

    async Task<Stopped> Stopping(string rowKey, int workItemId, string sessionId, string agent)
    {
        if (await hub.Act(new JsonObject { ["type"] = "open-question", ["workItemId"] = workItemId, ["nativeSessionId"] = sessionId }) is { } refused)
        {
            return new Stopped(refused, null);
        }

        var ended = await hub.Until((view) => Offers(RowOf(view, rowKey)?.Open, sessionId), StopWait);

        return ended is null ? new Stopped($"The session did not stop within {StopWait.TotalSeconds:0} seconds, so it was not opened in {agent}.", null) : new Stopped(null, RowOf(ended, rowKey));
    }

    /// <summary>Whether a row's open offers the ended session: in its item window, or in a terminal with no stop left to run.</summary>
    static bool Offers(DockOpen? open, string sessionId) => open?.SessionId == sessionId && (open.Type == "session" || open is { Type: "terminal", Handoff: null });

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

            var handle = windows.Find(window.Name);
            // A window the command opens shows its tabs, as one a click opens does (PRD R72).
            var tabs = handle == 0 ? await hub.Window(new JsonObject { ["type"] = "openTabs" }, file) : null;

            if (tabs is not null && cancel.IsCancellationRequested)
            {
                return await Withdrawn(tabs, null, cancel);
            }

            var left = await hub.Window(command, file);

            if (left.Error is { } refused)
            {
                if (tabs is not null)
                {
                    await Withdrawn(tabs, refused, cancel);
                }

                return cancel.IsCancellationRequested ? null : refused;
            }

            var failure = cancel.IsCancellationRequested || handle != 0 ? null : Launch(file);

            if (cancel.IsCancellationRequested || failure is not null)
            {
                if (tabs is not null)
                {
                    await Withdrawn(tabs, failure, cancel);
                }

                return await Withdrawn(left, failure, cancel);
            }

            // Once VS Code has started, the window it opens claims the tabs, as in a click; only the command is the control's to withdraw.
            return await Withdrawn(left, await BringForward(window, handle, cancel), cancel);
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

        // The command stays for the next VS Code window that gains focus, which the operator brings forward.
        if (!windows.Raises)
        {
            return cancel.IsCancellationRequested ? await Withdrawn(forAny, null, cancel) : "Switch to a VS Code window to run it.";
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

    /// <summary>Starts VS Code on the workspace file; returns why it did not start, or null.</summary>
    string? Launch(string file)
    {
        try
        {
            vsCode.Open(file);
            return null;
        }
        catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception or FileNotFoundException)
        {
            return $"VS Code did not start: {error.Message}";
        }
    }

    /// <summary>Brings the window forward, waiting for it to appear when <paramref name="handle"/> is 0 because VS Code is opening it.</summary>
    async Task<string?> BringForward(DockWindow window, nint handle, CancellationToken cancel)
    {
        if (handle == 0)
        {
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

        try
        {
            return windows.Show(handle) ? null : "Windows kept another window in front. Click the row again.";
        }
        catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception or FileNotFoundException)
        {
            return $"VS Code did not start: {error.Message}";
        }
    }

    const string Older = "The hub names no workspace file for this window. Reload a VS Code window to update the hub.";

    /// <summary>The window's workspace file, which the hub writes before it sends the view (architecture.md § Dock).</summary>
    static string? FileOf(DockWindow window) => string.IsNullOrEmpty(window.File) ? null : window.File;

    public static DockRow? RowOf(DockView view, string key) => view.Groups.SelectMany((group) => group.Rows).FirstOrDefault((row) => row.Key == key);
}
