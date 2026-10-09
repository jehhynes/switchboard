using System.Text.Json.Nodes;
using Switchboard.Dock.Settings;

namespace Switchboard.Dock.Tests;

public sealed class SettingsFieldsTests
{
    [Fact]
    public void GeneralFields_AnyState_ListsSessionsThenTriageFields()
    {
        var sections = SettingsFields.GeneralFields(SettingsConfigs.State());

        Assert.Equal(["Sessions", "Triage"], sections.Select((section) => section.Heading));
        Assert.Equal(
            ["sessions.concurrency", "sessions.permissionMode", "sessions.model", "sessions.installHooks", "sessions.debriefs", "triage.model", "triage.concurrency", "triage.timeoutSeconds"],
            sections.SelectMany((section) => section.Fields).Select((field) => field.Path));
        Assert.Equal(["acceptEdits", "auto", "plan"], sections[0].Fields[1].Options!.Select((option) => option.Value));
        Assert.True(sections[0].Fields[3].Fallback);
        Assert.False(sections[0].Fields[4].Fallback);
    }

    [Fact]
    public void SourceFields_Github_OffersNamespacesAndTriagePlaybooksAndKeepsAMissingValue()
    {
        var config = SettingsConfigs.Basic();

        config["settings"]!["value"]!["sources"]!["github"]!["triagePlaybook"] = "triage:gone";

        var sections = SettingsFields.SourceFields(SettingsConfigs.State(config), "github");
        var fields = sections.SelectMany((section) => section.Fields).ToDictionary((field) => field.Path);

        Assert.Equal(["Source", "GitHub"], sections.Select((section) => section.Heading));
        Assert.Equal(["", "dev", "triage"], fields["sources.github.namespace"].Options!.Select((option) => option.Value));
        Assert.Equal(["None", "triage:github", "triage:gone (missing)"], fields["sources.github.triagePlaybook"].Options!.Select((option) => option.Label));
        Assert.Equal(FieldKind.List, fields["sources.github.logins"].Kind);
        Assert.Equal("^(\\d+)-", fields["sources.github.branchPattern"].Placeholder);
    }

    [Fact]
    public void SourceFields_UnknownSource_HasOnlyTheCommonSection()
    {
        var sections = SettingsFields.SourceFields(SettingsConfigs.State(), "jira");

        Assert.Equal(["Source"], sections.Select((section) => section.Heading));
        Assert.Equal("sources.jira.setupPrompt", sections[0].Fields[^1].Path);
    }

    [Fact]
    public void SourceFields_Zoho_ShowsTheAutomationAgentDefault()
    {
        var field = SettingsFields.SourceFields(SettingsConfigs.State(), "zoho")[1].Fields.Single((entry) => entry.Path == "sources.zoho.automationAgentIds");

        Assert.Equal(["8000000000000000002", "8000000000000000003"], field.ListDefault);
    }

    [Fact]
    public void PlaybookFieldsOf_TaskWithApproval_OffersApprovalSendsAfterTheApprovalReport()
    {
        var state = SettingsConfigs.State();
        var paths = SettingsFields.PlaybookFieldsOf(state, PlaybookFields.Empty with { Reports = ["approval"] }).Select((field) => field.Path).ToList();

        Assert.Equal(
            ["description", "kind", "autoStart", "requiresWorktree", "reports.done", "reports.approval", "approvalSends", "reports.worktree", "reports.playbook", "reports.paste", "workdir", "permissionMode", "model", "template"],
            paths);
        Assert.DoesNotContain("approvalSends", SettingsFields.PlaybookFieldsOf(state, PlaybookFields.Empty).Select((field) => field.Path));
    }

    [Fact]
    public void PlaybookFieldsOf_Triage_OffersRatesAndClassifierInstructionsOnly()
    {
        var fields = SettingsFields.PlaybookFieldsOf(SettingsConfigs.State(), PlaybookFields.Empty with { Kind = "triage" });

        Assert.Equal(["description", "kind", "rates", "template"], fields.Select((field) => field.Path));
        Assert.Equal("Classifier instructions", fields[^1].Label);
    }

