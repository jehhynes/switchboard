using Switchboard.Dock.Hub;
using Switchboard.Dock.Switching;

namespace Switchboard.Dock.Tests;

public sealed class SwitcherTests
{
    readonly FakeHub hub = new();
    readonly FakeWindows windows = new();
    readonly FakeVsCode vsCode = new();
    readonly List<TimeSpan> waits = [];

    Switcher Switcher() => new(hub, windows, vsCode, (span) =>
    {
        waits.Add(span);
        return Task.CompletedTask;
    });

    [Fact]
    public async Task Click_OpenWindowAndEndedSession_LeavesTheSessionThenBringsTheWindowForward()
    {
        windows.Open["sb:gh-107-58c609 · "] = (42, 0);

        var status = await Switcher().Click(Fixtures.Row("item:7"), TestContext.Current.CancellationToken);

        Assert.Null(status);
        Assert.Equal(["open aaaa1111-native D:/git/widgets/.worktrees/107-fix gh-107-58c609.code-workspace"], hub.Calls);
        Assert.Equal(["show 42"], windows.Calls);
        Assert.Empty(vsCode.Calls);
    }

    [Fact]
    public async Task Click_NoWindowYet_OpensTheWorkspaceAndWaitsForTheWindow()
    {
        windows.Open["sb:gh-107-58c609 · "] = (43, 3);

        var status = await Switcher().Click(Fixtures.Row("item:7"), TestContext.Current.CancellationToken);

        Assert.Null(status);
        Assert.Equal(["open gh-107-58c609.code-workspace"], vsCode.Calls);
        Assert.Equal(4, windows.Finds("sb:gh-107-58c609 · "));
        Assert.Equal(3, waits.Count);
        Assert.Equal(["show 43"], windows.Calls);
    }

    [Fact]
    public async Task Click_WindowNeverAppears_SaysSoAfterTheWait()
    {
        var status = await Switcher().Click(Fixtures.Row("item:7"), TestContext.Current.CancellationToken);

        Assert.Equal("VS Code did not open the window for gh-107-58c609 within 20 seconds.", status);
        Assert.Equal(200, waits.Count);
        Assert.Empty(windows.Calls);
    }

