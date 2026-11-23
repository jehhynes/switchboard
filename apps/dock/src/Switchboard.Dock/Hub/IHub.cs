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
    /// no other window claims it (architecture.md § Claude Code runner). Returns the refusal or failure, or the open's ID for withdrawing it.
    /// </summary>
    Task<WindowReply> Open(string sessionId, string cwd, string workspace);

    /// <summary>Drops a session left for a window the click did not reach, so the window does not open it when it connects later.</summary>
    Task<string?> WithdrawOpen(int id);

    /// <summary>
    /// Makes a hosted conversation's row the selection of its host window, so the window shows it when the click brings it forward
    /// (architecture.md § Dock).
    /// </summary>
    Task<string?> Select(string rowKey);

    /// <summary>
    /// The New session dialog (PRD R122): a conversation in &lt;paramref name="folder"/&gt;, empty or with &lt;paramref name="prompt"/&gt; as its first message, when
    /// &lt;paramref name="run"/&gt; is `now`; else a task started when a slot is free (`queue`) or waiting for Start (`wait`). A null &lt;paramref name="model"/&gt;
    /// is the provider's default. A retry with the same &lt;paramref name="opId"/&gt; answers the first work item.
    /// </summary>
    Task<NewSessionReply> NewSession(string folder, string opId, string provider, string? model, string? prompt, string run);

    /// <summary>The New session dialog's folders: the recent folders, which the hub keeps for the dock and every page, repo roots and worktrees.</summary>
    Task<FolderPlaces> Folders();

    /// <summary>The configured default for a new session's provider choice, and each provider's models.</summary>
    Task<SessionProviderReply> SessionProvider();

    /// <summary>
    /// Reports the session whose terminal window came to the front, or null when the window in front is no session's terminal, and
    /// <paramref name="at"/>, when, in epoch milliseconds (architecture.md § Voice).
    /// </summary>
    Task<string?> Focus(string? sessionId, long at);

    /// <summary>
    /// The Done rows of work done from &lt;paramref name="since"/&gt;, in epoch milliseconds, up to the start of the Done list, whose search text holds every
    /// word of &lt;paramref name="text"/&gt; (PRD R63).
    /// </summary>
    Task<SearchReply> Search(string text, long since);

    /// <summary>Stops a held session by its Switchboard session ID (PRD R94).</summary>
    Task<string?> StopHeld(string session);

    /// <summary>
    /// Restarts a terminal holder from an older build and resumes its sessions in the background (architecture.md § Restarting the holder);
    /// &lt;paramref name="detail"/&gt; is the confirmation the operator accepted, which the hub refuses once it asks another.
    /// </summary>
    Task<string?> RestartHolder(string detail);

    /// <summary>
    /// A row's click with <c>dock.openIn: web</c> (architecture.md § Dock): the installed web page used last shows the row's work item and puts
    /// the answered marker in its title, or, with none open, the answer is the page's address at the work item.
    /// </summary>
    Task<PageReply> Page(string rowKey);

    /// <summary>The first view, from the current one on, that passes <paramref name="test"/>, or null after <paramref name="within"/>.</summary>
    Task<DockView?> Until(Func<DockView, bool> test, TimeSpan within);
}

/// <summary>The hub's answer to New session: the refusal or failure, or the new work item and the canonical folder it runs in.</summary>
public sealed record NewSessionReply(string? Error, int? WorkItemId, string? Folder);

/// <summary>The New session dialog's folders, or why the hub did not list them.</summary>
public sealed record FolderPlaces(string? Error, IReadOnlyList<string> Recent, IReadOnlyList<string> RepoRoots, IReadOnlyList<string> Worktrees);

/// <summary>A model the New session dialog offers: what is sent, and what it shows.</summary>
public sealed record ModelChoice(string Id, string Label);

/// <summary>
/// The configured default provider, or why the hub did not name one; &lt;paramref name="Installed"/&gt; lists the providers whose CLI the hub finds,
/// null from a hub that does not say.
/// </summary>
public sealed record SessionProviderReply(string? Error, string? DefaultProvider, IReadOnlyList<string>? Installed = null, string? ClaudeModel = null, string? CodexModel = null, IReadOnlyDictionary<string, IReadOnlyList<ModelChoice>>? ModelChoices = null);

/// <summary>The hub's answer to a click in the web page: the refusal or failure, the marker of the page that shows it, or the page's address at it.</summary>
public sealed record PageReply(string? Error, string? Marker, string? Url);

/// <summary>The hub's answer to a window command: the refusal or failure, or the command's ID for withdrawing it.</summary>
public sealed record WindowReply(string? Error, int? Id);