    [Fact]
    public void PlaybookFieldsOf_SessionsSetModeAndModel_NamesThemInTheDefaults()
    {
        var config = SettingsConfigs.Basic();

        config["settings"]!["value"]!["sessions"] = new JsonObject { ["permissionMode"] = "plan", ["model"] = "opus" };

        var fields = SettingsFields.PlaybookFieldsOf(SettingsConfigs.State(config), PlaybookFields.Empty).ToDictionary((field) => field.Path);
        var defaults = SettingsFields.PlaybookFieldsOf(SettingsConfigs.State(), PlaybookFields.Empty).ToDictionary((field) => field.Path);

        Assert.Equal("Sessions setting (plan)", fields["permissionMode"].Options![0].Label);
        Assert.Equal("Sessions setting (opus)", fields["model"].Placeholder);
        Assert.Equal("Sessions setting (auto)", defaults["permissionMode"].Options![0].Label);
        Assert.Equal("Sessions setting (Claude’s default)", defaults["model"].Placeholder);
        Assert.StartsWith("Variables: {{ticket.title}} {{report}}.", fields["template"].Help);
    }

    [Theory]
    [InlineData(FieldKind.Integer, " 12 ", "12")]
    [InlineData(FieldKind.Integer, "12a", "\"12a\"")]
    [InlineData(FieldKind.Integer, "  ", null)]
    [InlineData(FieldKind.Text, "", null)]
    [InlineData(FieldKind.Text, " a ", "\" a \"")]
    [InlineData(FieldKind.List, " a \n\n b\n", "[\"a\",\"b\"]")]
    [InlineData(FieldKind.List, "\n ", null)]
    public void ReadField_Input_GivesTheSettingOrRemovesIt(FieldKind kind, string text, string? json)
    {
        Assert.Equal(json, SettingsFields.ReadField(kind, text)?.ToJsonString());
    }

    [Fact]
    public void ReadField_EmptiedListWithADefault_KeepsAnEmptyList()
    {
        Assert.Equal("[]", SettingsFields.ReadField(FieldKind.List, "", keepEmpty: true)!.ToJsonString());
        Assert.Equal("false", SettingsFields.ReadField(FieldKind.Boolean, "", isChecked: false)!.ToJsonString());
    }

    [Fact]
    public void ApplyPlaybookField_ReportsToggled_KeepFrontMatterOrderAndDropApprovalSendsWithApproval()
    {
        var playbook = PlaybookFields.Empty with { Reports = ["paste", "approval"], ApprovalSends = true };
        var withDone = SettingsFields.ApplyPlaybookField(playbook, "reports.done", "", isChecked: true);
        var withoutApproval = SettingsFields.ApplyPlaybookField(withDone, "reports.approval", "", isChecked: false);

        Assert.Equal(["done", "approval", "paste"], withDone.Reports);
        Assert.True(withDone.ApprovalSends);
        Assert.Equal(["done", "paste"], withoutApproval.Reports);
        Assert.False(withoutApproval.ApprovalSends);
    }

    [Fact]
    public void ApplyPlaybookField_KindTask_DropsRates()
    {
        var triage = PlaybookFields.Empty with { Kind = "triage", Rates = true };

        Assert.False(SettingsFields.ApplyPlaybookField(triage, "kind", "task").Rates);
        Assert.True(SettingsFields.ApplyPlaybookField(triage, "kind", "triage").Rates);
        Assert.Null(SettingsFields.ApplyPlaybookField(triage with { Model = "opus" }, "model", "").Model);
        Assert.Equal("repoRoot", SettingsFields.ApplyPlaybookField(triage, "workdir", "repoRoot").Workdir);
        Assert.Same(triage, SettingsFields.ApplyPlaybookField(triage, "unknown", "x"));
    }

