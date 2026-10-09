using System.Text.Json.Nodes;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Switching;

namespace Switchboard.Dock.Tests;

/// <summary>Records each request; answers with the queued replies and fails on a request it has no reply for.</summary>
sealed class FakeHub : IHub
{
    public List<string> Calls { get; } = [];

    public Queue<string?> ActReplies { get; } = new();

    /// <summary>When set, each action waits for it before answering.</summary>
    public TaskCompletionSource? HoldAct { get; set; }

    public string? OpenReply { get; set; }

    public DockView? Ended { get; set; }

    public async Task<string?> Act(JsonObject action)
    {
        Calls.Add($"act {action.ToJsonString()}");

        var reply = ActReplies.Count > 0 ? ActReplies.Dequeue() : throw new InvalidOperationException($"Unexpected action {action.ToJsonString()}");

        if (HoldAct is not null)
        {
            await HoldAct.Task;
        }

        return reply;
    }

    public string? WindowReply { get; set; }

    public Task<WindowReply> Window(JsonObject command, string? workspace)
    {
        Calls.Add($"window {(workspace is null ? "any" : Path.GetFileName(workspace))} {command.ToJsonString()}");

        return Task.FromResult(WindowReply is null ? new WindowReply(null, 40 + Calls.Count) : new WindowReply(WindowReply, null));
    }

    public Task<string?> Withdraw(int id)
    {
        Calls.Add($"withdraw {id}");

        return Task.FromResult<string?>(null);
    }

    public Task<string?> SetSource(string name, bool enabled)
    {
        Calls.Add($"source {name} {enabled}");

        return Task.FromResult<string?>(null);
    }

    public Task<string?> Open(string sessionId, string cwd, string workspace)
    {
        Calls.Add($"open {sessionId} {cwd} {Path.GetFileName(workspace)}");

        return Task.FromResult(OpenReply);
    }

    /// <summary>Runs while <see cref="Until"/> waits, as another click would.</summary>
    public Action? OnUntil { get; set; }

    /// <summary>When set, <see cref="Until"/> waits for it before answering.</summary>
    public TaskCompletionSource? HoldUntil { get; set; }

    public async Task<DockView?> Until(Func<DockView, bool> test, TimeSpan within)
    {
        Calls.Add($"until {within.TotalSeconds}s");
        OnUntil?.Invoke();

        if (HoldUntil is not null)
        {
            await HoldUntil.Task;
        }

        return Ended is { } view && test(view) ? view : null;
    }
}

sealed class FakeWindows : IWindows
{
    public List<string> Calls { get; } = [];

    /// <summary>The window each title prefix finds, appearing after that many finds.</summary>
    public Dictionary<string, (nint Window, int After)> Open { get; } = [];

    public bool Front { get; set; } = true;

    public Exception? UrlFails { get; set; }

    readonly Dictionary<string, int> finds = [];

    public nint Find(string titlePrefix)
    {
        finds[titlePrefix] = finds.GetValueOrDefault(titlePrefix) + 1;

        return Open.TryGetValue(titlePrefix, out var found) && finds[titlePrefix] > found.After ? found.Window : 0;
    }

    public int Finds(string titlePrefix) => finds.GetValueOrDefault(titlePrefix);

    /// <summary>The VS Code window nearest the front, or 0 for none.</summary>
    public nint Front0 { get; set; }

    public nint FindVsCode() => Front0;

    public bool Show(nint window)
    {
        Calls.Add($"show {window}");

        return Front;
    }

    public void OpenUrl(string url)
    {
        Calls.Add($"url {url}");

        if (UrlFails is not null)
        {
            throw UrlFails;
        }
    }
}

sealed class FakeVsCode : IVsCode
{
    public Exception? Fails { get; set; }

    public List<string> Calls { get; } = [];

    public void Open(string workspaceFile)
    {
        Calls.Add($"open {Path.GetFileName(workspaceFile)}");

        if (Fails is not null)
        {
            throw Fails;
        }
    }
}

/// <summary>Records what the dock asked to run, and answers with the given replies.</summary>
sealed class FakeActions : IDockActions
{
    public List<DockRow> Clicked { get; } = [];

    public List<CancellationToken> Cancels { get; } = [];

    public List<string> Runs { get; } = [];

    public List<string> Urls { get; } = [];

    public string? ClickReply { get; set; }

    public string? RunReply { get; set; }

    public string? UrlReply { get; set; }

    /// <summary>When set, the first click waits for it.</summary>
    public TaskCompletionSource<string?>? Pending { get; set; }

    public Task<string?> Click(DockRow row, CancellationToken cancel)
    {
        Clicked.Add(row);
        Cancels.Add(cancel);

        return Pending is { } first && Clicked.Count == 1 ? first.Task : Task.FromResult(ClickReply);
    }

    public List<CancellationToken> RunCancels { get; } = [];

    public Task<string?> Run(DockRow? row, JsonObject command, CancellationToken cancel)
    {
        Runs.Add($"{row?.Key ?? "none"} {command.ToJsonString()}");
        RunCancels.Add(cancel);

        return Task.FromResult(RunReply);
    }

    public string? OpenUrl(string url)
    {
        Urls.Add(url);

        return UrlReply;
    }
}
