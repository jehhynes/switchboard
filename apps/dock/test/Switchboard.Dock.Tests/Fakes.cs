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

/// <summary>The hub's config requests for the Settings window: answers from <see cref="Config"/> and the queued replies, and records each request.</summary>
sealed class FakeConfigHub : Switchboard.Dock.Settings.IConfigHub
{
    public JsonObject Config { get; set; } = SettingsConfigs.Basic();

    public List<string> Calls { get; } = [];

    /// <summary>Each check's errors; an empty queue answers no errors.</summary>
    public Queue<string[]> CheckReplies { get; } = new();

    /// <summary>When set, each check waits for the task this returns for it before answering.</summary>
    public Func<int, Task>? HoldCheck { get; set; }

    public Queue<string[]> SaveReplies { get; } = new();

    public string[] DeleteReply { get; set; } = [];

    /// <summary>When set, the next read answers with the config as it was when asked, once the task this returns ends.</summary>
    public Func<Task>? HoldRead { get; set; }

    public async Task<(Switchboard.Dock.Settings.EditorConfig? Config, string? Error)> ReadConfig()
    {
        Calls.Add("read");

        var config = Switchboard.Dock.Settings.EditorConfig.Parse(Config.DeepClone());

        if (HoldRead is { } hold)
        {
            HoldRead = null;
            await hold();
        }

        return (config, null);
    }

    public async Task<IReadOnlyList<string>?> CheckConfig(JsonObject body)
    {
        Calls.Add($"check {body.ToJsonString()}");

        var reply = CheckReplies.Count > 0 ? CheckReplies.Dequeue() : [];

        if (HoldCheck is not null)
        {
            await HoldCheck(Calls.Count((call) => call.StartsWith("check", StringComparison.Ordinal)));
        }

        return reply;
    }

    public Task<IReadOnlyList<string>> SaveConfig(JsonObject body)
    {
        Calls.Add($"save {body.ToJsonString()}");

        return Task.FromResult<IReadOnlyList<string>>(SaveReplies.Count > 0 ? SaveReplies.Dequeue() : []);
    }

    public Task<IReadOnlyList<string>> DeletePlaybook(string name, string version, string configDir)
    {
        Calls.Add($"delete {name} {version}");

        return Task.FromResult<IReadOnlyList<string>>(DeleteReply);
    }
}

/// <summary>Config replies as <c>POST /config/read</c> answers them.</summary>
static class SettingsConfigs
{
    public static JsonObject Playbook(string kind = "task", string template = "Do {{ticket.title}}.", params string[] reports) =>
        new()
        {
            ["description"] = "Build it",
            ["kind"] = kind,
            ["autoStart"] = false,
            ["requiresWorktree"] = false,
            ["permissionMode"] = null,
            ["model"] = null,
            ["workdir"] = "worktree",
            ["reports"] = new JsonArray(reports.Select((report) => (JsonNode)JsonValue.Create(report)).ToArray()),
            ["approvalSends"] = false,
            ["rates"] = false,
            ["template"] = template,
        };

    /// <summary>Settings with GitHub on and Zoho off, playbooks dev:develop, dev:review and triage:github, and dev:develop used by two open work items.</summary>
    public static JsonObject Basic() =>
        new()
        {
            ["settings"] = new JsonObject
            {
                ["path"] = "C:/cfg/settings.json",
                ["version"] = "v1",
                ["value"] = new JsonObject
                {
                    ["sessions"] = new JsonObject { ["concurrency"] = 2 },
                    ["sources"] = new JsonObject { ["github"] = new JsonObject { ["enabled"] = true, ["repo"] = "acme/widgets" }, ["zoho"] = new JsonObject { ["enabled"] = false } },
                },
                ["error"] = null,
            },
            ["playbooks"] = new JsonArray(
                new JsonObject { ["name"] = "dev:develop", ["path"] = "C:/cfg/playbooks/dev/develop.md", ["version"] = "p1", ["playbook"] = Playbook(reports: ["done"]), ["error"] = null },
                new JsonObject { ["name"] = "dev:review", ["path"] = "C:/cfg/playbooks/dev/review.md", ["version"] = "p2", ["playbook"] = Playbook(), ["error"] = null },
                new JsonObject { ["name"] = "triage:github", ["path"] = "C:/cfg/playbooks/triage/github.md", ["version"] = "p3", ["playbook"] = Playbook("triage", "Choose."), ["error"] = null }),
            ["permissionModes"] = new JsonArray("acceptEdits", "auto", "plan"),
            ["templateVariables"] = new JsonArray("ticket.title", "report"),
            ["sourceKinds"] = new JsonArray("github", "zoho", "forum"),
            ["inUse"] = new JsonObject { ["dev:develop"] = 2 },
            ["configDir"] = "C:/cfg",
        };

    public static Switchboard.Dock.Settings.EditorState State(JsonObject? config = null) => new(Switchboard.Dock.Settings.EditorConfig.Parse(config ?? Basic()));
}