    [Fact]
    public void SetAt_NestedPath_CopiesAndCreatesOrRemovesTheKey()
    {
        var root = new JsonObject { ["sessions"] = new JsonObject { ["concurrency"] = 2 } };
        var set = SettingsFields.SetAt(root, "sources.github.repo", "a/b");
        var removed = SettingsFields.SetAt(root, "sessions.concurrency", null);

        Assert.Equal("{\"sessions\":{\"concurrency\":2},\"sources\":{\"github\":{\"repo\":\"a/b\"}}}", set.ToJsonString());
        Assert.Equal("{\"sessions\":{}}", removed.ToJsonString());
        Assert.Equal("{\"sessions\":{\"concurrency\":2}}", root.ToJsonString());
    }

    [Fact]
    public void FieldOfError_PathsInErrors_NamesTheLongestStandalonePath()
    {
        string[] paths = ["sessions.concurrency", "sources.github.repo", "sources.github.project.owner", "sources.github.project.number"];

        Assert.Equal("sessions.concurrency", SettingsFields.FieldOfError("sessions.concurrency must be 1 to 10.", paths));
        Assert.Equal("sessions.concurrency", SettingsFields.FieldOfError("Set sessions.concurrency.", paths));
        Assert.Equal("sources.github.project.owner", SettingsFields.FieldOfError("sources.github.project needs owner and number.", paths));
        Assert.Equal("sources.github.repo", SettingsFields.FieldOfError("sources.github is invalid.", paths));
        Assert.Null(SettingsFields.FieldOfError("sessions.concurrencyLimit is unknown.", paths));
        Assert.Null(SettingsFields.FieldOfError("settings.json is not valid JSON.", paths));
    }

    [Fact]
    public void PlaybookFieldOfError_Errors_NameTheLeadingKeyElseTheTemplate()
    {
        string[] paths = ["description", "model", "template"];

        Assert.Equal("model", SettingsFields.PlaybookFieldOfError("model must be a string.", paths));
        Assert.Equal("template", SettingsFields.PlaybookFieldOfError("Unknown Template variable: x.", paths));
        Assert.Null(SettingsFields.PlaybookFieldOfError("The name must be namespace:name.", paths));
    }

    [Fact]
    public void Same_TemplatesDifferOnlyByTheFinalNewlineOrCrLf_AreTheSame()
    {
        var a = PlaybookFields.Empty with { Template = "One\r\nTwo" };

        Assert.True(PlaybookFields.Same(a, a with { Template = "One\nTwo\n" }));
        Assert.False(PlaybookFields.Same(a, a with { Template = "One\nTwo\n\n" }));
        Assert.False(PlaybookFields.Same(a, null));
    }
}

public sealed class SettingsPagesTests
{
    [Fact]
    public void Nav_Basic_ListsPagesSourcesAddsAndPlaybooksByNamespace()
    {
        var nav = SettingsPages.Nav(SettingsConfigs.State());

        Assert.Equal(
            ["heading Settings", "item Sessions and triage", "heading Sources", "item GitHub", "item Zoho Desk off", "add Add Forum", "heading Playbooks", "namespace dev", "item develop", "item review", "namespace triage", "item github", "add New playbook"],
            nav.Select((entry) => $"{entry.Kind} {entry.Label}{(entry.Note is null ? "" : $" {entry.Note}")}"));
        Assert.True(nav[1].Current);
        Assert.Equal("add-source", nav[5].Command);
        Assert.Equal("forum", nav[5].Argument);
    }

