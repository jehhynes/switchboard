using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Settings;

namespace Switchboard.Dock.Tests;

/// <summary>A test-owned loopback HTTP server that answers each request from a handler, as the hub would.</summary>
sealed class LoopbackHub : IDisposable
{
    readonly TcpListener listener = new(IPAddress.Loopback, 0);
    readonly CancellationTokenSource stop = new();

    public List<string> Requests { get; } = [];

    public LoopbackHub(Func<string, string, NetworkStream, Task> handle)
    {
        listener.Start();
        _ = Serve(handle);
    }

    public int Port => ((IPEndPoint)listener.LocalEndpoint).Port;

    async Task Serve(Func<string, string, NetworkStream, Task> handle)
    {
        while (!stop.IsCancellationRequested)
        {
            TcpClient client;

            try
            {
                client = await listener.AcceptTcpClientAsync(stop.Token);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            _ = Task.Run(async () =>
            {
                using (client)
                {
                    var stream = client.GetStream();
                    var reader = new StreamReader(stream, Encoding.UTF8, leaveOpen: true);
                    var start = await reader.ReadLineAsync() ?? "";
                    var length = 0;

                    while (await reader.ReadLineAsync() is { Length: > 0 } header)
                    {
                        lock (Requests)
                        {
                            Requests.Add(header);
                        }

                        if (header.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
                        {
                            length = int.Parse(header["Content-Length:".Length..].Trim(), System.Globalization.CultureInfo.InvariantCulture);
                        }
                    }

                    var body = new char[length];

                    for (var read = 0; read < length;)
                    {
                        read += await reader.ReadAsync(body.AsMemory(read));
                    }

                    lock (Requests)
                    {
                        Requests.Add($"{start} {new string(body)}");
                    }

                    await handle(start, new string(body), stream);
                }
            });
        }
    }

    public static async Task Reply(NetworkStream stream, int status, string body, string type = "application/json")
    {
        var bytes = Encoding.UTF8.GetBytes(body);

        await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 {status} X\r\nContent-Type: {type}\r\nContent-Length: {bytes.Length}\r\nConnection: close\r\n\r\n"));
        await stream.WriteAsync(bytes);
    }

    public void Dispose()
    {
        stop.Cancel();
        listener.Stop();
    }
}

public sealed class HubClientTests
{
    static string HomeFor(LoopbackHub server)
    {
        var home = Fixtures.TempFolder();

        File.WriteAllText(Path.Combine(home, "hub.json"), $$"""{"protocol":1,"port":{{server.Port}},"token":"t0k","pid":7}""");

        return home;
    }

    static async Task<T> Until<T>(Func<T?> value) where T : class
    {
        for (var deadline = DateTime.UtcNow.AddSeconds(5); DateTime.UtcNow < deadline; await Task.Delay(20))
        {
            if (value() is { } found)
            {
                return found;
            }
        }

        throw new TimeoutException();
    }

    [Fact]
    public async Task Start_HubStreamsTheDockView_ShowsItAndPassesTheToken()
    {
        using var server = new LoopbackHub(async (start, _, stream) =>
        {
            var json = Fixtures.DockJson.ReplaceLineEndings(" ");
            var events = $"event: hello\ndata: {{\"hub\":\"switchboard\"}}\n\n: ping\n\nevent: dock\ndata: {json}\n\n";

            await stream.WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n"));
            await stream.WriteAsync(Encoding.UTF8.GetBytes(events));
            await Task.Delay(5000);
        });
        using var client = new HubClient(HomeFor(server));
        var changes = 0;

        client.Changed += () => Interlocked.Increment(ref changes);
        client.Start();

        var view = await Until(() => client.View);

        Assert.Equal(Connection.Connected, client.Connection);
        Assert.Equal(5, view.Groups.Count);
        Assert.True(changes >= 1);
        Assert.Contains("Authorization: Bearer t0k", server.Requests);
        Assert.Contains(server.Requests, (request) => request.StartsWith("GET /dock/events?click=1 HTTP/1.1"));
    }

    [Fact]
    public async Task Start_HubWithoutTheDockStream_SaysItIsTooOld()
    {
        using var server = new LoopbackHub((_, _, stream) => LoopbackHub.Reply(stream, 404, "{\"error\":\"not found\"}"));
        using var client = new HubClient(HomeFor(server));

        client.Start();

        await Until(() => client.Connection == Connection.TooOld ? "" : null);
        Assert.Null(client.View);
    }

    [Fact]
    public async Task Start_TooOldHubThenStops_SaysSwitchboardIsNotRunning()
    {
        using var server = new LoopbackHub((_, _, stream) => LoopbackHub.Reply(stream, 404, "{\"error\":\"not found\"}"));
        var home = HomeFor(server);
        using var client = new HubClient(home);

        client.Start();
        await Until(() => client.Connection == Connection.TooOld ? "" : null);
        File.Delete(Path.Combine(home, "hub.json"));

        await Until(() => client.Connection == Connection.NotRunning ? "" : null);
    }

    [Fact]
    public async Task Start_NoHubRecord_SaysSwitchboardIsNotRunning()
    {
        using var client = new HubClient(Fixtures.TempFolder());

        client.Start();

        await Until(() => client.Connection == Connection.NotRunning ? "" : null);
    }

    [Fact]
    public async Task Act_HubRefuses_ReturnsTheRefusal()
    {
        using var server = new LoopbackHub((start, body, stream) => start.StartsWith("POST /action") ? LoopbackHub.Reply(stream, 409, "{\"error\":\"Nothing to approve.\"}") : LoopbackHub.Reply(stream, 500, "boom", "text/plain"));
        using var client = new HubClient(HomeFor(server));

        Assert.Equal("Nothing to approve.", await client.Act(new JsonObject { ["type"] = "approve", ["workItemId"] = 3 }));
        Assert.Contains("POST /action HTTP/1.1 {\"type\":\"approve\",\"workItemId\":3}", server.Requests);
        Assert.Equal("The hub answered 500.", await client.Open("s1", "D:/x", "C:/h/w.code-workspace"));
    }

    [Fact]
    public async Task Open_HubAccepts_ReturnsNullAndPostsTheSession()
    {
        using var server = new LoopbackHub((_, _, stream) => LoopbackHub.Reply(stream, 200, "{\"recorded\":true}"));
        using var client = new HubClient(HomeFor(server));

        Assert.Null(await client.Open("s1", "D:/git/widgets", "C:/h/windows/gh-7.code-workspace"));
        Assert.Contains("POST /open HTTP/1.1 {\"sessionId\":\"s1\",\"cwd\":\"D:/git/widgets\",\"workspace\":\"C:/h/windows/gh-7.code-workspace\"}", server.Requests);
    }

    [Fact]
    public async Task StopHeld_HubRefusesOrAccepts_PostsTheIdAndReturnsTheRefusal()
    {
        using var server = new LoopbackHub((_, body, stream) => body.Contains("\"nope\"", StringComparison.Ordinal) ? LoopbackHub.Reply(stream, 404, "{\"error\":\"No held session nope.\"}") : LoopbackHub.Reply(stream, 200, "{\"stopped\":\"o1\"}"));
        using var client = new HubClient(HomeFor(server));

        Assert.Equal("No held session nope.", await client.StopHeld("nope"));
        Assert.Null(await client.StopHeld("o1"));
        Assert.Contains("POST /holder/stop HTTP/1.1 {\"id\":\"o1\"}", server.Requests);
    }

    [Fact]
    public async Task Act_NoHub_SaysSwitchboardIsNotRunning()
    {
        using var client = new HubClient(Fixtures.TempFolder());

        Assert.Equal("Switchboard is not running.", await client.Act(new JsonObject()));
    }

    [Fact]
    public async Task Until_NoViewPasses_ReturnsNullAfterTheWait()
    {
        using var client = new HubClient(Fixtures.TempFolder());

        Assert.Null(await client.Until((_) => true, TimeSpan.FromMilliseconds(50)));
    }

    [Fact]
    public async Task Window_HubKeepsTheCommand_ReturnsItsIdForWithdraw()
    {
        using var server = new LoopbackHub((start, _, stream) => LoopbackHub.Reply(stream, 200, start.StartsWith("POST /window/withdraw") ? "{\"withdrawn\":true}" : "{\"id\":5}"));
        using var client = new HubClient(HomeFor(server));

        Assert.Equal(new WindowReply(null, 5), await client.Window(new JsonObject { ["type"] = "openUrl", ["url"] = "D:/r.md" }, null));
        Assert.Null(await client.Withdraw(5));
        Assert.Contains("POST /window HTTP/1.1 {\"workspace\":null,\"command\":{\"type\":\"openUrl\",\"url\":\"D:/r.md\"}}", server.Requests);
        Assert.Contains("POST /window/withdraw HTTP/1.1 {\"id\":5}", server.Requests);
    }

    [Fact]
    public async Task Window_HubRefuses_ReturnsTheRefusalAndNoId()
    {
        using var server = new LoopbackHub((_, _, stream) => LoopbackHub.Reply(stream, 400, "{\"error\":\"Expected {workspace, command}.\"}"));
        using var client = new HubClient(HomeFor(server));

        Assert.Equal(new WindowReply("Expected {workspace, command}.", null), await client.Window(new JsonObject { ["type"] = "attach" }, null));
    }
    [Fact]
    public async Task ReadConfig_HubAnswers_ParsesTheFilesAndChoices()
    {
        using var server = new LoopbackHub((_, _, stream) => LoopbackHub.Reply(stream, 200, SettingsConfigs.Basic().ToJsonString()));
        using var client = new HubClient(HomeFor(server));
        var (config, error) = await client.ReadConfig();

        Assert.Null(error);
        Assert.Equal("v1", config!.Settings.Version);
        Assert.Equal("Build it", config.Settings.Value!["playbooks"]!["dev:develop"]!["description"]!.GetValue<string>());
        Assert.Equal(2, config.InUse["dev:develop"]);
        Assert.Contains("POST /config/read HTTP/1.1 {}", server.Requests);
    }

    [Fact]
    public async Task SaveConfig_HubRefusesOrFails_ReturnsTheErrors()
    {
        using var server = new LoopbackHub((start, _, stream) =>
            start.StartsWith("POST /config/save") ? LoopbackHub.Reply(stream, 409, "{\"errors\":[\"a\",\"b\"]}") : LoopbackHub.Reply(stream, 400, "{\"error\":\"Expected {settings}.\"}"));
        using var client = new HubClient(HomeFor(server));

        Assert.Equal(["a", "b"], (await client.SaveConfig(new JsonObject { ["sessions"] = new JsonObject() }, "v1", "C:/cfg")).Errors);
        Assert.Null(await client.CheckConfig(new JsonObject()));
        Assert.Contains("POST /config/save HTTP/1.1 {\"value\":{\"sessions\":{}},\"version\":\"v1\",\"configDir\":\"C:/cfg\"}", server.Requests);
        Assert.Equal(["Switchboard is not running."], (await new HubClient(Fixtures.TempFolder()).SaveConfig([], null, "C:/cfg")).Errors);
    }

    [Fact]
    public async Task CheckConfig_HubAnswers_SendsTheDraftAndReturnsTheErrors()
    {
        using var server = new LoopbackHub((_, _, stream) => LoopbackHub.Reply(stream, 200, "{\"errors\":[\"playbooks.dev:x: description is required.\"]}"));
        using var client = new HubClient(HomeFor(server));

        Assert.Equal(["playbooks.dev:x: description is required."], await client.CheckConfig(new JsonObject { ["playbooks"] = new JsonObject() }));
        Assert.Contains("POST /config/check HTTP/1.1 {\"settings\":{\"playbooks\":{}}}", server.Requests);
    }

    [Fact]
    public async Task SaveConfig_HubWrites_ReturnsTheVersionWritten()
    {
        using var server = new LoopbackHub((_, _, stream) => LoopbackHub.Reply(stream, 200, "{\"saved\":true,\"version\":\"abc\"}"));
        using var client = new HubClient(HomeFor(server));

        var reply = await client.SaveConfig([], null, "C:/cfg");

        Assert.Empty(reply.Errors);
        Assert.Equal("abc", reply.Version);
    }

    [Fact]
    public async Task Start_NoHubAndAStarterThatNeverSawOne_SaysToOpenVsCodeOnce()
    {
        var home = Fixtures.TempFolder();
        var at = DateTime.UtcNow;
        // Each attempt reads a clock 10 seconds on, past the grace a missing hub gets.
        using var client = new HubClient(home, new HubStarter(home, () => at = at.AddSeconds(10)));
        var changes = 0;

        client.Changed += () => Interlocked.Increment(ref changes);
        client.Start();

        await Until(() => client.Connection == Connection.NotRunning ? client.NotRunningText : null);
        Assert.Equal(HubStarter.Never, client.NotRunningText);
        Assert.True(changes >= 1);
    }

    [Fact]
    public async Task Start_HubAnswersTheStream_RemembersItsRuntimeAndConfigFolderForTheStarter()
    {
        using var server = new LoopbackHub(async (_, _, stream) =>
        {
            await stream.WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n"));
            await stream.WriteAsync(Encoding.UTF8.GetBytes($"event: dock\ndata: {Fixtures.DockJson.ReplaceLineEndings(" ")}\n\n"));
            await Task.Delay(5000);
        });
        var home = HomeFor(server);
        var record = JsonNode.Parse(File.ReadAllText(Path.Combine(home, "hub.json")))!;

        record["configDir"] = "/home/me/.claude/switchboard";
        record["execPath"] = "/usr/share/code/code";
        File.WriteAllText(Path.Combine(home, "hub.json"), record.ToJsonString());

        using var client = new HubClient(home, new HubStarter(home));

        client.Start();
        await Until(() => client.View);

        Assert.Equal("{\"execPath\":\"/usr/share/code/code\",\"configDir\":\"/home/me/.claude/switchboard\"}", File.ReadAllText(Path.Combine(home, "dock-hub.json")));
    }

    [Fact]
    public async Task Start_AsksForClicksAndRaisesEachForwardedClickWithItsRowKey()
    {
        var started = "";
        using var server = new LoopbackHub(async (start, _, stream) =>
        {
            started = start;
            var json = Fixtures.DockJson.ReplaceLineEndings(" ");

            await stream.WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n"));
            await stream.WriteAsync(Encoding.UTF8.GetBytes($"event: click\ndata: {{\"rowKey\":\"item:8\"}}\n\nevent: click\ndata: {{}}\n\nevent: dock\ndata: {json}\n\n"));
            await Task.Delay(5000);
        });
        using var client = new HubClient(HomeFor(server));
        var clicked = new System.Collections.Concurrent.ConcurrentQueue<string>();

        client.ClickRequested += clicked.Enqueue;
        client.Start();

        await Until(() => client.View);
        Assert.StartsWith("GET /dock/events?click=1 ", started);
        Assert.Equal(["item:8"], clicked);
    }

    [Fact]
    public async Task Start_HubSendsNeeds_RaisesEachItemWithItsRowKeyAndMessage()
    {
        using var server = new LoopbackHub(async (_, _, stream) =>
        {
            var json = Fixtures.DockJson.ReplaceLineEndings(" ");

            await stream.WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n"));
            await stream.WriteAsync(Encoding.UTF8.GetBytes($"event: needs\ndata: {{\"items\":[{{\"rowKey\":\"item:8\",\"message\":\"Switchboard: Fix it — Answer a question\"}},{{\"rowKey\":\"item:9\"}}]}}\n\nevent: dock\ndata: {json}\n\n"));
            await Task.Delay(5000);
        });
        using var client = new HubClient(HomeFor(server));
        var needs = new System.Collections.Concurrent.ConcurrentQueue<(string, string)>();

        client.NeedsYou += (key, message) => needs.Enqueue((key, message));
        client.Start();

        await Until(() => client.View);
        Assert.Equal([("item:8", "Switchboard: Fix it — Answer a question")], needs);
    }

    [Fact]
    public async Task Start_HubSendsShowConfigAndUnknownEvents_RaisesEachAndKeepsReading()
    {
        using var server = new LoopbackHub(async (_, _, stream) =>
        {
            var json = Fixtures.DockJson.ReplaceLineEndings(" ");

            await stream.WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n"));
            await stream.WriteAsync(Encoding.UTF8.GetBytes($"event: show\ndata: {{}}\n\nevent: later\ndata: {{}}\n\nevent: config\ndata: {{}}\n\nevent: dock\ndata: {json}\n\n"));
            await Task.Delay(5000);
        });
        using var client = new HubClient(HomeFor(server));
        var changed = 0;
        var shown = 0;

        client.ConfigChanged += () => Interlocked.Increment(ref changed);
        client.ShowRequested += () => Interlocked.Increment(ref shown);
        client.Start();

        await Until(() => client.View);
        Assert.Equal(1, changed);
        Assert.Equal(1, shown);
    }
}
