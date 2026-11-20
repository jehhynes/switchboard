using System.Text.Json;
using System.Text.Json.Nodes;

namespace Switchboard.Dock.Settings;

/// <summary>A navigation entry: a heading, a namespace's table page, a page, or an Add button (<see cref="Command"/> <c>add-source</c> or <c>navigate</c>).</summary>
public sealed record NavEntry(string Kind, string Label, string? Command = null, string? Argument = null, string? Note = null, bool Current = false, bool Dirty = false, bool HasErrors = false);

/// <summary>A header button: <see cref="Command"/> is <c>create</c>, <c>delete</c> or <c>remove-source</c>.</summary>
public sealed record PageButton(string Command, string Label, bool Enabled, bool Primary = false, string? Argument = null, string? Tip = null);

/// <summary>A field with what it shows: its text or checked state and the errors that name it.</summary>
public sealed record FieldView(Field Field, string Text, bool Checked, string Selected, IReadOnlyList<string> Errors);

public sealed record SectionView(string Heading, bool Advanced, IReadOnlyList<FieldView> Fields);

/// <summary>
/// One page of the Settings window: its title, the file it edits, its buttons, notes (an unknown source), the errors that name no field, a message
/// in place of fields for an entry or file to fix by hand, and the sections. <see cref="NewName"/> is set on the New playbook page, and
/// <see cref="Table"/> on a namespace page.
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
    AssignView? Assign = null);

/// <summary>The Voice page's Assign row: the task playbooks with no persona yet and the roster's personas, or none when either list is empty.</summary>
public sealed record AssignView(IReadOnlyList<string> Playbooks, IReadOnlyList<FieldOption> Personas);

/// <summary>
/// The window-wide bar: the file's status, a warning that settings.json changed on disk, the errors of a refused or blocked save, and whether
/// Save and Discard are enabled.
/// </summary>
public sealed record BarView(string Status, string? Warning, IReadOnlyList<string> Errors, bool CanSave, bool CanDiscard);

/// <summary>A namespace's playbooks, one row each, with a checkbox per column; a null cell does not apply to the row's kind or unreadable entry.</summary>
public sealed record PlaybookTable(IReadOnlyList<TableColumn> Columns, IReadOnlyList<TableRow> Rows);

/// <summary>A playbook's row: its full and short name, its description, its cells, and its unsaved and error state.</summary>
public sealed record TableRow(string Name, string Label, string Description, IReadOnlyList<TableCell?> Cells, bool Dirty, IReadOnlyList<string> Errors);

/// <summary>
/// The New playbook, New schedule or New source page's name fields and the name's error, shown once a name is typed or Create was pressed. A
/// schedule's, source's or persona's name has no namespace (<see cref="Schedule"/>); a source also has a kind, one of <see cref="Kinds"/> as (value,
/// label); a persona's name is its ID (<see cref="Persona"/>).
/// </summary>
public sealed record NewNameView(string Namespace, string Name, IReadOnlyList<string> Namespaces, string? Error, bool Schedule = false, IReadOnlyList<(string Value, string Label)>? Kinds = null, string Kind = "", bool Persona = false);

/// <summary>What each page of the Settings window and its bar show, from the editor state alone (PRD R54).</summary>
public static class SettingsPages
{
    const string FixByHand = "Fix the file in an editor; the window reads it again when it changes.";
    const string FixEntry = "Fix this entry in settings.json in an editor, or delete it.";