    [Fact]
    public void Nav_DraftAndErrors_MarkTheirPages()
    {
        var state = SettingsConfigs.State();

        state.SettingsDraft = new SettingsDraft(SettingsFields.SetAt(state.SettingsValue!, "sources.github.repo", "a/b"), "v1");
        state.SettingsErrors = ["sessions.concurrency must be 1 to 10."];
        state.PlaybookErrors["dev:review"] = ["model must be a string."];

        var nav = SettingsPages.Nav(state).Where((entry) => entry.Kind == "item").ToDictionary((entry) => entry.Argument!);

        Assert.True(nav["source:github"].Dirty);
        Assert.False(nav["general"].Dirty);
        Assert.True(nav["general"].HasErrors);
        Assert.False(nav["source:github"].HasErrors);
        Assert.True(nav["playbook:dev:review"].HasErrors);
        Assert.False(nav["playbook:dev:develop"].HasErrors);
    }

    [Fact]
    public void Page_SettingsErrors_PlacesFieldErrorsAndShowsTheRestAtTheTop()
    {
        var state = SettingsConfigs.State();

        state.SettingsErrors = ["sessions.concurrency must be 1 to 10.", "sources.github.repo must be owner/name.", "Something else."];
        state.Refusals["settings"] = ["settings.json changed on disk after the editor read it. Reload to see the change."];

        var page = SettingsPages.Page(state);
        var concurrency = page.Sections[0].Fields[0];

        Assert.Equal(["settings.json changed on disk after the editor read it. Reload to see the change.", "Something else."], page.Errors);
        Assert.Equal(["sessions.concurrency must be 1 to 10."], concurrency.Errors);
        Assert.Equal("2", concurrency.Text);
        Assert.Equal(["revert", "save-all", "save"], page.Buttons.Select((button) => button.Command));
        Assert.All(page.Buttons, (button) => Assert.False(button.Enabled));
    }

    [Fact]
    public void Page_InvalidSettingsFile_ShowsItsErrorAndNoFields()
    {
        var config = SettingsConfigs.Basic();

        config["settings"]!["value"] = null;
        config["settings"]!["error"] = "settings.json is not valid JSON: x";

        var page = SettingsPages.Page(SettingsConfigs.State(config));

        Assert.Equal(["settings.json is not valid JSON: x"], page.Errors);
        Assert.Empty(page.Sections);
        Assert.Empty(page.Buttons);
        Assert.Equal("Fix the file in an editor; the editor reloads it when it changes.", page.Message);
    }

    [Fact]
    public void Page_UnknownSource_SaysSoAndOffersRemove()
    {
        var state = SettingsConfigs.State();

        state.Page = "source:jira";

        var page = SettingsPages.Page(state);

        Assert.Equal(["Switchboard has no source named jira."], page.Notes);
        Assert.Equal("remove-source", page.Buttons[0].Command);
        Assert.Equal("sources.jira", page.Subtitle);
    }

    [Fact]
    public void Page_InvalidPlaybookFileWithoutDraft_ShowsItsErrorWithDeleteOnly()
    {
        var config = SettingsConfigs.Basic();

        config["playbooks"]![1]!["playbook"] = null;
        config["playbooks"]![1]!["error"] = "The front matter has no closing --- line.";

        var state = SettingsConfigs.State(config);

        state.Page = "playbook:dev:review";

        var page = SettingsPages.Page(state);

        Assert.Equal(["The front matter has no closing --- line."], page.Errors);
        Assert.Equal(["delete"], page.Buttons.Select((button) => button.Command));
        Assert.Empty(page.Sections);
    }

    [Fact]
    public void Page_DraftOfAChangedOrDeletedFile_SaysSo()
    {
        var state = SettingsConfigs.State();

        state.Page = "playbook:dev:review";
        state.PlaybookDrafts["dev:review"] = new PlaybookDraft(PlaybookFields.Empty with { Description = "New" }, "p0");

        var changed = SettingsPages.Page(state);

        Assert.Equal(["dev:review changed on disk. Revert to load it, or Save to see the refusal."], changed.Notes);
        Assert.Equal(["delete", "revert", "save-all", "save"], changed.Buttons.Select((button) => button.Command));
        Assert.True(changed.Buttons.Single((button) => button.Command == "save").Enabled);

        state.PlaybookDrafts["dev:gone"] = new PlaybookDraft(PlaybookFields.Empty, "p9");
        state.Page = "playbook:dev:gone";

        var deleted = SettingsPages.Page(state);

        Assert.Equal(["dev:gone was deleted on disk. Save creates it again; Revert discards your changes."], deleted.Notes);
        Assert.DoesNotContain("delete", deleted.Buttons.Select((button) => button.Command));
    }

