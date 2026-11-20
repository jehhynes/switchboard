using System.Text.Json.Nodes;

namespace Switchboard.Dock.Settings;

/// <summary>
/// The Settings window's behaviour (PRD R54): keeps one draft of settings.json, checks it with the hub once the operator pauses, and saves it on
/// Save. <see cref="Changed"/> says whether the window must draw the page again (true) or only update its navigation, bar, notes and errors (false),
/// so the field being typed in keeps focus.
/// </summary>
public sealed class SettingsEditor(IConfigHub hub, Func<CancellationToken, Task>? checkDelay = null, Func<Task>? enrollPoll = null)
{
    public static readonly TimeSpan CheckDelay = TimeSpan.FromMilliseconds(250);

    /// <summary>How often the window asks how a running enrolment stands.</summary>
    public static readonly TimeSpan EnrollPoll = TimeSpan.FromSeconds(1);

    readonly Func<CancellationToken, Task> delay = checkDelay ?? ((cancel) => Task.Delay(CheckDelay, cancel));
    readonly Func<Task> poll = enrollPoll ?? (() => Task.Delay(EnrollPoll));
    bool polling;
    int seq;
    int loads;
    CancellationTokenSource? pending;
    // Edits made, and the edits the last answered check covered; they differ while a check is due.
    int edits;
    int checkedEdits;
    Task<bool>? saving;

    /// <summary>Null until the first read answers.</summary>
    public EditorState? State { get; private set; }

    /// <summary>Why settings.json could not be read, or null.</summary>
    public string? Error { get; private set; }

    /// <summary>What a reload discarded, or null.</summary>
    public string? Notice { get; private set; }

    public event Action<bool>? Changed;

    /// <summary>Voiceprint enrolment as the hub last said, or null before the Voice page asked (architecture.md § Voice check and barge-in).</summary>
    public Enrollment? Enrollment { get; private set; }

    /// <summary>Why the last enrolment request was refused or failed, or null.</summary>
    public string? EnrollmentError { get; private set; }

    public event Action? EnrollmentChanged;

    /// <summary>
    /// Enroll my voice on the Voice page: <c>start</c>, <c>cancel</c> or <c>status</c>; while enrolment starts or records, asks again every
    /// <see cref="EnrollPoll"/> until it ends.
    /// </summary>
    public async Task Enroll(string action)
    {
        var reply = await hub.Enroll(action);

        EnrollmentError = reply.Error;
        Enrollment = reply.Enrollment ?? Enrollment;
        EnrollmentChanged?.Invoke();

        if (polling || Enrollment is not { Active: true })
        {
            return;
        }

        polling = true;

        try
        {
            while (Enrollment is { Active: true })
            {
                await poll();

                var status = await hub.Enroll("status");

                // A hub that stopped answering leaves the last state shown, with why.
                if (status.Enrollment is null)
                {
                    EnrollmentError = status.Error;
                    EnrollmentChanged?.Invoke();
                    break;
                }

                Enrollment = status.Enrollment;
                EnrollmentChanged?.Invoke();
            }
        }
        finally
        {
            polling = false;
        }
    }

    /// <summary>Asks before a delete, with a question, a detail and the action's button label; true to go ahead.</summary>
    public Func<string, string, string, Task<bool>>? Confirm { get; set; }

    /// <summary>Reads settings.json, as when the window opens, Discard is pressed, or the hub says the file changed on disk.</summary>
    public async Task Load()
    {
        var mine = ++loads;
        var (config, error) = await hub.ReadConfig();

        // A later read, such as after a reconnect to another config folder, already answered.
        if (mine != loads)
        {
            return;
        }

        Error = error;

        if (config is null)
        {
            Changed?.Invoke(true);
            return;
        }

        var shown = State?.PageSignature();

        if (State is null)
        {
            State = new EditorState(config);
        }
        else if (State.Config.ConfigDir != config.ConfigDir)
        {
            // The draft and its version belong to the old folder, and a save could overwrite an identical file in the new one.
            Notice = $"The config folder changed to {config.ConfigDir}. Unsaved changes were discarded.";
            State = new EditorState(config);
        }
        else
        {
            State.Refresh(config);
        }

        // A read after the window's own save changes nothing on the page; redrawing would reset the field being typed in.
        Changed?.Invoke(shown != State.PageSignature());
        await Check();
    }

