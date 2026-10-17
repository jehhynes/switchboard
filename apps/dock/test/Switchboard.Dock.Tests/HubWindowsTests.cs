using System.Text.Json.Nodes;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Platform;
using Switchboard.Dock.Switching;

namespace Switchboard.Dock.Tests;

public sealed class HubWindowsTests
{
    const string Item = "/home/op/.switchboard/windows/gh-107-58c609.code-workspace";
    const string Other = "/home/op/.switchboard/windows/gh-108-1a2b3c.code-workspace";

    readonly FakeVsCode vsCode = new();
    readonly FakeHub hub = new();
    readonly List<TimeSpan> waits = [];

    [Fact]
    public void Find_ConnectedItemWindow_ShowOpensItsWorkspaceFile()
    {
        var windows = new HubWindows(vsCode);

        Assert.Equal(0, windows.Find("gh-107-58c609"));
        windows.Update(new OpenWindows([Other, Item], null, 3));

        var found = windows.Find("gh-107-58c609");

        Assert.NotEqual(0, found);
        Assert.Equal(found, windows.Find("gh-107-58c609"));
        Assert.NotEqual(found, windows.Find("gh-108-1a2b3c"));
        Assert.True(windows.Show(found));
        Assert.Equal(["open gh-107-58c609.code-workspace"], vsCode.Calls);
    }

    [Fact]
    public void FindVsCode_AnyConnectedWindow_IsShownByTheWindowTheOperatorFocusesNext()
    {
        var windows = new HubWindows(vsCode);

        Assert.Equal(0, windows.FindVsCode());
        windows.Update(new OpenWindows([], null, 1));
        Assert.Equal(HubWindows.AnyWindow, windows.FindVsCode());
        Assert.True(windows.Show(HubWindows.AnyWindow));
        Assert.Empty(vsCode.Calls);
    }

    [Fact]
    public void Update_FrontAndClosedWindows_ReportsEachChangeOnce()
    {
        var windows = new HubWindows(vsCode);
        List<string> front = [];
        List<string> closed = [];

        windows.WatchForeground(front.Add);
        windows.WatchClosed(closed.Add);
        windows.Update(new OpenWindows([Item, Other], Item, 2));
        windows.Update(new OpenWindows([Item, Other], Item, 2));
        windows.Update(new OpenWindows([Item, Other], null, 2));
        windows.Update(new OpenWindows([Item, Other], Other, 2));
        windows.Update(new OpenWindows([Other], Other, 1));
        windows.Update(null);

        Assert.Equal(["gh-107-58c609", "gh-108-1a2b3c"], front);
        Assert.Equal(["gh-107-58c609", "gh-108-1a2b3c"], closed);
        Assert.Equal(0, windows.Find("gh-108-1a2b3c"));
    }

    [Fact]
    public async Task Click_ItemWindowOpen_FocusesItWithoutLeavingTabs()
    {
        var windows = new HubWindows(vsCode);

        windows.Update(new OpenWindows([Fixtures.Row("item:7").Window!.File!], null, 1));

        Assert.Null(await Switcher(windows).Click(Fixtures.Row("item:7"), TestContext.Current.CancellationToken));
        Assert.Equal(["open aaaa1111-native D:/git/widgets/.worktrees/107-fix gh-107-58c609.code-workspace"], hub.Calls);
        Assert.Equal(["open gh-107-58c609.code-workspace"], vsCode.Calls);
        Assert.Empty(waits);
    }

    [Fact]
    public async Task Click_ItemWindowNotOpen_LeavesTheTabsAndWaitsForTheWindowToConnect()
    {
        var windows = new HubWindows(vsCode);
        var click = Switcher(windows, () => windows.Update(new OpenWindows([Fixtures.Row("item:7").Window!.File!], null, 1))).Click(Fixtures.Row("item:7"), TestContext.Current.CancellationToken);

        Assert.Null(await click);
        Assert.Equal("window gh-107-58c609.code-workspace {\"type\":\"openTabs\"}", hub.Calls[^1]);
        // Once to open the window, and again to focus it once it connected.
        Assert.Equal(["open gh-107-58c609.code-workspace", "open gh-107-58c609.code-workspace"], vsCode.Calls);
        Assert.Single(waits);
    }

    [Fact]
    public async Task Run_NoRowWithAWindowConnected_LeavesTheCommandAndSaysToSwitchToVsCode()
    {
        var windows = new HubWindows(vsCode);

        windows.Update(new OpenWindows([], null, 1));

        Assert.Equal("Switch to a VS Code window to run it.", await Switcher(windows).Run(null, new JsonObject { ["type"] = "log" }, TestContext.Current.CancellationToken));
        Assert.Equal(["window any {\"type\":\"log\"}"], hub.Calls);
        Assert.Empty(vsCode.Calls);
    }

    [Fact]
    public async Task Run_CancelledWithNoRow_WithdrawsTheCommand()
    {
        var windows = new HubWindows(vsCode);
        using var cancel = new CancellationTokenSource();

        windows.Update(new OpenWindows([], null, 1));
        cancel.Cancel();

        Assert.Null(await Switcher(windows).Run(null, new JsonObject { ["type"] = "log" }, cancel.Token));
        Assert.StartsWith("withdraw ", hub.Calls[^1]);
    }

    [Fact]
    public async Task Run_CodeFailsForAnOpenWindow_SaysSoAndWithdrawsTheCommand()
    {
        var windows = new HubWindows(vsCode);

        windows.Update(new OpenWindows([Fixtures.Row("item:7").Window!.File!], null, 1));
        vsCode.Fails = new FileNotFoundException("code was not found on PATH.");

        Assert.Equal("VS Code did not start: code was not found on PATH.", await Switcher(windows).Run(Fixtures.Row("item:7"), new JsonObject { ["type"] = "log" }, TestContext.Current.CancellationToken));
        Assert.StartsWith("withdraw ", hub.Calls[^1]);
    }

    Switcher Switcher(HubWindows windows, Action? connect = null) => new(hub, windows, vsCode, (span) =>
    {
        waits.Add(span);
        connect?.Invoke();
        return Task.CompletedTask;
    });
}
