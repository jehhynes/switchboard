using System.Text.Json.Nodes;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Views;

namespace Switchboard.Dock.Tests;

public sealed class DockViewTests
{
    [Fact]
    public void Parse_RecordedMessage_ReadsGroupsRowsAndSnoozeChoices()
    {
        var view = Fixtures.View;

        Assert.Equal(["review", "blocked", "progress", "unstarted", "done"], view.Groups.Select((group) => group.Key));
        Assert.Equal(["item:13", "item:7", "item:10"], view.Groups[0].Rows.Select((row) => row.Key));
        Assert.Equal(["item:14", "item:8", "item:15"], view.Groups[1].Rows.Select((row) => row.Key));
        Assert.Equal(7, view.Snooze.Count);
        Assert.Equal(new SnoozeChoice("Indefinitely", "", null), view.Snooze[^1]);
        Assert.Equal(1791093600000, view.Snooze[0].Until);
    }

    [Fact]
    public void Parse_RecordedMessage_ReadsEveryRowField()
    {
        var finished = Fixtures.Row("item:7");

        Assert.Equal("Issue <7>", finished.Title);
        Assert.Equal(new TimeText("3h", "Ready since 2026-10-03 09:00 UTC"), finished.Time);
        Assert.Equal(("dev:develop", "gh 107", "github"), (finished.Playbook, finished.Ticket, finished.Source));
        Assert.Equal(new RowMark("finished", "\uea70", "Review the finished turn"), finished.Mark);
        Assert.Equal([new DockText("Review the finished turn", null, null)], finished.Details);
        Assert.Equal((Tone.Turn, "operator", false, true), (finished.Stripe, finished.Turn, finished.Dim, finished.Movable));
        Assert.Equal(("gh-107-58c609", "Issue <7>"), (finished.Window!.Name, finished.Window.Title));
        Assert.Equal(["D:/git/widgets/.worktrees/107-fix"], finished.Window.Folders);
        Assert.Equal(new DockOpen("session", null, "aaaa1111-native", "D:/git/widgets/.worktrees/107-fix", null, "claude"), finished.Open);
        Assert.Equal(["Mark done", "Snooze…", "Add comment…", "Delete", "Move to top", "Move up", "Move down"], finished.Controls.Select((control) => control.Label));
        Assert.Equal("{\"type\":\"mark-done\",\"workItemId\":7}", finished.Controls[0].Action.ToJsonString());
        Assert.Null(finished.Controls[0].Confirm);
        Assert.Equal(("Delete gh 107?", "Delete"), (finished.Controls[3].Confirm!.Question, finished.Controls[3].Confirm!.Action));
        Assert.StartsWith("Switchboard deletes the work item", finished.Controls[3].Confirm!.Detail);
        Assert.Equal("{\"type\":\"move\",\"workItemId\":7,\"after\":10}", finished.Controls[6].Action.ToJsonString());
        Assert.Equal(new DockInput("Add comment", "Switchboard keeps it with the work item and shows it on the row. It is not sent to the source.", "text", "Add"), finished.Controls[2].Input);
        Assert.Null(finished.Comment);
        Assert.Equal(7, finished.WorkItemId);
    }

    [Fact]
    public void Parse_RecordedMessage_ReadsQuestionOpenPriorityAndPoolRow()
    {
        Assert.Equal(new DockOpen("question", 8, "aaaa1111-native", "D:/git/widgets", null, "claude"), Fixtures.Row("item:8").Open);
        Assert.Equal("Immediacy: BLOCKING   Severity: MED", Fixtures.Row("item:9").Priority);

        var pool = Fixtures.Row("ticket:4");

        Assert.Null(pool.Time);
        Assert.Null(pool.Window);
        Assert.Equal(new DockOpen("url", null, null, null, "https://github.com/o/r/issues/104"), pool.Open);
    }

    [Fact]
    public void Parse_RecordedMessage_ReadsStartWithGuidanceInput()
    {
        var unstarted = Fixtures.Row("item:9");
        var guided = unstarted.Controls[1];

        Assert.Equal(["Start", "Start with guidance…"], unstarted.Controls.Take(2).Select((control) => control.Label));
        Assert.Null(unstarted.Controls[0].Input);
        Assert.Equal(("Start with guidance", "Switchboard adds your guidance to the end of the session's prompt.", "guidance", "Start"), (guided.Input!.Question, guided.Input.Detail, guided.Input.Field, guided.Input.Action));
        Assert.Equal(("playbook", "Playbook", "dev:develop"), (guided.Input.Choice!.Field, guided.Input.Choice.Label, guided.Input.Choice.Value));
        Assert.Equal(["dev:develop", "dev:other"], guided.Input.Choice.Values);
        Assert.Equal("{\"type\":\"start\",\"workItemId\":9}", guided.Action.ToJsonString());
        Assert.Equal("{\"type\":\"pick\",\"ticketId\":4}", Fixtures.Row("ticket:4").Controls.Single((control) => control.Input is not null).Action.ToJsonString());
    }

