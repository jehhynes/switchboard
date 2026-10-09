using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Switchboard.Dock.Hub;

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
        Assert.Equal(4, view.Groups.Count);
        Assert.True(changes >= 1);
        Assert.Contains("Authorization: Bearer t0k", server.Requests);
        Assert.Contains(server.Requests, (request) => request.StartsWith("GET /dock/events HTTP/1.1"));
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

        Assert.Equal(new WindowReply(null, 5), await client.Window(new JsonObject { ["type"] = "settings" }, null));
        Assert.Null(await client.Withdraw(5));
        Assert.Contains("POST /window HTTP/1.1 {\"workspace\":null,\"command\":{\"type\":\"settings\"}}", server.Requests);
        Assert.Contains("POST /window/withdraw HTTP/1.1 {\"id\":5}", server.Requests);
    }

    [Fact]
    public async Task Window_HubRefuses_ReturnsTheRefusalAndNoId()
    {
        using var server = new LoopbackHub((_, _, stream) => LoopbackHub.Reply(stream, 400, "{\"error\":\"Expected {workspace, command}.\"}"));
        using var client = new HubClient(HomeFor(server));

        Assert.Equal(new WindowReply("Expected {workspace, command}.", null), await client.Window(new JsonObject { ["type"] = "attach" }, null));
    }
}
