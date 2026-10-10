using System.Text.Json;
using System.Text.Json.Nodes;

namespace Switchboard.Dock.Settings;

/// <summary>A navigation entry: a heading, a namespace's table page, a page, or an Add button (<see cref="Command"/> <c>add-source</c> or <c>navigate</c>).</summary>
public sealed record NavEntry(string Kind, string Label, string? Command = null, string? Argument = null, string? Note = null, bool Current = false, bool Dirty = false, bool HasErrors = false);

/// <summary>A header button: <see cref="Command"/> is <c>revert</c>, <c>create</c>, <c>delete</c> or <c>remove-source</c>.</summary>
public sealed record PageButton(string Command, string Label, bool Enabled, bool Primary = false, string? Argument = null, string? Tip = null);

/// <summary>A field with what it shows: its text or checked state and the errors that name it.</summary>
public sealed record FieldView(Field Field, string Text, bool Checked, string Selected, IReadOnlyList<string> Errors);

public sealed record SectionView(string Heading, bool Advanced, IReadOnlyList<FieldView> Fields);

/// <summary>
/// One page of the Settings window: its title, the file it edits, its buttons, a note (unknown source, changed on disk), the errors that name no
/// field, a message in place of fields for a file to fix by hand, and the sections. <see cref="NewName"/> is set on the New playbook page, and
/// <see cref="Table"/> on a namespace page. <see cref="Saved"/> says whether the page's changes are saved; null on a page with no file to save.
/// </summary>
public sealed record PageView(
    string Title,
    string? FilePath,
    IReadOnlyList<PageButton> Buttons,
    IReadOnlyList<string> Notes,
    IReadOnlyList<string> Errors,
    string? Message,
    IReadOnlyList<SectionView> Sections,
    NewNameView? NewName,
    PlaybookTable? Table = null,
    SaveState? Saved = null);

/// <summary>Whether a page's files hold its changes: saved, saving once the check passes, or not saved because of an error or a refusal.</summary>
public enum SaveState
{
    Saved,
    Saving,
    NotSaved,
}

/// <summary>A namespace's playbooks, one row each, with a checkbox per column; a null cell does not apply to the row's kind or invalid file.</summary>
public sealed record PlaybookTable(IReadOnlyList<TableColumn> Columns, IReadOnlyList<TableRow> Rows);

