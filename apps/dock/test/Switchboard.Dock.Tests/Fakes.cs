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

    /// <summary>The window found for each window name, appearing after that many finds.</summary>
    public Dictionary<string, (nint Window, int After)> Open { get; } = [];

    public bool Front { get; set; } = true;

    public Exception? UrlFails { get; set; }

    readonly Dictionary<string, int> finds = [];

    public nint Find(string name)
    {
        finds[name] = finds.GetValueOrDefault(name) + 1;

        return Open.TryGetValue(name, out var found) && finds[name] > found.After ? found.Window : 0;
    }

    public int Finds(string name) => finds.GetValueOrDefault(name);

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

    /// <summary>Each save's refusal; an empty queue, or an empty entry, saves.</summary>
    public Queue<string[]> SaveReplies { get; } = new();

    /// <summary>When set, the next read answers with the config as it was when asked, once the task this returns ends.</summary>
    public Func<Task>? HoldRead { get; set; }

    public IEnumerable<string> Saves => Calls.Where((call) => call.StartsWith("save", StringComparison.Ordinal));

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

    /// <summary>When set, checks get no answer, as when the hub stopped.</summary>
    public bool Silent { get; set; }

    public async Task<IReadOnlyList<string>?> CheckConfig(JsonObject settings)
    {
        Calls.Add($"check {settings.ToJsonString()}");

        if (Silent)
        {
            return null;
        }

        var reply = CheckReplies.Count > 0 ? CheckReplies.Dequeue() : [];

        if (HoldCheck is not null)
        {
            await HoldCheck(Calls.Count((call) => call.StartsWith("check", StringComparison.Ordinal)));
        }

        return reply;
    }

    /// <summary>When set, each save waits for the task this returns before answering.</summary>
    public Func<Task>? HoldSave { get; set; }

    int saves;

    /// <summary>
    /// Refuses with the next <see cref="SaveReplies"/> entry, or as the hub does when settings.json is no longer at the version sent; else writes
    /// the value into <see cref="Config"/> under a new version <c>s&lt;n&gt;</c>.
    /// </summary>
    public async Task<Switchboard.Dock.Settings.SaveReply> SaveConfig(JsonObject value, string? version, string configDir)
    {
        Calls.Add($"save {new JsonObject { ["value"] = value.DeepClone(), ["version"] = version, ["configDir"] = configDir }.ToJsonString()}");

        if (HoldSave is { } hold)
        {
            await hold();
        }

        if (SaveReplies.Count > 0 && SaveReplies.Dequeue() is { Length: > 0 } errors)
        {
            return new(errors, null);
        }

        if (version != Config["settings"]!["version"]?.GetValue<string>())
        {
            return new(["settings.json changed on disk after the editor read it. Discard to load it."], null);
        }

        var written = $"s{++saves}";

        Config["settings"]!["value"] = value.DeepClone();
        Config["settings"]!["version"] = written;

        return new([], written);
    }
}

/// <summary>Config replies as <c>POST /config/read</c> answers them.</summary>
static class SettingsConfigs
{
    /// <summary>A task playbook entry as the window writes it, or a triage one.</summary>
    public static JsonObject Playbook(string kind = "task", string template = "Do {{ticket.title}}.", params string[] reports)
    {
        var entry = new JsonObject { ["description"] = "Build it" };

        if (kind == "task")
        {
            entry["autoStart"] = false;
            entry["requiresWorktree"] = false;
        }
        else
        {
            entry["kind"] = kind;
        }

        if (reports.Length > 0)
        {
            entry["reports"] = new JsonArray(reports.Select((report) => (JsonNode)JsonValue.Create(report)).ToArray());
        }

        entry["template"] = template;

        return entry;
    }

    /// <summary>Settings with GitHub on and Zoho off in the hub's stored state, playbooks dev:develop, dev:review and triage:github, and dev:develop used by two open work items.</summary>
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
                    ["sources"] = new JsonObject { ["github"] = new JsonObject { ["repo"] = "acme/widgets" }, ["zoho"] = new JsonObject() },
                    ["playbooks"] = new JsonObject
                    {
                        ["dev:develop"] = Playbook(reports: ["done"]),
                        ["dev:review"] = Playbook(),
                        ["triage:github"] = Playbook("triage", "Choose."),
                    },
                },
                ["error"] = null,
            },
            ["permissionModes"] = new JsonArray("acceptEdits", "auto", "plan"),
            ["templateVariables"] = new JsonArray("ticket.title", "report"),
            ["sourceKinds"] = new JsonArray("github", "zoho", "forum"),
            ["inUse"] = new JsonObject { ["dev:develop"] = 2 },
            ["enabled"] = new JsonObject { ["github"] = true, ["zoho"] = false },
            ["configDir"] = "C:/cfg",
        };

    /// <summary>The settings.json value of a config reply.</summary>
    public static JsonObject Value(JsonObject config) => config["settings"]!["value"]!.AsObject();

    public static Switchboard.Dock.Settings.EditorState State(JsonObject? config = null) => new(Switchboard.Dock.Settings.EditorConfig.Parse(config ?? Basic()));
}
