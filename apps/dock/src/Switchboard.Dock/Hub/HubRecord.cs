using System.Text.Json;

namespace Switchboard.Dock.Hub;

/// <summary>The running hub's <c>hub.json</c>: where it listens and the token its requests need (architecture.md § Hub lifecycle).</summary>
public sealed record HubRecord(int Port, string Token, int Pid)
{
    /// <summary>The record in a Switchboard home, or null when it is missing or unreadable.</summary>
    public static HubRecord? Read(string switchboardHome)
    {
        try
        {
            var record = JsonSerializer.Deserialize<HubRecord>(File.ReadAllText(Path.Combine(switchboardHome, "hub.json")), new JsonSerializerOptions(JsonSerializerDefaults.Web));

            return record is { Port: > 0, Token.Length: > 0 } ? record : null;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }
}
