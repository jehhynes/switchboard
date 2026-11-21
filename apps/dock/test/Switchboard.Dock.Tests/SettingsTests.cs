using System.Text.Json.Nodes;
using Switchboard.Dock.Settings;

namespace Switchboard.Dock.Tests;

public sealed class SettingsFieldsTests
{
    [Fact]
    public void GeneralFields_AnyState_GroupsSessionsAgentsTriageDockWebPageThenACollapsedAdvancedSection()
    {
        var sections = SettingsFields.GeneralFields(SettingsConfigs.State());
        var fields = sections.SelectMany((section) => section.Fields).ToDictionary((field) => field.Path);

        Assert.Equal(["Sessions", "Claude sessions", "Codex sessions", "Triage", "Dock", "Alerts", "Web page", "Advanced"], sections.Select((section) => section.Heading));
        Assert.Equal([false, false, false, false, false, false, false, true], sections.Select((section) => section.Advanced));
        Assert.Equal(
            [
                "sessions.provider", "sessions.concurrency", "sessions.codeMode", "sessions.debriefs",
                "sessions.model", "sessions.permissionMode",
                "sessions.codex.model", "sessions.codex.permissionMode",
                "triage.concurrency", "triage.model", "triage.timeoutSeconds",
                "dock.openVSCode", "dock.openIn", "dock.openTerminal",
                "alerts.surface",
                "web.chromePane",
                "sessions.installHooks", "sessions.claudePath", "sessions.codexPath", "sessions.nodePath",
            ],
            sections.SelectMany((section) => section.Fields).Select((field) => field.Path));
        Assert.Equal(
            ["Default agent", "Concurrency", "Code Mode (experimental)", "Friction debriefs", "Model", "Permission mode", "Model", "Permission mode", "Concurrency", "Model", "Timeout (seconds)", "Rows open in", "Row click opens", "Terminal for \"Open in terminal\"", "Needs-you alerts from", "Chrome pane (experimental)", "Install hooks", "Claude Code path", "Codex path", "Node.js path"],
            sections.SelectMany((section) => section.Fields).Select((field) => field.Label));
        Assert.Equal(["claude", "codex"], fields["sessions.provider"].Options!.Select((option) => option.Value));
        Assert.Equal(["Claude", "Codex"], fields["sessions.provider"].Options!.Select((option) => option.Label));
        Assert.True(fields["sessions.installHooks"].Fallback);
        Assert.False(fields["sessions.debriefs"].Fallback);
        Assert.Equal((FieldKind.Boolean, false), (fields["sessions.codeMode"].Kind, fields["sessions.codeMode"].Fallback));
        Assert.Contains("skip the gateway in your Claude settings and use your Claude subscription sign-in", fields["sessions.codeMode"].Help);
        Assert.Equal(["acceptEdits", "auto", "plan"], fields["sessions.permissionMode"].Options!.Select((option) => option.Value));
        Assert.Equal(["auto", "bypassPermissions"], fields["sessions.codex.permissionMode"].Options!.Select((option) => option.Value));
        Assert.Equal("bypassPermissions", fields["sessions.codex.permissionMode"].Placeholder);
        Assert.Equal([("always", "Always"), ("review", "Only for review")], fields["dock.openVSCode"].Options!.Select((option) => (option.Value, option.Label)));
        Assert.Equal("always", fields["dock.openVSCode"].Placeholder);
        Assert.Equal([("vscode", "VS Code"), ("web", "Web app")], fields["dock.openIn"].Options!.Select((option) => (option.Value, option.Label)));
        Assert.Equal("vscode", fields["dock.openIn"].Placeholder);
        Assert.Contains("Alt-click opens the other", fields["dock.openIn"].Help);
        Assert.Equal([("auto", "Web app when open"), ("web", "Web page when open"), ("dock", "Dock")], fields["alerts.surface"].Options!.Select((option) => (option.Value, option.Label)));
        Assert.Equal("auto", fields["alerts.surface"].Placeholder);
        Assert.Equal([("vscode", "VS Code"), ("app", "Terminal app"), ("auto", "VS Code when open")], fields["dock.openTerminal"].Options!.Select((option) => (option.Value, option.Label)));
        Assert.Equal("vscode", fields["dock.openTerminal"].Placeholder);
        Assert.Contains("when Rows open in is Always", fields["dock.openTerminal"].Help);
        Assert.Equal((FieldKind.Boolean, false), (fields["web.chromePane"].Kind, fields["web.chromePane"].Fallback));
        Assert.StartsWith("Experimental, Windows only, and may break with Chrome updates.", fields["web.chromePane"].Help);
    }

    [Fact]
    public void SourceFields_Github_OffersNamespacesAndTriagePlaybooksAndKeepsAMissingValue()
    {
        var config = SettingsConfigs.Basic();

        SettingsConfigs.Value(config)["sources"]!["github"]!["triagePlaybook"] = "triage:gone";

        var sections = SettingsFields.SourceFields(SettingsConfigs.State(config), "github");
        var fields = sections.SelectMany((section) => section.Fields).ToDictionary((field) => field.Path);

        Assert.Equal(["Source", "GitHub", "Advanced"], sections.Select((section) => section.Heading));
        Assert.Equal([false, false, true], sections.Select((section) => section.Advanced));
        Assert.Equal(["", "dev", "triage"], fields["sources.github.namespace"].Options!.Select((option) => option.Value));
        Assert.Equal(["None", "triage:github", "triage:gone (missing)"], fields["sources.github.triagePlaybook"].Options!.Select((option) => option.Label));
        Assert.Equal(FieldKind.List, fields["sources.github.logins"].Kind);
        Assert.Equal(FieldKind.Boolean, fields["sources.github.requireAssignee"].Kind);
        Assert.True(SettingsPages.FieldViewOf(fields["sources.github.requireAssignee"], null, []).Checked);
        Assert.Equal(FieldKind.Boolean, fields["sources.github.waitForBlockers"].Kind);
        Assert.False(SettingsPages.FieldViewOf(fields["sources.github.waitForBlockers"], null, []).Checked);
        Assert.True(SettingsPages.FieldViewOf(fields["sources.github.waitForBlockers"], true, []).Checked);
        Assert.Equal(FieldKind.Boolean, fields["sources.github.includeClosed"].Kind);
        Assert.False(SettingsPages.FieldViewOf(fields["sources.github.includeClosed"], null, []).Checked);
        Assert.DoesNotContain(sections[2].Fields, (field) => field.Path == "sources.github.requireAssignee");
        Assert.Equal("^(\\d+)-", sections[2].Fields.Single((field) => field.Path == "sources.github.branchPattern").Placeholder);
        Assert.DoesNotContain("sources.github.enabled", fields.Keys);
        Assert.Equal("sources.github.kind", sections[0].Fields[0].Path);
        Assert.Equal("sources.github.pollIntervalSeconds", sections[0].Fields[1].Path);
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
        var field = SettingsFields.SourceFields(SettingsConfigs.State(), "zoho").Single((section) => section.Advanced).Fields.Single((entry) => entry.Path == "sources.zoho.automationAgentIds");

        Assert.Equal(["8000000000000000002", "8000000000000000003"], field.ListDefault);
    }

    [Fact]
    public void PlaybookFieldsOf_TaskWithApproval_OffersApprovalSendsAfterTheApprovalReport()
    {
        var state = SettingsConfigs.State();
        var paths = SettingsFields.PlaybookFieldsOf(state, PlaybookFields.Empty with { Reports = ["approval"] }).Select((field) => field.Path).ToList();

        var fields = SettingsFields.PlaybookFieldsOf(state, PlaybookFields.Empty with { Reports = ["approval"] });

        Assert.Equal(
            ["description", "kind", "autoStart", "requiresWorktree", "reports.done", "reports.approval", "reports.worktree", "reports.playbook", "reports.paste", "approvalSends", "workdir", "provider", "permissionMode", "model", "returnOf", "focus", "template"],
            paths);
        Assert.Equal(["Start", "Start", "Reports", "Reports", "Reports", "Reports", "Reports"], fields.Where((field) => field.Group is not null).Select((field) => field.Group));
        Assert.Null(fields.Single((field) => field.Path == "approvalSends").Group);
        Assert.DoesNotContain("approvalSends", SettingsFields.PlaybookFieldsOf(state, PlaybookFields.Empty).Select((field) => field.Path));
    }