    public void Navigate(string page)
    {
        if (State is null)
        {
            return;
        }

        State.Page = page;
        Changed?.Invoke(true);
    }

    /// <summary>A field's new input on the current page: its text, or a checkbox's checked state.</summary>
    public void Edit(Field field, string text, bool isChecked = false)
    {
        if (State is not { } state)
        {
            return;
        }

        var page = state.Page;

        if (page == "new-playbook")
        {
            state.NewPlaybook = state.NewPlaybook with { Playbook = SettingsFields.ApplyPlaybookField(state.NewPlaybook.Playbook, field.Path, text, isChecked) };
            Changed?.Invoke(field.Path is "kind" or "reports.approval" or "provider");
            return;
        }

        if (page.StartsWith("playbook:", StringComparison.Ordinal))
        {
            if (!SetPlaybook(state, page["playbook:".Length..], (playbook) => SettingsFields.ApplyPlaybookField(playbook, field.Path, text, isChecked)))
            {
                return;
            }
        }
        else if (page is "general" or "voice" || page.StartsWith("source:", StringComparison.Ordinal) || page.StartsWith("schedule:", StringComparison.Ordinal) || page.StartsWith("persona:", StringComparison.Ordinal))
        {
            if (state.SettingsValue is not { } value)
            {
                return;
            }

            var next = SettingsFields.SetAt(value, field.Path, SettingsFields.ReadField(field.Kind, text, isChecked, field.ListDefault is not null));

            if (field.Path.StartsWith("voice.", StringComparison.Ordinal))
            {
                next = Tidy(state, next);
            }

            if (SourceKind(field.Path) && field.Path.Split('.')[1] is var name
                && SettingsFields.SourceKind(next, name) != SettingsFields.SourceKind(value, name)
                && SettingsFields.GetAt(next, $"sources.{name}") is JsonObject source)
            {
                foreach (var key in source.Select((entry) => entry.Key).Where((key) => !SettingsFields.CommonSourceKeys.Contains(key)).ToList())
                {
                    source.Remove(key);
                }
            }

            // A weekday and a day of the month are different values, so a new period starts without the old one's day; by hand takes no time.
            if (Every(field.Path))
            {
                var schedule = field.Path[..^".every".Length];

                next = SettingsFields.SetAt(next, $"{schedule}.day", null);

                if (text == "")
                {
                    next = SettingsFields.SetAt(next, $"{schedule}.at", null);
                }
            }

            state.SetDraft(next);
        }
        else
        {
            return;
        }

        // The kind and the approval report decide which playbook fields show, the agent which modes and defaults they offer, a schedule's
        // period which of its day and time fields show, a source's kind its plugin's fields, and None on a playbook's persona removes its row.
        Edited(field.Path is "kind" or "reports.approval" or "provider" || Every(field.Path) || SourceKind(field.Path) || (field.Path.StartsWith("voice.playbookPersonas.", StringComparison.Ordinal) && text == ""));
    }

    static bool SourceKind(string path) => path.StartsWith("sources.", StringComparison.Ordinal) && path.EndsWith(".kind", StringComparison.Ordinal);

    static bool Every(string path) => path.StartsWith("schedules.", StringComparison.Ordinal) && path.EndsWith(".every", StringComparison.Ordinal);

    /// <summary>A checkbox in a namespace page's table, for one of its playbooks.</summary>
    public void EditCell(string name, string path, bool isChecked)
    {
        if (State is { } state && SetPlaybook(state, name, (playbook) => SettingsFields.ApplyPlaybookCell(playbook, path, isChecked)))
        {
            Edited(false);
        }
    }