    public static IReadOnlyList<NavEntry> Nav(EditorState state)
    {
        var sources = state.SettingsValue?["sources"] is JsonObject configured ? configured.ToList() : [];
        var missing = state.Config.SourceKinds.Where((kind) => !sources.Any((entry) => entry.Key == kind));
        List<NavEntry> nav = [new("heading", "Settings"), Item(state, "general", "General"), Item(state, "voice", "Voice"), new("heading", "Personas")];

        nav.AddRange(Enumerable.Range(0, state.PersonaCount).Select((index) => Item(state, $"persona:{index}", state.PersonaLabel(index))));
        nav.Add(new NavEntry("add", "New persona", "navigate", "new-persona", Current: state.Page == "new-persona"));
        nav.Add(new NavEntry("heading", "Sources"));

        foreach (var (name, _) in sources)
        {
            nav.Add(Item(state, $"source:{name}", SettingsFields.SourceTitle(state, name), state.Config.Enabled.GetValueOrDefault(name) ? null : "off"));
        }

        nav.AddRange(missing.Select((kind) => new NavEntry("add", $"Add {SettingsFields.SourceLabel(kind)}", "add-source", kind)));
        nav.Add(new NavEntry("add", "New source", "navigate", "new-source", Current: state.Page == "new-source"));
        nav.Add(new NavEntry("heading", "Schedules"));
        nav.AddRange(state.ScheduleNames.Select((name) => Item(state, $"schedule:{name}", name)));
        nav.Add(new NavEntry("add", "New schedule", "navigate", "new-schedule", Current: state.Page == "new-schedule"));
        nav.Add(new NavEntry("heading", "Playbooks"));

        foreach (var group in state.PlaybookNames.GroupBy((full) => full.Split(':')[0]))
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

            return state.PlaybookErrors(name).Count > 0 || (state.HasPlaybook(name) && state.PlaybookValue(name) is null);
        }

        return SettingsFields.SettingsErrorPages(state).Values.Contains(page);
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

        if (page is "new-playbook" or "new-schedule" or "new-source" or "new-persona" || state.Draft is null)
        {
            return false;
        }

        // The Voice page edits the voice section but the personas, which have pages of their own.
        if (page == "voice")
        {
            return Json(WithoutPersonas(state.Draft["voice"])) != Json(WithoutPersonas(state.Config.Settings.Value?["voice"]));
        }

        if (page.StartsWith("persona:", StringComparison.Ordinal))
        {
            var path = $"voice.personas[{page["persona:".Length..]}]";

            return Json(SettingsFields.GetAt(state.Draft, path)) != Json(SettingsFields.GetAt(state.Config.Settings.Value, path));
        }

        string[] paths = page == "general" ? ["sessions", "triage"]
            : page.StartsWith("schedule:", StringComparison.Ordinal) ? [$"schedules.{page["schedule:".Length..]}"]
            : [$"sources.{page["source:".Length..]}"];

