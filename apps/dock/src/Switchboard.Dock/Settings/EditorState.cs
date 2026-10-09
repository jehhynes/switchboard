using System.Text.Json.Nodes;

namespace Switchboard.Dock.Settings;

/// <summary>The playbook being created on the New playbook page; <see cref="Touched"/> once Create was pressed, so an empty name shows its error.</summary>
public sealed record NewPlaybook(string Namespace, string Name, PlaybookFields Playbook, bool Touched)
{
    public static NewPlaybook Empty => new("", "", PlaybookFields.Empty, false);

    public string FullName => $"{Namespace.Trim()}:{Name.Trim()}";
}

/// <summary>An unsaved playbook and the file version it started from.</summary>
public sealed record PlaybookDraft(PlaybookFields Playbook, string Version);

/// <summary>Unsaved settings.json and the file version it started from, null for a missing file.</summary>
public sealed record SettingsDraft(JsonObject Value, string? Version);

/// <summary>
/// The Settings window's state: the files, the page, unsaved drafts, and errors. Pages are <c>general</c>, <c>source:&lt;name&gt;</c>,
/// <c>playbook:&lt;namespace:name&gt;</c> and <c>new-playbook</c>. Errors and refusals are keyed by <c>settings</c>, a playbook name, or <c>new</c>.
/// </summary>
public sealed class EditorState(EditorConfig config)
{
    public EditorConfig Config { get; set; } = config;

    public string Page { get; set; } = "general";

    public SettingsDraft? SettingsDraft { get; set; }

    public Dictionary<string, PlaybookDraft> PlaybookDrafts { get; } = [];

    public NewPlaybook NewPlaybook { get; set; } = NewPlaybook.Empty;

    public IReadOnlyList<string> SettingsErrors { get; set; } = [];

    public Dictionary<string, IReadOnlyList<string>> PlaybookErrors { get; } = [];

    /// <summary>Why the last save, create or delete failed; kept across checks and refreshes until the next edit, revert or success.</summary>
    public Dictionary<string, IReadOnlyList<string>> Refusals { get; } = [];

    /// <summary><c>settings</c>, a playbook name, or <c>new</c>: what the current page checks and saves; null for none.</summary>
    public string? Target =>
        Page == "new-playbook" ? "new" : Page.StartsWith("playbook:", StringComparison.Ordinal) ? Page["playbook:".Length..] : Page == "general" || Page.StartsWith("source:", StringComparison.Ordinal) ? "settings" : null;

    /// <summary>The settings being edited: the draft, else the file's object, else null when the file holds no object.</summary>
    public JsonObject? SettingsValue => SettingsDraft?.Value ?? Config.Settings.Value as JsonObject;

    public bool SettingsDirty => SettingsDraft is not null && SettingsDraft.Value.ToJsonString() != (Config.Settings.Value?.ToJsonString() ?? "null");

    public PlaybookFile? PlaybookFile(string name) => Config.Playbooks.FirstOrDefault((entry) => entry.Name == name);

    public PlaybookFields? PlaybookValue(string name) => PlaybookDrafts.TryGetValue(name, out var draft) ? draft.Playbook : PlaybookFile(name)?.Playbook;

    public bool PlaybookDirty(string name) => PlaybookDrafts.TryGetValue(name, out var draft) && !PlaybookFields.Same(draft.Playbook, PlaybookFile(name)?.Playbook);

    /// <summary>Whether settings.json or any playbook has unsaved changes.</summary>
    public bool AnyDirty => SettingsDirty || PlaybookDrafts.Keys.Any(PlaybookDirty);

    /// <summary>The version a new settings draft starts from: the draft's own, even null for a missing file, so a save never overwrites a later change.</summary>
    public string? DraftVersion => SettingsDraft is null ? Config.Settings.Version : SettingsDraft.Version;

    /// <summary>Why the new playbook's name cannot be used, or null.</summary>
    public string? NewNameError
    {
        get
        {
            if (!SettingsFields.IsSegment(NewPlaybook.Namespace.Trim()) || !SettingsFields.IsSegment(NewPlaybook.Name.Trim()))
            {
                return "Namespace and name must be lowercase letters, digits and hyphens.";
            }

            return PlaybookFile(NewPlaybook.FullName) is null ? null : $"A playbook named {NewPlaybook.FullName} already exists.";
        }
    }

    /// <summary>The namespaces of the configured playbooks, sorted.</summary>
    public IReadOnlyList<string> Namespaces => Config.Playbooks.Select((entry) => entry.Name.Split(':')[0]).Distinct().Order(StringComparer.Ordinal).ToList();

    /// <summary>Takes files read again: a draft that now matches its file is saved; one whose file was deleted or broke on disk is kept, so no edit is lost.</summary>
    public void Refresh(EditorConfig config)
    {
        Config = config;

        if (SettingsDraft is not null && SettingsDraft.Value.ToJsonString() == (config.Settings.Value?.ToJsonString() ?? "null"))
        {
            SettingsDraft = null;
        }

        foreach (var (name, draft) in PlaybookDrafts.ToList())
        {
            if (PlaybookFile(name) is { } file && PlaybookFields.Same(draft.Playbook, file.Playbook))
            {
                PlaybookDrafts.Remove(name);
            }
        }
    }
}
