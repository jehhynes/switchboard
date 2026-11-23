using System.Text.Json;

namespace Switchboard.Dock;

/// <summary>
/// What the dock keeps between runs in <c>&lt;Switchboard home&gt;/dock.json</c>: its edge, monitor, width and auto-hide, and the groups
/// the operator opened or closed.
/// </summary>
public sealed class DockSettings
{
    public const double DefaultWidth = 320;
    public const double MinWidth = 200;
    public const double MaxWidth = 800;

    static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public double Width { get; set; } = DefaultWidth;

    /// <summary><c>left</c> or <c>right</c>; anything else docks on the left.</summary>
    public string Edge { get; set; } = "left";

    /// <summary>The monitor's device name, such as <c>\\.\DISPLAY2</c>, or null for the primary monitor.</summary>
    public string? Monitor { get; set; }

    /// <summary>Hides the dock to a sliver at its edge instead of reserving a strip, and shows it while the pointer is over it (PRD R71).</summary>
    public bool AutoHide { get; set; }

    public string Theme { get; set; } = "system";

    [System.Text.Json.Serialization.JsonIgnore]
    public Platform.DockEdge DockEdge => Edge == "right" ? Platform.DockEdge.Right : Platform.DockEdge.Left;

    /// <summary>
    /// The folders, newest first, that the dock's old New ad-hoc session picked outside the repo roots. The dock no longer adds to them: the hub
    /// keeps the recent folders for the dock and every page, and imports these once (PRD R122). Kept so an older file keeps them for that import.
    /// </summary>
    public List<string> RecentFolders { get; set; } = [];

    /// <summary>The Run as the New session dialog sent with a first message last, which it offers next time: `now`, `queue` or `wait` (PRD R122).</summary>
    public string NewSessionRun { get; set; } = "now";

    /// <summary>How many chosen folders <see cref="RecentFolders"/> keeps.</summary>
    public const int RecentFolderCount = 5;

    /// <summary>Groups the operator opened or closed, by key; the others take their default (PRD R27).</summary>
    public Dictionary<string, bool> Groups { get; set; } = [];

    static string PathOf(string switchboardHome) => Path.Combine(switchboardHome, "dock.json");

    /// <summary>The kept settings, or the defaults when the file is missing or unreadable; the width is kept within its limits.</summary>
    public static DockSettings Load(string switchboardHome)
    {
        DockSettings settings;

        try
        {
            settings = JsonSerializer.Deserialize<DockSettings>(File.ReadAllText(PathOf(switchboardHome)), Options) ?? new();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            settings = new();
        }

        settings.Width = double.IsFinite(settings.Width) ? Math.Clamp(settings.Width, MinWidth, MaxWidth) : DefaultWidth;
        // Done's date bands (done:<band>) start at their defaults each run (PRD R27).
        settings.Groups = (settings.Groups ?? []).Where((entry) => !entry.Key.Contains(':', StringComparison.Ordinal)).ToDictionary();
        settings.Edge = settings.Edge == "right" ? "right" : "left";
        settings.Theme = settings.Theme is "light" or "dark" or "vscode" ? settings.Theme : "system";
        settings.NewSessionRun = settings.NewSessionRun is "queue" or "wait" ? settings.NewSessionRun : "now";
        settings.RecentFolders = (settings.RecentFolders ?? []).Where((folder) => !string.IsNullOrWhiteSpace(folder)).Distinct(StringComparer.OrdinalIgnoreCase).Take(RecentFolderCount).ToList();

        return settings;
    }

    public void Save(string switchboardHome)
    {
        Directory.CreateDirectory(switchboardHome);

        var path = PathOf(switchboardHome);
        var temporary = $"{path}.{Environment.ProcessId}.tmp";

        File.WriteAllText(temporary, JsonSerializer.Serialize(this, Options));
        File.Move(temporary, path, overwrite: true);
    }
}
