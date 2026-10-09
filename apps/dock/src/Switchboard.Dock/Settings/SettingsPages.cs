using System.Text.Json;
using System.Text.Json.Nodes;

namespace Switchboard.Dock.Settings;

/// <summary>A navigation entry: a heading, a namespace label, a page, or an Add button (<see cref="Command"/> <c>add-source</c> or <c>navigate</c>).</summary>
public sealed record NavEntry(string Kind, string Label, string? Command = null, string? Argument = null, string? Note = null, bool Current = false, bool Dirty = false, bool HasErrors = false);

/// <summary>A header button: <see cref="Command"/> is <c>save</c>, <c>save-all</c>, <c>revert</c>, <c>create</c>, <c>delete</c> or <c>remove-source</c>.</summary>
public sealed record PageButton(string Command, string Label, bool Enabled, bool Primary = false, string? Argument = null, string? Tip = null);

/// <summary>A field with what it shows: its text or checked state and the errors that name it.</summary>
public sealed record FieldView(Field Field, string Text, bool Checked, string Selected, IReadOnlyList<string> Errors);

public sealed record SectionView(string Heading, IReadOnlyList<FieldView> Fields);

/// <summary>
/// One page of the Settings window: its title, the file it edits, its buttons, a note (unknown source, changed on disk), the errors that name no
/// field, a message in place of fields for a file to fix by hand, and the sections. <see cref="NewName"/> is set on the New playbook page.
/// </summary>
public sealed record PageView(
    string Title,
    string? Subtitle,
    string? FilePath,
    IReadOnlyList<PageButton> Buttons,
    IReadOnlyList<string> Notes,
    IReadOnlyList<string> Errors,
    string? Message,
    IReadOnlyList<SectionView> Sections,
    NewNameView? NewName);

/// <summary>The New playbook page's name fields and the name's error, shown once a name is typed or Create was pressed.</summary>
public sealed record NewNameView(string Namespace, string Name, IReadOnlyList<string> Namespaces, string? Error);

/// <summary>What each page of the Settings window shows, from the editor state alone (PRD R54).</summary>
public static class SettingsPages
{
    const string FixByHand = "Fix the file in an editor; the editor reloads it when it changes.";

    public static IReadOnlyList<NavEntry> Nav(EditorState state)
    {
        var sources = state.SettingsValue?["sources"] is JsonObject configured ? configured.ToList() : [];
        var missing = state.Config.SourceKinds.Where((kind) => !sources.Any((entry) => entry.Key == kind));
        var names = state.Config.Playbooks.Select((entry) => entry.Name).Concat(state.PlaybookDrafts.Keys).Distinct().Order(StringComparer.Ordinal).ToList();
        List<NavEntry> nav = [new("heading", "Settings"), Item(state, "general", "Sessions and triage"), new("heading", "Sources")];

        foreach (var (name, source) in sources)
        {
            nav.Add(Item(state, $"source:{name}", SettingsFields.SourceLabel(name), source is JsonObject entry && entry["enabled"] is JsonValue on && on.GetValueKind() == JsonValueKind.True ? null : "off"));
        }

        nav.AddRange(missing.Select((kind) => new NavEntry("add", $"Add {SettingsFields.SourceLabel(kind)}", "add-source", kind)));
        nav.Add(new NavEntry("heading", "Playbooks"));

        foreach (var group in names.GroupBy((full) => full.Split(':')[0]))
        {
            nav.Add(new NavEntry("namespace", group.Key));
            nav.AddRange(group.Select((full) => Item(state, $"playbook:{full}", full.Contains(':') ? full[(full.IndexOf(':') + 1)..] : full)));
        }

        nav.Add(new NavEntry("add", "New playbook", "navigate", "new-playbook", Current: state.Page == "new-playbook"));

        return nav;
    }

    static NavEntry Item(EditorState state, string page, string label, string? note = null) =>
        new("item", label, "navigate", page, note, state.Page == page, PageDirty(state, page), PageHasErrors(state, page));

