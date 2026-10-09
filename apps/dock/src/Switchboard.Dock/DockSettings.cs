using System.Text.Json;

namespace Switchboard.Dock;

/// <summary>What the dock keeps between runs in <c>&lt;Switchboard home&gt;/dock.json</c>: its width and the groups the operator opened or closed.</summary>
public sealed class DockSettings
{
    public const double DefaultWidth = 320;
    public const double MinWidth = 200;
    public const double MaxWidth = 800;

    static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public double Width { get; set; } = DefaultWidth;

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
        settings.Groups ??= [];

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
