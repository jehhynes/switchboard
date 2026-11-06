using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Switchboard.Dock.Hub;

// The hub's dock view (architecture.md § Dock), built by `dockView` in packages/hub/src/dock.ts; the dock adds no rules of its own.

public sealed record DockView(IReadOnlyList<string> Notes, IReadOnlyList<DockGroup> Groups, IReadOnlyList<SnoozeChoice> Snooze, IReadOnlyList<SourceGroup> Sources, IReadOnlyList<string> RepoRoots, IReadOnlyList<ScheduleEntry>? Schedules = null, OpenWindows? Windows = null, string? Theme = null)
{
    static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) } };

    public static DockView Parse(string json) => JsonSerializer.Deserialize<DockView>(json, Options) ?? throw new JsonException("The dock view is null.");
}

/// <summary>
/// The VS Code windows connected to the hub: each item window's workspace file, the one in front, and how many windows there are, item windows or not.
/// The dock follows them where it cannot see other apps' windows (architecture.md § Dock).
/// </summary>
public sealed record OpenWindows(IReadOnlyList<string> Open, string? Front, int Count);

/// <summary>A schedule Run now can start, and the playbook it runs (PRD R82).</summary>
public sealed record ScheduleEntry(string Name, string Playbook);

/// <summary>A configured source and whether it is polled (PRD R3).</summary>
public sealed record SourceState(string Name, bool Enabled);

/// <summary>
/// One header icon: the sources of one kind, such as <c>github</c>, on while any of them is polled, and its tooltip. A kind with several sources
/// opens a menu instead of toggling (PRD R71).
/// </summary>
public sealed record SourceGroup(string Kind, bool Enabled, string Title, IReadOnlyList<SourceState> Sources, string? Name = null)
{
    /// <summary>
    /// The group, or for a hub older than source groups, whose entries are one source each (<c>{name, enabled}</c>), a group of that source alone,
    /// so the dock keeps working until the hub restarts.
    /// </summary>
    public SourceGroup Current => Sources is not null && Kind is not null
        ? this
        : new(Name ?? "", Enabled, $"{Name}: {(Enabled ? "polled. Click to stop polling it." : "not polled. Click to poll it.")}", [new SourceState(Name ?? "", Enabled)]);
}

/// <summary>A snooze choice: its wake time as epoch milliseconds, or null to snooze until restored (PRD R49).</summary>
public sealed record SnoozeChoice(string Label, string Description, long? Until);

/// <summary>A group of rows, with its codicon glyph and, for Ready for review, how many of its rows are on the operator's turn.</summary>
public sealed record DockGroup(string Key, string Title, string? Empty, IReadOnlyList<DockRow> Rows, string Glyph = "");

public sealed record DockRow(
    string Key,
    string Title,
    string? Priority,
    TimeText? Time,
    string Playbook,
    string Ticket,
    string Source,
    string SourceKind,
    string Url,
    RowMark? Mark,
    IReadOnlyList<DockText> Details,
    [property: JsonConverter(typeof(StripeConverter))] Tone? Stripe,
    DockWindow? Window,
    DockOpen? Open,
    IReadOnlyList<DockControl> Controls,
    string? Main,
    string? MainTitle,
    IReadOnlyList<DockPaste> Pastes,
    IReadOnlyList<DockCommand> Commands,
    string Search,
    IReadOnlyList<DockLink> Links,
    int Returned,
    string? Band = null,
    string? MainGlyph = null,
    string? Turn = null,
    bool Dim = false,
    bool Movable = false,
    DockTerminal? Terminal = null,
    RowComment? Comment = null)
{
    /// <summary>The work item ID of an <c>item:&lt;id&gt;</c> row, or null for a pool row.</summary>
    [JsonIgnore]
    public int? WorkItemId => Key.StartsWith("item:", StringComparison.Ordinal) && int.TryParse(Key.AsSpan(5), System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var id) ? id : null;
}

/// <summary>A ticket's link, named as <c>PR #19002</c>, <c>gh 18941</c> or by its label (PRD R52); <c>Mentioned</c> when the ticket's text names it (PRD R61).</summary>
public sealed record DockLink(string Label, string Url, string Kind = "url", string? Badge = null, string? Glyph = null, bool Mentioned = false)
{
    [JsonIgnore]
    public bool IsPullRequest => Kind == "pr";

    [JsonIgnore]
    public bool IsIssue => Kind == "issue";

    [JsonIgnore]
    public bool HasGlyph => Glyph is not null;

    /// <summary>The pill's text: the badge, or the menu name from a hub older than badges.</summary>
    [JsonIgnore]
    public string Text => Badge ?? Label;

    [JsonIgnore]
    public string Tooltip => Mentioned ? $"Named in the ticket: {Url}" : Url;
}

/// <summary>A drafted text Copy puts on the clipboard (PRD R60).</summary>
public sealed record DockPaste(string Label, string File);

/// <summary>A control a VS Code window runs, with the message the window's handler reads (PRD R71).</summary>
public sealed record DockCommand(string Label, JsonObject Command, string Glyph = "");

public sealed record TimeText(string Text, string Title);

public sealed record RowMark(string Kind, string Glyph, string Title);

/// <summary>Line 2's comment icon, with the work item's comments as its tooltip (PRD R87).</summary>
public sealed record RowComment(string Glyph, string Title);