    public static bool PageHasErrors(EditorState state, string page)
    {
        if (page.StartsWith("playbook:", StringComparison.Ordinal))
        {
            var name = page["playbook:".Length..];

            return state.PlaybookErrors.GetValueOrDefault(name)?.Count > 0 || state.Refusals.GetValueOrDefault(name)?.Count > 0 || state.PlaybookFile(name)?.Error is not null;
        }

        // A refused settings save names no field, so the mark goes on Sessions and triage.
        return SettingsFields.SettingsErrorPages(state).Values.Contains(page) || (page == "general" && state.Refusals.GetValueOrDefault("settings")?.Count > 0);
    }

    public static bool PageDirty(EditorState state, string page)
    {
        if (page.StartsWith("playbook:", StringComparison.Ordinal))
        {
            return state.PlaybookDirty(page["playbook:".Length..]);
        }

        if (page == "new-playbook" || state.SettingsDraft is null)
        {
            return false;
        }

        string[] paths = page == "general" ? ["sessions", "triage"] : [$"sources.{page["source:".Length..]}"];

        return paths.Any((path) => Json(SettingsFields.GetAt(state.SettingsDraft.Value, path)) != Json(SettingsFields.GetAt(state.Config.Settings.Value, path)));
    }

    static string Json(JsonNode? node) => node?.ToJsonString() ?? "undefined";

    public static PageView Page(EditorState state)
    {
        var page = state.Page;

        if (page == "general")
        {
            return SettingsPage(state, "Sessions and triage", null, SettingsFields.GeneralFields(state), [], []);
        }

        if (page.StartsWith("source:", StringComparison.Ordinal))
        {
            var name = page["source:".Length..];
            var notes = state.Config.SourceKinds.Contains(name) ? [] : new[] { $"Switchboard has no source named {name}." };

            return SettingsPage(state, SettingsFields.SourceLabel(name), $"sources.{name}", SettingsFields.SourceFields(state, name), [new PageButton("remove-source", "Remove source", true, Argument: name)], notes);
        }

        if (page == "new-playbook")
        {
            var draft = state.NewPlaybook;
            var nameError = draft.Namespace == "" && draft.Name == "" && !draft.Touched ? null : state.NewNameError;
            var (errors, sections) = PlaybookSections(state, draft.Playbook, state.PlaybookErrors.GetValueOrDefault("new") ?? [], state.Refusals.GetValueOrDefault("new") ?? []);

            return new PageView("New playbook", null, null, [SaveAll(state), new PageButton("create", "Create", true, Primary: true)], [], errors, null, sections,
                new NewNameView(draft.Namespace, draft.Name, state.Namespaces, nameError));
        }

        var playbook = page["playbook:".Length..];
        var file = state.PlaybookFile(playbook);
        var hasDraft = state.PlaybookDrafts.TryGetValue(playbook, out var current);
        var refused = state.Refusals.GetValueOrDefault(playbook) ?? [];

        if (file is null && !hasDraft)
        {
            return new PageView(playbook, null, null, [], [], refused, "This playbook no longer exists.", [], null);
        }

        List<PageButton> delete = file is null ? [] : [new PageButton("delete", "Delete", true)];

        // An invalid file is fixed by hand; a draft started before the file broke stays editable.
        if (!hasDraft && file!.Playbook is null)
        {
            return new PageView(playbook, null, file.Path, delete, [], [file.Error ?? "The file is invalid.", .. refused], FixByHand, [], null);
        }

        var changed = hasDraft && (file is null || current!.Version != file.Version);
        var broken = hasDraft && file is not null && file.Playbook is null ? new[] { $"On disk: {file.Error ?? "The file is invalid."}" } : [];
        var (loose, fields) = PlaybookSections(state, state.PlaybookValue(playbook)!, state.PlaybookErrors.GetValueOrDefault(playbook) ?? [], [.. refused, .. broken]);

        return new PageView(playbook, null, file?.Path, [.. delete, .. SaveButtons(state, state.PlaybookDirty(playbook))], changed ? [ChangedNote(playbook, file is null)] : [], loose, null, fields, null);
    }