    [Fact]
    public void Page_NewPlaybook_ShowsTheNameErrorOnlyOnceTyped()
    {
        var state = SettingsConfigs.State();

        state.Page = "new-playbook";
        Assert.Null(SettingsPages.Page(state).NewName!.Error);

        state.NewPlaybook = state.NewPlaybook with { Namespace = "dev", Name = "develop" };
        Assert.Equal("A playbook named dev:develop already exists.", SettingsPages.Page(state).NewName!.Error);

        state.NewPlaybook = state.NewPlaybook with { Name = "Bad Name" };
        Assert.Equal("Namespace and name must be lowercase letters, digits and hyphens.", SettingsPages.Page(state).NewName!.Error);
    }

    [Fact]
    public void FieldViewOf_AbsentValues_ShowDefaultsFallbacksAndPlaceholders()
    {
        var list = new Field("x", "X", FieldKind.List, "", ListDefault: ["a", "b"]);
        var flag = new Field("y", "Y", FieldKind.Boolean, "", Fallback: true);
        var choice = new Field("z", "Z", FieldKind.Select, "", "auto");

        Assert.Equal("a\nb", SettingsPages.FieldViewOf(list, null, []).Text);
        Assert.Equal("", SettingsPages.FieldViewOf(list, new JsonArray(), []).Text);
        Assert.True(SettingsPages.FieldViewOf(flag, null, []).Checked);
        Assert.False(SettingsPages.FieldViewOf(flag, JsonValue.Create(false), []).Checked);
        Assert.Equal("auto", SettingsPages.FieldViewOf(choice, null, []).Selected);
        Assert.Equal("plan", SettingsPages.FieldViewOf(choice, JsonValue.Create("plan"), []).Selected);
    }

    [Fact]
    public void Refresh_FilesReadAgain_DropsSavedDraftsAndKeepsOthers()
    {
        var state = SettingsConfigs.State();
        var saved = SettingsConfigs.Basic();

        saved["settings"]!["value"]!["sessions"]!["concurrency"] = 4;
        saved["playbooks"]![0]!["playbook"]!["description"] = "Saved";
        saved["playbooks"]!.AsArray().RemoveAt(1);
        state.SettingsDraft = new SettingsDraft(SettingsFields.SetAt(state.SettingsValue!, "sessions.concurrency", 4), "v1");
        state.PlaybookDrafts["dev:develop"] = new PlaybookDraft(state.PlaybookValue("dev:develop")! with { Description = "Saved" }, "p1");
        state.PlaybookDrafts["dev:review"] = new PlaybookDraft(PlaybookFields.Empty, "p2");

        state.Refresh(EditorConfig.Parse(saved));

        Assert.Null(state.SettingsDraft);
        Assert.False(state.PlaybookDrafts.ContainsKey("dev:develop"));
        Assert.True(state.PlaybookDrafts.ContainsKey("dev:review"));
    }
}

public sealed class SettingsEditorTests
{
    readonly FakeConfigHub hub = new();

    static Field Concurrency => SettingsFields.GeneralFields(SettingsConfigs.State())[0].Fields[0];

    async Task<SettingsEditor> Loaded(Func<CancellationToken, Task>? delay = null)
    {
        var editor = new SettingsEditor(hub, delay ?? ((_) => Task.CompletedTask));

        await editor.Load();
        hub.Calls.Clear();

        return editor;
    }

