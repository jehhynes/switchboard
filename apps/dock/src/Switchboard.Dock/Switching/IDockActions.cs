using System.Text.Json.Nodes;
using Switchboard.Dock.Hub;

namespace Switchboard.Dock.Switching;

/// <summary>What the dock's controls do outside the hub: switch windows, run a control in VS Code, open a URL. Each returns why it did not, or null.</summary>
public interface IDockActions
{
    Task<string?> Click(DockRow row, CancellationToken cancel);

    Task<string?> Run(DockRow? row, JsonObject command, CancellationToken cancel);

    /// <summary>Open in terminal (PRD R28): in the item window or the terminal app, as the row offers; returns why not, or null.</summary>
    Task<string?> OpenInTerminal(DockRow row, CancellationToken cancel);

    string? OpenUrl(string url);
}
