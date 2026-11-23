using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Switchboard.Dock.Settings;

namespace Switchboard.Dock.Hub;

/// <summary>Whether the dock has the hub's view, and why not.</summary>
public enum Connection
{
    Connecting,
    Connected,
    NotRunning,
    TooOld,
}

/// <summary>
/// Holds the running hub's dock stream (<c>GET /dock/events</c>), connecting again whenever it ends, and sends the click's requests.
/// While no hub answers, <paramref name="starter"/> starts one, as a VS Code window with Switchboard does (PRD R71).
/// </summary>
public sealed class HubClient(string switchboardHome, HubStarter? starter = null) : IHub, IConfigHub, IDisposable
{
    static readonly TimeSpan Retry = TimeSpan.FromSeconds(2);
    static readonly TimeSpan HeadersTimeout = TimeSpan.FromSeconds(5);
    static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(10);

    readonly HttpClient http = new() { Timeout = Timeout.InfiniteTimeSpan };
    readonly CancellationTokenSource stop = new();
    readonly List<(Func<DockView, bool> Test, TaskCompletionSource<DockView?> Done)> waiting = [];
    readonly Lock gate = new();

    public DockView? View { get; private set; }

    public Connection Connection { get; private set; } = Connection.Connecting;

    /// <summary>What the dock says while no hub runs: why it could not start one, that one is starting, or to open VS Code without a starter.</summary>
    public string NotRunningText { get; private set; } = NotRunningDefault;

    const string NotRunningDefault = "Switchboard is not running. Open VS Code to start it.";

    /// <summary>
    /// Starts a hub now, for the dock's Start hub button, rather than after the starter's wait; returns why it could not, or null while one starts.
    /// Without a starter it starts nothing and says to open VS Code.
    /// </summary>
    public string? StartHub()
    {
        if (starter is null)
        {
            return NotRunningDefault;
        }

        var problem = starter.StartNow();

        NotRunningText = problem ?? "Starting Switchboard…";
        Changed?.Invoke();

        return problem;
    }

    /// <summary>Raised on the stream's thread after the view or the connection changes.</summary>
    public event Action? Changed;

    /// <summary>Raised on the stream's thread when the hub says settings.json changed on disk (PRD R54).</summary>
    public event Action? ConfigChanged;

    /// <summary>Raised on the stream's thread when a VS Code window's status bar item asks the dock to show its list (PRD R71).</summary>
    public event Action? ShowRequested;

    /// <summary>Raised on the stream's thread with a row's key when VS Code forwards that row's click, which only the dock runs (PRD R65, R69, R71).</summary>
    public event Action<string>? ClickRequested;

    /// <summary>
    /// Raised on the stream's thread with a row's key and the message for each work item that starts needing the operator, which the dock shows
    /// in place of a VS Code window's notification, since a window sees only its own work item (PRD R65).
    /// </summary>
    public event Action<string, string>? NeedsYou;

    /// <summary>Raised on the stream's thread with the first view of each connection, such as to a hub started on another config folder.</summary>
    public event Action? Connected;

    public void Start() => _ = Run(stop.Token);

