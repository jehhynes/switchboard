using System.Text.Json.Nodes;

namespace Switchboard.Dock.Hub;

/// <summary>The hub requests a click makes. Each returns null on success, or the hub's refusal or the failure to show.</summary>
public interface IHub
{
    Task<string?> Act(JsonObject action);

    /// <summary>
    /// Leaves a session for the window on <paramref name="cwd"/> opened from <paramref name="workspace"/> to open when it gains focus or connects;
    /// no other window claims it (architecture.md § Claude Code runner).
    /// </summary>
    Task<string?> Open(string sessionId, string cwd, string workspace);

    /// <summary>The first view, from the current one on, that passes <paramref name="test"/>, or null after <paramref name="within"/>.</summary>
    Task<DockView?> Until(Func<DockView, bool> test, TimeSpan within);
}
