using System.Text.Json.Nodes;

namespace Switchboard.Dock.Settings;

/// <summary>
/// The Settings window's behaviour (PRD R54): keeps drafts, checks each edited file with the hub once the operator pauses, saves it when the check
/// passes, and creates and deletes playbooks through the hub, which writes the files. <see cref="Changed"/> says whether the window must draw the
/// page again (true) or only update its navigation, buttons, notes and errors (false), so the field being typed in keeps focus.
/// </summary>
public sealed class SettingsEditor(IConfigHub hub, Func<CancellationToken, Task>? checkDelay = null)
{
    public static readonly TimeSpan CheckDelay = TimeSpan.FromMilliseconds(250);

    readonly Func<CancellationToken, Task> delay = checkDelay ?? ((cancel) => Task.Delay(CheckDelay, cancel));
    readonly Dictionary<string, int> latest = [];
    int seq;
    int loads;
    CancellationTokenSource? pending;
    // The files edited since the last check, which the pending check covers.
    readonly HashSet<string> edited = [];
    // The saves in flight by file, and the files edited again while theirs was in flight.
    readonly Dictionary<string, Task> saving = [];
    readonly HashSet<string> again = [];

    /// <summary>Null until the first read answers.</summary>
    public EditorState? State { get; private set; }

    /// <summary>Why the files could not be read, or null.</summary>
    public string? Error { get; private set; }

    /// <summary>What a reload discarded, or null.</summary>
    public string? Notice { get; private set; }

    public event Action<bool>? Changed;

    /// <summary>Asks before a delete or a source's removal, with a question, a detail and the action's button label; true to go ahead.</summary>
    public Func<string, string, string, Task<bool>>? Confirm { get; set; }