    [Fact]
    public async Task Edit_SettingsField_ChecksTheDraftOnlyAfterTheDelay()
    {
        var wait = new TaskCompletionSource();
        var editor = await Loaded((_) => wait.Task);

        editor.Edit(Concurrency, "11");
        Assert.Empty(hub.Calls);

        hub.CheckReplies.Enqueue(["sessions.concurrency must be 1 to 10."]);
        wait.SetResult();
        await Until(() => editor.State!.SettingsErrors.Count > 0);

        Assert.Equal(["check {\"target\":\"settings\",\"settings\":{\"sessions\":{\"concurrency\":11},\"sources\":{\"github\":{\"enabled\":true,\"repo\":\"acme/widgets\"},\"zoho\":{\"enabled\":false}}}}"], hub.Calls);
        Assert.True(editor.State!.SettingsDirty);
    }

    [Fact]
    public async Task Edit_TypedAgainBeforeTheDelay_ChecksOnce()
    {
        var waits = new List<TaskCompletionSource>();
        var editor = await Loaded((cancel) =>
        {
            var wait = new TaskCompletionSource();

            cancel.Register(() => wait.TrySetCanceled());
            waits.Add(wait);
            return wait.Task;
        });

        editor.Edit(Concurrency, "1");
        editor.Edit(Concurrency, "12");
        waits[0].TrySetResult();
        waits[1].TrySetResult();
        await Until(() => hub.Calls.Count > 0);
        await Task.Delay(50, TestContext.Current.CancellationToken);

        Assert.Single(hub.Calls);
        Assert.Contains("\"concurrency\":12", hub.Calls[0]);
    }

    [Fact]
    public async Task Check_OlderAnswerArrivesLast_IsDropped()
    {
        var editor = await Loaded();
        var first = new TaskCompletionSource();

        hub.CheckReplies.Enqueue(["old"]);
        hub.CheckReplies.Enqueue(["new"]);
        hub.HoldCheck = (n) => n == 1 ? first.Task : Task.CompletedTask;

        var older = editor.Check();

        await editor.Check();
        first.SetResult();
        await older;

        Assert.Equal(["new"], editor.State!.SettingsErrors);
    }

    [Fact]
    public async Task Save_Refused_KeepsTheRefusalUntilTheNextEdit()
    {
        var editor = await Loaded();

        editor.Edit(Concurrency, "3");
        hub.SaveReplies.Enqueue(["settings.json changed on disk after the editor read it. Reload to see the change."]);
        await editor.Save();

        Assert.Contains("save {\"target\":\"settings\",\"value\":{\"sessions\":{\"concurrency\":3},", string.Join('\n', hub.Calls));
        Assert.Contains("\"version\":\"v1\",\"configDir\":\"C:/cfg\"}", hub.Calls.Single((call) => call.StartsWith("save", StringComparison.Ordinal)));
        Assert.Equal(["settings.json changed on disk after the editor read it. Reload to see the change."], SettingsPages.Page(editor.State!).Errors);

        await editor.Check();
        Assert.NotEmpty(SettingsPages.Page(editor.State!).Errors);

        editor.Edit(Concurrency, "4");
        Assert.Empty(SettingsPages.Page(editor.State!).Errors);
    }

    [Fact]
    public async Task Save_Accepted_ReadsTheFilesAgainAndDropsTheSavedDraft()
    {
        var editor = await Loaded();

        editor.Edit(Concurrency, "3");
        hub.Config["settings"]!["value"]!["sessions"]!["concurrency"] = 3;
        await editor.Save();

        Assert.Contains("read", hub.Calls);
        Assert.Null(editor.State!.SettingsDraft);
    }

