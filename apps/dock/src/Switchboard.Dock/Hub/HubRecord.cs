using System.Text.Json;

namespace Switchboard.Dock.Hub;

/// <summary>
/// The running hub's <c>hub.json</c>: where it listens, the token its requests need, and its config folder and runtime, which the dock starts the
/// next hub with; an older hub writes neither (architecture.md § Hub lifecycle).
/// </summary>
public sealed record HubRecord(int Port, string Token, int Pid, string? ConfigDir = null, string? ExecPath = null)
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