    /// <summary>Drafts a playbook changed by <paramref name="change"/>; false when its entry cannot be read or nothing changed.</summary>
    static bool SetPlaybook(EditorState state, string name, Func<PlaybookFields, PlaybookFields> change)
    {
        if (state.SettingsValue is not { } value || state.PlaybookValue(name) is not { } current)
        {
            return false;
        }

        var next = change(current);

        if (PlaybookFields.Same(next, current))
        {
            return false;
        }

        var entry = next.ToEntry();

        // Undoing an edit restores the entry as the file holds it, so the playbook is no longer marked unsaved.
        if (state.FileEntry(name) is JsonObject file && PlaybookFields.Read(file).Fields is { } onDisk && onDisk.ToEntry().ToJsonString() == entry.ToJsonString())
        {
            entry = file.DeepClone().AsObject();
        }

        state.SetDraft(SettingsFields.WithPlaybook(value, name, entry));
        return true;
    }

    /// <summary>After a change to the draft: drops the bar's errors, updates the window, and checks the draft once the operator pauses.</summary>
    void Edited(bool redraw)
    {
        State!.BarErrors = [];
        edits++;
        Changed?.Invoke(redraw);
        CheckSoon();
    }

    /// <summary>The New source page's kind.</summary>
    public void EditNewKind(string kind)
    {
        if (State is { } state)
        {
            state.NewSource = state.NewSource with { Kind = kind };
            Changed?.Invoke(false);
        }
    }

    /// <summary>The New playbook page's namespace or name, or the New schedule or New source page's name; null leaves that part as it is.</summary>
    public void EditNewName(string? space, string? name)
    {
        if (State is not { } state)
        {
            return;
        }

        if (state.Page == "new-schedule")
        {
            state.NewSchedule = (name ?? state.NewSchedule.Name, state.NewSchedule.Touched);
            Changed?.Invoke(false);
            return;
        }

        if (state.Page == "new-source")
        {
            state.NewSource = state.NewSource with { Name = name ?? state.NewSource.Name };
            Changed?.Invoke(false);
            return;
        }

        if (state.Page == "new-persona")
        {
            state.NewPersona = (name ?? state.NewPersona.Name, state.NewPersona.Touched);
            Changed?.Invoke(false);
            return;
        }

        state.NewPlaybook = state.NewPlaybook with { Namespace = space ?? state.NewPlaybook.Namespace, Name = name ?? state.NewPlaybook.Name };
        Changed?.Invoke(false);
    }

    public void AddSource(string kind)
    {
        if (State?.SettingsValue is { } value)
        {
            State.SetDraft(SettingsFields.SetAt(value, $"sources.{kind}", new JsonObject()));
            State.Page = $"source:{kind}";
            Edited(true);
        }
    }

    /// <summary>Removes a source's settings from the draft; its work items stay, and Discard restores it.</summary>
    public void RemoveSource(string name)
    {
        if (State?.SettingsValue is { } value)
        {
            State.SetDraft(SettingsFields.SetAt(value, $"sources.{name}", null));
            State.Page = "general";
            Edited(true);
        }
    }

    /// <summary>Removes a schedule from the draft; its work items stay, and Discard restores it.</summary>
    public void RemoveSchedule(string name)
    {
        if (State?.SettingsValue is { } value)
        {
            State.SetDraft(SettingsFields.SetAt(value, $"schedules.{name}", null));
            State.Page = "general";
            Edited(true);
        }
    }

    /// <summary>
    /// Removes a persona from the draft, with the playbook assignments that name its ID unless another entry has that ID, since the hub refuses an
    /// assignment to a persona not in the roster. Discard restores it.
    /// </summary>
    public void RemovePersona(int index)
    {
        if (State is not { } state || state.SettingsValue is not { } value || index < 0 || index >= state.PersonaCount)
        {
            return;
        }

        var id = state.PersonaId(index);
        var next = SettingsFields.SetAt(value, $"voice.personas[{index}]", null);

        if (id is not null && !Enumerable.Range(0, state.PersonaCount).Any((at) => at != index && state.PersonaId(at) == id) && SettingsFields.GetAt(next, "voice.playbookPersonas") is JsonObject assigned)
        {
            foreach (var playbook in assigned.Where((entry) => entry.Value is JsonValue persona && persona.TryGetValue<string>(out var named) && named == id).Select((entry) => entry.Key).ToList())
            {
                next = SettingsFields.SetAt(next, $"voice.playbookPersonas.{playbook}", null);
            }
        }

        state.SetDraft(Tidy(state, next));
        state.Page = "voice";
        Edited(true);
    }