    async Task Run(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            var record = HubRecord.Read(switchboardHome);
            var ended = Connection.NotRunning;

            if (record is not null)
            {
                try
                {
                    ended = await Read(record, token);
                }
                catch (Exception error) when (error is HttpRequestException or IOException or TaskCanceledException or JsonException && !token.IsCancellationRequested)
                {
                }
            }

            if (ended == Connection.NotRunning && starter is not null)
            {
                var text = starter.Start() ?? "Starting Switchboard…";
                var changed = text != NotRunningText;

                NotRunningText = text;

                // A connection that stays not running raises no change of its own.
                if (changed && Connection == Connection.NotRunning)
                {
                    Changed?.Invoke();
                }
            }

            // Each attempt decides the state, so a hub that was too old and then stopped reads as not running.
            SetConnection(ended);

            try
            {
                await Task.Delay(Retry, token);
            }
            catch (TaskCanceledException)
            {
                return;
            }
        }
    }

    /// <summary>Reads the stream until it ends; returns <see cref="Connection.TooOld"/> for a hub without one, else <see cref="Connection.NotRunning"/>.</summary>
    async Task<Connection> Read(HubRecord record, CancellationToken token)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{record.Port}/dock/events?click=1");

        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", record.Token);

        using var headers = CancellationTokenSource.CreateLinkedTokenSource(token);

        headers.CancelAfter(HeadersTimeout);

        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, headers.Token);

        // A hub older than the dock answers 404.
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return Connection.TooOld;
        }

        response.EnsureSuccessStatusCode();
        // The stream answered the record's token, so the record is this hub's: keep how to start the next one.
        starter?.Remember(record);

        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(token), Encoding.UTF8);
        var stream = new EventStream();

        while (await reader.ReadLineAsync(token) is { } line)
        {
            var read = stream.Read(line);

            // Events the dock does not know, such as ones from a newer hub, are skipped.
            if (read is { Name: "dock" })
            {
                Show(DockView.Parse(read.Data));
            }
            else if (read is { Name: "config" })
            {
                ConfigChanged?.Invoke();
            }
            else if (read is { Name: "show" })
            {
                ShowRequested?.Invoke();
            }
            else if (read is { Name: "click" } && JsonNode.Parse(read.Data)?["rowKey"]?.GetValue<string>() is { } rowKey)
            {
                ClickRequested?.Invoke(rowKey);
            }
            else if (read is { Name: "needs" } && JsonNode.Parse(read.Data)?["items"] is JsonArray items)
            {
                foreach (var item in items)
                {
                    if (item?["rowKey"]?.GetValue<string>() is { } key && item["message"]?.GetValue<string>() is { } message)
                    {
                        NeedsYou?.Invoke(key, message);
                    }
                }
            }
        }

        return Connection.NotRunning;
    }

    void SetConnection(Connection connection)
    {
        if (Connection != connection)
        {
            Connection = connection;
            Changed?.Invoke();
        }
    }

    void Show(DockView view)
    {
        List<TaskCompletionSource<DockView?>> passed = [];
        bool connected;

        lock (gate)
        {
            connected = Connection != Connection.Connected;
            View = view;
            Connection = Connection.Connected;

            foreach (var entry in waiting.Where((entry) => entry.Test(view)).ToList())
            {
                waiting.Remove(entry);
                passed.Add(entry.Done);
            }
        }

        Changed?.Invoke();

        if (connected)
        {
            Connected?.Invoke();
        }

        foreach (var done in passed)
        {
            done.TrySetResult(view);
        }
    }

    public async Task<DockView?> Until(Func<DockView, bool> test, TimeSpan within)
    {
        var done = new TaskCompletionSource<DockView?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var entry = (test, done);

        lock (gate)
        {
            if (View is { } view && test(view))
            {
                return view;
            }

            waiting.Add(entry);
        }

        using var timer = new CancellationTokenSource(within);
        using var _ = timer.Token.Register(() => done.TrySetResult(null));
        var result = await done.Task;

        lock (gate)
        {
            waiting.Remove(entry);
        }

        return result;
    }

    public Task<string?> Act(JsonObject action) => Post("/action", action);

    public async Task<WindowReply> Window(JsonObject command, string? workspace)
    {
        var (error, body) = await PostFor("/window", new JsonObject { ["workspace"] = workspace, ["command"] = command.DeepClone() });

        return new WindowReply(error, body?["id"]?.GetValueKind() == JsonValueKind.Number ? body["id"]!.GetValue<int>() : null);
    }

    public Task<string?> Withdraw(int id) => Post("/window/withdraw", new JsonObject { ["id"] = id });

    public Task<string?> SetSource(string name, bool enabled) => Post("/sources", new JsonObject { ["name"] = name, ["enabled"] = enabled });

    public Task<string?> Poll() => Post("/poll", []);

    public Task<string?> Select(string rowKey) => Post("/dock/select", new JsonObject { ["rowKey"] = rowKey });

    public async Task<PageReply> Page(string rowKey)
    {
        var (error, body) = await PostFor("/dock/page", new JsonObject { ["rowKey"] = rowKey });
        string? Text(string name) => body?[name] is JsonValue value && value.TryGetValue<string>(out var text) && text != "" ? text : null;

        return error is not null ? new PageReply(error, null, null)
            : Text("marker") is { } marker ? new PageReply(null, marker, null)
            : Text("url") is { } url ? new PageReply(null, null, url)
            : new PageReply("The hub cannot open work items in the web page. Reload a VS Code window to update it.", null, null);
    }

    public async Task<SessionProviderReply> SessionProvider()
    {
        var (error, body) = await PostFor("/v1/conversation/providers", new JsonObject());
        var provider = body?["defaultProvider"] is JsonValue value && value.TryGetValue<string>(out var named) ? named : null;
        var installed = body?["installed"] is JsonArray list ? list.Select((item) => item is JsonValue named && named.TryGetValue<string>(out var id) ? id : null).OfType<string>().Where((id) => id is "claude" or "codex").ToList() : null;
        var models = body?["models"] as JsonObject;
        var choices = body?["modelChoices"] is JsonObject listed
            ? listed.ToDictionary((entry) => entry.Key, (entry) => (IReadOnlyList<ModelChoice>)(entry.Value is JsonArray list
                ? list.OfType<JsonObject>().Select((one) => one["id"] is JsonValue id && id.TryGetValue<string>(out var text) && text != "" ? new ModelChoice(text, one["label"] is JsonValue label && label.TryGetValue<string>(out var shown) && shown != "" ? shown : text) : null).OfType<ModelChoice>().ToList()
                : []))
            : null;
        string? Model(string name) => models?[name] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

        return error is not null ? new(error, null) : provider is "claude" or "codex" ? new(null, provider, installed, Model("claude"), Model("codex"), choices) : new("The hub did not provide the session providers. Reload VS Code to update it.", null);
    }

    public async Task<NewSessionReply> NewSession(string folder, string opId, string provider, string? model, string? prompt, string run)
    {
        var body = new JsonObject { ["folder"] = folder, ["opId"] = opId, ["provider"] = provider, ["model"] = model, ["run"] = run };

        if (prompt is not null)
        {
            body["prompt"] = prompt;
        }

        var (status, reply, failure) = await Send("/dock/new-session", body);

        // A request whose answer was lost is sent once more with the same opId, which the hub answers with the work item it made, not a second.
        if (status is null)
        {
            (status, reply, failure) = await Send("/dock/new-session", body);
        }

        if (failure is not null)
        {
            return new NewSessionReply(failure, null, null);
        }

        if (status != HttpStatusCode.OK)
        {
            return new NewSessionReply(RefusalOf(reply?.ToJsonString() ?? "") ?? $"The hub answered {(int?)status}.", null, null);
        }

        var workItemId = reply?["workItemId"] is JsonValue id && id.TryGetValue<int>(out var number) ? number : (int?)null;
        var chosen = reply?["folder"] is JsonValue path && path.TryGetValue<string>(out var text) ? text : null;

        return new NewSessionReply(null, workItemId, chosen);
    }

    public async Task<FolderPlaces> Folders()
    {
        var (error, body) = await PostFor("/dock/folders", new JsonObject());
        IReadOnlyList<string> List(string name) => body?[name] is JsonArray list ? list.Select((item) => item is JsonValue value && value.TryGetValue<string>(out var text) ? text : null).OfType<string>().ToList() : [];

        return error is not null ? new FolderPlaces(error, [], [], []) : new FolderPlaces(null, List("recent"), List("repoRoots"), List("worktrees"));
    }

    public Task<string?> Focus(string? sessionId, long at) => Post("/dock/focus", new JsonObject { ["sessionId"] = sessionId, ["at"] = at });

    public async Task<SearchReply> Search(string text, long since)
    {
        var (error, body) = await PostFor("/dock/search", new JsonObject { ["text"] = text, ["since"] = since });

        try
        {
            return error is null && body is not null ? DockView.ParseSearch(body) with { Error = null } : new SearchReply(error ?? "The hub answered no rows.", []);
        }
        catch (JsonException parse)
        {
            return new SearchReply($"The hub's answer could not be read: {parse.Message}", []);
        }
    }

    public Task<string?> StopHeld(string session) => Post("/holder/stop", new JsonObject { ["id"] = session });

    public Task<string?> RestartHolder(string detail) => Post("/holder/restart", new JsonObject { ["detail"] = detail });

    public async Task<WindowReply> Open(string sessionId, string cwd, string workspace)
    {
        var (error, body) = await PostFor("/open", new JsonObject { ["sessionId"] = sessionId, ["cwd"] = cwd, ["workspace"] = workspace });

        return new WindowReply(error, body?["id"]?.GetValueKind() == JsonValueKind.Number ? body["id"]!.GetValue<int>() : null);
    }

    public Task<string?> WithdrawOpen(int id) => Post("/open/withdraw", new JsonObject { ["id"] = id });

    async Task<string?> Post(string path, JsonObject body) => (await PostFor(path, body)).Error;

    public async Task<(EditorConfig? Config, string? Error)> ReadConfig()
    {
        var (error, body) = await PostFor("/config/read", []);

        return body is null ? (null, error ?? "The hub sent no settings.") : (EditorConfig.Parse(body), null);
    }

    public async Task<IReadOnlyList<string>?> CheckConfig(JsonObject settings)
    {
        var (_, reply, _) = await Send("/config/check", new JsonObject { ["settings"] = settings.DeepClone() });

        return reply?["errors"] is JsonArray errors ? Strings(errors) : null;
    }

    public async Task<SaveReply> SaveConfig(JsonObject value, string? version, string configDir)
    {
        var (errors, reply) = await Written("/config/save", new JsonObject { ["value"] = value.DeepClone(), ["version"] = version, ["configDir"] = configDir });

        return new SaveReply(errors, reply?["version"] is JsonValue written && written.TryGetValue<string>(out var text) ? text : null);
    }

    public async Task<EnrollReply> Enroll(string action)
    {
        var (status, reply, failure) = await Send("/config/voice-enroll", new JsonObject { ["action"] = action });

        if (failure is not null)
        {
            return new EnrollReply(failure, null);
        }

        var enrollment = Enrollment.Parse(reply?["enrollment"]);

        return status == HttpStatusCode.OK ? new EnrollReply(null, enrollment) : new EnrollReply(RefusalOf(reply?.ToJsonString() ?? "") ?? $"The hub answered {(int?)status}.", enrollment);
    }

    public async Task<DevicesReply> Devices()
    {
        var (status, reply, failure) = await Send("/page/devices", []);

        return status == HttpStatusCode.OK ? new DevicesReply(null, PairedDevice.ParseList(reply?["devices"])) : new DevicesReply(failure ?? RefusalOf(reply?.ToJsonString() ?? "") ?? $"The hub answered {(int?)status}.", null);
    }

    public async Task<PairReply> Pair()
    {
        var (status, reply, failure) = await Send("/page/pair", []);

        return status == HttpStatusCode.OK && Pairing.Parse(reply) is { } pairing ? new PairReply(null, pairing) : new PairReply(failure ?? RefusalOf(reply?.ToJsonString() ?? "") ?? $"The hub answered {(int?)status}.", null);
    }

    public async Task<string?> RevokeDevice(string id)
    {
        var (status, reply, failure) = await Send("/page/revoke", new JsonObject { ["id"] = id });

        return status == HttpStatusCode.OK ? null : failure ?? RefusalOf(reply?.ToJsonString() ?? "") ?? $"The hub answered {(int?)status}.";
    }

    public async Task<string?> AllowVoice(string id, bool allow)
    {
        var (status, reply, failure) = await Send("/page/voice", new JsonObject { ["id"] = id, ["allow"] = allow });

        return status == HttpStatusCode.OK ? null : failure ?? RefusalOf(reply?.ToJsonString() ?? "") ?? $"The hub answered {(int?)status}.";
    }

    /// <summary>A write's refusal: the <c>errors</c> of a 409, else the failure; empty, with the reply, when the hub wrote the file.</summary>
    async Task<(IReadOnlyList<string> Errors, JsonNode? Reply)> Written(string path, JsonObject body)
    {
        var (status, reply, failure) = await Send(path, body);

        if (status == HttpStatusCode.OK)
        {
            return ([], reply);
        }

        return (reply?["errors"] is JsonArray errors ? Strings(errors) : [failure ?? RefusalOf(reply?.ToJsonString() ?? "") ?? $"The hub answered {(int?)status}."], null);
    }

    static IReadOnlyList<string> Strings(JsonArray list) => list.Select((entry) => entry?.GetValue<string>() ?? "").ToList();

    /// <summary>Posts a request; returns the status and body, or null and why the hub did not answer.</summary>
    async Task<(HttpStatusCode? Status, JsonNode? Body, string? Failure)> Send(string path, JsonObject body)
    {
        if (HubRecord.Read(switchboardHome) is not { } record)
        {
            return (null, null, "Switchboard is not running.");
        }

        using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{record.Port}{path}") { Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json") };

        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", record.Token);

        try
        {
            using var timeout = new CancellationTokenSource(RequestTimeout);
            using var response = await http.SendAsync(request, timeout.Token);

            return (response.StatusCode, ParseOrNull(await response.Content.ReadAsStringAsync(timeout.Token)), null);
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException)
        {
            return (null, null, "Switchboard is not running.");
        }
    }

    /// <summary>Posts a request; returns the refusal or failure, or null and the reply's body.</summary>
    async Task<(string? Error, JsonNode? Body)> PostFor(string path, JsonObject body)
    {
        var (status, reply, failure) = await Send(path, body);

        if (failure is not null)
        {
            return (failure, null);
        }

        return status == HttpStatusCode.OK ? (null, reply) : (RefusalOf(reply?.ToJsonString() ?? "") ?? $"The hub answered {(int?)status}.", null);
    }

    static JsonNode? ParseOrNull(string text)
    {
        try
        {
            return JsonNode.Parse(text);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    static string? RefusalOf(string text)
    {
        try
        {
            return JsonNode.Parse(text)?["error"]?.GetValue<string>();
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException)
        {
            return null;
        }
    }

    public void Dispose()
    {
        stop.Cancel();
        http.Dispose();
        stop.Dispose();
    }
}
