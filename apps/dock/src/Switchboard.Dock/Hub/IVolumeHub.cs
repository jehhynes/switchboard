using System.Text.Json.Nodes;

namespace Switchboard.Dock.Hub;

public interface IVolumeHub
{
    Task<(string? Error, JsonNode? Body)> Volume(JsonObject query);
}
