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

    /// <summary>A command type the hub refuses with "Refused.", while it leaves the others.</summary>
    public string? RefuseCommand { get; set; }

    /// <summary>Runs when the hub receives a window command, such as to cancel the click that sent it.</summary>
    public Action<JsonObject>? OnWindow { get; set; }

    public Task<WindowReply> Window(JsonObject command, string? workspace)
    {
        Calls.Add($"window {(workspace is null ? "any" : Paths.FileName(workspace))} {command.ToJsonString()}");
        OnWindow?.Invoke(command);

        if (RefuseCommand is not null && command["type"]?.GetValue<string>() == RefuseCommand)
        {
            return Task.FromResult(new WindowReply("Refused.", null));
        }

        return Task.FromResult(WindowReply is null ? new WindowReply(null, 40 + Calls.Count) : new WindowReply(WindowReply, null));
    }

    public Task<string?> Withdraw(int id)
    {
        Calls.Add($"withdraw {id}");

        return Task.FromResult<string?>(null);
    }

    /// <summary>The answer to each source toggle; null accepts it.</summary>
    public string? SourceReply { get; set; }

    public Task<string?> SetSource(string name, bool enabled)
    {
        Calls.Add($"source {name} {enabled}");

        return Task.FromResult(SourceReply);
    }

    public string? PollReply { get; set; }

    public Task<string?> Poll()
    {
        Calls.Add("poll");

        return Task.FromResult(PollReply);
    }

    public Task<string?> Open(string sessionId, string cwd, string workspace)
    {
        Calls.Add($"open {sessionId} {cwd} {Paths.FileName(workspace)}");

        return Task.FromResult(OpenReply);
    }

    public string? StopReply { get; set; }

    public Task<string?> StopHeld(string session)
    {
        Calls.Add($"stop held {session}");

        return Task.FromResult(StopReply);
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

static class Paths
{
    /// <summary>The file name in a path with either separator, because the recorded paths are Windows paths and the tests also run on Linux.</summary>
    public static string FileName(string path) => path[(path.LastIndexOfAny(['\\', '/']) + 1)..];
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

    public bool FindsTerminals { get; set; } = true;

    /// <summary>The terminal window found for each terminal name, appearing after that many finds.</summary>
    public Dictionary<string, (nint Window, int After)> Terminals { get; } = [];

    readonly Dictionary<string, int> terminalFinds = [];

    public nint FindTerminal(string name)
    {
        terminalFinds[name] = terminalFinds.GetValueOrDefault(name) + 1;

        return Terminals.TryGetValue(name, out var found) && terminalFinds[name] > found.After ? found.Window : 0;
    }

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

/// <summary>The GNOME Shell extension's windows, front first; a failing shell throws as a missing service does.</summary>
sealed class FakeShell : Switchboard.Dock.Platform.IShell
{
    public List<Switchboard.Dock.Platform.ShellWindow> Open { get; } = [];

    public List<string> Calls { get; } = [];

    public bool Fails { get; set; }

    public IReadOnlyList<Switchboard.Dock.Platform.ShellWindow> Windows() => Fails ? throw new Switchboard.Dock.Platform.ShellException("The name switchboard.Shell was not provided.") : Open;

    public bool Activate(ulong id, string monitor)
    {
        Calls.Add(monitor == "" ? $"activate {id}" : $"activate {id} on {monitor}");

        return Fails ? throw new Switchboard.Dock.Platform.ShellException("The name switchboard.Shell was not provided.") : Open.Concat(Terms ?? []).Any((window) => window.Id == id);
    }

    /// <summary>Whether the extension has <c>OpenUrl</c>; an older one throws.</summary>
    public bool OpensUrls { get; set; } = true;

    /// <summary>Whether <c>OpenUrl</c> gets no answer in time.</summary>
    public bool TimesOut { get; set; }

    public bool OpenUrl(string url)
    {
        Calls.Add($"url {url}");

        if (TimesOut)
        {
            throw new Switchboard.Dock.Platform.ShellTimeoutException("GNOME Shell did not answer within 2 seconds.");
        }

        return Fails || !OpensUrls ? throw new Switchboard.Dock.Platform.ShellException("No such method “OpenUrl”.") : url.StartsWith("https://");
    }

    public IReadOnlyList<string> FullScreen() => [];

    public void WatchFullScreen(Action<IReadOnlyList<string>> changed)
    {
    }

    /// <summary>Ptyxis's windows; null for an extension older than terminals, which has no such method.</summary>
    public List<Switchboard.Dock.Platform.ShellWindow>? Terms { get; set; } = [];

    public IReadOnlyList<Switchboard.Dock.Platform.ShellWindow> Terminals() =>
        Fails || Terms is null ? throw new Switchboard.Dock.Platform.ShellException("No such method “Terminals”.") : Terms;
}

/// <summary>Records each terminal the dock opens; throws <see cref="Fails"/> as a missing terminal app does.</summary>
sealed class FakeTerminal : ITerminal
{
    public List<DockTerminal> Opened { get; } = [];

    public Exception? Fails { get; set; }

    public void Open(DockTerminal terminal)
    {
        Opened.Add(terminal);

        if (Fails is not null)
        {
            throw Fails;
        }
    }
}

sealed class FakeVsCode : IVsCode
{
    public Exception? Fails { get; set; }

    public List<string> Calls { get; } = [];

    public void Open(string workspaceFile)
    {
        Calls.Add($"open {Paths.FileName(workspaceFile)}");

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

    public List<DockTerminal> Terminals { get; } = [];

    public string? TerminalReply { get; set; }

    public Task<string?> Terminal(DockRow? row, DockTerminal terminal, CancellationToken cancel)
    {
        Terminals.Add(terminal);

        return Task.FromResult(TerminalReply);
    }

    public List<DockRow> InTerminal { get; } = [];

    public Task<string?> OpenInTerminal(DockRow row, CancellationToken cancel)
    {
        InTerminal.Add(row);

        return Task.FromResult<string?>(null);
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
            return new(["settings.json changed on disk after the editor read it. Discard your changes and open Settings again to load it."], null);
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
            ["codexPermissionModes"] = new JsonArray("auto", "bypassPermissions"),
            ["providers"] = new JsonArray("claude", "codex"),
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

/// <summary>Records the dock's X11 calls; <see cref="Kept"/> answers whether the pointer or focus keeps the dock open.</summary>
sealed class FakeX11Edge : Switchboard.Dock.Platform.IX11Edge
{
    public List<string> Calls { get; } = [];

    public bool CanShape { get; init; } = true;

    public bool Kept { get; set; }

    public void Reserve(Switchboard.Dock.Platform.DockEdge edge, Switchboard.Dock.Platform.PixelRect strip) => Calls.Add($"reserve {edge}");

    public void Release() => Calls.Add("release");

    public void ClipToSliver(Switchboard.Dock.Platform.DockEdge edge, int width) => Calls.Add($"clip {edge} {width}");

    public void Unclip() => Calls.Add("unclip");

    public bool KeptOpen() => Kept;

    /// <summary>Whether the dock or its menu has the focus; <see cref="Focus"/> gives it unless <see cref="Refuses"/>.</summary>
    public bool Focused { get; set; }

    public bool Refuses { get; init; }

    public bool HasFocus() => Focused;

    public IReadOnlyList<Switchboard.Dock.Platform.PixelRect> WorkAreas() => [];

    public Avalonia.PixelPoint? Pointer() => null;

    public void Focus() => Focused = !Refuses;

    public void Below(bool below)
    {
    }

    public void Dispose()
    {
    }
}
