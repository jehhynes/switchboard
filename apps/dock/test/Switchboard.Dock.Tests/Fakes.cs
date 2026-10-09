using System.Text.Json.Nodes;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Switching;

namespace Switchboard.Dock.Tests;

/// <summary>Records each request; answers with the queued replies and fails on a request it has no reply for.</summary>
sealed class FakeHub : IHub
{
    public List<string> Calls { get; } = [];

    public Queue<string?> ActReplies { get; } = new();

    public string? OpenReply { get; set; }

    public DockView? Ended { get; set; }

    public Task<string?> Act(JsonObject action)
    {
        Calls.Add($"act {action.ToJsonString()}");

        return Task.FromResult(ActReplies.Count > 0 ? ActReplies.Dequeue() : throw new InvalidOperationException($"Unexpected action {action.ToJsonString()}"));
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