    [Fact]
    public async Task SaveAll_SettingsAndPlaybooksChanged_SavesEachWithItsVersion()
    {
        var editor = await Loaded();
        var description = new Field("description", "Description", FieldKind.Text, "");

        editor.Edit(Concurrency, "3");
        await editor.Navigate("playbook:dev:review");
        editor.Edit(description, "Review it");
        await editor.Navigate("playbook:dev:develop");
        editor.Edit(description, "Build it");
        await editor.SaveAll();

        var saves = hub.Calls.Where((call) => call.StartsWith("save", StringComparison.Ordinal)).ToList();

        Assert.Equal(2, saves.Count);
        Assert.Contains("\"target\":\"settings\"", saves[0]);
        Assert.Contains("\"name\":\"dev:review\"", saves[1]);
        Assert.Contains("\"description\":\"Review it\"", saves[1]);
        Assert.EndsWith("\"version\":\"p2\",\"configDir\":\"C:/cfg\"}", saves[1]);
    }

    [Fact]
    public async Task Create_BadName_ShowsTheErrorWithoutSaving()
    {
        var editor = await Loaded();

        await editor.Navigate("new-playbook");
        await editor.Create();

        Assert.DoesNotContain(hub.Calls, (call) => call.StartsWith("save", StringComparison.Ordinal));
        Assert.Equal("Namespace and name must be lowercase letters, digits and hyphens.", SettingsPages.Page(editor.State!).NewName!.Error);
    }

    [Fact]
    public async Task Create_Accepted_SavesWithNoVersionAndOpensThePlaybook()
    {
        var editor = await Loaded();

        await editor.Navigate("new-playbook");
        editor.EditNewName("dev", null);
        editor.EditNewName(null, "fix-tests");
        await editor.Create();

        Assert.Contains(hub.Calls, (call) => call.StartsWith("save {\"target\":\"playbook\",\"name\":\"dev:fix-tests\"", StringComparison.Ordinal) && call.EndsWith("\"version\":null,\"configDir\":\"C:/cfg\"}", StringComparison.Ordinal));
        Assert.Equal("playbook:dev:fix-tests", editor.State!.Page);
        Assert.Equal(NewPlaybook.Empty, editor.State.NewPlaybook);
    }

    [Fact]
    public async Task Create_Refused_ShowsTheRefusalOnThePage()
    {
        var editor = await Loaded();

        await editor.Navigate("new-playbook");
        editor.EditNewName("dev", "fix");
        hub.SaveReplies.Enqueue(["Unknown template variable: x."]);
        await editor.Create();

        Assert.Equal("new-playbook", editor.State!.Page);
        Assert.Equal(["Unknown template variable: x."], SettingsPages.Page(editor.State).Errors);
    }

    [Fact]
    public async Task Delete_PlaybookInUse_AsksNamingTheOpenWorkItemsAndDeletesOnlyOnYes()
    {
        var editor = await Loaded();
        var asked = new List<string>();
        var answer = false;

        editor.Confirm = (question, detail) =>
        {
            asked.Add($"{question} {detail}");
            return Task.FromResult(answer);
        };
        await editor.Navigate("playbook:dev:develop");
        await editor.Delete();

        Assert.Equal(["Delete playbook dev:develop? 2 open work items use it. Its file is deleted."], asked);
        Assert.DoesNotContain(hub.Calls, (call) => call.StartsWith("delete", StringComparison.Ordinal));

        answer = true;
        await editor.Delete();

        Assert.Contains("delete dev:develop p1", hub.Calls);
        Assert.Equal("general", editor.State!.Page);
    }

    [Fact]
    public async Task Delete_WorkItemsChangedSinceTheRead_NamesTheCurrentCount()
    {
        var editor = await Loaded();
        var asked = new List<string>();

        editor.Confirm = (question, detail) =>
        {
            asked.Add(detail);
            return Task.FromResult(false);
        };
        await editor.Navigate("playbook:dev:review");
        hub.Config["inUse"]!["dev:review"] = 1;
        await editor.Delete();

        Assert.Equal(["1 open work item uses it. Its file is deleted."], asked);
    }

