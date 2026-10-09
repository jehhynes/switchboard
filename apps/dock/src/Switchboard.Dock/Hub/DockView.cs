using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Switchboard.Dock.Hub;

// The hub's dock view (architecture.md § Dock), built by `dockView` in packages/hub/src/dock.ts; the dock adds no rules of its own.

public sealed record DockView(IReadOnlyList<string> Notes, IReadOnlyList<DockGroup> Groups, IReadOnlyList<SnoozeChoice> Snooze, IReadOnlyList<SourceState> Sources, IReadOnlyList<string> RepoRoots)
{
    static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) } };

    public static DockView Parse(string json) => JsonSerializer.Deserialize<DockView>(json, Options) ?? throw new JsonException("The dock view is null.");
}

/// <summary>A configured source and whether it is polled (PRD R3).</summary>
public sealed record SourceState(string Name, bool Enabled);

/// <summary>A snooze choice: its wake time as epoch milliseconds, or null to snooze until restored (PRD R49).</summary>
public sealed record SnoozeChoice(string Label, string Description, long? Until);

public sealed record DockGroup(string Key, string Title, string? Empty, IReadOnlyList<DockRow> Rows);

public sealed record DockRow(
    string Key,
    string Title,
    string? Priority,
    TimeText? Time,
    string Playbook,
    string Ticket,
    string Source,
    string Url,
    RowMark? Mark,
    IReadOnlyList<DockText> Details,
    Tone? Stripe,
    DockWindow? Window,
    DockOpen? Open,
    IReadOnlyList<DockControl> Controls,
    string? Main,
    string? MainTitle,
    IReadOnlyList<DockAnswer> Answers,
    IReadOnlyList<DockPaste> Pastes,
    IReadOnlyList<DockCommand> Commands,
    string Search,
    IReadOnlyList<DockLink> Links,
    int Returned);

/// <summary>A ticket's link, named as <c>PR #19002</c>, <c>gh 18941</c> or by its label (PRD R52).</summary>
public sealed record DockLink(string Label, string Url);

/// <summary>A one-part question's option and the <c>answer</c> action it posts (PRD R70).</summary>
public sealed record DockAnswer(string Label, string Description, JsonObject Action);

/// <summary>A drafted text Copy puts on the clipboard (PRD R60).</summary>
public sealed record DockPaste(string Label, string File);

/// <summary>A control a VS Code window runs, with the message the window's handler reads (PRD R71).</summary>
public sealed record DockCommand(string Label, JsonObject Command);

public sealed record TimeText(string Text, string Title);

public sealed record RowMark(string Kind, string Glyph, string Title);

public sealed record DockText(string Text, string? Title, Tone? Tone);

public enum Tone
{
    Warning,
    Error,
}

/// <summary>
/// A work item's VS Code window: the workspace file's name, the title prefix the dock finds it by, its folders, and the workspace file the hub writes
/// (PRD R71); a hub older than the dock sends no file.
/// </summary>
public sealed record DockWindow(string Name, string Title, IReadOnlyList<string> Folders, string? File = null)
{
    /// <summary>Every title VS Code gives the window starts with this, whatever editor is active.</summary>
    public string TitlePrefix => $"sb:{Name} · ";

    /// <summary>The window name a title starts with, as <c>sb:&lt;name&gt; · </c>, or null for a window that is not an item window.</summary>
    public static string? NameOf(string title)
    {
        var end = title.IndexOf(" · ", StringComparison.Ordinal);

        return title.StartsWith("sb:", StringComparison.Ordinal) && end > 3 ? title[3..end] : null;
    }
}

public sealed record DockOpen(string Type, int? WorkItemId, string? SessionId, string? Cwd, string? Url);

/// <summary>A hub control in the row's menu, with the action posted to <c>/action</c> as the hub sent it.</summary>
public sealed record DockControl(string Label, JsonObject Action);