    /// <summary>Drops the voice containers an edit emptied that the file does not have, so creating and removing a persona leaves no change.</summary>
    static JsonObject Tidy(EditorState state, JsonObject next)
    {
        foreach (var path in new[] { "voice.personas", "voice.playbookPersonas", "voice" })
        {
            if (SettingsFields.GetAt(next, path) is JsonArray { Count: 0 } or JsonObject { Count: 0 } && SettingsFields.GetAt(state.Config.Settings.Value, path) is null)
            {
                next = SettingsFields.SetAt(next, path, null);
            }
        }

        return next;
    }

    /// <summary>Gives a playbook a persona on the Voice page; the playbook's row then offers None to remove it.</summary>
    public void AssignPersona(string playbook, string personaId)
    {
        if (State is not { } state || state.SettingsValue is not { } value || playbook == "" || !state.PersonaIds.Contains(personaId))
        {
            return;
        }

        state.SetDraft(SettingsFields.SetAt(value, $"voice.playbookPersonas.{playbook}", JsonValue.Create(personaId)));
        Edited(true);
    }

    /// <summary>
    /// Adds the New playbook page's playbook to the draft and opens its page, or on the New schedule page an empty schedule, on the New source page
    /// a source with only its kind, and on the New persona page a persona with only its ID, whose errors name the fields to fill; refuses an invalid
    /// or taken name.
    /// </summary>
    public void Create()
    {
        if (State is not { } state)
        {
            return;
        }

        if (state.Page == "new-persona")
        {
            if (state.NewPersonaError is not null)
            {
                state.NewPersona = (state.NewPersona.Name, true);
                Changed?.Invoke(false);
                return;
            }

            var id = state.NewPersona.Name.Trim();
            var index = state.PersonaCount;
            var draft = state.SettingsValue!;

            if (SettingsFields.GetAt(draft, "voice.personas") is not JsonArray)
            {
                draft = SettingsFields.SetAt(draft, "voice.personas", new JsonArray());
            }

            var personas = SettingsFields.GetAt(draft, "voice.personas")!.AsArray().DeepClone().AsArray();

            personas.Add(new JsonObject { ["id"] = id });
            state.SetDraft(SettingsFields.SetAt(draft, "voice.personas", personas));
            state.NewPersona = ("", false);
            state.Page = $"persona:{index}";
            Edited(true);
            return;
        }

        if (state.Page == "new-source")
        {
            if (state.NewSourceError is not null)
            {
                state.NewSource = state.NewSource with { Touched = true };
                Changed?.Invoke(false);
                return;
            }

            var source = state.NewSource.Name.Trim();
            var kind = state.NewSourceKind;

            state.SetDraft(SettingsFields.SetAt(state.SettingsValue!, $"sources.{source}", kind == source ? new JsonObject() : new JsonObject { ["kind"] = kind }));
            state.NewSource = ("", "", false);
            state.Page = $"source:{source}";
            Edited(true);
            return;
        }

        if (state.Page == "new-schedule")
        {
            if (state.NewScheduleError is not null)
            {
                state.NewSchedule = (state.NewSchedule.Name, true);
                Changed?.Invoke(false);
                return;
            }

            var schedule = state.NewSchedule.Name.Trim();

            state.SetDraft(SettingsFields.SetAt(state.SettingsValue!, $"schedules.{schedule}", new JsonObject()));
            state.NewSchedule = ("", false);
            state.Page = $"schedule:{schedule}";
            Edited(true);
            return;
        }

        if (state.NewNameError is not null)
        {
            state.NewPlaybook = state.NewPlaybook with { Touched = true };
            Changed?.Invoke(false);
            return;
        }

        var name = state.NewPlaybook.FullName;

        state.SetDraft(SettingsFields.WithPlaybook(state.SettingsValue!, name, state.NewPlaybook.Playbook.ToEntry()));
        state.NewPlaybook = NewPlaybook.Empty;
        state.Page = $"playbook:{name}";
        Edited(true);
    }