    [Fact]
    public async Task Save_Settings_NamesTheConfigFolderItRead()
    {
        var editor = await Loaded();

        editor.Edit(Concurrency, "3");
        await editor.Save();

        Assert.Contains(hub.Calls, (call) => call.StartsWith("save {\"target\":\"settings\"", StringComparison.Ordinal) && call.EndsWith(",\"version\":\"v1\",\"configDir\":\"C:/cfg\"}", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Load_ConfigFolderChanged_DropsTheDraftsAndSaysSo()
    {
        var editor = await Loaded();

        editor.Edit(Concurrency, "3");
        Assert.NotNull(editor.State!.SettingsDraft);

        hub.Config["configDir"] = "D:/repo/switchboard";
        await editor.Load();

        Assert.Null(editor.State!.SettingsDraft);
        Assert.Equal("D:/repo/switchboard", editor.State.Config.ConfigDir);
        Assert.Equal("The config folder changed to D:/repo/switchboard. Unsaved changes were discarded.", editor.Notice);
    }

    [Fact]
    public async Task Load_OlderReadAnswersLast_KeepsTheNewerFolderAndItsDraft()
    {
        var editor = await Loaded();
        var older = new TaskCompletionSource();

        hub.HoldRead = () => older.Task;

        var stale = editor.Load();

        hub.Config["configDir"] = "D:/repo/switchboard";
        await editor.Load();
        editor.Edit(Concurrency, "3");
        older.SetResult();
        await stale;

        Assert.Equal("D:/repo/switchboard", editor.State!.Config.ConfigDir);
        Assert.NotNull(editor.State.SettingsDraft);
    }

    [Fact]
    public async Task Load_SameConfigFolder_KeepsTheDraft()
    {
        var editor = await Loaded();

        editor.Edit(Concurrency, "3");
        await editor.Load();

        Assert.NotNull(editor.State!.SettingsDraft);
        Assert.Null(editor.Notice);
    }

    [Fact]
    public async Task Delete_Refused_KeepsThePageAndShowsTheRefusal()
    {
        var editor = await Loaded();

        editor.Confirm = (_, _) => Task.FromResult(true);
        hub.DeleteReply = ["dev:review changed on disk after the editor read it. Reload to see the change."];
        await editor.Navigate("playbook:dev:review");
        await editor.Delete();

        Assert.Equal("playbook:dev:review", editor.State!.Page);
        Assert.Equal(["dev:review changed on disk after the editor read it. Reload to see the change."], SettingsPages.Page(editor.State).Errors);
    }

    [Fact]
    public async Task AddAndRemoveSource_Clicked_DraftTheSettingsAndChangePage()
    {
        var editor = await Loaded();

        await editor.AddSource("forum");
        Assert.Equal("source:forum", editor.State!.Page);
        Assert.Equal("{\"enabled\":false}", editor.State.SettingsValue!["sources"]!["forum"]!.ToJsonString());

        await editor.RemoveSource("github");
        Assert.Equal("general", editor.State.Page);
        Assert.Null(editor.State.SettingsValue!["sources"]!["github"]);
    }

    [Fact]
    public async Task Revert_PlaybookDraft_DropsItAndItsRefusal()
    {
        var editor = await Loaded();

        await editor.Navigate("playbook:dev:review");
        editor.Edit(new Field("model", "Model", FieldKind.Text, ""), "opus");
        editor.State!.Refusals["dev:review"] = ["no"];
        await editor.Revert();

        Assert.False(editor.State.PlaybookDrafts.ContainsKey("dev:review"));
        Assert.False(editor.State.Refusals.ContainsKey("dev:review"));
    }

    static async Task Until(Func<bool> done)
    {
        for (var deadline = DateTime.UtcNow.AddSeconds(5); !done(); await Task.Delay(10))
        {
            if (DateTime.UtcNow > deadline)
            {
                throw new TimeoutException();
            }
        }
    }
}