/// <summary>A playbook's row: its full and short name, its description, its cells, and its unsaved and error state.</summary>
public sealed record TableRow(string Name, string Label, string Description, IReadOnlyList<TableCell?> Cells, bool Dirty, IReadOnlyList<string> Errors);

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
            var page = $"namespace:{group.Key}";

            nav.Add(new NavEntry("namespace", group.Key, "navigate", page, null, state.Page == page, PageDirty(state, page), PageHasErrors(state, page)));
            nav.AddRange(group.Select((full) => Item(state, $"playbook:{full}", full.Contains(':') ? full[(full.IndexOf(':') + 1)..] : full)));
        }

        nav.Add(new NavEntry("add", "New playbook", "navigate", "new-playbook", Current: state.Page == "new-playbook"));

        return nav;
    }

    static NavEntry Item(EditorState state, string page, string label, string? note = null) =>
        new("item", label, "navigate", page, note, state.Page == page, PageDirty(state, page), PageHasErrors(state, page));

    public static bool PageHasErrors(EditorState state, string page)
    {
        if (page.StartsWith("namespace:", StringComparison.Ordinal))
        {
            return state.NamespacePlaybooks(page["namespace:".Length..]).Any((name) => PageHasErrors(state, $"playbook:{name}"));
        }

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
        if (page.StartsWith("namespace:", StringComparison.Ordinal))
        {
            return state.NamespacePlaybooks(page["namespace:".Length..]).Any(state.PlaybookDirty);
        }

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
            return SettingsPage(state, "Sessions and triage", SettingsFields.GeneralFields(state), [], []);
        }

        if (page.StartsWith("source:", StringComparison.Ordinal))
        {
            var name = page["source:".Length..];
            var notes = state.Config.SourceKinds.Contains(name) ? [] : new[] { $"Switchboard has no source named {name}." };

            return SettingsPage(state, SettingsFields.SourceLabel(name), SettingsFields.SourceFields(state, name), [new PageButton("remove-source", "Remove source", true, Argument: name)], notes);
        }

        if (page.StartsWith("namespace:", StringComparison.Ordinal))
        {
            return NamespacePage(state, page["namespace:".Length..]);
        }

        if (page == "new-playbook")
        {
            var draft = state.NewPlaybook;
            var nameError = draft.Namespace == "" && draft.Name == "" && !draft.Touched ? null : state.NewNameError;
            var (errors, sections) = PlaybookSections(state, draft.Playbook, state.PlaybookErrors.GetValueOrDefault("new") ?? [], state.Refusals.GetValueOrDefault("new") ?? []);

            return new PageView("New playbook", null, [new PageButton("create", "Create", true, Primary: true)], [], errors, null, sections,
                new NewNameView(draft.Namespace, draft.Name, state.Namespaces, nameError));
        }

        var playbook = page["playbook:".Length..];
        var file = state.PlaybookFile(playbook);
        var hasDraft = state.PlaybookDrafts.TryGetValue(playbook, out var current);
        var refused = state.Refusals.GetValueOrDefault(playbook) ?? [];

        if (file is null && !hasDraft)
        {
            return new PageView(playbook, null, [], [], refused, "This playbook no longer exists.", [], null);
        }

        List<PageButton> delete = file is null ? [] : [new PageButton("delete", "Delete", true)];

        // An invalid file is fixed by hand; a draft started before the file broke stays editable.
        if (!hasDraft && file!.Playbook is null)
        {
            return new PageView(playbook, file.Path, delete, [], [file.Error ?? "The file is invalid.", .. refused], FixByHand, [], null);
        }

        var changed = hasDraft && (file is null || current!.Version != file.Version);
        var broken = hasDraft && file is not null && file.Playbook is null ? new[] { $"On disk: {file.Error ?? "The file is invalid."}" } : [];
        var (loose, fields) = PlaybookSections(state, state.PlaybookValue(playbook)!, state.PlaybookErrors.GetValueOrDefault(playbook) ?? [], [.. refused, .. broken]);

        var dirty = state.PlaybookDirty(playbook);

        return new PageView(playbook, file?.Path, [.. delete, Discard(dirty && !state.Saving.Contains(playbook))], changed ? [ChangedNote(playbook, file is null)] : [], loose, null, fields, null,
            Saved: SaveStateOf(dirty, changed || loose.Count > 0 || fields.Any((section) => section.Fields.Any((field) => field.Errors.Count > 0))));
    }

    static string ChangedNote(string file, bool deleted) =>
        deleted ? $"{file} was deleted on disk, so your changes are not saved. Discard them to close it." : $"{file} changed on disk, so your changes are not saved. Discard them to load it.";

    /// <summary>Discard, enabled for unsaved drafts whose save is not in flight, because that save writes them anyway.</summary>
    static PageButton Discard(bool enabled) => new("revert", "Discard", enabled, Tip: "Discard the changes that are not saved");

    static SaveState SaveStateOf(bool dirty, bool blocked) => !dirty ? SaveState.Saved : blocked ? SaveState.NotSaved : SaveState.Saving;

    static PageView SettingsPage(EditorState state, string title, IReadOnlyList<Section> sections, IReadOnlyList<PageButton> extra, IReadOnlyList<string> notes)
    {
        var settings = state.Config.Settings;

        if (state.SettingsValue is not { } value)
        {
            return new PageView(title, settings.Path, [], notes, [settings.Error ?? "settings.json must contain an object."], FixByHand, [], null);
        }

        var paths = SettingsFields.AllSettingsPaths(state);
        var pages = SettingsFields.SettingsErrorPages(state);
        var loose = (state.Refusals.GetValueOrDefault("settings") ?? []).Concat(state.SettingsErrors.Where((error) => pages.GetValueOrDefault(error) is null)).ToList();
        var views = sections.Select((section) => new SectionView(section.Heading, section.Advanced, section.Fields.Select((field) =>
            FieldViewOf(field, SettingsFields.GetAt(value, field.Path), state.SettingsErrors.Where((error) => SettingsFields.FieldOfError(error, paths) == field.Path).ToList())).ToList())).ToList();
        var changed = state.SettingsDraft is not null && state.SettingsDraft.Version != settings.Version;

        return new PageView(title, settings.Path, [.. extra, Discard(state.SettingsDirty && !state.Saving.Contains("settings"))], changed ? [.. notes, ChangedNote("settings.json", false)] : notes, loose, null, views, null,
            Saved: SaveStateOf(state.SettingsDirty, changed || state.SettingsErrors.Count > 0 || state.Refusals.ContainsKey("settings")));
    }

    /// <summary>The errors that name no field, led by <paramref name="extra"/>, and the playbook's fields with the errors that name each.</summary>
    static (IReadOnlyList<string> Loose, IReadOnlyList<SectionView> Sections) PlaybookSections(EditorState state, PlaybookFields playbook, IReadOnlyList<string> errors, IReadOnlyList<string> extra)
    {
        var fields = SettingsFields.PlaybookFieldsOf(state, playbook);
        var paths = fields.Select((field) => field.Path).ToList();
        var loose = extra.Concat(errors.Where((error) => SettingsFields.PlaybookFieldOfError(error, paths) is null)).ToList();
        var views = fields.Select((field) => FieldViewOf(field, SettingsFields.PlaybookFieldValue(playbook, field.Path), errors.Where((error) => SettingsFields.PlaybookFieldOfError(error, paths) == field.Path).ToList())).ToList();

        return (loose, [new SectionView("", false, views)]);
    }

    /// <summary>A namespace's playbooks as a table of their checkboxes, each row with its own errors.</summary>
    static PageView NamespacePage(EditorState state, string space)
    {
        var names = state.NamespacePlaybooks(space);
        var playbooks = names.Select((name) => (Name: name, Playbook: state.PlaybookValue(name))).ToList();
        var columns = SettingsFields.TableColumns(playbooks.Select((entry) => entry.Playbook).OfType<PlaybookFields>());
        var rows = playbooks.Select((entry) =>
        {
            var file = state.PlaybookFile(entry.Name);
            var hasDraft = state.PlaybookDrafts.TryGetValue(entry.Name, out var draft);
            var onDisk = file?.Error is { } broken ? new[] { hasDraft ? $"On disk: {broken}" : broken } : [];
            var changed = hasDraft && (file is null || draft!.Version != file.Version) ? new[] { ChangedNote(entry.Name, file is null) } : [];
            var cells = columns.Select((column) => entry.Playbook is { } playbook ? SettingsFields.Cell(playbook, column.Path) : null).ToList();
            IReadOnlyList<string> errors = [.. changed, .. onDisk, .. state.Refusals.GetValueOrDefault(entry.Name) ?? [], .. state.PlaybookErrors.GetValueOrDefault(entry.Name) ?? []];

            return new TableRow(entry.Name, entry.Name[(entry.Name.IndexOf(':') + 1)..], entry.Playbook?.Description ?? "", cells, state.PlaybookDirty(entry.Name), errors);
        }).ToList();

        if (names.Count == 0)
        {
            return new PageView($"{space} playbooks", null, [], [], [], "This namespace has no playbooks.", [], null);
        }

        var dirty = rows.Where((row) => row.Dirty).ToList();

        return new PageView($"{space} playbooks", null, [Discard(dirty.Count > 0 && !names.Any(state.Saving.Contains))], [], [], null, [], null, new PlaybookTable(columns, rows),
            SaveStateOf(dirty.Count > 0, dirty.Any((row) => row.Errors.Count > 0)));
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