        return paths.Any((path) => Json(SettingsFields.GetAt(state.Draft, path)) != Json(SettingsFields.GetAt(state.Config.Settings.Value, path)));
    }

    static string Json(JsonNode? node) => node?.ToJsonString() ?? "undefined";

    static JsonNode? WithoutPersonas(JsonNode? voice)
    {
        if (voice is not JsonObject section)
        {
            return voice;
        }

        var copy = section.DeepClone().AsObject();

        copy.Remove("personas");
        // A voice section that holds only personas is no change to this page, nor is one the file does not have.
        return copy.Count == 0 ? null : copy;
    }

    public static BarView Bar(EditorState state)
    {
        var count = state.Errors.Count;
        var status = state.Saving ? "Saving…"
            : state.SettingsValue is null ? "settings.json cannot be read"
            : string.Join(" · ", [state.Dirty ? "Unsaved changes" : "Saved", .. count == 0 ? Array.Empty<string>() : [count == 1 ? "1 error" : $"{count} errors"]]);
        var warning = state.ChangedOnDisk ? "settings.json changed on disk, so your changes cannot be saved. Discard them and open Settings again to load it." : null;

        return new BarView(status, warning, state.BarErrors, state.Dirty && !state.ChangedOnDisk && !state.Saving, (state.Dirty || state.ChangedOnDisk) && !state.Saving);
    }

    public static PageView Page(EditorState state)
    {
        var page = state.Page;

        if (page == "general")
        {
            return SettingsPage(state, "General", SettingsFields.GeneralFields(state), [], []);
        }

        if (page == "voice")
        {
            var voice = SettingsPage(state, "Voice", SettingsFields.VoiceFields(state), [], []);
            var playbooks = SettingsFields.UnassignedPlaybooks(state);
            var personas = SettingsFields.PersonaOptions(state);

            return voice with { Assign = voice.Message is null ? new AssignView(personas.Count == 0 ? [] : playbooks, personas) : null };
        }

        if (page.StartsWith("persona:", StringComparison.Ordinal))
        {
            return PersonaPage(state, page["persona:".Length..]);
        }

        if (page == "new-persona")
        {
            var (name, touched) = state.NewPersona;
            var error = name == "" && !touched ? null : state.NewPersonaError;

            return new PageView("New persona", null, [new PageButton("create", "Create", true, Primary: true)], [], [], null, [], new NewNameView("", name, [], error, Schedule: true, Persona: true));
        }

        if (page.StartsWith("source:", StringComparison.Ordinal))
        {
            var name = page["source:".Length..];
            var kind = SettingsFields.SourceKind(state, name);
            var notes = state.Config.SourceKinds.Contains(kind) ? [] : new[] { $"Switchboard has no source kind {kind}." };

            return SettingsPage(state, SettingsFields.SourceTitle(state, name), SettingsFields.SourceFields(state, name), [new PageButton("remove-source", "Remove source", true, Argument: name)], notes);
        }

        if (page == "new-source")
        {
            var (name, _, touched) = state.NewSource;
            var error = name == "" && !touched ? null : state.NewSourceError;
            var kinds = state.Config.SourceKinds.Select((kind) => (kind, SettingsFields.SourceLabel(kind))).ToList();

            return new PageView("New source", null, [new PageButton("create", "Create", true, Primary: true)], [], [], null, [],
                new NewNameView("", name, [], error, Schedule: true, Kinds: kinds, Kind: state.NewSourceKind));
        }

        if (page.StartsWith("schedule:", StringComparison.Ordinal))
        {
            var name = page["schedule:".Length..];

            return state.ScheduleNames.Contains(name)
                ? SettingsPage(state, name, SettingsFields.ScheduleFields(state, name), [new PageButton("remove-schedule", "Remove schedule", true, Argument: name)], [])
                : new PageView(name, state.Config.Settings.Path, [], [], [], "This schedule no longer exists.", [], null);
        }

        if (page == "new-schedule")
        {
            var (name, touched) = state.NewSchedule;
            var error = name == "" && !touched ? null : state.NewScheduleError;

            return new PageView("New schedule", null, [new PageButton("create", "Create", true, Primary: true)], [], [], null, [], new NewNameView("", name, [], error, Schedule: true));
        }

        if (page.StartsWith("namespace:", StringComparison.Ordinal))
        {
            return NamespacePage(state, page["namespace:".Length..]);
        }

        if (page == "new-playbook")
        {
            var draft = state.NewPlaybook;
            var nameError = draft.Namespace == "" && draft.Name == "" && !draft.Touched ? null : state.NewNameError;
            var (errors, sections) = PlaybookSections(state, draft.Playbook, []);

            return new PageView("New playbook", null, [new PageButton("create", "Create", true, Primary: true)], [], errors, null, sections,
                new NewNameView(draft.Namespace, draft.Name, state.Namespaces, nameError));
        }

        var playbook = page["playbook:".Length..];
        var path = state.Config.Settings.Path;

        if (!state.HasPlaybook(playbook))
        {
            return new PageView(playbook, path, [], [], [], "This playbook no longer exists.", [], null);
        }

        List<PageButton> delete = [new PageButton("delete", "Delete", true)];
        var errorsOf = state.PlaybookErrors(playbook);

        if (PlaybookFields.Read(state.PlaybookEntry(playbook)) is { Fields: null, Error: var readError })
        {
            return new PageView(playbook, path, delete, [], errorsOf.Count > 0 ? errorsOf : [readError!], FixEntry, [], null);
        }

        var (loose, fields) = PlaybookSections(state, state.PlaybookValue(playbook)!, errorsOf);

        return new PageView(playbook, path, delete, [], loose, null, fields, null);
    }

    /// <summary>A persona's page, by its index in <c>voice.personas</c>; an entry that is not an object shows its errors and Remove persona.</summary>
    static PageView PersonaPage(EditorState state, string at)
    {
        if (!int.TryParse(at, out var index) || index < 0 || index >= state.PersonaCount)
        {
            return new PageView("Persona", state.Config.Settings.Path, [], [], [], "This persona no longer exists.", [], null);
        }

        var remove = new PageButton("remove-persona", "Remove persona", true, Argument: at, Tip: "Removes the persona and its playbook assignments from the draft. Sessions that have it keep its ID and speak with the voice settings.");
        var title = state.PersonaId(index) is { } id ? $"Persona {id}" : $"Persona {index + 1}";
        var view = SettingsPage(state, title, SettingsFields.PersonaFields(state, index), [remove], []);

        return view.Sections.Count == 0 && view.Message is null ? view with { Message = "Fix this entry in settings.json in an editor, or remove it." } : view;
    }

    static PageView SettingsPage(EditorState state, string title, IReadOnlyList<Section> sections, IReadOnlyList<PageButton> extra, IReadOnlyList<string> notes)
    {
        var settings = state.Config.Settings;

        if (state.SettingsValue is not { } value)
        {
            return new PageView(title, settings.Path, [], notes, [settings.Error ?? "settings.json must contain an object."], FixByHand, [], null);
        }

        var paths = SettingsFields.AllSettingsPaths(state);
        var errors = state.SettingsErrors;
        var pages = SettingsFields.SettingsErrorPages(state);
        // Errors on no page show on every settings page; one that names no field but belongs to this page, such as a persona that is not an object, shows here.
        var loose = errors.Where((error) => pages.GetValueOrDefault(error) is not { } on || (on == state.Page && SettingsFields.FieldOfError(error, paths) is null)).ToList();
        var views = sections.Select((section) => new SectionView(section.Heading, section.Advanced, section.Fields.Select((field) =>
            FieldViewOf(field, SettingsFields.GetAt(value, field.Path), errors.Where((error) => SettingsFields.FieldOfError(error, paths) == field.Path).ToList())).ToList())).ToList();

        return new PageView(title, settings.Path, extra, notes, loose, null, views, null);
    }

    /// <summary>The errors that name no field, and the playbook's fields with the errors that name each.</summary>
    static (IReadOnlyList<string> Loose, IReadOnlyList<SectionView> Sections) PlaybookSections(EditorState state, PlaybookFields playbook, IReadOnlyList<string> errors)
    {
        var fields = SettingsFields.PlaybookFieldsOf(state, playbook);
        var paths = fields.Select((field) => field.Path).ToList();
        var loose = errors.Where((error) => SettingsFields.PlaybookFieldOfError(error, paths) is null).ToList();
        var views = fields.Select((field) => FieldViewOf(field, SettingsFields.PlaybookFieldValue(playbook, field.Path), errors.Where((error) => SettingsFields.PlaybookFieldOfError(error, paths) == field.Path).ToList())).ToList();

        return (loose, [new SectionView("", false, views)]);
    }

    /// <summary>A namespace's playbooks as a table of their checkboxes, each row with its own errors.</summary>
    static PageView NamespacePage(EditorState state, string space)
    {
        var names = state.NamespacePlaybooks(space);

        if (names.Count == 0)
        {
            return new PageView($"{space} playbooks", null, [], [], [], "This namespace has no playbooks.", [], null);
        }

        var playbooks = names.Select((name) => (Name: name, Read: PlaybookFields.Read(state.PlaybookEntry(name)))).ToList();
        var columns = SettingsFields.TableColumns(playbooks.Select((entry) => entry.Read.Fields).OfType<PlaybookFields>());
        var rows = playbooks.Select((entry) =>
        {
            var cells = columns.Select((column) => entry.Read.Fields is { } playbook ? SettingsFields.Cell(playbook, column.Path) : null).ToList();
            var errors = state.PlaybookErrors(entry.Name);

            return new TableRow(entry.Name, entry.Name[(entry.Name.IndexOf(':') + 1)..], entry.Read.Fields?.Description ?? "", cells, state.PlaybookDirty(entry.Name),
                errors.Count == 0 && entry.Read.Error is { } unread ? [unread] : errors);
        }).ToList();

        return new PageView($"{space} playbooks", null, [], [], [], null, [], null, new PlaybookTable(columns, rows));
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
