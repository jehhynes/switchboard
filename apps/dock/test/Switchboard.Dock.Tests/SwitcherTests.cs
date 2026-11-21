using Switchboard.Dock.Hub;
using Switchboard.Dock.Switching;

namespace Switchboard.Dock.Tests;

public sealed class SwitcherTests
{
    readonly FakeHub hub = new();
    readonly FakeWindows windows = new();
    readonly FakeVsCode vsCode = new();
    readonly List<TimeSpan> waits = [];

    /// <summary>The canonical folder as a hub on this platform could send it: with backslashes on Windows only, where it is one folder.</summary>
    static string HubSpelling(string folder) => OperatingSystem.IsWindows() ? folder.Replace('/', '\\') : folder;

    [Fact]
    public void FolderKey_Spellings_MatchTheHubsHostKey()
    {
        Assert.Equal(Switching.Switcher.FolderKey("/"), Switching.Switcher.FolderKey("//"));

        if (OperatingSystem.IsWindows() || OperatingSystem.IsMacOS())
        {
            Assert.Equal("d:/git/étage", Switching.Switcher.FolderKey("D:\\git\\Étage\\"));
            Assert.Equal(Switching.Switcher.FolderKey("/tmp/a/b"), Switching.Switcher.FolderKey("/tmp/a\\b"));
        }
        else
        {
            // A backslash is part of a POSIX folder's name, and case tells two folders apart.
            Assert.NotEqual(Switching.Switcher.FolderKey("/tmp/a/b"), Switching.Switcher.FolderKey("/tmp/a\\b"));
            Assert.NotEqual(Switching.Switcher.FolderKey("/tmp/A"), Switching.Switcher.FolderKey("/tmp/a"));
            Assert.Equal("/tmp/a", Switching.Switcher.FolderKey("/tmp/a//"));
        }
    }

    Switcher Switcher() => new(hub, windows, vsCode, (span) =>
    {
        waits.Add(span);
        return Task.CompletedTask;
    });

    [Fact]
    public async Task OpenInPage_InstalledPageShowsIt_RaisesItsWindowOnceFound()
    {
        windows.Pages["m1"] = (51, 2);

        Assert.Null(await Switcher().OpenInPage(Fixtures.Row("item:7"), TestContext.Current.CancellationToken));
        Assert.Equal(["page item:7"], hub.Calls);
        Assert.Equal(["raise 51"], windows.Calls);
        Assert.Equal(3, windows.PageFinds("m1"));
        Assert.Empty(vsCode.Calls);
    }