    [Fact]
    public void ApplyPlaybookField_ReturnOfLines_KeepsDistinctTrimmedNames()
    {
        var playbook = SettingsFields.ApplyPlaybookField(PlaybookFields.Empty, "returnOf", " dev:qa-question \n\ndev:develop, dev:qa-question");

        Assert.Equal(["dev:qa-question", "dev:develop"], playbook.ReturnOf);
        Assert.Equal("dev:qa-question\ndev:develop", SettingsPages.FieldViewOf(SettingsFields.PlaybookFieldsOf(SettingsConfigs.State(), playbook).Single((field) => field.Path == "returnOf"), SettingsFields.PlaybookFieldValue(playbook, "returnOf"), []).Text);
        Assert.Equal(playbook.ReturnOf, PlaybookFields.Read(playbook.ToEntry()).Fields!.ReturnOf);
    }

    [Fact]
    public void ApplyPlaybookField_FocusPage_SetsItAndAnyPageRemovesTheKey()
    {
        var state = SettingsConfigs.State();
        var pr = SettingsFields.ApplyPlaybookField(PlaybookFields.Empty with { Description = "D", Template = "T" }, "focus", "pr");
        var any = SettingsFields.ApplyPlaybookField(pr, "focus", "");

        Assert.Equal("pr", pr.Focus);
        Assert.Equal(["", "ticket", "pr"], SettingsFields.PlaybookFieldsOf(state, pr).Single((field) => field.Path == "focus").Options!.Select((option) => option.Value));
        Assert.Equal("pr", PlaybookFields.Read(pr.ToEntry()).Fields!.Focus);
        Assert.Null(any.Focus);
        Assert.Equal("{\"description\":\"D\",\"autoStart\":false,\"requiresWorktree\":false,\"template\":\"T\"}", any.ToEntry().ToJsonString());
        Assert.False(PlaybookFields.Same(pr, any));
    }

    [Fact]
    public void ApplyPlaybookField_KindTriage_DropsFocus()
    {
        var playbook = SettingsFields.ApplyPlaybookField(PlaybookFields.Empty with { Description = "D", Focus = "ticket", Template = "T" }, "kind", "triage");

        Assert.Null(playbook.Focus);
        Assert.DoesNotContain("focus", SettingsFields.PlaybookFieldsOf(SettingsConfigs.State(), playbook).Select((field) => field.Path));
        Assert.Equal("{\"description\":\"D\",\"kind\":\"triage\",\"template\":\"T\"}", playbook.ToEntry().ToJsonString());
    }

    [Fact]
    public void ApplyPlaybookField_KindTriage_DropsReturnOf()
    {
        var playbook = SettingsFields.ApplyPlaybookField(PlaybookFields.Empty with { ReturnOf = ["dev:develop"] }, "kind", "triage");

        Assert.Empty(playbook.ReturnOf);
        Assert.DoesNotContain("returnOf", SettingsFields.PlaybookFieldsOf(SettingsConfigs.State(), playbook).Select((field) => field.Path));
    }

    [Fact]
    public void TableColumns_TaskAndTriagePlaybooks_GroupsStartAndReportsAndAddsRates()
    {
        var columns = SettingsFields.TableColumns([PlaybookFields.Empty, PlaybookFields.Empty with { Kind = "triage" }]);

        Assert.Equal(
            ["autoStart", "requiresWorktree", "reports.done", "reports.approval", "approvalSends", "reports.worktree", "reports.playbook", "reports.paste", "workdir", "rates"],
            columns.Select((column) => column.Path));
        Assert.Equal(["Start", "Start", "Reports", "Reports", "Reports", "Reports", "Reports", "Reports", null, null], columns.Select((column) => column.Group));
        Assert.Equal(["rates"], SettingsFields.TableColumns([PlaybookFields.Empty with { Kind = "triage" }]).Select((column) => column.Path));
    }

    [Fact]
    public void Cell_Playbooks_ShowValuesLeaveOtherKindsEmptyAndEnableSendsOnlyWithApproval()
    {
        var task = PlaybookFields.Empty with { Reports = ["done"], Workdir = "repoRoot", ApprovalSends = false };
        var triage = PlaybookFields.Empty with { Kind = "triage", Rates = true };

        Assert.Equal(new TableCell(true, true), SettingsFields.Cell(task, "reports.done"));
        Assert.Equal(new TableCell(false, true), SettingsFields.Cell(task, "reports.paste"));
        Assert.Equal(new TableCell(true, true), SettingsFields.Cell(task, "workdir"));
        Assert.Equal(new TableCell(false, false), SettingsFields.Cell(task, "approvalSends"));
        Assert.Equal(new TableCell(false, true), SettingsFields.Cell(task with { Reports = ["approval"] }, "approvalSends"));
        Assert.Null(SettingsFields.Cell(task, "rates"));
        Assert.Equal(new TableCell(true, true), SettingsFields.Cell(triage, "rates"));
        Assert.Null(SettingsFields.Cell(triage, "autoStart"));
    }

    [Fact]
    public void ApplyPlaybookCell_RepoRootAndReports_SetTheWorkdirAndReports()
    {
        var playbook = SettingsFields.ApplyPlaybookCell(PlaybookFields.Empty, "workdir", true);

        Assert.Equal("repoRoot", playbook.Workdir);
        Assert.Equal("worktree", SettingsFields.ApplyPlaybookCell(playbook, "workdir", false).Workdir);
        Assert.Equal(["approval"], SettingsFields.ApplyPlaybookCell(playbook, "reports.approval", true).Reports);
        Assert.True(SettingsFields.ApplyPlaybookCell(playbook, "autoStart", true).AutoStart);
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

        SettingsConfigs.Value(config)["sessions"] = new JsonObject { ["permissionMode"] = "plan", ["model"] = "opus" };

        var fields = SettingsFields.PlaybookFieldsOf(SettingsConfigs.State(config), PlaybookFields.Empty).ToDictionary((field) => field.Path);
        var defaults = SettingsFields.PlaybookFieldsOf(SettingsConfigs.State(), PlaybookFields.Empty).ToDictionary((field) => field.Path);

        Assert.Equal("Sessions setting (plan)", fields["permissionMode"].Options![0].Label);
        Assert.Equal("Sessions setting (opus)", fields["model"].Placeholder);
        Assert.Equal("Sessions setting (auto)", defaults["permissionMode"].Options![0].Label);
        Assert.Equal("Sessions setting (Claude’s default)", defaults["model"].Placeholder);
        Assert.StartsWith("Variables: {{ticket.title}} {{report}}.", fields["template"].Help);
    }

    [Fact]
    public void PlaybookFieldsOf_CodexPlaybook_OffersCodexModesAndCodexDefaults()
    {
        var config = SettingsConfigs.Basic();

        SettingsConfigs.Value(config)["sessions"] = new JsonObject { ["provider"] = "codex", ["codex"] = new JsonObject { ["model"] = "gpt-6" } };

        var inherited = SettingsFields.PlaybookFieldsOf(SettingsConfigs.State(config), PlaybookFields.Empty).ToDictionary((field) => field.Path);
        var claude = SettingsFields.PlaybookFieldsOf(SettingsConfigs.State(config), PlaybookFields.Empty with { Provider = "claude" }).ToDictionary((field) => field.Path);
        var codex = SettingsFields.PlaybookFieldsOf(SettingsConfigs.State(), PlaybookFields.Empty with { Provider = "codex" }).ToDictionary((field) => field.Path);

        Assert.Equal(["", "claude", "codex"], inherited["provider"].Options!.Select((option) => option.Value));
        Assert.Equal("Sessions setting (Codex)", inherited["provider"].Options![0].Label);
        Assert.Equal(["", "auto", "bypassPermissions"], inherited["permissionMode"].Options!.Select((option) => option.Value));
        Assert.Equal("Sessions setting (bypassPermissions)", inherited["permissionMode"].Options![0].Label);
        Assert.Equal("Sessions setting (gpt-6)", inherited["model"].Placeholder);
        Assert.Equal(["", "acceptEdits", "auto", "plan"], claude["permissionMode"].Options!.Select((option) => option.Value));
        Assert.Equal("Sessions setting (Codex’s default)", codex["model"].Placeholder);
        Assert.Equal("Sessions setting (Claude)", codex["provider"].Options![0].Label);
    }

