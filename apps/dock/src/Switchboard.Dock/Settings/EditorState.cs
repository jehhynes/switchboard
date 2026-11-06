using System.Text.Json.Nodes;

namespace Switchboard.Dock.Settings;

/// <summary>The playbook being created on the New playbook page; <see cref="Touched"/> once Create was pressed, so an empty name shows its error.</summary>
public sealed record NewPlaybook(string Namespace, string Name, PlaybookFields Playbook, bool Touched)
{
    public static NewPlaybook Empty => new("", "", PlaybookFields.Empty, false);

    public string FullName => $"{Namespace.Trim()}:{Name.Trim()}";
}

/// <summary>
/// The Settings window's state: settings.json as read, one unsaved draft of the whole file with the version it started from, the page, and the
/// errors. Pages are <c>general</c>, <c>source:&lt;name&gt;</c>, <c>new-source</c>, <c>schedule:&lt;name&gt;</c>, <c>new-schedule</c>, <c>namespace:&lt;namespace&gt;</c>,
/// <c>playbook:&lt;namespace:name&gt;</c> and <c>new-playbook</c>.
/// </summary>
public sealed class EditorState(EditorConfig config)
{
    public EditorConfig Config { get; set; } = config;

    public string Page { get; set; } = "general";

    /// <summary>The unsaved settings.json, or null when there are no unsaved changes.</summary>
    public JsonObject? Draft { get; private set; }

    /// <summary>The file version the draft started from, null for a missing file.</summary>
    public string? DraftVersion { get; private set; }

    public NewPlaybook NewPlaybook { get; set; } = NewPlaybook.Empty;

    /// <summary>The name typed and kind chosen on the New source page, empty for the first kind, and whether Create was pressed.</summary>
    public (string Name, string Kind, bool Touched) NewSource { get; set; } = ("", "", false);

    /// <summary>The New source page's kind: the one chosen, else the first the hub offers.</summary>
    public string NewSourceKind => NewSource.Kind != "" ? NewSource.Kind : Config.SourceKinds.FirstOrDefault() ?? "";

    /// <summary>The name typed on the New schedule page, and whether Create was pressed, so an empty name shows its error.</summary>
    public (string Name, bool Touched) NewSchedule { get; set; } = ("", false);

    /// <summary>The last check's errors for the whole draft.</summary>
    public IReadOnlyList<string> Errors { get; set; } = [];

    /// <summary>A refused save's errors, or the check errors that stopped a save; shown in the bar until the next edit, discard or successful save.</summary>
    public IReadOnlyList<string> BarErrors { get; set; } = [];

    public bool Saving { get; set; }

    /// <summary>The settings being edited: the draft, else the file's object, else null when the file holds no object.</summary>
    public JsonObject? SettingsValue => Draft ?? Config.Settings.Value as JsonObject;

    /// <summary>Replaces the draft; the first change records the file version it starts from.</summary>
    public void SetDraft(JsonObject value)
    {
        if (Draft is null)
        {
            DraftVersion = Config.Settings.Version;
        }

        Draft = value;
    }

    public void DropDraft()
    {
        Draft = null;
        DraftVersion = null;
    }

    public bool Dirty => Draft is not null && Draft.ToJsonString() != (Config.Settings.Value?.ToJsonString() ?? "null");

    /// <summary>Whether settings.json changed on disk after the draft started, so the hub refuses to save the draft.</summary>
    public bool ChangedOnDisk => Draft is not null && DraftVersion != Config.Settings.Version;

    /// <summary>The playbook names in the settings being edited, sorted.</summary>
    public IReadOnlyList<string> PlaybookNames => SettingsValue?["playbooks"] is JsonObject playbooks ? playbooks.Select((entry) => entry.Key).Order(StringComparer.Ordinal).ToList() : [];

    public JsonNode? PlaybookEntry(string name) => SettingsValue?["playbooks"] is JsonObject playbooks ? playbooks[name] : null;

    public bool HasPlaybook(string name) => SettingsValue?["playbooks"] is JsonObject playbooks && playbooks.ContainsKey(name);

    public JsonNode? FileEntry(string name) => Config.Settings.Value?["playbooks"] is JsonObject playbooks ? playbooks[name] : null;

    /// <summary>A playbook's fields, or null when it is absent or its entry cannot be read.</summary>
    public PlaybookFields? PlaybookValue(string name) => HasPlaybook(name) ? PlaybookFields.Read(PlaybookEntry(name)).Fields : null;

    public bool PlaybookDirty(string name) => Draft is not null && Json(PlaybookEntry(name), HasPlaybook(name)) != Json(FileEntry(name), Config.Settings.Value?["playbooks"] is JsonObject file && file.ContainsKey(name));

    static string Json(JsonNode? node, bool present) => present ? node?.ToJsonString() ?? "null" : "absent";

