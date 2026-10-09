using System.Text.Json.Nodes;
using Switchboard.Dock.Hub;

namespace Switchboard.Dock.Switching;

/// <summary>What the dock's controls do outside the hub: switch windows, run a control in VS Code, open a URL. Each returns why it did not, or null.</summary>
public interface IDockActions
{
    Task<string?> Click(DockRow row, CancellationToken cancel);

    Task<string?> Run(DockRow? row, JsonObject command, CancellationToken cancel);

    string? OpenUrl(string url);
}
