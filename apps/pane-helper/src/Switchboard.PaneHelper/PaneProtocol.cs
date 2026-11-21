using System.Text.Json;
using System.Text.Json.Nodes;

namespace Switchboard.PaneHelper;

/// <summary>
/// The lines the hub and the helper exchange over stdin and stdout, one JSON object per line (architecture.md § Pane helper): the hub sends
/// <c>{type: 'pane', marker, rect}</c>, the helper answers <c>{state: 'ready'}</c> once and then its reports.
/// </summary>
public static class PaneProtocol
{
    /// <summary>The first line the helper writes, once its window hooks are in place.</summary>
    public static readonly JsonObject Ready = new() { ["state"] = "ready" };

    /// <summary>The hub's <c>pane</c> line, or null for any other line; a malformed column reads as none, which hides the pane.</summary>
    public static PaneOrder? ParseOrder(string line)
    {
        try
        {
            if (JsonNode.Parse(line) is not JsonObject body || body["type"] is not JsonValue type || !type.TryGetValue<string>(out var name) || name != "pane")
            {
                return null;
            }

            var marker = body["marker"] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
            PaneRect? rect = null;

            if (body["rect"] is JsonObject r)
            {
                double Read(string key) => r[key] is JsonValue number && number.TryGetValue<double>(out var read) && double.IsFinite(read) ? read : double.NaN;

                var values = new[] { "left", "top", "width", "height", "dpr", "innerWidth", "innerHeight" }.Select(Read).ToArray();

                rect = values.Any(double.IsNaN) || values[4] <= 0 ? null : new PaneRect(values[0], values[1], values[2], values[3], values[4], values[5], values[6]);
            }

            return new PaneOrder(marker, rect);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>A report as one line, without line breaks.</summary>
    public static string Line(JsonObject report) => report.ToJsonString();
}