    [Fact]
    public async Task Click_VsCodeFailsToStart_ShowsWhy()
    {
        vsCode.Fails = new FileNotFoundException("Code.exe was not found beside code on PATH.");

        Assert.Equal("VS Code did not start: Code.exe was not found beside code on PATH.", await Switcher().Click(Fixtures.Row("item:7"), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Click_WindowsKeepsAnotherWindowInFront_AsksForAnotherClick()
    {
        windows.Open["sb:gh-107-58c609 · "] = (42, 0);
        windows.Front = false;

        Assert.Equal("Windows kept another window in front. Click the row again.", await Switcher().Click(Fixtures.Row("item:7"), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Click_HubRefusesTheOpen_DoesNotSwitch()
    {
        windows.Open["sb:gh-107-58c609 · "] = (42, 0);
        hub.OpenReply = "Switchboard is not running.";

        Assert.Equal("Switchboard is not running.", await Switcher().Click(Fixtures.Row("item:7"), TestContext.Current.CancellationToken));
        Assert.Empty(windows.Calls);
    }

    [Fact]
    public async Task Click_QuestionRow_StopsTheSessionWaitsForItToEndThenOpensIt()
    {
        var question = Fixtures.Row("item:8");
        var stopped = Fixtures.View with { Groups = [new DockGroup("needs", "Needs you", null, [question with { Open = question.Open! with { Type = "session", WorkItemId = null } }])] };

        windows.Open["sb:gh-108-widgets-655280 · "] = (44, 0);
        hub.ActReplies.Enqueue(null);
        hub.Ended = stopped;

        var status = await Switcher().Click(question, TestContext.Current.CancellationToken);

        Assert.Null(status);
        Assert.Equal(["act {\"type\":\"open-question\",\"workItemId\":8,\"nativeSessionId\":\"aaaa1111-native\"}", "until 20s", "open aaaa1111-native D:/git/widgets gh-108-widgets-655280.code-workspace"], hub.Calls);
        Assert.Equal(["show 44"], windows.Calls);
    }

    [Fact]
    public async Task Click_QuestionRowWhoseSessionDoesNotStop_OpensNothing()
    {
        hub.ActReplies.Enqueue(null);
        hub.Ended = Fixtures.View;

        Assert.Equal("The session did not stop within 20 seconds, so it was not opened in Claude.", await Switcher().Click(Fixtures.Row("item:8"), TestContext.Current.CancellationToken));
        Assert.DoesNotContain(hub.Calls, (call) => call.StartsWith("open"));
        Assert.Empty(windows.Calls);
    }

    [Fact]
    public async Task Click_QuestionRowRefused_ShowsTheRefusal()
    {
        hub.ActReplies.Enqueue("The session no longer waits on a question.");

        Assert.Equal("The session no longer waits on a question.", await Switcher().Click(Fixtures.Row("item:8"), TestContext.Current.CancellationToken));
        Assert.Single(hub.Calls);
    }

    [Fact]
    public async Task Click_RowWithoutWindow_OpensTheTicket()
    {
        Assert.Null(await Switcher().Click(Fixtures.Row("ticket:4"), TestContext.Current.CancellationToken));
        Assert.Equal(["url https://github.com/o/r/issues/104"], windows.Calls);
        Assert.Empty(hub.Calls);
    }

    [Fact]
    public async Task Click_BrowserFails_SaysWhy()
    {
        windows.UrlFails = new System.ComponentModel.Win32Exception("No application is associated");

        Assert.Equal("The browser did not open https://github.com/o/r/issues/104: No application is associated", await Switcher().Click(Fixtures.Row("ticket:4"), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Click_HubNamesNoWorkspaceFile_SaysToReloadAndSendsNothing()
    {
        var row = Fixtures.Row("item:7");
        var status = await Switcher().Click(row with { Window = row.Window! with { File = null } }, TestContext.Current.CancellationToken);

        Assert.Equal("The hub names no workspace file for this window. Reload a VS Code window to update the hub.", status);
        Assert.Empty(hub.Calls);
        Assert.Empty(vsCode.Calls);
    }

    [Fact]
    public async Task Click_ReplacedByAnotherClick_StopsBeforeTheSwitch()
    {
        windows.Open["sb:gh-107-58c609 · "] = (42, 0);

        using var cancel = new CancellationTokenSource();

        cancel.Cancel();

        Assert.Null(await Switcher().Click(Fixtures.Row("item:7"), cancel.Token));
        Assert.Empty(windows.Calls);
    }

    [Fact]
    public async Task Click_ReplacedWhileTheQuestionStops_OpensNothing()
    {
        var question = Fixtures.Row("item:8");
        using var cancel = new CancellationTokenSource();

        hub.ActReplies.Enqueue(null);
        hub.Ended = Fixtures.View with { Groups = [new DockGroup("needs", "Needs you", null, [question with { Open = question.Open! with { Type = "session" } }])] };
        hub.OnUntil = cancel.Cancel;

        Assert.Null(await Switcher().Click(question, cancel.Token));
        Assert.Equal(["act {\"type\":\"open-question\",\"workItemId\":8,\"nativeSessionId\":\"aaaa1111-native\"}", "until 20s"], hub.Calls);
        Assert.Empty(windows.Calls);
    }

    [Fact]
    public async Task Click_SameQuestionAgainWhileItStops_SendsOneStopAndBothWait()
    {
        var question = Fixtures.Row("item:8");
        var switcher = Switcher();
        using var replaced = new CancellationTokenSource();

        windows.Open["sb:gh-108-widgets-655280 · "] = (44, 0);
        hub.ActReplies.Enqueue(null);
        hub.Ended = Fixtures.View with { Groups = [new DockGroup("needs", "Needs you", null, [question with { Open = question.Open! with { Type = "session" } }])] };
        hub.HoldUntil = new TaskCompletionSource();

        var first = switcher.Click(question, replaced.Token);

        replaced.Cancel();

        var again = switcher.Click(question, TestContext.Current.CancellationToken);

        hub.HoldUntil.SetResult();

        Assert.Null(await first);
        Assert.Null(await again);
        Assert.Single(hub.Calls, (call) => call.StartsWith("act "));
        Assert.Equal(["show 44"], windows.Calls);

        // Once that stop is over, a new click on a new question sends its own stop.
        hub.ActReplies.Enqueue("The session no longer waits on a question.");
        Assert.Equal("The session no longer waits on a question.", await switcher.Click(question, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Click_QuestionRefusedAtOnceThenClickedAgain_SendsTheStopAgain()
    {
        var question = Fixtures.Row("item:8");
        var switcher = Switcher();

        hub.ActReplies.Enqueue("Switchboard is not running.");
        hub.ActReplies.Enqueue(null);
        hub.Ended = Fixtures.View with { Groups = [new DockGroup("needs", "Needs you", null, [question with { Open = question.Open! with { Type = "session" } }])] };
        windows.Open["sb:gh-108-widgets-655280 · "] = (44, 0);

        Assert.Equal("Switchboard is not running.", await switcher.Click(question, TestContext.Current.CancellationToken));
        Assert.Null(await switcher.Click(question, TestContext.Current.CancellationToken));
        Assert.Equal(2, hub.Calls.Count((call) => call.StartsWith("act ")));
        Assert.Equal(["show 44"], windows.Calls);
    }

    [Fact]
    public async Task Click_ReplacedWhileTheWindowOpens_StopsLooking()
    {
        using var cancel = new CancellationTokenSource();
        var switcher = new Switcher(hub, windows, vsCode, (_) =>
        {
            cancel.Cancel();
            return Task.CompletedTask;
        });

        Assert.Null(await switcher.Click(Fixtures.Row("item:7"), cancel.Token));
        Assert.Equal(1, windows.Finds("sb:gh-107-58c609 · "));
    }

    [Fact]
    public async Task Click_RowWithNothingToOpen_DoesNothing()
    {
        Assert.Null(await Switcher().Click(Fixtures.Row("ticket:4") with { Open = null }, TestContext.Current.CancellationToken));
        Assert.Empty(windows.Calls);
    }

    [Fact]
    public async Task Run_RowWithWindow_LeavesTheCommandForItsWorkspaceThenSwitches()
    {
        windows.Open["sb:gh-107-58c609 · "] = (42, 0);

        var status = await Switcher().Run(Fixtures.Row("item:7"), new System.Text.Json.Nodes.JsonObject { ["type"] = "history", ["ticketId"] = 7, ["key"] = "gh 107" }, TestContext.Current.CancellationToken);

        Assert.Null(status);
        Assert.Equal(["window gh-107-58c609.code-workspace {\"type\":\"history\",\"ticketId\":7,\"key\":\"gh 107\"}"], hub.Calls);
        Assert.Equal(["show 42"], windows.Calls);
    }

    [Fact]
    public async Task Run_RowWithoutWindow_LeavesTheCommandForAnyWindowAndShowsTheFrontVsCodeWindow()
    {
        windows.Front0 = 77;

        Assert.Null(await Switcher().Run(Fixtures.Row("ticket:4"), new System.Text.Json.Nodes.JsonObject { ["type"] = "history", ["ticketId"] = 4, ["key"] = "gh 104" }, TestContext.Current.CancellationToken));
        Assert.Equal(["window any {\"type\":\"history\",\"ticketId\":4,\"key\":\"gh 104\"}"], hub.Calls);
        Assert.Equal(["show 77"], windows.Calls);
    }

    [Fact]
    public async Task Run_NoVsCodeWindow_SaysSoAndLeavesNothing()
    {
        Assert.Equal("Open a VS Code window first; this runs in VS Code.", await Switcher().Run(null, new System.Text.Json.Nodes.JsonObject { ["type"] = "openUrl", ["url"] = "D:/drafts/reply.md" }, TestContext.Current.CancellationToken));
        Assert.Empty(hub.Calls);
    }

    [Fact]
    public async Task Run_HubRefuses_DoesNotSwitch()
    {
        windows.Open["sb:gh-107-58c609 · "] = (42, 0);
        hub.WindowReply = "Switchboard is not running.";

        Assert.Equal("Switchboard is not running.", await Switcher().Run(Fixtures.Row("item:7"), new System.Text.Json.Nodes.JsonObject { ["type"] = "openUrl", ["url"] = "D:/drafts/reply.md" }, TestContext.Current.CancellationToken));
        Assert.Empty(windows.Calls);
    }

    [Fact]
    public async Task Run_ReplacedBeforeTheSwitch_DoesNotSwitch()
    {
        windows.Open["sb:gh-107-58c609 · "] = (42, 0);

        using var cancel = new CancellationTokenSource();

        cancel.Cancel();

        Assert.Null(await Switcher().Run(Fixtures.Row("item:7"), new System.Text.Json.Nodes.JsonObject { ["type"] = "openUrl", ["url"] = "D:/drafts/reply.md" }, cancel.Token));
        Assert.Equal(["window gh-107-58c609.code-workspace {\"type\":\"openUrl\",\"url\":\"D:/drafts/reply.md\"}", "withdraw 41"], hub.Calls);
        Assert.Empty(windows.Calls);
    }

    [Fact]
    public async Task Run_ForegroundRefused_WithdrawsTheCommandAndSaysSo()
    {
        windows.Front0 = 77;
        windows.Front = false;

        Assert.Equal("Windows kept another window in front. Try again.", await Switcher().Run(null, new System.Text.Json.Nodes.JsonObject { ["type"] = "openUrl", ["url"] = "D:/drafts/reply.md" }, TestContext.Current.CancellationToken));
        Assert.Equal(["window any {\"type\":\"openUrl\",\"url\":\"D:/drafts/reply.md\"}", "withdraw 41"], hub.Calls);
    }

    [Fact]
    public async Task Run_ItemWindowNeverOpens_WithdrawsTheCommand()
    {
        var status = await Switcher().Run(Fixtures.Row("item:7"), new System.Text.Json.Nodes.JsonObject { ["type"] = "openUrl", ["url"] = "D:/drafts/reply.md" }, TestContext.Current.CancellationToken);

        Assert.Equal("VS Code did not open the window for gh-107-58c609 within 20 seconds.", status);
        Assert.Equal("withdraw 41", hub.Calls[^1]);
    }

    [Fact]
    public async Task Run_SwitchWorks_KeepsTheCommandForTheWindow()
    {
        windows.Open["sb:gh-107-58c609 · "] = (42, 0);

        Assert.Null(await Switcher().Run(Fixtures.Row("item:7"), new System.Text.Json.Nodes.JsonObject { ["type"] = "openUrl", ["url"] = "D:/drafts/reply.md" }, TestContext.Current.CancellationToken));
        Assert.DoesNotContain(hub.Calls, (call) => call.StartsWith("withdraw"));
    }
}
