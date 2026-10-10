using System.Text.Json.Nodes;
using Switchboard.Dock.Hub;

namespace Switchboard.Dock.Tests;

public sealed class DockViewTests
{
    [Fact]
    public void Parse_RecordedMessage_ReadsGroupsRowsAndSnoozeChoices()
    {
        var view = Fixtures.View;

        Assert.Equal(["review", "blocked", "progress", "unstarted", "done"], view.Groups.Select((group) => group.Key));
        Assert.Equal(["item:13", "item:7", "item:10"], view.Groups[0].Rows.Select((row) => row.Key));
        Assert.Equal(["item:14", "item:8"], view.Groups[1].Rows.Select((row) => row.Key));
        Assert.Equal([2, null, null, null, null], view.Groups.Select((group) => group.Yours));
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
        Assert.Equal(new DockOpen("session", null, "aaaa1111-native", "D:/git/widgets/.worktrees/107-fix", null), finished.Open);
        Assert.Equal(["Triage again", "Mark done", "Snooze", "Move to top", "Move up", "Move down"], finished.Controls.Select((control) => control.Label));
        Assert.Equal("{\"type\":\"retriage\",\"workItemId\":7}", finished.Controls[0].Action.ToJsonString());
        Assert.Equal("{\"type\":\"move\",\"workItemId\":7,\"after\":10}", finished.Controls[5].Action.ToJsonString());
        Assert.Equal(7, finished.WorkItemId);
    }

    [Fact]
    public void Parse_RecordedMessage_ReadsQuestionOpenPriorityAndPoolRow()
    {
        Assert.Equal(new DockOpen("question", 8, "aaaa1111-native", "D:/git/widgets", null), Fixtures.Row("item:8").Open);
        Assert.Equal("Immediacy: BLOCKING   Severity: MED", Fixtures.Row("item:9").Priority);

        var pool = Fixtures.Row("ticket:4");

        Assert.Null(pool.Time);
        Assert.Null(pool.Window);
        Assert.Equal(new DockOpen("url", null, null, null, "https://github.com/o/r/issues/104"), pool.Open);
    }

    [Fact]
    public void Parse_NullView_Throws()
    {
        Assert.Throws<System.Text.Json.JsonException>(() => DockView.Parse("null"));
    }

    [Fact]
    public void Parse_RecordedMessage_ReadsControlsAnswersPastesCommandsAndHeader()
    {
        var view = Fixtures.View;
        var question = Fixtures.Row("item:8");
        var approval = Fixtures.Row("item:10");

        Assert.Equal([new SourceState("github", true), new SourceState("zoho", false)], view.Sources);
        Assert.Equal(["D:/git/widgets", "D:/git/support"], view.RepoRoots);
        Assert.Equal("Open in Claude", question.Main);
        Assert.Equal("main", question.Answers.Single().Label);
        Assert.Equal("{\"type\":\"answer\",\"workItemId\":8,\"nativeSessionId\":\"aaaa1111-native\",\"question\":\"Which branch?\",\"answer\":\"main\"}", question.Answers.Single().Action.ToJsonString());
        Assert.Equal("Approve", approval.Main);
        Assert.Equal([new DockPaste("Customer reply", "D:/drafts/reply.md")], approval.Pastes);
        Assert.Equal(["Open in terminal", "History", "Open report"], approval.Commands.Select((command) => command.Label));
        Assert.Equal("Issue <7> · gh 107 · PR #19002 · dev:develop · Ready for review · 107-fix", Fixtures.Row("item:7").Search);
        Assert.Equal([new DockLink("PR #19002", "https://github.com/o/r/pull/19002", "pr", "19002", "\uEA64")], Fixtures.Row("item:7").Links);
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
            group!.AsObject().Remove("yours");

            foreach (var row in group["rows"]!.AsArray())
            {
                row!.AsObject().Remove("turn");
                row.AsObject().Remove("dim");
                row.AsObject().Remove("movable");
            }
        }

        var view = DockView.Parse(json.ToJsonString());
        var rows = view.Groups.SelectMany((group) => group.Rows).ToList();

        Assert.Equal(9, rows.Count);
        Assert.All(view.Groups, (group) => Assert.Null(group.Yours));
        Assert.All(rows, (row) => Assert.Equal((null, false, false), (row.Turn, row.Dim, row.Movable)));
    }

    [Fact]
    public void Parse_LinkFromAnOlderHub_ShowsItsName()
    {
        var link = System.Text.Json.JsonSerializer.Deserialize<DockLink>("""{"label":"PR #19002","url":"https://github.com/o/r/pull/19002"}""", new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web))!;

        Assert.Equal(("PR #19002", false), (link.Text, link.HasGlyph));
    }
}