    /// <summary>Removes the current page's playbook from the draft after asking, naming how many open work items use it.</summary>
    public async Task Delete()
    {
        if (State is not { } state || !state.Page.StartsWith("playbook:", StringComparison.Ordinal))
        {
            return;
        }

        var name = state.Page["playbook:".Length..];

        if (!state.HasPlaybook(name))
        {
            return;
        }

        // Work items change while the window is open, so the count is read now.
        var (current, _) = await hub.ReadConfig();
        var count = (current ?? state.Config).InUse.GetValueOrDefault(name);
        var removed = "Save removes it from settings.json.";
        var detail = count == 0 ? removed : $"{count} open work {(count == 1 ? "item uses" : "items use")} it. {removed}";

        if (Confirm is null || !await Confirm($"Delete playbook {name}?", detail, "Delete") || State != state || state.SettingsValue is not { } value)
        {
            return;
        }

        state.SetDraft(SettingsFields.WithPlaybook(value, name, null));

        if (state.Page == $"playbook:{name}")
        {
            state.Page = "general";
        }

        Edited(true);
    }

    /// <summary>Drops every unsaved change and reads settings.json again.</summary>
    public async Task Discard()
    {
        if (State is not { } state)
        {
            return;
        }

        CancelCheck();
        state.DropDraft();
        state.BarErrors = [];
        Changed?.Invoke(true);
        await Load();
    }

    /// <summary>
    /// Saves the draft when it differs from the file: runs a due check first, and while a check error stands shows the errors in the bar instead.
    /// A Save during another waits for it. True when the file holds the draft.
    /// </summary>
    public async Task<bool> Save()
    {
        if (saving is { IsCompleted: false } running)
        {
            await running;
            return State is { Dirty: false };
        }

        saving = SaveDraft();
        return await saving;
    }

    async Task<bool> SaveDraft()
    {
        if (State is not { } state)
        {
            return false;
        }

        if (!state.Dirty)
        {
            return true;
        }

        // The hub refuses a draft of a file that changed on disk; the bar says to Discard.
        if (state.ChangedOnDisk)
        {
            return false;
        }

        if (checkedEdits != edits)
        {
            CancelCheck();
            await Check();
        }

        if (State != state)
        {
            return false;
        }

        if (state.Errors.Count > 0)
        {
            state.BarErrors = state.Errors;
            Changed?.Invoke(false);
            return false;
        }

        var sent = state.Draft!.DeepClone().AsObject();
        SaveReply reply;

        state.Saving = true;
        Changed?.Invoke(false);

        try
        {
            reply = await hub.SaveConfig(sent, state.DraftVersion, state.Config.ConfigDir);
        }
        finally
        {
            state.Saving = false;
        }

        if (State != state)
        {
            return false;
        }

        if (reply.Errors.Count > 0)
        {
            state.BarErrors = reply.Errors;
            Changed?.Invoke(false);
            return false;
        }

        state.BarErrors = [];

        if (reply.Version is { } version)
        {
            // Until the read answers, the file is taken to hold what was sent at the version written, so an edit made meanwhile builds on it.
            state.Wrote(sent, version);
        }
        else if (state.Draft?.ToJsonString() == sent.ToJsonString())
        {
            state.DropDraft();
        }

        Changed?.Invoke(false);
        await Load();
        return true;
    }

    void CancelCheck()
    {
        pending?.Cancel();
        pending = null;
    }

    /// <summary>Checks the draft once the operator stops typing for <see cref="CheckDelay"/>.</summary>
    void CheckSoon()
    {
        CancelCheck();

        var cancel = new CancellationTokenSource();

        pending = cancel;
        _ = Later(cancel.Token);

        async Task Later(CancellationToken token)
        {
            try
            {
                await delay(token);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            if (!token.IsCancellationRequested)
            {
                await Check();
            }
        }
    }

    /// <summary>Checks the whole draft, or the file when there is none; an answer to an older check is dropped.</summary>
    public async Task Check()
    {
        if (State is not { } state)
        {
            return;
        }

        var covered = edits;

        if (state.SettingsValue is not { } value)
        {
            state.Errors = [];
            checkedEdits = covered;
            return;
        }

        var next = ++seq;
        var errors = await hub.CheckConfig(value.DeepClone().AsObject());

        if (next != seq || State != state || errors is null)
        {
            return;
        }

        state.Errors = errors;
        checkedEdits = covered;
        Changed?.Invoke(false);
    }
}
