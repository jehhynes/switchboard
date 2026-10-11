using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

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
    string Url,
    RowMark? Mark,
    IReadOnlyList<DockText> Details,
    [property: JsonConverter(typeof(StripeConverter))] Tone? Stripe,
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
    int Returned,
    string? Band = null,
    string? MainGlyph = null,
    string? Turn = null,
    bool Dim = false,
    bool Movable = false)
{
    /// <summary>The work item ID of an <c>item:&lt;id&gt;</c> row, or null for a pool row.</summary>
    [JsonIgnore]
    public int? WorkItemId => Key.StartsWith("item:", StringComparison.Ordinal) && int.TryParse(Key.AsSpan(5), System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var id) ? id : null;
}

/// <summary>A ticket's link, named as <c>PR #19002</c>, <c>gh 18941</c> or by its label (PRD R52).</summary>
public sealed record DockLink(string Label, string Url, string Kind = "url", string? Badge = null, string? Glyph = null)
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
}

/// <summary>A one-part question's option and the <c>answer</c> action it posts (PRD R70).</summary>
public sealed record DockAnswer(string Label, string Description, JsonObject Action);

/// <summary>A drafted text Copy puts on the clipboard (PRD R60).</summary>
public sealed record DockPaste(string Label, string File);

/// <summary>A control a VS Code window runs, with the message the window's handler reads (PRD R71).</summary>
public sealed record DockCommand(string Label, JsonObject Command, string Glyph = "");

public sealed record TimeText(string Text, string Title);

public sealed record RowMark(string Kind, string Glyph, string Title);

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

/// <summary>What a row's click opens; <paramref name="Provider"/> names the agent of a session, and an older hub sends none.</summary>
public sealed record DockOpen(string Type, int? WorkItemId, string? SessionId, string? Cwd, string? Url, string? Provider = null);

/// <summary>A hub control in the row's menu, with the action posted to <c>/action</c> as the hub sent it, after <paramref name="Confirm"/> when set.</summary>
public sealed record DockControl(string Label, JsonObject Action, string Glyph = "", DockConfirm? Confirm = null);

/// <summary>A question the dock asks before it posts a control's action, such as Delete's (PRD R76); <paramref name="Action"/> labels the button that goes ahead.</summary>
public sealed record DockConfirm(string Question, string Detail, string Action);