    static string ChangedNote(string file, bool deleted) =>
        deleted ? $"{file} was deleted on disk. Save creates it again; Revert discards your changes." : $"{file} changed on disk. Revert to load it, or Save to see the refusal.";

    static PageButton SaveAll(EditorState state) => new("save-all", "Save all", state.AnyDirty, Tip: "Save settings.json and every changed playbook");

    static IReadOnlyList<PageButton> SaveButtons(EditorState state, bool dirty) => [new("revert", "Revert", dirty), SaveAll(state), new("save", "Save", dirty, Primary: true)];

    static PageView SettingsPage(EditorState state, string title, string? subtitle, IReadOnlyList<Section> sections, IReadOnlyList<PageButton> extra, IReadOnlyList<string> notes)
    {
        var settings = state.Config.Settings;

        if (state.SettingsValue is not { } value)
        {
            return new PageView(title, subtitle, settings.Path, [], notes, [settings.Error ?? "settings.json must contain an object."], FixByHand, [], null);
        }

        var paths = SettingsFields.AllSettingsPaths(state);
        var pages = SettingsFields.SettingsErrorPages(state);
        var loose = (state.Refusals.GetValueOrDefault("settings") ?? []).Concat(state.SettingsErrors.Where((error) => pages.GetValueOrDefault(error) is null)).ToList();
        var views = sections.Select((section) => new SectionView(section.Heading, section.Fields.Select((field) =>
            FieldViewOf(field, SettingsFields.GetAt(value, field.Path), state.SettingsErrors.Where((error) => SettingsFields.FieldOfError(error, paths) == field.Path).ToList())).ToList())).ToList();
        var changed = state.SettingsDraft is not null && state.SettingsDraft.Version != settings.Version;

        return new PageView(title, subtitle, settings.Path, [.. extra, .. SaveButtons(state, state.SettingsDirty)], changed ? [.. notes, ChangedNote("settings.json", false)] : notes, loose, null, views, null);
    }

    /// <summary>The errors that name no field, led by <paramref name="extra"/>, and the playbook's fields with the errors that name each.</summary>
    static (IReadOnlyList<string> Loose, IReadOnlyList<SectionView> Sections) PlaybookSections(EditorState state, PlaybookFields playbook, IReadOnlyList<string> errors, IReadOnlyList<string> extra)
    {
        var fields = SettingsFields.PlaybookFieldsOf(state, playbook);
        var paths = fields.Select((field) => field.Path).ToList();
        var loose = extra.Concat(errors.Where((error) => SettingsFields.PlaybookFieldOfError(error, paths) is null)).ToList();
        var views = fields.Select((field) => FieldViewOf(field, SettingsFields.PlaybookFieldValue(playbook, field.Path), errors.Where((error) => SettingsFields.PlaybookFieldOfError(error, paths) == field.Path).ToList())).ToList();

        return (loose, [new SectionView("", views)]);
    }

    /// <summary>What a field shows for its value: an absent list with a default shows the default; a checkbox without a value shows its fallback.</summary>
    public static FieldView FieldViewOf(Field field, JsonNode? value, IReadOnlyList<string> errors)
    {
        var text = value is null && field.ListDefault is { } defaults
            ? string.Join('\n', defaults)
            : value switch
            {
                null => "",
                JsonArray list => string.Join('\n', list.Select((entry) => entry is JsonValue item && item.TryGetValue<string>(out var line) ? line : entry?.ToJsonString() ?? "null")),
                JsonValue item when item.TryGetValue<string>(out var plain) => plain,
                _ => value.ToJsonString(),
            };
        var isChecked = value is JsonValue flag && flag.GetValueKind() is JsonValueKind.True or JsonValueKind.False ? flag.GetValueKind() == JsonValueKind.True : field.Fallback == true;
        var selected = value is JsonValue choice && choice.TryGetValue<string>(out var chosen) ? chosen : field.Placeholder ?? "";

        return new FieldView(field, text, isChecked, selected, errors);
    }
}
