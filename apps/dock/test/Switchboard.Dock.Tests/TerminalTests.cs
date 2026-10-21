using System.Collections;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Platform;
using Switchboard.Dock.Switching;
using Switchboard.Dock.Views;

namespace Switchboard.Dock.Tests;

/// <summary>Clicks and Open in terminal with <c>dock.openVSCode: review</c> (PRD R71).</summary>
public sealed class TerminalTests
{
    readonly FakeHub hub = new();
    readonly FakeWindows windows = new();
    readonly FakeVsCode vsCode = new();
    readonly FakeTerminal terminal = new();
    readonly List<TimeSpan> waits = [];

    Switcher Switcher() => new(hub, windows, vsCode, (span) =>
    {
        waits.Add(span);
        return Task.CompletedTask;
    }, terminal);

    const string Name = "gh-108-widgets-655280-aaaa1111";

    /// <summary>The recorded row whose Claude session waits on a question, as the hub sends it with review: Answer in terminal attaches to it.</summary>
    static DockRow Attach(DockHandoff? handoff = null, bool active = false, string provider = "claude") =>
        Fixtures.Row("item:8") with
        {
            Open = new DockOpen("terminal", null, "aaaa1111-native", "D:/git/widgets", null, provider, ["attach", "aaaa1111"], Name, $"Issue <8> · sb:{Name}", handoff, active, "/opt/claude/bin/claude"),
            Main = "Answer in terminal",
        };

    static CancellationToken Cancel => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Click_TerminalNotOpen_OpensItAndBringsItForwardWithoutVsCode()
    {
        windows.Terminals[Name] = (51, 2);

        Assert.Null(await Switcher().Click(Attach(), Cancel));
        Assert.Equal(["attach", "aaaa1111"], Assert.Single(terminal.Opened).Args);
        Assert.Equal(["show 51"], windows.Calls);
        Assert.Equal(2, waits.Count);
        Assert.Empty(vsCode.Calls);
        Assert.Empty(hub.Calls);
    }

    [Fact]
    public async Task Click_TerminalOpen_BringsItForwardAndOpensNoOther()
    {
        windows.Terminals[Name] = (52, 0);

        Assert.Null(await Switcher().Click(Attach(), Cancel));
        Assert.Empty(terminal.Opened);
        Assert.Equal(["show 52"], windows.Calls);
    }

    [Fact]
    public async Task Click_TerminalAppMissing_SaysWhyAndWaitsForNothing()
    {
        terminal.Fails = new System.ComponentModel.Win32Exception("No such file or directory");

        Assert.Equal("The terminal did not start: No such file or directory", await Switcher().Click(Attach(), Cancel));
        Assert.Empty(waits);
        Assert.Empty(windows.Calls);
    }

    [Fact]
    public async Task Click_TerminalNeverAppears_SaysSoAfterTheWait()
    {
        Assert.Equal($"The terminal for {Name} did not open within 20 seconds.", await Switcher().Click(Attach(), Cancel));
        Assert.Single(terminal.Opened);
        Assert.Equal(200, waits.Count);
    }

    [Fact]
    public async Task Click_NoShellExtension_RefusesWithoutOpeningACopy()
    {
        windows.FindsTerminals = false;

        Assert.Equal("Opening terminals needs Switchboard's GNOME Shell extension.", await Switcher().Click(Attach(), Cancel));
        Assert.Empty(terminal.Opened);
    }

    [Fact]
    public async Task Click_CodexQuestion_StopsTheTurnThenOpensTheTerminalTheRowThenOffers()
    {
        var asked = Attach(new DockHandoff(8, "aaaa1111-native"), provider: "codex");
        var resumed = asked with { Open = asked.Open! with { Args = ["resume", "aaaa1111-native"], Handoff = null } };

        hub.ActReplies.Enqueue(null);
        hub.Ended = Fixtures.View with { Groups = [new DockGroup("blocked", "Blocked on you", null, [resumed])] };
        windows.Terminals[Name] = (53, 1);

        Assert.Null(await Switcher().Click(asked, Cancel));
        Assert.Equal(["act {\"type\":\"open-question\",\"workItemId\":8,\"nativeSessionId\":\"aaaa1111-native\"}", "until 20s"], hub.Calls);
        Assert.Equal(["resume", "aaaa1111-native"], Assert.Single(terminal.Opened).Args);
    }