    /// <summary>The playbooks of a namespace, sorted.</summary>
    public IReadOnlyList<string> NamespacePlaybooks(string space) => PlaybookNames.Where((name) => name.Split(':')[0] == space).ToList();

    /// <summary>The namespaces of the playbooks, sorted.</summary>
    public IReadOnlyList<string> Namespaces => PlaybookNames.Select((name) => name.Split(':')[0]).Distinct().ToList();

    static string Prefix(string name) => $"playbooks.{name}: ";

    /// <summary>The check errors of one playbook, without their <c>playbooks.&lt;name&gt;: </c> prefix.</summary>
    public IReadOnlyList<string> PlaybookErrors(string name) =>
        Errors.Where((error) => error.StartsWith(Prefix(name), StringComparison.Ordinal)).Select((error) => error[Prefix(name).Length..]).ToList();

    /// <summary>The check errors that belong to no playbook in the draft.</summary>
    public IReadOnlyList<string> SettingsErrors
    {
        get
        {
            var prefixes = PlaybookNames.Select(Prefix).ToList();

            return Errors.Where((error) => !prefixes.Any((prefix) => error.StartsWith(prefix, StringComparison.Ordinal))).ToList();
        }
    }

    /// <summary>What the current page shows from the file and draft; equal before and after a read when the read changes nothing there.</summary>
    public string PageSignature() => string.Join('\n', Page, Config.ConfigDir, SettingsValue?.ToJsonString(), Config.Settings.Path, Config.Settings.Error);

    /// <summary>The schedule names in the settings being edited, in file order.</summary>
    public IReadOnlyList<string> ScheduleNames => SettingsValue?["schedules"] is JsonObject schedules ? schedules.Select((entry) => entry.Key).ToList() : [];

    /// <summary>The source names in the settings being edited, in file order.</summary>
    public IReadOnlyList<string> SourceNames => SettingsValue?["sources"] is JsonObject sources ? sources.Select((entry) => entry.Key).ToList() : [];

    /// <summary>Why the new source's name cannot be used, or null.</summary>
    public string? NewSourceError
    {
        get
        {
            var name = NewSource.Name.Trim();

            if (!SettingsFields.IsSegment(name))
            {
                return "The name must be lowercase letters, digits and hyphens.";
            }

            if (name is "schedule" or "adhoc")
            {
                return $"{name} names Switchboard's own tickets; choose another name.";
            }

            if (SettingsValue is not { } value || (value["sources"] is { } sources && sources is not JsonObject))
            {
                return "settings.json must hold an object with a sources object.";
            }

            return SourceNames.Contains(name) ? $"A source named {name} already exists." : null;
        }
    }

    /// <summary>Why the new schedule's name cannot be used, or null.</summary>
    public string? NewScheduleError
    {
        get
        {
            var name = NewSchedule.Name.Trim();

            if (!SettingsFields.IsSegment(name))
            {
                return "The name must be lowercase letters, digits and hyphens.";
            }

            if (SettingsValue is not { } value || (value["schedules"] is { } schedules && schedules is not JsonObject))
            {
                return "settings.json must hold an object with a schedules object.";
            }

            return ScheduleNames.Contains(name) ? $"A schedule named {name} already exists." : null;
        }
    }

    /// <summary>Why the new playbook's name cannot be used, or null.</summary>
    public string? NewNameError
    {
        get
        {
            if (!SettingsFields.IsSegment(NewPlaybook.Namespace.Trim()) || !SettingsFields.IsSegment(NewPlaybook.Name.Trim()))
            {
                return "Namespace and name must be lowercase letters, digits and hyphens.";
            }

            if (SettingsValue is not { } value || (value["playbooks"] is { } playbooks && playbooks is not JsonObject))
            {
                return "settings.json must hold an object with a playbooks object.";
            }

            return HasPlaybook(NewPlaybook.FullName) ? $"A playbook named {NewPlaybook.FullName} already exists." : null;
        }
    }

    /// <summary>Takes a successful save of <paramref name="sent"/> at <paramref name="version"/>; a draft edited since continues from that version.</summary>
    public void Wrote(JsonObject sent, string version)
    {
        Config = Config with { Settings = Config.Settings with { Version = version, Value = sent.DeepClone(), Error = null } };

        if (Draft is not null && Draft.ToJsonString() == sent.ToJsonString())
        {
            DropDraft();
        }
        else if (Draft is not null)
        {
            DraftVersion = version;
        }
    }

    /// <summary>
    /// Takes the file read again. A draft that matches the old or the new file holds no edit and is dropped, so the page shows the new file; any
    /// other draft is kept, so no edit is lost.
    /// </summary>
    public void Refresh(EditorConfig config)
    {
        var unchanged = !Dirty;

        Config = config;

        if (unchanged || !Dirty)
        {
            DropDraft();
        }
    }
}
