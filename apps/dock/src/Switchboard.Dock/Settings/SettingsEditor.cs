using System.Text.Json.Nodes;

namespace Switchboard.Dock.Settings;

/// <summary>
/// The Settings window's behaviour (PRD R54): keeps unsaved drafts, checks the current page with the hub after each edit, and saves, creates and
/// deletes through the hub, which writes the files. <see cref="Changed"/> says whether the window must draw the page again (true) or only update
/// its navigation, buttons, notes and errors (false), so the field being typed in keeps focus.
/// </summary>
public sealed class SettingsEditor(IConfigHub hub, Func<CancellationToken, Task>? checkDelay = null)
{
    public static readonly TimeSpan CheckDelay = TimeSpan.FromMilliseconds(250);

    readonly Func<CancellationToken, Task> delay = checkDelay ?? ((cancel) => Task.Delay(CheckDelay, cancel));
    readonly Dictionary<string, int> latest = [];
    int seq;
    int loads;
    CancellationTokenSource? pending;

    /// <summary>Null until the first read answers.</summary>
    public EditorState? State { get; private set; }

    /// <summary>Why the files could not be read, or null.</summary>
    public string? Error { get; private set; }

    /// <summary>What a reload discarded, or null.</summary>
    public string? Notice { get; private set; }

    public event Action<bool>? Changed;

    /// <summary>Asks before a delete, with a question and a detail; true to delete.</summary>
    public Func<string, string, Task<bool>>? Confirm { get; set; }

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

        Changed?.Invoke(true);
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
        else
        {
            var file = state.PlaybookFile(target);
            var hasDraft = state.PlaybookDrafts.TryGetValue(target, out var draft);

            if (state.PlaybookValue(target) is not { } current || (!hasDraft && file is null))
            {
                return;
            }

            state.PlaybookDrafts[target] = new PlaybookDraft(SettingsFields.ApplyPlaybookField(current, field.Path, text, isChecked), draft?.Version ?? file!.Version);
        }

        state.Refusals.Remove(target);
        // The kind and the approval report decide which playbook fields show.
        Changed?.Invoke(field.Path is "kind" or "reports.approval");
        CheckSoon();
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
        CheckSoon();
    }

    public async Task AddSource(string kind)
    {
        if (State?.SettingsValue is { } value)
        {
            State.SettingsDraft = new SettingsDraft(SettingsFields.SetAt(value, $"sources.{kind}", new JsonObject { ["enabled"] = false }), State.DraftVersion);
            await Navigate($"source:{kind}");
        }
    }

    public async Task RemoveSource(string name)
    {
        if (State?.SettingsValue is { } value)
        {
            State.SettingsDraft = new SettingsDraft(SettingsFields.SetAt(value, $"sources.{name}", null), State.DraftVersion);
            await Navigate("general");
        }
    }

    public async Task Revert()
    {
        if (State is not { } state || state.Target is not { } target)
        {
            return;
        }

        state.Refusals.Remove(target);

        if (target == "settings")
        {
            state.SettingsDraft = null;
        }
        else
        {
            state.PlaybookDrafts.Remove(target);
        }

        Changed?.Invoke(true);
        await Check();
    }

    public async Task Save()
    {
        CancelCheck();

        if (State?.Target is "settings")
        {
            await SaveSettings();
        }
        else if (State?.Target is { } target && target != "new")
        {
            await SavePlaybook(target);
        }
    }

    public async Task SaveAll()
    {
        CancelCheck();

        if (State is not { } state)
        {
            return;
        }

        var playbooks = state.PlaybookDrafts.Keys.Where(state.PlaybookDirty).ToList();

        if (state.SettingsDirty)
        {
            await SaveSettings();
        }

        foreach (var name in playbooks)
        {
            await SavePlaybook(name);
        }
    }

    async Task SaveSettings()
    {
        if (State?.SettingsDraft is not { } draft)
        {
            return;
        }

        await Written("settings", await hub.SaveConfig(new JsonObject { ["target"] = "settings", ["value"] = draft.Value.DeepClone(), ["version"] = draft.Version, ["configDir"] = State.Config.ConfigDir }));
    }

    async Task SavePlaybook(string name)
    {
        if (State is not { } state || !state.PlaybookDrafts.TryGetValue(name, out var draft))
        {
            return;
        }

        // A file deleted on disk is created again.
        var version = state.PlaybookFile(name) is null ? null : draft.Version;

        await Written(name, await hub.SaveConfig(new JsonObject { ["target"] = "playbook", ["name"] = name, ["playbook"] = draft.Playbook.ToJson(), ["version"] = version, ["configDir"] = state.Config.ConfigDir }));
    }

    /// <summary>Shows a refusal, or reads the written files again, which drops the drafts that now match them.</summary>
    async Task Written(string target, IReadOnlyList<string> errors)
    {
        if (State is not { } state)
        {
            return;
        }

        if (errors.Count > 0)
        {
            state.Refusals[target] = errors;
            Changed?.Invoke(false);
            return;
        }

        state.Refusals.Remove(target);
        await Load();
    }

    public async Task Create()
    {
        CancelCheck();

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
        var errors = await hub.SaveConfig(new JsonObject { ["target"] = "playbook", ["name"] = name, ["playbook"] = state.NewPlaybook.Playbook.ToJson(), ["version"] = null, ["configDir"] = state.Config.ConfigDir });

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
        CancelCheck();

        if (State is not { } state || state.Target is not { } target || state.PlaybookFile(target) is not { } file)
        {
            return;
        }

        // Work items change while the window is open, so the count is read now.
        var (current, _) = await hub.ReadConfig();
        var count = (current ?? state.Config).InUse.GetValueOrDefault(file.Name);
        var detail = count == 0 ? "Its file is deleted." : $"{count} open work {(count == 1 ? "item uses" : "items use")} it. Its file is deleted.";

        if (Confirm is null || !await Confirm($"Delete playbook {file.Name}?", detail))
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

    /// <summary>Checks the page once the operator stops typing for <see cref="CheckDelay"/>.</summary>
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

    /// <summary>Asks the hub for the current page's errors; an answer to an older check is dropped.</summary>
    public async Task Check()
    {
        if (State is not { } state || state.Target is not { } target)
        {
            return;
        }

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

        if (errors is null || latest.GetValueOrDefault(target) != next)
        {
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
    }
}
