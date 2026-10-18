using System.Text.Json.Nodes;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Platform;
using Switchboard.Dock.Switching;

namespace Switchboard.Dock.Tests;

public sealed class ShellWindowsTests
{
    const string Item = "First item · page.ts · sb:gh-107-58c609";
    const string Other = "Other · sb:gh-108-1a2b3c";

    readonly FakeShell shell = new();
    readonly FakeHub hub = new();
    readonly FakeVsCode vsCode = new();
    readonly HubWindows followed;

    public ShellWindowsTests() => followed = new HubWindows(vsCode);

    [Fact]
    public void Find_ItemWindowTitle_IsShownByItsShellId()
    {
        var windows = new ShellWindows(shell, followed);

        shell.Open.AddRange([new(41, "Plain VS Code"), new(42, Other), new(43, Item)]);

        Assert.Equal(43, windows.Find("gh-107-58c609"));
        Assert.Equal(0, windows.Find("gh-109-000000"));
        Assert.True(windows.Show(43));
        Assert.False(windows.Show(44));
        Assert.Equal(["activate 43", "activate 44"], shell.Calls);
    }

    [Fact]
    public void Show_DockOnAMonitor_MaximizesTheWindowOnIt()
    {
        var windows = new ShellWindows(shell, followed) { Monitor = "HDMI-2" };

        shell.Open.Add(new(43, Item));

        Assert.True(windows.Show(windows.Find("gh-107-58c609")));
        Assert.Equal(["activate 43 on HDMI-2"], shell.Calls);
    }

    [Fact]
    public void FindVsCode_WindowsFrontFirst_IsTheFrontOneOrNone()
    {
        var windows = new ShellWindows(shell, followed);

        Assert.Equal(0, windows.FindVsCode());
        shell.Open.AddRange([new(41, "Plain VS Code"), new(43, Item)]);
        Assert.Equal(41, windows.FindVsCode());
    }

    [Fact]
    public void Calls_ShellFails_TheHubsWindowsAnswerAndOpeningTheFileShowsThem()
    {
        var windows = new ShellWindows(shell, followed);

        followed.Update(new OpenWindows([Fixtures.Row("item:7").Window!.File!], null, 1));
        shell.Open.Add(new(43, Item));
        shell.Fails = true;

        var found = windows.Find("gh-107-58c609");

        Assert.NotEqual(0, found);
        Assert.NotEqual(43, found);
        Assert.False(windows.Raises);
        Assert.True(windows.Show(found));
        Assert.Equal(["open gh-107-58c609.code-workspace"], vsCode.Calls);

        // Any connected window runs the command, so the fallback opens nothing.
        var any = windows.FindVsCode();

        Assert.NotEqual(0, any);
        Assert.True(windows.Show(any));
        Assert.Single(vsCode.Calls);
        // A window the shell found before it failed is not shown.
        Assert.False(windows.Show(43));
    }

    [Fact]
    public void Show_ShellIdEqualToAFallbackHandle_ActivatesTheShellsWindow()
    {
        var windows = new ShellWindows(shell, followed);

        followed.Update(new OpenWindows([Fixtures.Row("item:7").Window!.File!], null, 1));
        shell.Fails = true;
        windows.Find("gh-107-58c609");
        shell.Fails = false;
        // The hub's first handle is 1; a Mutter window ID can be 1 too.
        shell.Open.Add(new(1, Item));

        Assert.Equal(1, windows.Find("gh-107-58c609"));
        Assert.True(windows.Show(1));
        Assert.Equal(["activate 1"], shell.Calls);
        Assert.Empty(vsCode.Calls);
    }

    [Fact]
    public void Find_ShellAnswersAgainAfterAFailure_RaisesThroughItAgain()
    {
        var windows = new ShellWindows(shell, followed);

        shell.Open.Add(new(43, Item));
        shell.Fails = true;
        Assert.Equal(0, windows.Find("gh-107-58c609"));

        shell.Fails = false;

        Assert.Equal(43, windows.Find("gh-107-58c609"));
        Assert.True(windows.Raises);
        Assert.True(windows.Show(43));
        Assert.Empty(vsCode.Calls);
    }

    [Fact]
    public async Task Click_ItemWindowOpen_BringsItForwardWithoutOpeningIt()
    {
        shell.Open.Add(new(43, Item));

        Assert.Null(await new Switcher(hub, new ShellWindows(shell, followed), vsCode).Click(Fixtures.Row("item:7"), TestContext.Current.CancellationToken));
        Assert.Equal(["activate 43"], shell.Calls);
        Assert.Empty(vsCode.Calls);
    }

    [Fact]
    public async Task Run_NoRow_BringsTheFrontVsCodeWindowForward()
    {
        shell.Open.AddRange([new(41, "Plain VS Code"), new(43, Item)]);

        Assert.Null(await new Switcher(hub, new ShellWindows(shell, followed), vsCode).Run(null, new JsonObject { ["type"] = "log" }, TestContext.Current.CancellationToken));
        Assert.Equal(["window any {\"type\":\"log\"}"], hub.Calls);
        Assert.Equal(["activate 41"], shell.Calls);
    }
}