    /// <summary>Reads the files, as when the window opens or the hub says they changed on disk.</summary>
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
            // Drafts and versions belong to the old folder, and a save could overwrite an identical file in the new one.
            Notice = $"The config folder changed to {config.ConfigDir}. Unsaved changes were discarded.";
            State = new EditorState(config);
        }
        else
        {
            State.Refresh(config);
        }

        // A read after the window's own save, or the hub's notice of it, changes nothing on the page; redrawing would reset the field being typed in.
        Changed?.Invoke(shown != State.PageSignature());
        await Check();
    }

    public async Task Navigate(string page)
    {
        if (State is null)
        {
            return;
        }

        State.Page = page;
        Changed?.Invoke(true);
        await Check();
    }

    /// <summary>A field's new input: its text, or a checkbox's checked state.</summary>
    public void Edit(Field field, string text, bool isChecked = false)
    {
        if (State is not { } state || state.Target is not { } target)
        {
            return;
        }

        if (target == "settings")
        {
            if (state.SettingsValue is not { } value)
            {
                return;
            }

            state.SettingsDraft = new SettingsDraft(SettingsFields.SetAt(value, field.Path, SettingsFields.ReadField(field.Kind, text, isChecked, field.ListDefault is not null)), state.DraftVersion);
        }
        else if (target == "new")
        {
            state.NewPlaybook = state.NewPlaybook with { Playbook = SettingsFields.ApplyPlaybookField(state.NewPlaybook.Playbook, field.Path, text, isChecked) };
        }
        else if (!Draft(state, target, (playbook) => SettingsFields.ApplyPlaybookField(playbook, field.Path, text, isChecked)))
        {
            return;
        }

        state.Refusals.Remove(target);
        // The kind and the approval report decide which playbook fields show.
        Changed?.Invoke(field.Path is "kind" or "reports.approval");
        CheckSoon(target);
    }

    /// <summary>A checkbox in a namespace page's table, for one of its playbooks.</summary>
    public void EditCell(string name, string path, bool isChecked)
    {
        if (State is not { } state || !Draft(state, name, (playbook) => SettingsFields.ApplyPlaybookCell(playbook, path, isChecked)))
        {
            return;
        }

        state.Refusals.Remove(name);
        Changed?.Invoke(false);
        CheckSoon(name);
    }

    /// <summary>Drafts a playbook changed by <paramref name="change"/>; false when it has neither a valid file nor a draft.</summary>
    static bool Draft(EditorState state, string name, Func<PlaybookFields, PlaybookFields> change)
    {
        var file = state.PlaybookFile(name);
        var hasDraft = state.PlaybookDrafts.TryGetValue(name, out var draft);

        if (state.PlaybookValue(name) is not { } current || (!hasDraft && file is null))
        {
            return false;
        }

        state.PlaybookDrafts[name] = new PlaybookDraft(change(current), draft?.Version ?? file!.Version);
        return true;
    }

    /// <summary>The New playbook page's namespace or name; null leaves that part as it is.</summary>
    public void EditNewName(string? space, string? name)
    {
        if (State is not { } state)
        {
            return;
        }

        state.NewPlaybook = state.NewPlaybook with { Namespace = space ?? state.NewPlaybook.Namespace, Name = name ?? state.NewPlaybook.Name };
        state.Refusals.Remove("new");
        Changed?.Invoke(false);
        CheckSoon("new");
    }

    public async Task AddSource(string kind)
    {
        if (State?.SettingsValue is { } value)
        {
            State.SettingsDraft = new SettingsDraft(SettingsFields.SetAt(value, $"sources.{kind}", new JsonObject { ["enabled"] = false }), State.DraftVersion);
            await Navigate($"source:{kind}");
        }
    }

    /// <summary>Removes a source's settings after asking; its work items stay.</summary>
    public async Task RemoveSource(string name)
    {
        var label = SettingsFields.SourceLabel(name);

        if (State?.SettingsValue is { } value && Confirm is not null && await Confirm($"Remove {label}?", $"Its settings are deleted from settings.json. Its work items stay.", "Remove"))
        {
            State.SettingsDraft = new SettingsDraft(SettingsFields.SetAt(value, $"sources.{name}", null), State.DraftVersion);
            await Navigate("general");
        }
    }

    /// <summary>Discards the current page's unsaved drafts and their refusals.</summary>
    public async Task Revert()
    {
        if (State is not { } state)
        {
            return;
        }

        foreach (var target in state.Targets)
        {
            state.Refusals.Remove(target);
            edited.Remove(target);

            if (target == "settings")
            {
                state.SettingsDraft = null;
            }
            else
            {
                state.PlaybookDrafts.Remove(target);
            }
        }

        Changed?.Invoke(true);
        await Check();
    }

    /// <summary>Runs the pending check and its saves now, and waits for the saves in flight, as before the window closes.</summary>
    public async Task Flush()
    {
        if (State is not { } state)
        {
            return;
        }

        CancelCheck();

        var targets = edited.ToList();

        edited.Clear();
        await Task.WhenAll(targets.Select((target) => Check(state, target)));

        while (saving.Count > 0)
        {
            await Task.WhenAll(saving.Values.ToList());
        }
    }

    /// <summary>Whether a file's draft can be saved: it differs from the file and starts from the file's current version.</summary>
    static bool Saveable(EditorState state, string target)
    {
        if (target == "settings")
        {
            return state.SettingsDirty && state.SettingsDraft!.Version == state.Config.Settings.Version;
        }

        return target != "new" && state.PlaybookDirty(target) && state.PlaybookFile(target) is { } file && state.PlaybookDrafts[target].Version == file.Version;
    }

    /// <summary>Saves a file whose check passed; one save per file at a time, and an edit made during it is checked and saved after it.</summary>
    async Task AutoSave(EditorState state, string target)
    {
        if (!Saveable(state, target))
        {
            return;
        }

        if (saving.ContainsKey(target))
        {
            again.Add(target);
            return;
        }

        var save = SaveFile(state, target);

        saving[target] = save;
        state.Saving.Add(target);
        Changed?.Invoke(false);

        try
        {
            await save;
        }
        finally
        {
            saving.Remove(target);
            state.Saving.Remove(target);
            Changed?.Invoke(false);
        }

        if (again.Remove(target) && State == state)
        {
            await Check(state, target);
        }
    }

    async Task SaveFile(EditorState state, string target)
    {
        JsonObject body;

        if (target == "settings")
        {
            body = new JsonObject { ["target"] = "settings", ["value"] = state.SettingsDraft!.Value.DeepClone(), ["version"] = state.SettingsDraft.Version, ["configDir"] = state.Config.ConfigDir };
        }
        else
        {
            var draft = state.PlaybookDrafts[target];

            body = new JsonObject { ["target"] = "playbook", ["name"] = target, ["playbook"] = draft.Playbook.ToJson(), ["version"] = draft.Version, ["configDir"] = state.Config.ConfigDir };
        }

        var sent = (target == "settings" ? body["value"] : body["playbook"])!.ToJsonString();
        var reply = await hub.SaveConfig(body);

        if (reply.Errors.Count > 0)
        {
            state.Refusals[target] = reply.Errors;
            Changed?.Invoke(false);
            return;
        }

        state.Refusals.Remove(target);

        if (reply.Version is { } version)
        {
            // Until the read answers, the file is taken to hold what was sent at the version written, so an edit made meanwhile builds on it.
            state.Wrote(target, JsonNode.Parse(sent)!, version);
        }
        else if (target == "settings" ? state.SettingsDraft?.Value.ToJsonString() == sent : state.PlaybookDrafts.GetValueOrDefault(target)?.Playbook.ToJson().ToJsonString() == sent)
        {
            // A hub that sends no version: the read shows the file; a draft edited since keeps its version, and its save is refused as changed.
            state.SettingsDraft = target == "settings" ? null : state.SettingsDraft;
            state.PlaybookDrafts.Remove(target);
        }

        await Load();
    }

    public async Task Create()
    {
        if (State is not { } state)
        {
            return;
        }

        if (state.NewNameError is not null)
        {
            state.NewPlaybook = state.NewPlaybook with { Touched = true };
            Changed?.Invoke(false);
            return;
        }

        var name = state.NewPlaybook.FullName;
        var errors = (await hub.SaveConfig(new JsonObject { ["target"] = "playbook", ["name"] = name, ["playbook"] = state.NewPlaybook.Playbook.ToJson(), ["version"] = null, ["configDir"] = state.Config.ConfigDir })).Errors;

        if (errors.Count > 0)
        {
            state.Refusals["new"] = errors;
            Changed?.Invoke(false);
            return;
        }

        state.Refusals.Remove("new");
        state.NewPlaybook = NewPlaybook.Empty;
        state.PlaybookErrors.Remove("new");
        state.Page = $"playbook:{name}";
        await Load();
    }

    /// <summary>Deletes the current page's playbook file after asking, naming how many open work items use it.</summary>
    public async Task Delete()
    {
        if (State is not { } state || state.Target is not { } target || state.PlaybookFile(target) is not { } file)
        {
            return;
        }

        edited.Remove(target);

        // Work items change while the window is open, so the count is read now.
        var (current, _) = await hub.ReadConfig();
        var count = (current ?? state.Config).InUse.GetValueOrDefault(file.Name);
        var detail = count == 0 ? "Its file is deleted." : $"{count} open work {(count == 1 ? "item uses" : "items use")} it. Its file is deleted.";

        if (Confirm is null || !await Confirm($"Delete playbook {file.Name}?", detail, "Delete"))
        {
            return;
        }

        var errors = await hub.DeletePlaybook(file.Name, file.Version, state.Config.ConfigDir);

        if (errors.Count > 0)
        {
            state.Refusals[file.Name] = errors;
            Changed?.Invoke(false);
            return;
        }

        state.Refusals.Remove(file.Name);
        state.PlaybookDrafts.Remove(file.Name);
        state.PlaybookErrors.Remove(file.Name);

        if (state.Page == $"playbook:{file.Name}")
        {
            state.Page = "general";
        }

        await Load();
    }

    void CancelCheck()
    {
        pending?.Cancel();
        pending = null;
    }

    /// <summary>Checks the edited files once the operator stops typing for <see cref="CheckDelay"/>, and saves each that passes.</summary>
    void CheckSoon(string target)
    {
        CancelCheck();
        edited.Add(target);

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

            if (!token.IsCancellationRequested && State is { } state)
            {
                var targets = edited.ToList();

                edited.Clear();
                await Task.WhenAll(targets.Select((target) => Check(state, target)));
            }
        }
    }

    /// <summary>Checks the current page's files, saving each that passes; an answer to an older check is dropped.</summary>
    public async Task Check()
    {
        if (State is not { } state)
        {
            return;
        }

        await Task.WhenAll(state.Targets.Select((target) => Check(state, target)));
    }

    async Task Check(EditorState state, string target)
    {
        JsonObject body;

        if (target == "settings")
        {
            if (state.SettingsValue is not { } value)
            {
                return;
            }

            body = new JsonObject { ["target"] = "settings", ["settings"] = value.DeepClone() };
        }
        else
        {
            var playbook = target == "new" ? state.NewPlaybook.Playbook : state.PlaybookValue(target);

            if (playbook is null)
            {
                return;
            }

            body = new JsonObject { ["target"] = "playbook", ["name"] = target == "new" ? state.NewPlaybook.FullName : target, ["playbook"] = playbook.ToJson() };
        }

        var next = ++seq;

        latest[target] = next;

        var errors = await hub.CheckConfig(body);

        if (latest.GetValueOrDefault(target) != next)
        {
            return;
        }

        if (errors is null)
        {
            if (Saveable(state, target))
            {
                state.Refusals[target] = ["Switchboard did not answer, so the change is not saved."];
                Changed?.Invoke(false);
            }

            return;
        }

        if (target == "settings")
        {
            state.SettingsErrors = errors;
        }
        else
        {
            state.PlaybookErrors[target] = errors;
        }

        Changed?.Invoke(false);

        if (errors.Count == 0)
        {
            await AutoSave(state, target);
        }
    }
}