    [Fact]
    public void Parse_InputWithText_ReadsTheTextThatStartsInTheBox()
    {
        var json = Fixtures.DockJson.Replace("\"field\": \"guidance\",", "\"field\": \"prompt\", \"text\": \"Write hello.txt\",");
        var row = DockView.Parse(json).Groups.SelectMany((group) => group.Rows).Single((row) => row.Key == "item:9");

        Assert.Equal(("prompt", "Write hello.txt"), (row.Controls[1].Input!.Field, row.Controls[1].Input!.Text));
        Assert.Null(Fixtures.Row("item:9").Controls[1].Input!.Text);
    }

    [Fact]
    public void Parse_OpenWindows_ReadsTheFilesTheFrontAndTheCount()
    {
        Assert.Null(Fixtures.View.Windows);

        var json = System.Text.Json.Nodes.JsonNode.Parse(Fixtures.DockJson)!.AsObject();

        json["windows"] = System.Text.Json.Nodes.JsonNode.Parse("""{"open":["/home/op/.switchboard/windows/gh-107-58c609.code-workspace"],"front":null,"count":2}""");

        var windows = DockView.Parse(json.ToJsonString()).Windows!;

        Assert.Equal(["/home/op/.switchboard/windows/gh-107-58c609.code-workspace"], windows.Open);
        Assert.Null(windows.Front);
        Assert.Equal(2, windows.Count);
    }

    [Fact]
    public void Parse_NullView_Throws()
    {
        Assert.Throws<System.Text.Json.JsonException>(() => DockView.Parse("null"));
    }

    [Fact]
    public void Parse_RecordedMessage_ReadsControlsPastesCommandsAndHeader()
    {
        var view = Fixtures.View;
        var question = Fixtures.Row("item:8");
        var approval = Fixtures.Row("item:10");

        Assert.Equal([("github", true, "github: polled\nClick to stop polling it."), ("zoho", false, "zoho: not polled\nClick to poll it.")], view.Sources.Select((group) => (group.Kind, group.Enabled, group.Title)));
        Assert.Equal([new SourceState("github", true)], view.Sources[0].Sources);
        Assert.Equal(["D:/git/widgets", "D:/git/support"], view.RepoRoots);
        Assert.Equal("Open in Claude", question.Main);
        Assert.Equal("Approve", approval.Main);
        Assert.Equal([new DockPaste("Customer reply", "D:/drafts/reply.md")], approval.Pastes);
        Assert.Equal(["Open in terminal", "History", "Open report"], approval.Commands.Select((command) => command.Label));
        Assert.Equal("Issue <7> · gh 107 · PR #19002 · gh 20087 · dev:develop · Ready for review · 107-fix", Fixtures.Row("item:7").Search);
        Assert.Equal(
            [new DockLink("PR #19002", "https://github.com/o/r/pull/19002", "pr", "19002", "\uEA64", false), new DockLink("gh 20087", "https://github.com/o/r/issues/20087", "issue", "gh 20087", null, true)],
            Fixtures.Row("item:7").Links);
        Assert.Equal(["https://github.com/o/r/pull/19002", "Named in the ticket: https://github.com/o/r/issues/20087"], Fixtures.Row("item:7").Links.Select((link) => link.Tooltip));
        Assert.Equal(2, Fixtures.Row("item:7").Returned);
        Assert.Equal(@"C:\Users\op\.switchboard\windows\gh-107-58c609.code-workspace", Fixtures.Row("item:7").Window!.File);
    }

    [Fact]
    public void Parse_RecordedMessage_ReadsStripesTurnsDimAndMovable()
    {
        Assert.Equal((Tone.Error, "operator", false, false), Stripe("item:14"));
        Assert.Equal((Tone.Warning, "operator", false, false), Stripe("item:8"));
        Assert.Equal((null, "agent", true, true), Stripe("item:13"));
        Assert.Equal((Tone.Turn, "operator", false, true), Stripe("item:10"));
        Assert.Equal((null, null, false, false), Stripe("item:9"));
        Assert.Equal((null, null, false, false), Stripe("ticket:4"));
        Assert.Null(Fixtures.Row("ticket:4").WorkItemId);

        static (Tone?, string?, bool, bool) Stripe(string key) => Fixtures.Row(key) is var row ? (row.Stripe, row.Turn, row.Dim, row.Movable) : default;
    }

