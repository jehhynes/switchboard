using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

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
/// The dock never starts the hub; a VS Code window with Switchboard does (PRD R71).
/// </summary>
public sealed class HubClient(string switchboardHome) : IHub, IDisposable
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

    /// <summary>Raised on the stream's thread after the view or the connection changes.</summary>
    public event Action? Changed;

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
        using var request = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{record.Port}/dock/events");

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

        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(token), Encoding.UTF8);
        var stream = new EventStream();

        while (await reader.ReadLineAsync(token) is { } line)
        {
            if (stream.Read(line) is { Name: "dock" } dock)
            {
                Show(DockView.Parse(dock.Data));
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

        lock (gate)
        {
            View = view;
            Connection = Connection.Connected;

            foreach (var entry in waiting.Where((entry) => entry.Test(view)).ToList())
            {
                waiting.Remove(entry);
                passed.Add(entry.Done);
            }
        }

        Changed?.Invoke();

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

    public Task<string?> Open(string sessionId, string cwd, string workspace) => Post("/open", new JsonObject { ["sessionId"] = sessionId, ["cwd"] = cwd, ["workspace"] = workspace });

    async Task<string?> Post(string path, JsonObject body)
    {
        if (HubRecord.Read(switchboardHome) is not { } record)
        {
            return "Switchboard is not running.";
        }

        using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{record.Port}{path}") { Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json") };

        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", record.Token);

        try
        {
            using var timeout = new CancellationTokenSource(RequestTimeout);
            using var response = await http.SendAsync(request, timeout.Token);
            var text = await response.Content.ReadAsStringAsync(timeout.Token);

            return response.StatusCode == HttpStatusCode.OK ? null : RefusalOf(text) ?? $"The hub answered {(int)response.StatusCode}.";
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException)
        {
            return "Switchboard is not running.";
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