    [Fact]
    public async Task Click_CodexStopRefusedOrTimedOut_OpensNothing()
    {
        var asked = Attach(new DockHandoff(8, "aaaa1111-native"), provider: "codex");

        hub.ActReplies.Enqueue("The session no longer waits on a question.");
        Assert.Equal("The session no longer waits on a question.", await Switcher().Click(asked, Cancel));

        hub.ActReplies.Enqueue(null);
        // A row that still names the stop is not done stopping.
        hub.Ended = Fixtures.View with { Groups = [new DockGroup("blocked", "Blocked on you", null, [asked])] };
        Assert.Equal("The session did not stop within 20 seconds, so it was not opened in Codex.", await Switcher().Click(asked, Cancel));
        Assert.Empty(terminal.Opened);
    }

    [Fact]
    public async Task Click_CodexQuestionOnWorkAwaitingApproval_OpensTheMenuTerminalTheStoppedRowKeeps()
    {
        var asked = Attach(new DockHandoff(8, "aaaa1111-native"), provider: "codex");
        var resume = new DockTerminal("codex", "aaaa1111-native", "D:/git/widgets", ["resume", "aaaa1111-native"], Name, $"Issue <8> · sb:{Name}");
        var stopped = asked with { Open = new DockOpen("session", null, "aaaa1111-native", "D:/git/widgets", null, "codex"), Terminal = resume };

        hub.ActReplies.Enqueue(null);
        hub.Ended = Fixtures.View with { Groups = [new DockGroup("review", "Ready for review", null, [stopped])] };
        windows.Terminals[Name] = (55, 1);

        Assert.Null(await Switcher().Click(asked, Cancel));
        Assert.Equal(resume, Assert.Single(terminal.Opened));
    }

    [Fact]
    public async Task Click_CodexStopLeavesATerminalForAnotherSession_OpensNothing()
    {
        var asked = Attach(new DockHandoff(8, "aaaa1111-native"), provider: "codex");
        var other = asked with { Open = asked.Open! with { Type = "session" }, Terminal = new DockTerminal("codex", "zzzz9999-native", "D:/git/widgets", ["resume", "zzzz9999-native"], "other", "sb:other") };

        hub.ActReplies.Enqueue(null);
        hub.Ended = Fixtures.View with { Groups = [new DockGroup("review", "Ready for review", null, [other])] };

        Assert.Equal($"The session stopped, but its row offers no terminal for {Name}.", await Switcher().Click(asked, Cancel));
        Assert.Empty(terminal.Opened);
    }

    [Fact]
    public async Task Click_AgainWhileTheTerminalStillOpens_WaitsForItInsteadOfOpeningASecond()
    {
        var gate = new TaskCompletionSource();
        var switcher = new Switcher(hub, windows, vsCode, (_) => gate.Task, terminal);
        using var first = new CancellationTokenSource();

        var replaced = switcher.Click(Attach(), first.Token);

        first.Cancel();
        Assert.Null(await replaced);

        var again = switcher.Click(Attach(), Cancel);

        windows.Terminals[Name] = (56, 0);
        gate.SetResult();

        Assert.Null(await again);
        Assert.Single(terminal.Opened);
        Assert.Equal(["show 56"], windows.Calls);
    }

    [Fact]
    public async Task Click_QuestionOnAnOlderHubWithNoWorkspaceFile_StopsNothing()
    {
        var question = Fixtures.Row("item:8");

        Assert.Equal("The hub names no workspace file for this window. Reload a VS Code window to update the hub.", await Switcher().Click(question with { Window = question.Window! with { File = null } }, Cancel));
        Assert.Empty(hub.Calls);
    }

    [Fact]
    public async Task Click_SessionResumedElsewhereWithNoTerminal_ShowsItInItsItemWindowWithoutResumingIt()
    {
        windows.Open["gh-108-widgets-655280"] = (42, 0);

        Assert.Null(await Switcher().Click(Attach(active: true), Cancel));
        Assert.Empty(terminal.Opened);
        Assert.Equal(["open aaaa1111-native D:/git/widgets gh-108-widgets-655280.code-workspace"], hub.Calls);
        Assert.Equal(["show 42"], windows.Calls);
    }

    [Fact]
    public async Task Click_SelectOrFocusOnARowWithAWindow_OpensNoWindow()
    {
        var row = Fixtures.Row("item:7");

        Assert.Null(await Switcher().Click(row with { Open = new DockOpen("select", null, null, null, null) }, Cancel));
        Assert.Null(await Switcher().Click(row with { Open = new DockOpen("url", null, null, null, "https://github.com/o/r/issues/107") }, Cancel));
        Assert.Equal(["url https://github.com/o/r/issues/107#switchboard-tab"], windows.Calls);
        Assert.Empty(vsCode.Calls);
        Assert.Empty(hub.Calls);
    }