    [Fact]
    public async Task OpenInPage_WindowNotFoundOrNotRaised_SaysSo()
    {
        Assert.Equal("The web page shows it, but the dock did not find its window.", await Switcher().OpenInPage(Fixtures.Row("item:7"), TestContext.Current.CancellationToken));
        Assert.Equal(Switching.Switcher.PageWait, TimeSpan.FromTicks(waits.Sum((wait) => wait.Ticks)));
        Assert.Empty(windows.Calls);

        windows.Pages["m1"] = (51, 0);
        windows.Front = false;
        Assert.Equal("The web page shows it, but Windows did not bring its window to the front.", await Switcher().OpenInPage(Fixtures.Row("item:7"), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task OpenInPage_NoInstalledPage_OpensThePageAtTheWorkItemUnmarked()
    {
        hub.PageReply = new PageReply(null, null, "http://127.0.0.1:47616/page/#w=7");

        Assert.Null(await Switcher().OpenInPage(Fixtures.Row("item:7"), TestContext.Current.CancellationToken));
        Assert.Equal(["url http://127.0.0.1:47616/page/#w=7"], windows.Calls);

        windows.UrlFails = new InvalidOperationException("No browser.");
        Assert.Equal("The browser did not open the web page: No browser.", await Switcher().OpenInPage(Fixtures.Row("item:7"), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task OpenInPage_RefusedOrWithoutPageWindows_LooksForNoWindow()
    {
        hub.PageReply = new PageReply("No work item has that row.", null, null);
        Assert.Equal("No work item has that row.", await Switcher().OpenInPage(Fixtures.Row("item:7"), TestContext.Current.CancellationToken));

        // On Linux the page shows the work item, but the dock cannot find its window.
        hub.PageReply = new PageReply(null, "m1", null);
        windows.FindsPages = false;
        Assert.Null(await Switcher().OpenInPage(Fixtures.Row("item:7"), TestContext.Current.CancellationToken));
        Assert.Equal(0, windows.PageFinds("m1"));
        Assert.Empty(windows.Calls);
    }

    [Fact]
    public async Task OpenInPage_PoolTicket_RunsItsOwnClick()
    {
        Assert.Null(await Switcher().OpenInPage(Fixtures.Row("ticket:4"), TestContext.Current.CancellationToken));
        Assert.Equal(["url https://github.com/o/r/issues/104#switchboard-tab"], windows.Calls);
        Assert.Empty(hub.Calls);
    }

    [Fact]
    public async Task Click_OpenWindowAndEndedSession_LeavesTheSessionThenBringsTheWindowForward()
    {
        windows.Open["gh-107-58c609"] = (42, 0);

        var status = await Switcher().Click(Fixtures.Row("item:7"), TestContext.Current.CancellationToken);

        Assert.Null(status);
        Assert.Equal(["open aaaa1111-native D:/git/widgets/.worktrees/107-fix gh-107-58c609.code-workspace"], hub.Calls);
        Assert.Equal(["show 42"], windows.Calls);
        Assert.Empty(vsCode.Calls);
    }

    [Fact]
    public async Task Click_CodeModeSessionWithAlways_LeavesItsSwitchboardIdForTheItemWindowThenBringsItForward()
    {
        var row = Fixtures.Row("item:15");

        windows.Open[row.Window!.Name] = (44, 0);

        Assert.Null(await Switcher().Click(row, TestContext.Current.CancellationToken));
        Assert.Equal([$"open cm15 D:/git/widgets {row.Window.Name}.code-workspace"], hub.Calls);
        Assert.Equal(["show 44"], windows.Calls);
        Assert.DoesNotContain(hub.Calls, (call) => call.Contains("open-question", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Click_HostedConversation_SelectsItInItsHostWindowBeforeLeavingTheSession()
    {
        var row = Fixtures.Row("item:7");
        var hosted = row with { Window = row.Window! with { Hosted = true } };

        windows.Open["gh-107-58c609"] = (42, 0);

        Assert.Null(await Switcher().Click(hosted, TestContext.Current.CancellationToken));
        Assert.Equal(["select item:7", "open aaaa1111-native D:/git/widgets/.worktrees/107-fix gh-107-58c609.code-workspace"], hub.Calls);
        Assert.Equal(["show 42"], windows.Calls);
    }

    [Fact]
    public async Task Click_FolderHostedConversation_SelectsItAndOpensTheFolderNeverAnItemWindow()
    {
        var row = Fixtures.Row("item:7");
        var hosted = row with { Window = new DockWindow("support", "New session", ["D:/git/support"], null, true, "D:/git/support") };

        // An item window whose name matches the row's window is never the destination: a folder window is found by no title. The click is done
        // once the hub lists a folder window on that folder, with either separator.
        windows.Open["support"] = (42, 0);
        hub.Ended = Fixtures.View with { Windows = new OpenWindows([], null, 1, [HubSpelling("D:/git/support")]) };

        Assert.Null(await Switcher().Click(hosted, TestContext.Current.CancellationToken));
        Assert.Equal(["select item:7", "open aaaa1111-native D:/git/widgets/.worktrees/107-fix support", "until 20s"], hub.Calls);
        Assert.Equal(["open support"], vsCode.Calls);
        Assert.Empty(windows.Calls);
        Assert.Equal(0, windows.Finds("support"));
    }

    [Fact]
    public async Task OpenFolder_NewSession_OpensTheFolderAndWaitsForAFolderWindowLeavingNothing()
    {
        // The hub stored New session's conversation as the folder's selection, so nothing is selected or left for the window; an item window
        // named like the folder is never the destination.
        windows.Open["support"] = (42, 0);
        hub.Ended = Fixtures.View with { Windows = new OpenWindows([], null, 1, [HubSpelling("D:/git/support")]) };

        Assert.Null(await Switcher().OpenFolder("D:/git/support", TestContext.Current.CancellationToken));
        Assert.Equal(["until 20s"], hub.Calls);
        Assert.Equal(["open support"], vsCode.Calls);
        Assert.Empty(windows.Calls);

        hub.Ended = Fixtures.View with { Windows = new OpenWindows(["D:/sb/windows/gh-1-support-abc123.code-workspace"], null, 1, []) };
        Assert.Equal("VS Code did not open a window on D:/git/support within 20 seconds.", await Switcher().OpenFolder("D:/git/support", TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Click_FolderRowCancelledWhileWaitingOrNeverReached_WithdrawsTheSessionItLeft()
    {
        var row = Fixtures.Row("item:7") with { Window = new DockWindow("support", "New session", ["D:/git/support"], null, true, "D:/git/support") };
        using var cancel = new CancellationTokenSource();

        // A later click cancels this one while the folder window is still opening.
        hub.HoldUntil = new TaskCompletionSource();
        hub.OnUntil = cancel.Cancel;

        Assert.Null(await Switcher().Click(row, cancel.Token));
        Assert.Equal(["select item:7", "open aaaa1111-native D:/git/widgets/.worktrees/107-fix support", "until 20s", "withdraw open 32"], hub.Calls);

        // No folder window connects within the wait.
        hub.Calls.Clear();
        hub.HoldUntil = null;
        hub.OnUntil = null;
        Assert.Equal("VS Code did not open a window on D:/git/support within 20 seconds.", await Switcher().Click(row, TestContext.Current.CancellationToken));
        Assert.Equal("withdraw open 32", hub.Calls[^1]);

        // VS Code does not start.
        hub.Calls.Clear();
        vsCode.Fails = new FileNotFoundException("Code.exe was not found beside code on PATH.");
        Assert.Equal("VS Code did not start: Code.exe was not found beside code on PATH.", await Switcher().Click(row, TestContext.Current.CancellationToken));
        Assert.Equal("withdraw open 32", hub.Calls[^1]);
    }

    [Fact]
    public async Task Click_HostedRowReplacedWhileTheHubSelects_LeavesNoOpenForItsWindow()
    {
        var row = Fixtures.Row("item:7");
        using var cancel = new CancellationTokenSource();

        // A newer click's open for the same window must not be replaced by this one's.
        windows.Open["gh-107-58c609"] = (42, 0);
        hub.OnSelect = cancel.Cancel;

        Assert.Null(await Switcher().Click(row with { Window = row.Window! with { Hosted = true } }, cancel.Token));
        Assert.Equal(["select item:7"], hub.Calls);

        hub.Calls.Clear();
        Assert.Null(await Switcher().Click(row with { Window = new DockWindow("support", "New session", ["D:/git/support"], null, true, "D:/git/support") }, cancel.Token));
        Assert.Equal(["select item:7"], hub.Calls);
        Assert.Empty(windows.Calls);
        Assert.Empty(vsCode.Calls);
    }

    [Fact]
    public async Task Click_CancelledAfterLeavingTheSession_WithdrawsItBeforeSwitching()
    {
        using var cancel = new CancellationTokenSource();

        windows.Open["gh-107-58c609"] = (42, 0);
        hub.OnOpen = cancel.Cancel;

        Assert.Null(await Switcher().Click(Fixtures.Row("item:7"), cancel.Token));
        Assert.Equal(["open aaaa1111-native D:/git/widgets/.worktrees/107-fix gh-107-58c609.code-workspace", "withdraw open 31"], hub.Calls);
        Assert.Empty(windows.Calls);
    }

    [Fact]
    public async Task Run_FolderHostedRow_LeavesTheCommandForTheFolderAndOpensIt()
    {
        var row = Fixtures.Row("item:7") with { Window = new DockWindow("support", "New session", ["D:/git/support"], null, true, "D:/git/support") };

        hub.Ended = Fixtures.View with { Windows = new OpenWindows([], null, 1, ["D:/git/support"]) };
        Assert.Null(await Switcher().Run(row, new System.Text.Json.Nodes.JsonObject { ["type"] = "openUrl", ["url"] = "D:/drafts/reply.md" }, TestContext.Current.CancellationToken));
        Assert.Equal(["window support {\"type\":\"openUrl\",\"url\":\"D:/drafts/reply.md\"}", "until 20s"], hub.Calls);
        Assert.Equal(["open support"], vsCode.Calls);
        Assert.Empty(windows.Calls);
    }

    [Fact]
    public async Task Click_FolderWindowNeverConnects_SaysSoEvenWithAnItemWindowOnTheFolder()
    {
        var row = Fixtures.Row("item:7") with { Window = new DockWindow("support", "New session", ["D:/git/support"], null, true, "D:/git/support") };

        // Only an item window on the folder is connected, which never reaches a folder destination.
        hub.Ended = Fixtures.View with { Windows = new OpenWindows(["D:/sb/windows/gh-1-support-abc123.code-workspace"], null, 1, []) };

        Assert.Equal("VS Code did not open a window on D:/git/support within 20 seconds.", await Switcher().Click(row, TestContext.Current.CancellationToken));
        Assert.Equal(["open support"], vsCode.Calls);
    }

    [Fact]
    public async Task Run_FolderRowCancelledWhileWaiting_WithdrawsTheCommandAtOnce()
    {
        var row = Fixtures.Row("item:7") with { Window = new DockWindow("support", "New session", ["D:/git/support"], null, true, "D:/git/support") };
        using var cancel = new CancellationTokenSource();

        // A later click cancels this one while it waits; the wait itself never ends, as for a folder window still opening.
        hub.HoldUntil = new TaskCompletionSource();
        hub.OnUntil = cancel.Cancel;

        Assert.Null(await Switcher().Run(row, new System.Text.Json.Nodes.JsonObject { ["type"] = "openUrl", ["url"] = "D:/drafts/reply.md" }, cancel.Token));
        Assert.Equal(["window support {\"type\":\"openUrl\",\"url\":\"D:/drafts/reply.md\"}", "until 20s", "withdraw 41"], hub.Calls);
    }

    [Fact]
    public async Task Run_FolderWindowNeverConnects_WithdrawsTheCommand()
    {
        var row = Fixtures.Row("item:7") with { Window = new DockWindow("support", "New session", ["D:/git/support"], null, true, "D:/git/support") };

        Assert.Equal("VS Code did not open a window on D:/git/support within 20 seconds.", await Switcher().Run(row, new System.Text.Json.Nodes.JsonObject { ["type"] = "openUrl", ["url"] = "D:/drafts/reply.md" }, TestContext.Current.CancellationToken));
        Assert.Equal(["window support {\"type\":\"openUrl\",\"url\":\"D:/drafts/reply.md\"}", "until 20s", "withdraw 41"], hub.Calls);
    }

    [Fact]
    public async Task Click_HubRefusesTheSelection_ShowsWhyAndOpensNothing()
    {
        var row = Fixtures.Row("item:7");

        windows.Open["gh-107-58c609"] = (42, 0);
        hub.SelectReply = "No work item has that row.";

        Assert.Equal("No work item has that row.", await Switcher().Click(row with { Window = row.Window! with { Hosted = true } }, TestContext.Current.CancellationToken));
        Assert.Equal(["select item:7"], hub.Calls);
        Assert.Empty(windows.Calls);
    }

    [Fact]
    public async Task Click_NoWindowYet_OpensTheWorkspaceAndWaitsForTheWindow()
    {
        windows.Open["gh-107-58c609"] = (43, 3);

        var status = await Switcher().Click(Fixtures.Row("item:7"), TestContext.Current.CancellationToken);

        Assert.Null(status);
        Assert.Equal(["open gh-107-58c609.code-workspace"], vsCode.Calls);
        Assert.Equal(4, windows.Finds("gh-107-58c609"));
        Assert.Equal(3, waits.Count);
        Assert.Equal(["show 43"], windows.Calls);
    }

    [Fact]
    public async Task Click_NoWindowYet_LeavesTheTabsForTheWindowItOpens()
    {
        windows.Open["gh-107-58c609"] = (43, 1);

        Assert.Null(await Switcher().Click(Fixtures.Row("item:7"), TestContext.Current.CancellationToken));
        Assert.Equal(["open aaaa1111-native D:/git/widgets/.worktrees/107-fix gh-107-58c609.code-workspace", "window gh-107-58c609.code-workspace {\"type\":\"openTabs\"}"], hub.Calls);
        Assert.Equal(["open gh-107-58c609.code-workspace"], vsCode.Calls);
    }

    [Fact]
    public async Task Click_HubRefusesTheTabs_StillOpensTheWindow()
    {
        windows.Open["gh-107-58c609"] = (43, 1);
        hub.WindowReply = "Expected {workspace, command} with a changes, history or openUrl command.";

        Assert.Null(await Switcher().Click(Fixtures.Row("item:7"), TestContext.Current.CancellationToken));
        Assert.Equal(["show 43"], windows.Calls);
        Assert.DoesNotContain(hub.Calls, (call) => call.StartsWith("withdraw"));
    }

    [Fact]
    public async Task Click_WindowNeverAppears_SaysSoAfterTheWaitAndKeepsTheTabsForTheWindowVsCodeStillOpens()
    {
        var status = await Switcher().Click(Fixtures.Row("item:7"), TestContext.Current.CancellationToken);

        Assert.Equal("VS Code did not open the window for gh-107-58c609 within 20 seconds.", status);
        Assert.Equal(200, waits.Count);
        Assert.Empty(windows.Calls);
        // The window VS Code still opens gets its tabs, but not the session the click left, so it does not open a terminal the operator gave up on.
        Assert.Equal(["withdraw open 31"], hub.Calls.Where((call) => call.StartsWith("withdraw")));
    }

    [Fact]
    public async Task Click_VsCodeFailsToStart_ShowsWhy()
    {
        vsCode.Fails = new FileNotFoundException("Code.exe was not found beside code on PATH.");

        Assert.Equal("VS Code did not start: Code.exe was not found beside code on PATH.", await Switcher().Click(Fixtures.Row("item:7"), TestContext.Current.CancellationToken));
        Assert.Equal(["withdraw 42", "withdraw open 31"], hub.Calls[^2..]);
    }

    [Fact]
    public async Task Click_ReplacedWhileLeavingTheTabs_WithdrawsThemAndDoesNotOpenTheWindow()
    {
        using var cancel = new CancellationTokenSource();

        hub.OnWindow = (_) => cancel.Cancel();

        Assert.Null(await Switcher().Click(Fixtures.Row("item:7"), cancel.Token));
        Assert.Equal(["withdraw 42", "withdraw open 31"], hub.Calls[^2..]);
        Assert.Empty(vsCode.Calls);
    }

    [Fact]
    public async Task Click_WindowsKeepsAnotherWindowInFront_AsksForAnotherClick()
    {
        windows.Open["gh-107-58c609"] = (42, 0);
        windows.Front = false;

        Assert.Equal("Windows kept another window in front. Click the row again.", await Switcher().Click(Fixtures.Row("item:7"), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Click_HubRefusesTheOpen_DoesNotSwitch()
    {
        windows.Open["gh-107-58c609"] = (42, 0);
        hub.OpenReply = "Switchboard is not running.";

        Assert.Equal("Switchboard is not running.", await Switcher().Click(Fixtures.Row("item:7"), TestContext.Current.CancellationToken));
        Assert.Empty(windows.Calls);
    }

    [Fact]
    public async Task Click_QuestionRow_StopsTheSessionWaitsForItToEndThenOpensIt()
    {
        var question = Fixtures.Row("item:8");
        var stopped = Fixtures.View with { Groups = [new DockGroup("blocked", "Blocked on you", null, [question with { Open = question.Open! with { Type = "session", WorkItemId = null } }])] };

        windows.Open["gh-108-widgets-655280"] = (44, 0);
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
        Assert.Equal(["url https://github.com/o/r/issues/104#switchboard-tab"], windows.Calls);
        Assert.Empty(hub.Calls);
    }

    [Fact]
    public void OpenUrl_LinkWithFragment_PutsTheMarkInTheQueryBeforeIt()
    {
        Assert.Null(Switcher().OpenUrl("https://github.com/o/r/issues/1#issuecomment-2"));
        Assert.Equal(["url https://github.com/o/r/issues/1?switchboard-tab=1#issuecomment-2"], windows.Calls);
    }

    [Theory]
    [InlineData("https://x.test/p?a=1", "https://x.test/p?a=1#switchboard-tab")]
    [InlineData("https://x.test/p?a=1#b", "https://x.test/p?a=1&switchboard-tab=1#b")]
    [InlineData("https://desk.zoho.com/support/x/ShowHomePage.do#Cases/dv/1?y", "https://desk.zoho.com/support/x/ShowHomePage.do?switchboard-tab=1#Cases/dv/1?y")]
    public void Marked_LinkWithOrWithoutBookmark_AddsTheMatchingMark(string url, string marked) => Assert.Equal(marked, Switching.Switcher.Marked(url));

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
        windows.Open["gh-107-58c609"] = (42, 0);

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
        hub.Ended = Fixtures.View with { Groups = [new DockGroup("blocked", "Blocked on you", null, [question with { Open = question.Open! with { Type = "session" } }])] };
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

        windows.Open["gh-108-widgets-655280"] = (44, 0);
        hub.ActReplies.Enqueue(null);
        hub.Ended = Fixtures.View with { Groups = [new DockGroup("blocked", "Blocked on you", null, [question with { Open = question.Open! with { Type = "session" } }])] };
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
        hub.Ended = Fixtures.View with { Groups = [new DockGroup("blocked", "Blocked on you", null, [question with { Open = question.Open! with { Type = "session" } }])] };
        windows.Open["gh-108-widgets-655280"] = (44, 0);

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
        Assert.Equal(1, windows.Finds("gh-107-58c609"));
        // VS Code still opens the window, which needs its tabs; the session the replaced click left is withdrawn.
        Assert.Equal(["open gh-107-58c609.code-workspace"], vsCode.Calls);
        Assert.Equal(["withdraw open 31"], hub.Calls.Where((call) => call.StartsWith("withdraw")));
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
        windows.Open["gh-107-58c609"] = (42, 0);

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
        windows.Open["gh-107-58c609"] = (42, 0);
        hub.WindowReply = "Switchboard is not running.";

        Assert.Equal("Switchboard is not running.", await Switcher().Run(Fixtures.Row("item:7"), new System.Text.Json.Nodes.JsonObject { ["type"] = "openUrl", ["url"] = "D:/drafts/reply.md" }, TestContext.Current.CancellationToken));
        Assert.Empty(windows.Calls);
    }

    [Fact]
    public async Task Run_ReplacedBeforeTheSwitch_DoesNotSwitch()
    {
        windows.Open["gh-107-58c609"] = (42, 0);

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
        Assert.Equal(["window gh-107-58c609.code-workspace {\"type\":\"openTabs\"}", "window gh-107-58c609.code-workspace {\"type\":\"openUrl\",\"url\":\"D:/drafts/reply.md\"}", "withdraw 42"], hub.Calls);
    }

    [Fact]
    public async Task Run_ReplacedWhileTheWindowOpens_KeepsTheTabsAndWithdrawsTheCommand()
    {
        using var cancel = new CancellationTokenSource();
        var switcher = new Switcher(hub, windows, vsCode, (_) =>
        {
            cancel.Cancel();
            return Task.CompletedTask;
        });

        Assert.Null(await switcher.Run(Fixtures.Row("item:7"), new System.Text.Json.Nodes.JsonObject { ["type"] = "openUrl", ["url"] = "D:/drafts/reply.md" }, cancel.Token));
        Assert.Equal(["open gh-107-58c609.code-workspace"], vsCode.Calls);
        Assert.Equal("withdraw 42", hub.Calls[^1]);
        Assert.Single(hub.Calls, (call) => call.StartsWith("withdraw"));
    }

    [Fact]
    public async Task Run_ReplacedWhileLeavingTheCommand_WithdrawsTheTabsAndTheCommandAndDoesNotOpenTheWindow()
    {
        using var cancel = new CancellationTokenSource();

        hub.OnWindow = (command) =>
        {
            if (command["type"]?.GetValue<string>() == "openUrl")
            {
                cancel.Cancel();
            }
        };

        Assert.Null(await Switcher().Run(Fixtures.Row("item:7"), new System.Text.Json.Nodes.JsonObject { ["type"] = "openUrl", ["url"] = "D:/drafts/reply.md" }, cancel.Token));
        Assert.Equal(["withdraw 41", "withdraw 42"], hub.Calls[^2..]);
        Assert.Empty(vsCode.Calls);
    }

    [Fact]
    public async Task Run_NoWindowYetAndVsCodeFailsToStart_WithdrawsTheTabsAndTheCommand()
    {
        vsCode.Fails = new FileNotFoundException("Code.exe was not found beside code on PATH.");

        Assert.Equal("VS Code did not start: Code.exe was not found beside code on PATH.", await Switcher().Run(Fixtures.Row("item:7"), new System.Text.Json.Nodes.JsonObject { ["type"] = "openUrl", ["url"] = "D:/drafts/reply.md" }, TestContext.Current.CancellationToken));
        Assert.Equal(["withdraw 41", "withdraw 42"], hub.Calls[^2..]);
    }

    [Fact]
    public async Task Run_NoWindowYet_LeavesTheTabsBeforeTheCommandForTheWindowItOpens()
    {
        windows.Open["gh-107-58c609"] = (43, 1);

        Assert.Null(await Switcher().Run(Fixtures.Row("item:7"), new System.Text.Json.Nodes.JsonObject { ["type"] = "terminal", ["sessionId"] = "s" }, TestContext.Current.CancellationToken));
        Assert.Equal(["window gh-107-58c609.code-workspace {\"type\":\"openTabs\"}", "window gh-107-58c609.code-workspace {\"type\":\"terminal\",\"sessionId\":\"s\"}"], hub.Calls);
        Assert.Equal(["open gh-107-58c609.code-workspace"], vsCode.Calls);
    }

    [Fact]
    public async Task Run_NoWindowYetAndReplacedWhileLeavingTheTabs_WithdrawsThemAndLeavesNoCommand()
    {
        windows.Open["gh-107-58c609"] = (43, 1);

        using var cancel = new CancellationTokenSource();

        hub.OnWindow = (_) => cancel.Cancel();

        Assert.Null(await Switcher().Run(Fixtures.Row("item:7"), new System.Text.Json.Nodes.JsonObject { ["type"] = "terminal", ["sessionId"] = "s" }, cancel.Token));
        Assert.Equal(["window gh-107-58c609.code-workspace {\"type\":\"openTabs\"}", "withdraw 41"], hub.Calls);
        Assert.Empty(vsCode.Calls);
    }

    [Fact]
    public async Task Run_NoWindowYetAndHubRefusesTheCommand_WithdrawsTheTabsAndDoesNotOpenTheWindow()
    {
        hub.RefuseCommand = "terminal";

        Assert.Equal("Refused.", await Switcher().Run(Fixtures.Row("item:7"), new System.Text.Json.Nodes.JsonObject { ["type"] = "terminal", ["sessionId"] = "s" }, TestContext.Current.CancellationToken));
        Assert.Equal("withdraw 41", hub.Calls[^1]);
        Assert.Empty(vsCode.Calls);
    }

    [Fact]
    public async Task Run_SwitchWorks_KeepsTheCommandForTheWindow()
    {
        windows.Open["gh-107-58c609"] = (42, 0);

        Assert.Null(await Switcher().Run(Fixtures.Row("item:7"), new System.Text.Json.Nodes.JsonObject { ["type"] = "openUrl", ["url"] = "D:/drafts/reply.md" }, TestContext.Current.CancellationToken));
        Assert.DoesNotContain(hub.Calls, (call) => call.StartsWith("withdraw"));
    }
}
