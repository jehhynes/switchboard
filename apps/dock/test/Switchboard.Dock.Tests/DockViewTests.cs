using Switchboard.Dock.Hub;

namespace Switchboard.Dock.Tests;

public sealed class DockViewTests
{
    [Fact]
    public void Parse_RecordedMessage_ReadsGroupsRowsAndSnoozeChoices()
    {
        var view = Fixtures.View;

        Assert.Equal(["needs", "working", "unstarted", "done"], view.Groups.Select((group) => group.Key));
        Assert.Equal(["item:7", "item:8", "item:10"], view.Groups[0].Rows.Select((row) => row.Key));
        Assert.Equal(7, view.Snooze.Count);
        Assert.Equal(new SnoozeChoice("Indefinitely", "", null), view.Snooze[^1]);
        Assert.Equal(1791093600000, view.Snooze[0].Until);
    }

    [Fact]
    public void Parse_RecordedMessage_ReadsEveryRowField()
    {
        var blocked = Fixtures.Row("item:7");

        Assert.Equal("Issue <7>", blocked.Title);
        Assert.Equal(new TimeText("0m", "In this status since 2026-10-03 12:00 UTC"), blocked.Time);
        Assert.Equal(("dev:develop", "gh 107", "github"), (blocked.Playbook, blocked.Ticket, blocked.Source));
        Assert.Equal(new RowMark("blocked", "\uead1", "Blocked"), blocked.Mark);
        Assert.Equal([new DockText("The session finished its turn.", null, Tone.Warning)], blocked.Details);
        Assert.Equal(Tone.Warning, blocked.Stripe);
        Assert.Equal("sb:gh-107-58c609 · ", blocked.Window!.TitlePrefix);
        Assert.Equal(["D:/git/widgets/.worktrees/107-fix"], blocked.Window.Folders);
        Assert.Equal(new DockOpen("session", null, "aaaa1111-native", "D:/git/widgets/.worktrees/107-fix", null), blocked.Open);
        Assert.Equal(["Triage again", "Mark done", "Snooze"], blocked.Controls.Select((control) => control.Label));
        Assert.Equal("{\"type\":\"retriage\",\"workItemId\":7}", blocked.Controls[0].Action.ToJsonString());
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
        Assert.Equal(["History", "Open report"], approval.Commands.Select((command) => command.Label));
        Assert.Equal("Issue <7> · gh 107 · PR #19002 · dev:develop · Needs you · 107-fix", Fixtures.Row("item:7").Search);
        Assert.Equal([new DockLink("PR #19002", "https://github.com/o/r/pull/19002")], Fixtures.Row("item:7").Links);
        Assert.Equal(2, Fixtures.Row("item:7").Returned);
        Assert.Equal(@"C:\Users\op\.switchboard\windows\gh-107-58c609.code-workspace", Fixtures.Row("item:7").Window!.File);
    }
}