    [Fact]
    public void ToEntry_PlaybookWithProvider_WritesItBeforeThePermissionMode()
    {
        var entry = (PlaybookFields.Empty with { Description = "D", Template = "T", Provider = "codex", PermissionMode = "auto" }).ToEntry();

        Assert.Equal(["description", "autoStart", "requiresWorktree", "provider", "permissionMode", "template"], entry.Select((pair) => pair.Key));
        Assert.Equal("codex", PlaybookFields.Read(entry).Fields!.Provider);
        Assert.Null(SettingsFields.ApplyPlaybookField(PlaybookFields.Empty with { Provider = "codex" }, "provider", "").Provider);
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
    public void ApplyPlaybookField_KindTriage_DropsReportsAndApprovalSends()
    {
        var task = PlaybookFields.Empty with { Reports = ["approval"], ApprovalSends = true };
        var triage = SettingsFields.ApplyPlaybookField(task, "kind", "triage");

        Assert.Empty(triage.Reports);
        Assert.False(triage.ApprovalSends);
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
    public void ToEntry_TaskPlaybook_LeavesOutDefaultsExceptTheStartFlagsInKeyOrder()
    {
        var entry = (PlaybookFields.Empty with { Description = "D", Template = "T\n" }).ToEntry();
        var full = (new PlaybookFields("D", "task", true, true, "plan", "opus", "repoRoot", ["approval"], true, false, ["dev:x"], "T") with { Focus = "pr" }).ToEntry();

        Assert.Equal("{\"description\":\"D\",\"autoStart\":false,\"requiresWorktree\":false,\"template\":\"T\\n\"}", entry.ToJsonString());
        Assert.Equal(
            "{\"description\":\"D\",\"autoStart\":true,\"requiresWorktree\":true,\"workdir\":\"repoRoot\",\"reports\":[\"approval\"],\"approvalSends\":true,\"returnOf\":[\"dev:x\"],\"focus\":\"pr\",\"permissionMode\":\"plan\",\"model\":\"opus\",\"template\":\"T\"}",
            full.ToJsonString());
    }

    [Fact]
    public void ToEntry_TriagePlaybook_WritesKindAndRatesAndLeavesOutFalseStartFlags()
    {
        var entry = (PlaybookFields.Empty with { Description = "D", Kind = "triage", Rates = true, Template = "T" }).ToEntry();

        Assert.Equal("{\"description\":\"D\",\"kind\":\"triage\",\"rates\":true,\"template\":\"T\"}", entry.ToJsonString());
    }

    [Theory]
    [InlineData("[]", "A playbook must be an object.")]
    [InlineData("{\"description\":1}", "description must be a string.")]
    [InlineData("{\"autoStart\":\"yes\"}", "autoStart must be true or false.")]
    [InlineData("{\"reports\":\"done\"}", "reports must be a list of strings.")]
    [InlineData("{\"returnOf\":[1]}", "returnOf must be a list of strings.")]
    [InlineData("{\"focus\":true}", "focus must be a string.")]
    [InlineData("{\"description\":\"D\",\"note\":\"x\",\"extra\":1,\"template\":\"T\"}", "Unknown keys: note, extra.")]
    public void Read_WrongJsonType_ReturnsTheErrorAndNoFields(string json, string error)
    {
        var (fields, message) = PlaybookFields.Read(JsonNode.Parse(json));

        Assert.Null(fields);
        Assert.Equal(error, message);
    }

    [Fact]
    public void Read_AbsentAndNullKeys_TakeTheDefaults()
    {
        var (fields, error) = PlaybookFields.Read(new JsonObject { ["description"] = "D", ["model"] = null, ["template"] = "T" });

        Assert.Null(error);
        Assert.True(PlaybookFields.Same(PlaybookFields.Empty with { Description = "D", Template = "T" }, fields));
        Assert.False(PlaybookFields.Same(PlaybookFields.Empty, fields));
    }
}

public sealed class SettingsPagesTests
{
    [Fact]
    public void Nav_Basic_ListsPagesSourcesAddsAndPlaybooksByNamespace()
    {
        var nav = SettingsPages.Nav(SettingsConfigs.State());

        Assert.Equal(
            ["item General", "heading Sources", "item GitHub", "item Zoho Desk off", "add New Forum source", "add New source", "heading Playbooks", "namespace dev", "item develop", "item review", "namespace triage", "item github", "add New playbook", "heading Schedules", "add New schedule", "heading Voice", "item Voice settings", "add New persona"],
            nav.Select((entry) => $"{entry.Kind} {entry.Label}{(entry.Note is null ? "" : $" {entry.Note}")}"));
        Assert.True(nav[0].Current);
        Assert.Equal("add-source", nav[4].Command);
        Assert.Equal("forum", nav[4].Argument);
        Assert.Equal("voice", nav[16].Argument);
        Assert.DoesNotContain(nav, (entry) => entry.Dirty || entry.HasErrors);
    }

    [Fact]
    public void Nav_EnabledMap_MarksTheSourcesItHasOffAndAMissingMapMarksAll()
    {
        var config = SettingsConfigs.Basic();

        config["enabled"] = new JsonObject { ["github"] = false, ["zoho"] = true };

        var notes = (JsonObject? reply) => SettingsPages.Nav(SettingsConfigs.State(reply)).Where((entry) => entry.Argument?.StartsWith("source:", StringComparison.Ordinal) == true).Select((entry) => $"{entry.Argument} {entry.Note}");

        Assert.Equal(["source:github off", "source:zoho "], notes(config));

        config.Remove("enabled");
        Assert.Equal(["source:github off", "source:zoho off"], notes(config));
        Assert.Equal(["source:github ", "source:zoho off"], notes(null));
    }

    [Theory]
    [InlineData("sessions.concurrency", "general")]
    [InlineData("triage.model", "general")]
    [InlineData("dock.openVSCode", "general")]
    [InlineData("alerts.surface", "general")]
    [InlineData("sources.github.repo", "source:github")]
    [InlineData("sources.zoho.orgId", "source:zoho")]
    public void Nav_SettingEdited_MarksOnlyItsPage(string path, string page)
    {
        var state = SettingsConfigs.State();

        state.SetDraft(SettingsFields.SetAt(state.SettingsValue!, path, "x"));

        var dirty = SettingsPages.Nav(state).Where((entry) => entry.Dirty).Select((entry) => entry.Argument);

        Assert.Equal([page], dirty);
    }

    [Fact]
    public void Nav_PlaybookEdited_MarksItsPageAndNamespace()
    {
        var state = SettingsConfigs.State();

        state.SetDraft(SettingsFields.WithPlaybook(state.SettingsValue!, "dev:review", SettingsConfigs.Playbook(template: "Other")));

        Assert.Equal(["namespace:dev", "playbook:dev:review"], SettingsPages.Nav(state).Where((entry) => entry.Dirty).Select((entry) => entry.Argument));
    }

    [Fact]
    public void Nav_PlaybookAddedOrDeletedInTheDraft_MarksTheNewOneAndDropsTheDeletedOne()
    {
        var state = SettingsConfigs.State();
        var value = SettingsFields.WithPlaybook(state.SettingsValue!, "dev:new", SettingsConfigs.Playbook());

        state.SetDraft(SettingsFields.WithPlaybook(value, "triage:github", null));

        var nav = SettingsPages.Nav(state);

        Assert.Equal(["namespace:dev", "playbook:dev:new"], nav.Where((entry) => entry.Dirty).Select((entry) => entry.Argument));
        Assert.DoesNotContain(nav, (entry) => entry.Argument is "playbook:triage:github" or "namespace:triage");
    }

    [Fact]
    public void Nav_Errors_MarkTheirPagesAndNamespaces()
    {
        var state = SettingsConfigs.State();

        state.Errors = ["sessions.concurrency must be 1 to 10.", "playbooks.dev:review: model must be a string."];

        var nav = SettingsPages.Nav(state).Where((entry) => entry.HasErrors).Select((entry) => entry.Argument);

        Assert.Equal(["general", "namespace:dev", "playbook:dev:review"], nav);
    }

    [Fact]
    public void Page_PlaybookErrors_LandOnTheirPlaybooksFieldsOrTop()
    {
        var state = SettingsConfigs.State();

        state.Errors =
        [
            "playbooks.dev:review: description is required.",
            "playbooks.dev:review: Unknown template variable: nope.",
            "playbooks.dev:review: approvalSends applies only to a playbook with the approval report.",
            "playbooks.dev:develop: model must be a string.",
            "playbooks must be an object.",
        ];
        state.Page = "playbook:dev:review";

        var page = SettingsPages.Page(state);
        var fields = page.Sections.SelectMany((section) => section.Fields).ToDictionary((field) => field.Field.Path);

        Assert.Equal(["description is required."], fields["description"].Errors);
        Assert.Equal(["Unknown template variable: nope."], fields["template"].Errors);
        Assert.Equal(["approvalSends applies only to a playbook with the approval report."], page.Errors);
        Assert.Empty(fields["model"].Errors);
        Assert.Equal(["playbooks must be an object."], state.SettingsErrors);

        state.Page = "general";
        Assert.Equal(["playbooks must be an object."], SettingsPages.Page(state).Errors);
    }

    [Fact]
    public void Page_ErrorOfAPlaybookNotInTheDraft_ShowsOnTheSettingsPages()
    {
        var state = SettingsConfigs.State();

        state.Errors = ["playbooks.dev:gone: description is required."];

        Assert.Equal(["playbooks.dev:gone: description is required."], SettingsPages.Page(state).Errors);
    }

    [Fact]
    public void Page_UnreadableEntry_ShowsItsErrorAndDeleteWithoutFields()
    {
        var config = SettingsConfigs.Basic();

        SettingsConfigs.Value(config)["playbooks"]!["dev:bad"] = new JsonObject { ["description"] = "Bad", ["reports"] = "done", ["template"] = "T" };

        var state = SettingsConfigs.State(config);

        state.Page = "playbook:dev:bad";

        var page = SettingsPages.Page(state);

        Assert.Equal(["reports must be a list of strings."], page.Errors);
        Assert.Equal(["delete"], page.Buttons.Select((button) => button.Command));
        Assert.Empty(page.Sections);
        Assert.NotNull(page.Message);
        Assert.Contains(SettingsPages.Nav(state), (entry) => entry.Argument == "playbook:dev:bad" && entry.HasErrors);

        state.Errors = ["playbooks.dev:bad: reports must be a list of done, approval, worktree, playbook, paste."];
        Assert.Equal(["reports must be a list of done, approval, worktree, playbook, paste."], SettingsPages.Page(state).Errors);
    }

    [Fact]
    public void Page_Namespace_ListsItsPlaybooksWithCellsDraftsAndErrors()
    {
        var config = SettingsConfigs.Basic();

        SettingsConfigs.Value(config)["playbooks"]!["dev:broken"] = new JsonArray();

        var state = SettingsConfigs.State(config);

        state.Page = "namespace:dev";
        state.SetDraft(SettingsFields.WithPlaybook(state.SettingsValue!, "dev:review", SettingsConfigs.Playbook(reports: ["approval"])));
        state.Errors = ["playbooks.dev:review: description is required."];

        var page = SettingsPages.Page(state);
        var table = page.Table!;
        var rows = table.Rows.ToDictionary((row) => row.Name);
        var approval = table.Columns.ToList().FindIndex((column) => column.Path == "reports.approval");
        var sends = table.Columns.ToList().FindIndex((column) => column.Path == "approvalSends");

        Assert.Equal("dev playbooks", page.Title);
        Assert.Equal(["dev:broken", "dev:develop", "dev:review"], table.Rows.Select((row) => row.Name));
        Assert.DoesNotContain(table.Columns, (column) => column.Path == "rates");
        Assert.All(rows["dev:broken"].Cells, Assert.Null);
        Assert.Equal(["A playbook must be an object."], rows["dev:broken"].Errors);
        Assert.False(rows["dev:develop"].Cells[approval]!.Checked);
        Assert.False(rows["dev:develop"].Cells[sends]!.Enabled);
        Assert.False(rows["dev:develop"].Dirty);
        Assert.True(rows["dev:review"].Cells[approval]!.Checked);
        Assert.True(rows["dev:review"].Cells[sends]!.Enabled);
        Assert.True(rows["dev:review"].Dirty);
        Assert.Equal(["description is required."], rows["dev:review"].Errors);
        Assert.Equal("review", rows["dev:review"].Label);
        Assert.Empty(page.Buttons);
    }

    [Fact]
    public void Page_NamespaceWithNoPlaybooks_SaysSo()
    {
        var state = SettingsConfigs.State();

        state.Page = "namespace:support";

        var page = SettingsPages.Page(state);

        Assert.Equal("This namespace has no playbooks.", page.Message);
        Assert.Null(page.Table);
        Assert.Empty(page.Buttons);
    }

    [Fact]
    public void Page_SettingsErrors_PlacesFieldErrorsAndShowsTheRestAtTheTop()
    {
        var state = SettingsConfigs.State();

        state.Errors = ["sessions.concurrency must be 1 to 10.", "sources.github.repo must be owner/name.", "Something else."];

        var page = SettingsPages.Page(state);
        var concurrency = page.Sections[0].Fields.Single((field) => field.Field.Path == "sessions.concurrency");

        Assert.Equal(["Something else."], page.Errors);
        Assert.Equal(["sessions.concurrency must be 1 to 10."], concurrency.Errors);
        Assert.Equal("2", concurrency.Text);
        Assert.Empty(page.Buttons);
        Assert.Equal("C:/cfg/settings.json", page.FilePath);
    }

    [Fact]
    public void Page_InvalidSettingsFile_ShowsItsErrorAndNoFields()
    {
        var config = SettingsConfigs.Basic();

        config["settings"]!["value"] = null;
        config["settings"]!["error"] = "settings.json is not valid JSON: x";

        var state = SettingsConfigs.State(config);
        var page = SettingsPages.Page(state);

        Assert.Equal(["settings.json is not valid JSON: x"], page.Errors);
        Assert.Empty(page.Sections);
        Assert.Empty(page.Buttons);
        Assert.Equal("Fix the file in an editor; the window reads it again when it changes.", page.Message);
        Assert.Equal(("settings.json cannot be read", (string?)null, false, false), Summary(SettingsPages.Bar(state)));
    }

    [Fact]
    public void Page_UnknownSource_SaysSoAndOffersRemove()
    {
        var state = SettingsConfigs.State();

        state.Page = "source:jira";

        var page = SettingsPages.Page(state);

        Assert.Equal(["Switchboard has no source kind jira."], page.Notes);
        Assert.Equal("remove-source", page.Buttons[0].Command);
    }

    [Fact]
    public void Page_PlaybookNotInTheDraft_SaysItNoLongerExists()
    {
        var state = SettingsConfigs.State();

        state.Page = "playbook:dev:gone";

        var page = SettingsPages.Page(state);

        Assert.Equal("This playbook no longer exists.", page.Message);
        Assert.Empty(page.Buttons);
    }

    /// <summary>A state whose settings hold one weekly schedule, <c>cleanup</c> (PRD R82).</summary>
    static EditorState WithSchedule()
    {
        var state = SettingsConfigs.State();

        state.SetDraft(SettingsFields.SetAt(state.SettingsValue!, "schedules.cleanup", new JsonObject { ["playbook"] = "dev:review", ["repoRoot"] = "D:/git/widgets", ["every"] = "week", ["day"] = "fri", ["at"] = "12:00" }));
        return state;
    }

    [Fact]
    public void Nav_Schedule_ListsItUnderSchedulesAndMarksItsEditsAndErrors()
    {
        var state = WithSchedule();

        state.Errors = ["schedules.cleanup.playbook names no task playbook: dev:gone."];

        var entry = Assert.Single(SettingsPages.Nav(state), (entry) => entry.Argument == "schedule:cleanup");

        Assert.Equal(("item", "cleanup", true, true), (entry.Kind, entry.Label, entry.Dirty, entry.HasErrors));
        Assert.False(SettingsPages.PageDirty(state, "general"));
    }

    [Theory]
    [InlineData(null, new[] { "playbook", "repoRoot", "every" })]
    [InlineData("day", new[] { "playbook", "repoRoot", "every", "at" })]
    [InlineData("week", new[] { "playbook", "repoRoot", "every", "day", "at" })]
    [InlineData("month", new[] { "playbook", "repoRoot", "every", "day", "at" })]
    public void ScheduleFields_Period_ShowsTheDayAndTimeItUses(string? every, string[] keys)
    {
        var state = WithSchedule();

        state.SetDraft(SettingsFields.SetAt(state.SettingsValue!, "schedules.cleanup.every", every is null ? null : JsonValue.Create(every)));

        var fields = Assert.Single(SettingsFields.ScheduleFields(state, "cleanup")).Fields;

        Assert.Equal(keys.Select((key) => $"schedules.cleanup.{key}"), fields.Select((field) => field.Path));
        Assert.Equal(["", "dev:develop", "dev:review"], fields[0].Options!.Select((option) => option.Value));

        if (every is "week" or "month")
        {
            Assert.Equal(every == "week" ? FieldKind.Select : FieldKind.Integer, fields[3].Kind);
        }
    }

    [Fact]
    public void Page_Schedule_PlacesItsErrorsOnItsFieldsAndOffersRemove()
    {
        var state = WithSchedule();

        state.Page = "schedule:cleanup";
        state.Errors = ["schedules.cleanup.at must be a time from 00:00 to 23:59, such as 09:00."];

        var page = SettingsPages.Page(state);

        Assert.Equal("cleanup", page.Title);
        Assert.Empty(page.Errors);
        Assert.Equal(["schedules.cleanup.at must be a time from 00:00 to 23:59, such as 09:00."], page.Sections[0].Fields.Single((field) => field.Field.Path == "schedules.cleanup.at").Errors);
        Assert.Equal(("remove-schedule", "cleanup"), (page.Buttons[0].Command, page.Buttons[0].Argument));

        state.Page = "schedule:gone";
        Assert.Equal("This schedule no longer exists.", SettingsPages.Page(state).Message);
    }

    [Fact]
    public void Page_NewSchedule_ShowsTheNameErrorOnlyOnceTyped()
    {
        var state = WithSchedule();

        state.Page = "new-schedule";
        Assert.Equal((true, null), (SettingsPages.Page(state).NewName!.Schedule, SettingsPages.Page(state).NewName!.Error));

        state.NewSchedule = ("cleanup", false);
        Assert.Equal("A schedule named cleanup already exists.", SettingsPages.Page(state).NewName!.Error);

        state.NewSchedule = ("Self Review", false);
        Assert.Equal("The name must be lowercase letters, digits and hyphens.", SettingsPages.Page(state).NewName!.Error);
    }

    [Fact]
    public void Page_NewSource_OffersKindsAndShowsTheNameErrorOnlyOnceTyped()
    {
        var state = SettingsConfigs.State();

        state.Page = "new-source";
        var names = SettingsPages.Page(state).NewName!;
        Assert.Equal((null, "github"), (names.Error, names.Kind));
        Assert.Equal([("github", "GitHub"), ("zoho", "Zoho Desk"), ("forum", "Forum")], names.Kinds);

        state.NewSource = ("github", "", false);
        Assert.Equal("A source named github already exists.", SettingsPages.Page(state).NewName!.Error);

        state.NewSource = ("schedule", "", false);
        Assert.Equal("schedule names Switchboard's own tickets; choose another name.", SettingsPages.Page(state).NewName!.Error);

        state.NewSource = ("adhoc", "", false);
        Assert.Equal("adhoc names Switchboard's own tickets; choose another name.", SettingsPages.Page(state).NewName!.Error);

        state.NewSource = ("Widgets Dashboard", "", false);
        Assert.Equal("The name must be lowercase letters, digits and hyphens.", SettingsPages.Page(state).NewName!.Error);
    }

    [Fact]
    public void Page_SourceNamedApartFromItsKind_ShowsTheKindsFieldsAndTitle()
    {
        var state = SettingsConfigs.State();

        state.SetDraft(SettingsFields.SetAt(state.SettingsValue!, "sources.widgets-dashboard", new JsonObject { ["kind"] = "github" }));
        state.Page = "source:widgets-dashboard";
        var page = SettingsPages.Page(state);

        Assert.Equal("widgets-dashboard (GitHub)", page.Title);
        Assert.Empty(page.Notes);
        var kind = page.Sections[0].Fields[0];
        Assert.Equal(("sources.widgets-dashboard.kind", "github"), (kind.Field.Path, kind.Selected));
        Assert.Equal(["", "github", "zoho", "forum"], kind.Field.Options!.Select((option) => option.Value));
        Assert.Equal(["Source", "GitHub", "Advanced"], page.Sections.Select((section) => section.Heading));
        Assert.Contains(page.Sections[1].Fields, (field) => field.Field.Path == "sources.widgets-dashboard.repo");
        Assert.Contains(SettingsPages.Nav(state), (entry) => entry.Argument == "source:widgets-dashboard" && entry.Label == "widgets-dashboard (GitHub)");

        state.SetDraft(SettingsFields.SetAt(state.SettingsValue!, "sources.widgets-dashboard.kind", "jira"));
        Assert.Equal(["Switchboard has no source kind jira."], SettingsPages.Page(state).Notes);

        state.SetDraft(SettingsFields.SetAt(state.SettingsValue!, "sources.adhoc", new JsonObject { ["repoRoot"] = "D:/scratch" }));
        Assert.DoesNotContain(SettingsFields.SourceFields(state, "adhoc").SelectMany((section) => section.Fields), (field) => field.Path == "sources.adhoc.kind");
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
    public void Bar_States_ShowSavedUnsavedErrorsAndChangedOnDisk()
    {
        var state = SettingsConfigs.State();

        Assert.Equal(("Saved", (string?)null, false, false), Summary(SettingsPages.Bar(state)));

        state.Errors = ["a"];
        Assert.Equal("Saved · 1 error", SettingsPages.Bar(state).Status);

        state.SetDraft(SettingsFields.SetAt(state.SettingsValue!, "sessions.concurrency", 3));
        state.Errors = ["a", "b"];

        var dirty = SettingsPages.Bar(state);

        Assert.Equal(("Unsaved changes · 2 errors", true, true, (string?)null), (dirty.Status, dirty.CanSave, dirty.CanDiscard, dirty.Warning));

        state.Refresh(EditorConfig.Parse(SettingsConfigs.Basic().Also((config) => config["settings"]!["version"] = "v2")));

        var changed = SettingsPages.Bar(state);

        Assert.Equal("settings.json changed on disk, so your changes cannot be saved. Discard them and open Settings again to load it.", changed.Warning);
        Assert.False(changed.CanSave);
        Assert.True(changed.CanDiscard);

        state.Saving = true;
        Assert.Equal(("Saving…", false, false), (SettingsPages.Bar(state).Status, SettingsPages.Bar(state).CanSave, SettingsPages.Bar(state).CanDiscard));
    }

    static (string, string?, bool, bool) Summary(BarView bar) => (bar.Status, bar.Warning, bar.CanSave, bar.CanDiscard);

    [Fact]
    public void Refresh_FileReadAgain_DropsADraftItMatchesAndKeepsOthers()
    {
        var state = SettingsConfigs.State();
        var saved = SettingsConfigs.Basic();

        SettingsConfigs.Value(saved)["sessions"]!["concurrency"] = 4;
        saved["settings"]!["version"] = "v2";
        state.SetDraft(SettingsFields.SetAt(state.SettingsValue!, "sessions.concurrency", 5));
        state.Refresh(EditorConfig.Parse(saved));

        Assert.NotNull(state.Draft);
        Assert.Equal("v1", state.DraftVersion);
        Assert.True(state.ChangedOnDisk);

        state.SetDraft(SettingsFields.SetAt(state.SettingsValue!, "sessions.concurrency", 4));
        state.Refresh(EditorConfig.Parse(saved));

        Assert.Null(state.Draft);
        Assert.False(state.ChangedOnDisk);
    }
}

static class JsonTestExtensions
{
    public static JsonObject Also(this JsonObject node, Action<JsonObject> change)
    {
        change(node);
        return node;
    }
}

public sealed class SettingsEditorTests
{
    readonly FakeConfigHub hub = new();

    static Field Concurrency => GeneralField("sessions.concurrency");

    static Field Model => GeneralField("sessions.model");

    static Field GeneralField(string path) => SettingsFields.GeneralFields(SettingsConfigs.State()).SelectMany((section) => section.Fields).Single((field) => field.Path == path);

    static Field PlaybookField(string path, FieldKind kind = FieldKind.Text) => new(path, path, kind, "");

    /// <summary>An editor that has read the file; by default its delayed check never runs, so a test runs it with <see cref="SettingsEditor.Check"/>.</summary>
    async Task<SettingsEditor> Loaded(Func<CancellationToken, Task>? delay = null)
    {
        var editor = new SettingsEditor(hub, delay ?? ((cancel) => Task.Delay(Timeout.Infinite, cancel)));

        await editor.Load();
        hub.Calls.Clear();

        return editor;
    }

    static JsonObject SavedValue(string call) => JsonNode.Parse(call["save ".Length..])!["value"]!.AsObject();

    [Fact]
    public async Task Edit_SettingsField_ChecksTheWholeDraftOnlyAfterTheDelay()
    {
        var wait = new TaskCompletionSource();
        var editor = await Loaded((_) => wait.Task);

        editor.Edit(Concurrency, "11");
        Assert.Empty(hub.Calls);

        hub.CheckReplies.Enqueue(["sessions.concurrency must be 1 to 10."]);
        wait.SetResult();
        await Until(() => editor.State!.Errors.Count > 0);

        var check = JsonNode.Parse(Assert.Single(hub.Calls)["check ".Length..])!;

        Assert.Equal(11, check["sessions"]!["concurrency"]!.GetValue<long>());
        Assert.NotNull(check["playbooks"]!["dev:review"]);
        Assert.NotNull(check["sources"]!["github"]);
        Assert.True(editor.State!.Dirty);
    }

    [Fact]
    public async Task Source_CreateSecondOfKind_AddsItsKindToTheDraft()
    {
        var editor = await Loaded();

        editor.Navigate("new-source");
        editor.Create();
        Assert.Equal("The name must be lowercase letters, digits and hyphens.", SettingsPages.Page(editor.State!).NewName!.Error);

        editor.EditNewName(null, "widgets-dashboard");
        editor.Create();

        Assert.Equal("source:widgets-dashboard", editor.State!.Page);
        Assert.Equal("""{"kind":"github"}""", editor.State.Draft!["sources"]!["widgets-dashboard"]!.ToJsonString());

        editor.Navigate("new-source");
        editor.EditNewKind("forum");
        editor.EditNewName(null, "forum");
        editor.Create();

        Assert.Equal("{}", editor.State.Draft!["sources"]!["forum"]!.ToJsonString());
        Assert.True(editor.State.Dirty);

        var redraws = new List<bool>();
        var kind = SettingsFields.SourceFields(editor.State, "widgets-dashboard")[0].Fields[0];

        editor.Changed += redraws.Add;
        editor.Navigate("source:widgets-dashboard");
        editor.Edit(SettingsFields.SourceFields(editor.State, "widgets-dashboard")[0].Fields.Single((field) => field.Path.EndsWith(".repoRoot", StringComparison.Ordinal)), "D:/git/widgets-dashboard");
        editor.Edit(SettingsFields.SourceFields(editor.State, "widgets-dashboard")[1].Fields.Single((field) => field.Path.EndsWith(".repo", StringComparison.Ordinal)), "acme/widgets-dashboard");
        redraws.Clear();
        editor.Edit(kind, "zoho");

        Assert.Equal("""{"kind":"zoho","repoRoot":"D:/git/widgets-dashboard"}""", editor.State.Draft!["sources"]!["widgets-dashboard"]!.ToJsonString());
        Assert.Equal([true], redraws);
        Assert.Equal("Zoho Desk", SettingsPages.Page(editor.State).Sections[1].Heading);

        var github = SettingsFields.SourceFields(editor.State, "github")[0].Fields[0];
        var before = editor.State.Draft!["sources"]!["github"]!["repo"]!.ToJsonString();

        editor.Navigate("source:github");
        editor.Edit(github, "github");
        editor.Edit(github, "");

        Assert.Equal(before, editor.State.Draft!["sources"]!["github"]!["repo"]!.ToJsonString());
        Assert.Null(editor.State.Draft!["sources"]!["github"]!["kind"]);
    }

    [Fact]
    public async Task Schedule_CreateEditPeriodAndRemove_ChangesOnlyTheDraft()
    {
        var editor = await Loaded();
        var redraws = new List<bool>();

        editor.Changed += redraws.Add;
        editor.Navigate("new-schedule");
        editor.Create();
        Assert.Equal("The name must be lowercase letters, digits and hyphens.", SettingsPages.Page(editor.State!).NewName!.Error);

        editor.EditNewName(null, "cleanup");
        editor.Create();

        Assert.Equal("schedule:cleanup", editor.State!.Page);
        Assert.Equal("{}", editor.State.Draft!["schedules"]!["cleanup"]!.ToJsonString());

        var every = SettingsFields.ScheduleFields(editor.State, "cleanup")[0].Fields.Single((field) => field.Path.EndsWith(".every", StringComparison.Ordinal));

        editor.Edit(every, "week");
        editor.Edit(SettingsFields.ScheduleFields(editor.State, "cleanup")[0].Fields.Single((field) => field.Path.EndsWith(".day", StringComparison.Ordinal)), "fri");
        redraws.Clear();
        editor.Edit(every, "month");

        Assert.Equal("""{"every":"month"}""", editor.State.Draft!["schedules"]!["cleanup"]!.ToJsonString());
        Assert.Equal([true], redraws);

        editor.Edit(SettingsFields.ScheduleFields(editor.State, "cleanup")[0].Fields.Single((field) => field.Path.EndsWith(".at", StringComparison.Ordinal)), "09:00");
        editor.Edit(every, "");
        Assert.Equal("{}", editor.State.Draft!["schedules"]!["cleanup"]!.ToJsonString());

        editor.RemoveSchedule("cleanup");

        Assert.Equal("general", editor.State.Page);
        Assert.Equal("{}", editor.State.Draft!["schedules"]!.ToJsonString());
        Assert.Empty(hub.Calls);
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

        Assert.Contains("\"concurrency\":12", Assert.Single(hub.Calls));
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

        Assert.Equal(["new"], editor.State!.Errors);
    }

    [Fact]
    public async Task Edit_CheckPasses_DoesNotSave()
    {
        var editor = await Loaded((_) => Task.CompletedTask);

        editor.Edit(Concurrency, "3");
        await Until(() => hub.Calls.Count > 0);
        await Task.Delay(50, TestContext.Current.CancellationToken);

        Assert.Empty(hub.Saves);
        Assert.True(editor.State!.Dirty);
        Assert.Equal("Unsaved changes", SettingsPages.Bar(editor.State).Status);
    }

    [Fact]
    public async Task Save_Draft_WritesTheWholeDraftWithItsVersionAndReadsTheFileAgain()
    {
        var editor = await Loaded();

        editor.Edit(Concurrency, "3");
        editor.Navigate("playbook:dev:review");
        editor.Edit(PlaybookField("model"), "opus");

        Assert.True(await editor.Save());

        var save = Assert.Single(hub.Saves);
        var sent = JsonNode.Parse(save["save ".Length..])!;

        Assert.Equal(3, sent["value"]!["sessions"]!["concurrency"]!.GetValue<long>());
        Assert.Equal("opus", sent["value"]!["playbooks"]!["dev:review"]!["model"]!.GetValue<string>());
        Assert.Equal("acme/widgets", sent["value"]!["sources"]!["github"]!["repo"]!.GetValue<string>());
        Assert.Equal(("v1", "C:/cfg"), (sent["version"]!.GetValue<string>(), sent["configDir"]!.GetValue<string>()));
        Assert.Equal("read", hub.Calls.SkipWhile((call) => !call.StartsWith("save", StringComparison.Ordinal)).ElementAt(1));
        Assert.Null(editor.State!.Draft);
        Assert.Equal("s1", editor.State.Config.Settings.Version);
        Assert.Equal("Saved", SettingsPages.Bar(editor.State).Status);
    }

    [Fact]
    public async Task Save_HubRefuses_ShowsItsErrorsInTheBarAndKeepsTheDraftUntilTheNextEdit()
    {
        var editor = await Loaded();

        editor.Edit(Concurrency, "3");
        hub.SaveReplies.Enqueue(["Switchboard is not running."]);

        Assert.False(await editor.Save());
        Assert.Equal(["Switchboard is not running."], SettingsPages.Bar(editor.State!).Errors);
        Assert.True(editor.State!.Dirty);
        Assert.DoesNotContain("read", hub.Calls);

        editor.Edit(Concurrency, "4");
        Assert.Empty(SettingsPages.Bar(editor.State).Errors);
    }

    [Fact]
    public async Task Save_CheckErrorStands_ShowsTheErrorsWithoutCallingTheHub()
    {
        var editor = await Loaded();

        editor.Edit(Concurrency, "11");
        hub.CheckReplies.Enqueue(["sessions.concurrency must be 1 to 10."]);
        await editor.Check();
        hub.Calls.Clear();

        Assert.False(await editor.Save());
        Assert.Empty(hub.Calls);
        Assert.Equal(["sessions.concurrency must be 1 to 10."], SettingsPages.Bar(editor.State!).Errors);
        Assert.True(editor.State!.Dirty);
    }

    [Fact]
    public async Task Save_EditNotYetChecked_ChecksItFirst()
    {
        var editor = await Loaded();

        editor.Edit(Concurrency, "11");
        hub.CheckReplies.Enqueue(["sessions.concurrency must be 1 to 10."]);

        Assert.False(await editor.Save());
        Assert.StartsWith("check", Assert.Single(hub.Calls));
        Assert.Equal(["sessions.concurrency must be 1 to 10."], SettingsPages.Bar(editor.State!).Errors);
    }

    [Fact]
    public async Task Save_NothingChanged_DoesNotCallTheHub()
    {
        var editor = await Loaded();

        Assert.True(await editor.Save());
        Assert.Empty(hub.Calls);
    }

    [Fact]
    public async Task Save_EditedDuringTheSave_KeepsTheEditFromTheVersionWritten()
    {
        var editor = await Loaded();
        var release = new TaskCompletionSource();

        editor.Edit(Concurrency, "3");
        await editor.Check();
        hub.HoldSave = () => release.Task;

        var first = editor.Save();

        Assert.Equal("Saving…", SettingsPages.Bar(editor.State!).Status);
        editor.Edit(Model, "opus");

        var second = editor.Save();

        hub.HoldSave = null;
        release.SetResult();
        Assert.True(await first);
        // The second Save waited for the first, which did not write the later edit.
        Assert.False(await second);

        Assert.Single(hub.Saves);
        Assert.True(editor.State!.Dirty);
        Assert.Equal("s1", editor.State.DraftVersion);
        Assert.False(editor.State.ChangedOnDisk);

        Assert.True(await editor.Save());
        Assert.Equal("{\"concurrency\":3,\"model\":\"opus\"}", SavedValue(hub.Saves.Last())["sessions"]!.ToJsonString());
        Assert.Contains("\"version\":\"s1\"", hub.Saves.Last());
    }

    [Fact]
    public async Task Save_DuringASaveOfTheSameDraft_WaitsAndReportsItSaved()
    {
        var editor = await Loaded();
        var release = new TaskCompletionSource();

        editor.Edit(Concurrency, "3");
        await editor.Check();
        hub.HoldSave = () => release.Task;

        var first = editor.Save();
        var second = editor.Save();

        Assert.False(second.IsCompleted);
        hub.HoldSave = null;
        release.SetResult();

        Assert.True(await second);
        Assert.True(await first);
        Assert.Single(hub.Saves);
    }

    [Fact]
    public async Task Load_DraftEditedBackToTheFileThenFileChanged_ShowsTheNewFile()
    {
        var editor = await Loaded();

        editor.Edit(Concurrency, "3");
        editor.Edit(Concurrency, "2");
        Assert.NotNull(editor.State!.Draft);
        Assert.False(editor.State.Dirty);

        SettingsConfigs.Value(hub.Config)["sessions"]!["model"] = "opus";
        hub.Config["settings"]!["version"] = "v2";
        await editor.Load();

        Assert.Null(editor.State.Draft);
        Assert.Equal("opus", editor.State.SettingsValue!["sessions"]!["model"]!.GetValue<string>());
        Assert.Null(SettingsPages.Bar(editor.State).Warning);
        Assert.Equal("Saved", SettingsPages.Bar(editor.State).Status);
    }

    [Fact]
    public async Task Discard_EveryKindOfChange_DropsThemAllAndReadsTheFile()
    {
        var editor = await Loaded();
        var before = editor.State!.SettingsValue!.ToJsonString();

        editor.Edit(Concurrency, "3");
        editor.RemoveSource("github");
        editor.AddSource("forum");
        editor.EditCell("dev:develop", "autoStart", true);
        editor.Navigate("new-playbook");
        editor.EditNewName("dev", "fix");
        editor.Create();
        hub.SaveReplies.Enqueue(["no"]);
        await editor.Save();
        Assert.True(editor.State.Dirty);
        hub.Calls.Clear();

        await editor.Discard();

        Assert.Null(editor.State.Draft);
        Assert.Equal(before, editor.State.SettingsValue!.ToJsonString());
        Assert.Empty(editor.State.BarErrors);
        Assert.Equal("read", hub.Calls[0]);
        Assert.Empty(hub.Saves);
    }

    [Fact]
    public async Task Load_FileChangedOnDiskWithADraft_KeepsTheDraftWarnsAndDiscardTakesTheFile()
    {
        var editor = await Loaded();

        editor.Edit(Concurrency, "3");
        SettingsConfigs.Value(hub.Config)["sessions"]!["concurrency"] = 7;
        hub.Config["settings"]!["version"] = "v2";
        await editor.Load();

        Assert.Equal(3, editor.State!.SettingsValue!["sessions"]!["concurrency"]!.GetValue<long>());
        Assert.NotNull(SettingsPages.Bar(editor.State).Warning);

        Assert.False(SettingsPages.Bar(editor.State).CanSave);
        Assert.False(await editor.Save());
        Assert.Empty(hub.Saves);

        await editor.Discard();

        Assert.Equal(7, editor.State.SettingsValue!["sessions"]!["concurrency"]!.GetValue<int>());
        Assert.Null(SettingsPages.Bar(editor.State).Warning);
    }

    [Fact]
    public async Task Load_FileChangedOnDiskWithoutADraft_ShowsTheFile()
    {
        var editor = await Loaded();

        SettingsConfigs.Value(hub.Config)["sessions"]!["concurrency"] = 7;
        hub.Config["settings"]!["version"] = "v2";
        await editor.Load();

        Assert.Equal(7, editor.State!.SettingsValue!["sessions"]!["concurrency"]!.GetValue<int>());
        Assert.Null(SettingsPages.Bar(editor.State).Warning);
        Assert.Equal("Saved", SettingsPages.Bar(editor.State).Status);
    }

    [Fact]
    public async Task Load_ReadChangesNothingOnThePage_UpdatesWithoutARedraw()
    {
        var editor = await Loaded();
        var redraws = new List<bool>();

        editor.Changed += redraws.Add;
        await editor.Load();
        SettingsConfigs.Value(hub.Config)["sessions"]!["concurrency"] = 4;
        await editor.Load();

        Assert.False(redraws[0]);
        Assert.Contains(true, redraws.Skip(1));
    }

    [Fact]
    public async Task Edit_PlaybookAgent_RedrawsTheFieldsWithTheAgentsModes()
    {
        var editor = await Loaded();
        var redraws = new List<bool>();

        editor.State!.Page = "playbook:dev:review";
        editor.Changed += redraws.Add;
        editor.Edit(PlaybookField("provider", FieldKind.Select), "codex");

        Assert.Equal([true], redraws);
        Assert.Equal(["", "auto", "bypassPermissions"], SettingsFields.PlaybookFieldsOf(editor.State, editor.State.PlaybookValue("dev:review")!).Single((field) => field.Path == "permissionMode").Options!.Select((option) => option.Value));

        editor.Edit(PlaybookField("model"), "gpt-6");
        Assert.Equal([true, false], redraws);
    }

    [Fact]
    public async Task Save_OwnSave_DoesNotRedrawTheFields()
    {
        var editor = await Loaded();
        var redraws = new List<bool>();

        editor.Edit(Concurrency, "3");
        editor.Changed += redraws.Add;
        await editor.Save();

        Assert.NotEmpty(redraws);
        Assert.DoesNotContain(true, redraws);
    }

    [Fact]
    public async Task Load_ConfigFolderChanged_DropsTheDraftAndSaysSo()
    {
        var editor = await Loaded();

        editor.Edit(Concurrency, "3");
        Assert.NotNull(editor.State!.Draft);

        hub.Config["configDir"] = "D:/repo/switchboard";
        await editor.Load();

        Assert.Null(editor.State!.Draft);
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
        Assert.NotNull(editor.State.Draft);
    }

    [Fact]
    public async Task Create_BadName_ShowsTheErrorWithoutChangingTheDraft()
    {
        var editor = await Loaded();

        editor.Navigate("new-playbook");
        editor.Create();

        Assert.Null(editor.State!.Draft);
        Assert.Equal("new-playbook", editor.State.Page);
        Assert.Equal("Namespace and name must be lowercase letters, digits and hyphens.", SettingsPages.Page(editor.State).NewName!.Error);
    }

    [Fact]
    public async Task Create_Accepted_AddsTheCompactEntryToTheDraftOnlyAndOpensIt()
    {
        var editor = await Loaded();

        editor.Navigate("new-playbook");
        editor.EditNewName("dev", null);
        editor.EditNewName(null, "fix-tests");
        editor.Edit(PlaybookField("description"), "Fix tests");
        editor.Edit(PlaybookField("template", FieldKind.Prompt), "Fix {{ticket.title}}");
        editor.Create();

        Assert.Empty(hub.Saves);
        Assert.Equal("playbook:dev:fix-tests", editor.State!.Page);
        Assert.Equal(NewPlaybook.Empty, editor.State.NewPlaybook);
        Assert.Equal("{\"description\":\"Fix tests\",\"autoStart\":false,\"requiresWorktree\":false,\"template\":\"Fix {{ticket.title}}\"}", editor.State.PlaybookEntry("dev:fix-tests")!.ToJsonString());
        Assert.True(editor.State.PlaybookDirty("dev:fix-tests"));
        Assert.Null(editor.State.FileEntry("dev:fix-tests"));
    }

    [Fact]
    public async Task Create_NameAlreadyInTheDraft_IsRefused()
    {
        var editor = await Loaded();

        editor.Navigate("new-playbook");
        editor.EditNewName("dev", "fix");
        editor.Create();
        var draft = editor.State!.Draft!.ToJsonString();

        editor.Navigate("new-playbook");
        editor.EditNewName("dev", "fix");
        editor.Edit(PlaybookField("description"), "Other");
        editor.Create();

        Assert.Equal("new-playbook", editor.State.Page);
        Assert.Equal("A playbook named dev:fix already exists.", SettingsPages.Page(editor.State).NewName!.Error);
        Assert.Equal(draft, editor.State.Draft!.ToJsonString());
    }

    [Fact]
    public async Task Delete_PlaybookInUse_AsksNamingTheOpenWorkItemsAndRemovesItFromTheDraftOnlyOnYes()
    {
        var editor = await Loaded();
        var asked = new List<string>();
        var answer = false;

        editor.Confirm = (question, detail, _) =>
        {
            asked.Add($"{question} {detail}");
            return Task.FromResult(answer);
        };
        editor.Navigate("playbook:dev:develop");
        await editor.Delete();

        Assert.Equal(["Delete playbook dev:develop? 2 open work items use it. Save removes it from settings.json."], asked);
        Assert.Null(editor.State!.Draft);

        answer = true;
        await editor.Delete();

        Assert.False(editor.State.HasPlaybook("dev:develop"));
        Assert.NotNull(editor.State.FileEntry("dev:develop"));
        Assert.Equal("general", editor.State.Page);
        Assert.Empty(hub.Saves);
        Assert.Equal(["read", "read"], hub.Calls.Where((call) => !call.StartsWith("check", StringComparison.Ordinal)));
    }

    [Fact]
    public async Task Delete_WorkItemsChangedSinceTheRead_NamesTheCurrentCount()
    {
        var editor = await Loaded();
        var asked = new List<string>();

        editor.Confirm = (question, detail, _) =>
        {
            asked.Add(detail);
            return Task.FromResult(false);
        };
        editor.Navigate("playbook:dev:review");
        hub.Config["inUse"]!["dev:review"] = 1;
        await editor.Delete();

        Assert.Equal(["1 open work item uses it. Save removes it from settings.json."], asked);
    }

    [Fact]
    public async Task AddAndRemoveSource_Clicked_ChangeOnlyTheDraftWithoutAsking()
    {
        var editor = await Loaded();
        var asked = 0;

        editor.Confirm = (_, _, _) =>
        {
            asked++;
            return Task.FromResult(true);
        };
        editor.AddSource("forum");
        Assert.Equal("source:forum", editor.State!.Page);
        Assert.Equal("{}", editor.State.SettingsValue!["sources"]!["forum"]!.ToJsonString());

        editor.RemoveSource("github");
        Assert.Equal("general", editor.State.Page);
        Assert.Null(editor.State.SettingsValue!["sources"]!["github"]);
        Assert.NotNull(editor.State.Config.Settings.Value!["sources"]!["github"]);
        Assert.Null(editor.State.Config.Settings.Value!["sources"]!["forum"]);
        Assert.Equal(0, asked);
        Assert.Empty(hub.Saves);
    }

    [Fact]
    public async Task EditCell_NamespacePage_WritesTheCompactEntryInPlace()
    {
        SettingsConfigs.Value(hub.Config)["playbooks"]!["dev:review"] = new JsonObject { ["description"] = "Build it", ["kind"] = "task", ["model"] = null, ["template"] = "Do it." };

        var editor = await Loaded();

        editor.Navigate("namespace:dev");
        editor.EditCell("dev:review", "reports.approval", true);
        editor.EditCell("dev:review", "workdir", true);

        Assert.Equal(
            "{\"description\":\"Build it\",\"autoStart\":false,\"requiresWorktree\":false,\"workdir\":\"repoRoot\",\"reports\":[\"approval\"],\"template\":\"Do it.\"}",
            editor.State!.PlaybookEntry("dev:review")!.ToJsonString());
        Assert.Equal(["dev:develop", "dev:review", "triage:github"], ((JsonObject)editor.State.SettingsValue!["playbooks"]!).Select((entry) => entry.Key));
        Assert.Empty(hub.Saves);
    }

    [Fact]
    public async Task EditPlaybook_EditUndone_RestoresTheFileEntryAndIsNotUnsaved()
    {
        SettingsConfigs.Value(hub.Config)["playbooks"]!["dev:review"] = new JsonObject { ["description"] = "Build it", ["kind"] = "task", ["template"] = "Do it." };

        var editor = await Loaded();

        editor.Navigate("playbook:dev:review");
        editor.Edit(PlaybookField("autoStart", FieldKind.Boolean), "", true);
        Assert.True(editor.State!.PlaybookDirty("dev:review"));

        editor.Edit(PlaybookField("autoStart", FieldKind.Boolean), "", false);

        Assert.False(editor.State.PlaybookDirty("dev:review"));
        Assert.False(editor.State.Dirty);
    }

    [Fact]
    public async Task EditPlaybook_Template_IsStoredAsTyped()
    {
        var editor = await Loaded();

        editor.Navigate("playbook:dev:review");
        editor.Edit(PlaybookField("template", FieldKind.Prompt), "Line one\nLine two");

        Assert.Equal("Line one\nLine two", editor.State!.PlaybookEntry("dev:review")!["template"]!.GetValue<string>());
    }

    [Fact]
    public async Task UnknownKey_Entry_ShowsItsErrorAndDeleteWithoutFieldsAndCannotBeEdited()
    {
        SettingsConfigs.Value(hub.Config)["playbooks"]!["dev:review"] = new JsonObject { ["description"] = "Build it", ["note"] = "mine", ["template"] = "Do it." };

        var editor = await Loaded();

        editor.Navigate("playbook:dev:review");

        var page = SettingsPages.Page(editor.State!);

        Assert.Equal(["Unknown keys: note."], page.Errors);
        Assert.Equal(["delete"], page.Buttons.Select((button) => button.Command));
        Assert.Empty(page.Sections);

        editor.EditCell("dev:review", "autoStart", true);
        Assert.Null(editor.State!.Draft);
    }

    [Fact]
    public async Task EditCell_UnreadableEntry_DoesNothing()
    {
        SettingsConfigs.Value(hub.Config)["playbooks"]!["dev:broken"] = new JsonObject { ["reports"] = "done" };

        var editor = await Loaded();

        editor.Navigate("namespace:dev");
        editor.EditCell("dev:broken", "autoStart", true);

        Assert.Null(editor.State!.Draft);
    }

    [Fact]
    public async Task Check_PlaybookErrors_LandOnThePlaybookPageField()
    {
        var editor = await Loaded();

        editor.Navigate("playbook:dev:review");
        editor.Edit(PlaybookField("description"), "");
        hub.CheckReplies.Enqueue(["playbooks.dev:review: description is required."]);
        await editor.Check();

        var page = SettingsPages.Page(editor.State!);

        Assert.Equal(["description is required."], page.Sections[0].Fields.Single((field) => field.Field.Path == "description").Errors);
        Assert.Empty(page.Errors);
        Assert.Equal("Unsaved changes · 1 error", SettingsPages.Bar(editor.State!).Status);
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