    [Fact]
    public async Task Terminal_FromTheMenu_OpensTheMenuTerminalWhateverTheClickDoes()
    {
        var row = Fixtures.Row("item:10");
        var menu = new DockTerminal("claude", "aaaa1111-native", "D:/git/support", ["--resume", "aaaa1111-native"], "gh-110-x-aaaa1111", "Issue · sb:gh-110-x-aaaa1111");

        windows.Terminals[menu.Name] = (54, 1);

        Assert.Null(await Switcher().Terminal(row, menu, Cancel));
        Assert.Equal(["--resume", "aaaa1111-native"], Assert.Single(terminal.Opened).Args);
        Assert.Empty(vsCode.Calls);
    }

    [Fact]
    public void Ptyxis_RunsTheCliInANewTitledWindowInTheSessionFolder()
    {
        var start = Terminals.Ptyxis(Attach().Open!.Terminal!, new Hashtable { ["PATH"] = "/usr/bin" });

        Assert.Equal("ptyxis", start.FileName);
        Assert.Equal(["--new-window", "-T", $"Issue <8> · sb:{Name}", "-d", "D:/git/widgets", "--", "/opt/claude/bin/claude", "attach", "aaaa1111"], start.ArgumentList);
        Assert.Equal("D:/git/widgets", start.WorkingDirectory);
    }

    [Fact]
    public void WindowsTerminal_KeepsTheTitleTheDockFindsTheWindowBy()
    {
        var start = Terminals.WindowsTerminal(Attach().Open!.Terminal! with { Executable = null }, new Hashtable());

        Assert.Equal("wt.exe", start.FileName);
        Assert.Equal(["-w", "new", "--title", $"Issue <8> · sb:{Name}", "--suppressApplicationTitle", "-d", "D:/git/widgets", "--", "claude", "attach", "aaaa1111"], start.ArgumentList);
    }

    [Fact]
    public void CliEnvironment_DropsVsCodeAndSessionVariablesAndPutsTheCliFolderFirstOnPath()
    {
        var environment = new Hashtable
        {
            ["Path"] = "/usr/bin",
            ["HOME"] = "/home/me",
            ["CLAUDECODE"] = "1",
            ["CLAUDE_CODE_CHILD_SESSION"] = "1",
            ["ELECTRON_RUN_AS_NODE"] = "1",
            ["VSCODE_PID"] = "7",
            ["CLAUDE_CONFIG_DIR"] = "/home/me/.claude",
        };
        var folder = Path.GetFullPath("/opt/claude/bin");

        var result = Terminals.CliEnvironment(environment, Path.Combine(folder, "claude"));

        Assert.Equal(["CLAUDE_CONFIG_DIR", "HOME", "Path"], result.Keys.Order(StringComparer.Ordinal));
        Assert.Equal($"{folder}{Path.PathSeparator}/usr/bin", result["Path"]);
        Assert.Equal("/usr/bin", Terminals.CliEnvironment(environment, "claude")["Path"]);
    }

    [Fact]
    public void ShellWindows_FindsTerminalsByNameAndKeepsThemOutOfTheVsCodeLookup()
    {
        var shell = new FakeShell();
        var windows = new ShellWindows(shell, new HubWindows(vsCode));

        shell.Terms!.Add(new ShellWindow(9, $"Issue <8> · sb:{Name}"));
        shell.Open.Add(new ShellWindow(3, "Issue <8> · sb:gh-108-widgets-655280"));

        Assert.True(windows.FindsTerminals);
        Assert.Equal(9, windows.FindTerminal(Name));
        Assert.Equal(0, windows.FindTerminal("gh-108-widgets-655280"));
        Assert.Equal(3, windows.FindVsCode());
        Assert.True(windows.Show(9));
        Assert.Equal(["activate 9"], shell.Calls);
    }

    [Fact]
    public void ShellWindows_OlderOrMissingExtension_FindsNoTerminals()
    {
        var shell = new FakeShell { Terms = null };
        var windows = new ShellWindows(shell, new HubWindows(vsCode));

        Assert.False(windows.FindsTerminals);
        Assert.Equal(0, windows.FindTerminal(Name));

        shell.Terms = [];
        shell.Fails = true;
        Assert.False(windows.FindsTerminals);
    }

    [Fact]
    public void SelectWindow_TerminalCameToTheFront_SelectsItsRow()
    {
        var model = new DockViewModel(new DockSettings(), (_) => { });
        var row = Attach();

        model.Show(Fixtures.View with { Groups = [new DockGroup("blocked", "Blocked on you", null, [row])] });

        Assert.Equal("item:8", model.SelectWindow(Name));

        model.Show(Fixtures.View with { Groups = [new DockGroup("review", "Ready for review", null, [Fixtures.Row("item:10") with { Terminal = Attach().Open!.Terminal }])] });
        Assert.Equal("item:10", model.SelectWindow(Name));
    }
}
