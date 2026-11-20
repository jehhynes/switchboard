using System.Text.Json.Nodes;

namespace Switchboard.Dock.Hub;

/// <summary>The hub requests a click makes. Each returns null on success, or the hub's refusal or the failure to show.</summary>
public interface IHub
{
    Task<string?> Act(JsonObject action);

    /// <summary>Leaves a command for the VS Code window opened from <paramref name="workspace"/>, or with null for the next window that claims.</summary>
    Task<WindowReply> Window(JsonObject command, string? workspace);

    /// <summary>Drops a command no window has claimed, because the dock did not bring its window forward.</summary>
    Task<string?> Withdraw(int id);

    /// <summary>Turns a source's polling on or off (PRD R3).</summary>
    Task<string?> SetSource(string name, bool enabled);

    /// <summary>Polls each source that is on now and restarts its poll interval.</summary>
    Task<string?> Poll();

    /// <summary>
    /// Leaves a session for the window on <paramref name="cwd"/> opened from <paramref name="workspace"/> to open when it gains focus or connects;
    /// no other window claims it (architecture.md § Claude Code runner).
    /// </summary>
    Task<string?> Open(string sessionId, string cwd, string workspace);

    /// <summary>
    /// Makes a hosted conversation's row the selection of its host window, so the window shows it when the click brings it forward
    /// (architecture.md § Dock).
    /// </summary>
    Task<string?> Select(string rowKey);

    /// <summary>
    /// The header's New session: makes a conversation hosted by <paramref name="folder"/> and stored as its folder window's selection, with no window
    /// open (architecture.md § Hosted conversations). A retry with the same <paramref name="opId"/> answers the first conversation.
    /// </summary>
    Task<NewConversationReply> NewConversation(string folder, string opId);

    /// <summary>Stops a held session by its Switchboard session ID (PRD R94).</summary>
    Task<string?> StopHeld(string session);

    /// <summary>The first view, from the current one on, that passes <paramref name="test"/>, or null after <paramref name="within"/>.</summary>
    Task<DockView?> Until(Func<DockView, bool> test, TimeSpan within);
}

/// <summary>The hub's answer to New session: the refusal or failure, or the new work item and the canonical folder that hosts it.</summary>
public sealed record NewConversationReply(string? Error, int? WorkItemId, string? Folder);

/// <summary>The hub's answer to a window command: the refusal or failure, or the command's ID for withdrawing it.</summary>
public sealed record WindowReply(string? Error, int? Id);
