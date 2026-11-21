using System.Text.Json.Nodes;
using Switchboard.Dock.Hub;

namespace Switchboard.Dock.Switching;

/// <summary>What the dock's controls do outside the hub: switch windows, run a control in VS Code, open a URL. Each returns why it did not, or null.</summary>
public interface IDockActions
{
    Task<string?> Click(DockRow row, CancellationToken cancel);

    /// <summary>The row's click in the web page (<c>dock.openIn: web</c>, or Alt-click otherwise, PRD R71); returns why not, or null.</summary>
    Task<string?> OpenInPage(DockRow row, CancellationToken cancel);

    Task<string?> Run(DockRow? row, JsonObject command, CancellationToken cancel);

    /// <summary>Open in terminal (PRD R28): in the item window or the terminal app, as the row offers; returns why not, or null.</summary>
    Task<string?> OpenInTerminal(DockRow row, CancellationToken cancel);

    /// <summary>Brings a session's terminal app window forward, or opens it (PRD R28); returns why not, or null.</summary>
    Task<string?> Terminal(DockRow? row, DockTerminal terminal, CancellationToken cancel);

    string? OpenUrl(string url);

    /// <summary>
    /// Brings forward or opens the VS Code window on a canonical folder, as <c>code &lt;folder&gt;</c>, and waits for a folder window on it to connect;
    /// returns why not, or null.
    /// </summary>
    Task<string?> OpenFolder(string folder, CancellationToken cancel);
}