public sealed record DockText(string Text, string? Title, Tone? Tone);

/// <summary>A text's colour, or a row stripe's: <c>turn</c> marks the operator's turn (PRD R27).</summary>
public enum Tone
{
    Warning,
    Error,
    Turn,
}

/// <summary>Reads a stripe, and an unknown one as none, such as the <c>agent</c> stripe an older hub sends.</summary>
sealed class StripeConverter : JsonConverter<Tone?>
{
    public override bool HandleNull => true;

    public override Tone? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.TokenType == JsonTokenType.String && Enum.TryParse<Tone>(reader.GetString(), ignoreCase: true, out var tone) ? tone : null;

    public override void Write(Utf8JsonWriter writer, Tone? value, JsonSerializerOptions options)
    {
        if (value is { } tone)
        {
            writer.WriteStringValue(JsonNamingPolicy.CamelCase.ConvertName(tone.ToString()));
        }
        else
        {
            writer.WriteNullValue();
        }
    }
}

/// <summary>
/// A work item's VS Code window: the workspace file's name, which the window title ends with as <c>sb:&lt;name&gt;</c>, the ticket title, its folders,
/// and the workspace file the hub writes (PRD R71); a hub older than the dock sends no file.
/// </summary>
public sealed partial record DockWindow(string Name, string Title, IReadOnlyList<string> Folders, string? File = null)
{
    /// <summary>
    /// The window name in the last <c>sb:&lt;name&gt;</c> at the start of a title or after <c> · </c>, or null for a window that is not an item window.
    /// VS Code can add a debugger mark before the title, and the editor state for a screen reader or <c> [Administrator]</c> after it.
    /// </summary>
    public static string? NameOf(string title) => NamePattern().Match(title) is { Success: true } match ? match.Groups[1].Value : null;

    [GeneratedRegex(@"(?:^| · )sb:([A-Za-z0-9._-]+)(?= |$)", RegexOptions.RightToLeft)]
    private static partial Regex NamePattern();
}

/// <summary>
/// What a row's click opens; <paramref name="Provider"/> names the agent of a session, and an older hub sends none. A <c>terminal</c> open carries a
/// <see cref="DockTerminal"/>'s fields, and a <c>select</c> open only selects the row (PRD R71).
/// </summary>
public sealed record DockOpen(
    string Type,
    int? WorkItemId,
    string? SessionId,
    string? Cwd,
    string? Url,
    string? Provider = null,
    IReadOnlyList<string>? Args = null,
    string? Name = null,
    string? Title = null,
    DockHandoff? Handoff = null,
    bool Active = false,
    string? Executable = null)
{
    /// <summary>The terminal a <c>terminal</c> open names, or null.</summary>
    [JsonIgnore]
    public DockTerminal? Terminal =>
        Type == "terminal" && Provider is { } provider && SessionId is { } sessionId && Cwd is { } cwd && Args is { } args && Name is { } name && Title is { } title
            ? new DockTerminal(provider, sessionId, cwd, args, name, title, Handoff, Active, Executable)
            : null;
}

/// <summary>
/// A session's terminal window (PRD R28, R71): the agent's CLI <paramref name="Executable"/> with <paramref name="Args"/> in <paramref name="Cwd"/>,
/// in a window titled <paramref name="Title"/>, which ends with <c>sb:&lt;name&gt;</c>. <paramref name="Handoff"/> is Open in Codex's stop, which
/// runs first (PRD R70); <paramref name="Active"/> marks a session resumed elsewhere, which only its open terminal or its item window shows.
/// </summary>
public sealed record DockTerminal(string Provider, string SessionId, string Cwd, IReadOnlyList<string> Args, string Name, string Title, DockHandoff? Handoff = null, bool Active = false, string? Executable = null);

/// <summary>The work item and session of Open in Codex's stop before a Codex question opens in a terminal (PRD R70).</summary>
public sealed record DockHandoff(int WorkItemId, string SessionId);

/// <summary>
/// A hub control in the row's menu, with the action posted to <c>/action</c> as the hub sent it, after <paramref name="Confirm"/> when set, or with
/// the text <paramref name="Input"/> asks for.
/// </summary>
public sealed record DockControl(string Label, JsonObject Action, string Glyph = "", DockConfirm? Confirm = null, DockInput? Input = null);

/// <summary>
/// A text the dock asks for before it posts a control's action, set as the action's <paramref name="Field"/>, such as Start's guidance (PRD R77),
/// with <paramref name="Choice"/> asked beside it and <paramref name="Text"/> in the box at first, such as an ad-hoc prompt.
/// </summary>
public sealed record DockInput(string Question, string Detail, string Field, string Action, DockChoice? Choice = null, string? Text = null);

/// <summary>A list of <paramref name="Values"/> with <paramref name="Value"/> selected; a changed choice is set as the action's <paramref name="Field"/>, such as Start's playbook (PRD R35).</summary>
public sealed record DockChoice(string Field, string Label, string Value, IReadOnlyList<string> Values);

/// <summary>A question the dock asks before it posts a control's action, such as Delete's (PRD R76); <paramref name="Action"/> labels the button that goes ahead.</summary>
public sealed record DockConfirm(string Question, string Detail, string Action);