    [Fact]
    public void Parse_OlderHubAgentStripe_ReadsNoStripe()
    {
        var view = DockView.Parse(Fixtures.DockJson.Replace("\"stripe\": \"turn\"", "\"stripe\": \"agent\"", StringComparison.Ordinal));
        var rows = view.Groups.SelectMany((group) => group.Rows).ToDictionary((row) => row.Key);

        Assert.Equal<Tone?>([null, null, Tone.Warning, Tone.Error], [rows["item:7"].Stripe, rows["item:10"].Stripe, rows["item:8"].Stripe, rows["item:14"].Stripe]);
    }

    [Fact]
    public void Parse_ViewFromAnOlderHub_DefaultsTheNewFields()
    {
        var json = JsonNode.Parse(Fixtures.DockJson)!.AsObject();

        foreach (var group in json["groups"]!.AsArray())
        {
            foreach (var row in group!["rows"]!.AsArray())
            {
                row!.AsObject().Remove("turn");
                row.AsObject().Remove("dim");
                row.AsObject().Remove("movable");
            }
        }

        var view = DockView.Parse(json.ToJsonString());
        var rows = view.Groups.SelectMany((group) => group.Rows).ToList();

        Assert.Equal(10, rows.Count);
        Assert.All(rows, (row) => Assert.Equal((null, false, false), (row.Turn, row.Dim, row.Movable)));
    }

    [Fact]
    public void Parse_RecordedCodeModeRow_OpensTheSessionAndOffersItsAttachTerminal()
    {
        var row = Fixtures.Row("item:15");
        var terminal = row.Commands.Single((command) => command.Label == "Open in terminal").Command;

        Assert.Equal(new DockOpen("session", null, "cm15", "D:/git/widgets", null, "claude"), row.Open);
        Assert.Equal(("Open in terminal", "Open in terminal: attaches to the Code Mode session"), (row.Main, row.MainTitle));
        Assert.Equal(("cm15", true), (terminal["sessionId"]!.GetValue<string>(), terminal["codeMode"]!.GetValue<bool>()));
        Assert.DoesNotContain(row.Controls, (control) => control.Label == "Open in Claude");
    }

    [Fact]
    public void Parse_RecordedHeldSessions_ReadsOrphansFirstWithTheirNoteAndAttachTerminals()
    {
        var view = Fixtures.View;

        Assert.Equal("1 held session without a work item", view.HeldNote);
        Assert.Equal(
            [("o1", "No work item", "9273f594-1111", "live", "3m", "50 MB", 0, true), ("cm15", "gh 115", "eeee5555-native", "waiting", "2h 5m", "300 MB", 1, false)],
            view.Held!.Select((held) => (held.Session, held.Item, held.NativeSessionId, held.State, held.Idle, held.Memory, held.Clients, held.Orphan)));
        Assert.Null(view.Held![0].Terminal);

        var terminal = view.Held[1].Terminal!;

        Assert.Equal(("cm15", true, false), (terminal.SessionId, terminal.CodeMode, terminal.Active));
        Assert.Equal(["attach", "cm15"], terminal.Args);
        Assert.EndsWith("-cm15", terminal.Name);
        Assert.EndsWith($"sb:{terminal.Name}", terminal.Title);
    }

    [Fact]
    public void Parse_HubWithoutHeldSessions_ReadsNone()
    {
        var json = JsonNode.Parse(Fixtures.DockJson)!.AsObject();

        json.Remove("held");
        json.Remove("heldNote");

        var view = DockView.Parse(json.ToJsonString());

        Assert.Equal((null, null), (view.Held, view.HeldNote));
    }

    [Fact]
    public void Parse_LinkFromAnOlderHub_ShowsItsName()
    {
        var link = System.Text.Json.JsonSerializer.Deserialize<DockLink>("""{"label":"PR #19002","url":"https://github.com/o/r/pull/19002"}""", new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web))!;

        Assert.Equal(("PR #19002", false), (link.Text, link.HasGlyph));
    }

    [Avalonia.Headless.XUnit.AvaloniaFact]
    public void Show_OlderHubSources_ShowsEachAsAToggleOfOne()
    {
        var json = System.Text.Json.Nodes.JsonNode.Parse(Fixtures.DockJson)!;
        json["sources"] = System.Text.Json.Nodes.JsonNode.Parse("""[{"name":"github","enabled":true},{"name":"zoho","enabled":false}]""");
        var model = new DockViewModel(new DockSettings(), (_) => { });

        model.Show(DockView.Parse(json.ToJsonString()));

        Assert.Equal([("github", "github", true, false), ("zoho", "zoho", false, false)], model.Sources.Select((group) => (group.Kind, group.Name, group.Enabled, group.IsMenu)));
        Assert.Equal("zoho: not polled. Click to poll it.", model.Sources[1].Tip);
    }
}
