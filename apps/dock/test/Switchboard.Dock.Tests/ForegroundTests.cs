using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.VisualTree;
using Avalonia.Threading;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Views;

namespace Switchboard.Dock.Tests;

public sealed class ForegroundTests
{
    [Theory]
    [InlineData("Issue <7> · render.ts · sb:gh-107-58c609", "gh-107-58c609")]
    [InlineData("Issue <7> · sb:gh-107-58c609", "gh-107-58c609")]
    [InlineData("Fix sb:x parsing · sb:gh-107-58c609", "gh-107-58c609")]
    [InlineData("\U0001F534 Issue <7> · sb:gh-107-58c609 [Administrator]", "gh-107-58c609")]
    [InlineData("Issue <7> · render.ts · sb:gh-107-58c609 · Dirty", "gh-107-58c609")]
    [InlineData("sb:gh-107-58c609 · Issue <7> · render.ts", "gh-107-58c609")]
    [InlineData("render.ts - widgets - Visual Studio Code", null)]
    [InlineData("Visual Studio Code", null)]
    [InlineData("Notes sb:gh-107-58c609 - Notepad", null)]
    [InlineData("Issue · sb:", null)]
    [InlineData("Issue · xsb:gh-107", null)]
    [InlineData("Issue · sb:gh-107/x", null)]
    public void NameOf_Title_ReadsTheItemWindowName(string title, string? name)
    {
        Assert.Equal(name, DockWindow.NameOf(title));
    }

    static DockViewModel Model(DockView view, DockSettings? settings = null)
    {
        var model = new DockViewModel(settings ?? new DockSettings(), (_) => { });

        model.Show(view);

        return model;
    }

    [Fact]
    public void SelectWindow_KnownWindow_SelectsItsRow()
    {
        var model = Model(Fixtures.View);

        Assert.Equal("item:8", model.SelectWindow("gh-108-widgets-655280"));
        Assert.Equal("item:8", model.Selected);
        Assert.True(model.Row("item:8")!.IsSelected);
    }

    [Fact]
    public void SelectWindow_FolderHostedRowsWindowName_SelectsNoRow()
    {
        // A folder window has no sb: title, so a title naming the same window name belongs to some other window.
        var folderHosted = Fixtures.View with
        {
            Groups = Fixtures.View.Groups.Select((group) => group with { Rows = group.Rows.Select((row) => row.Key == "item:8" ? row with { Window = row.Window! with { File = null, Hosted = true, Folder = "D:/git/widgets" } } : row).ToList() }).ToList(),
        };
        var model = Model(folderHosted);

        Assert.Null(model.SelectWindow("gh-108-widgets-655280"));
        Assert.Null(model.Selected);
    }

    [Fact]
    public void SelectWindow_UnknownWindow_KeepsTheSelection()
    {
        var model = Model(Fixtures.View);

        model.Selected = "item:7";

        Assert.Null(model.SelectWindow("gh-999-000000"));
        Assert.Equal("item:7", model.Selected);
    }

    [Fact]
    public void SelectWindow_RowInClosedGroup_OpensTheGroupAndKeepsThatChoice()
    {
        var settings = new DockSettings { Groups = { ["review"] = false } };
        var model = Model(Fixtures.View, settings);

        Assert.Equal("item:7", model.SelectWindow("gh-107-58c609"));
        Assert.True(model.Groups.Single((group) => group.Key == "review").IsOpen);
        Assert.True(settings.Groups["review"]);
    }

    [Fact]
    public void SelectWindow_WindowSharedByTwoWorkItems_SelectsTheFirstInListOrder()
    {
        var open = Fixtures.Row("item:7");
        var view = Fixtures.View with
        {
            Groups = [new DockGroup("blocked", "Blocked on you", null, [open]), new DockGroup("done", "Done", null, [open with { Key = "item:3" }])],
        };

        Assert.Equal("item:7", Model(view).SelectWindow("gh-107-58c609"));
    }

    [Fact]
    public void WindowClosed_SelectedRowsWindow_ClearsTheSelection()
    {
        var model = Model(Fixtures.View);

        model.SelectWindow("gh-108-widgets-655280");
        model.WindowClosed("gh-108-widgets-655280");

        Assert.Null(model.Selected);
        Assert.False(model.Row("item:8")!.IsSelected);
    }

    [Fact]
    public void WindowClosed_OtherRowsWindow_KeepsTheSelection()
    {
        var model = Model(Fixtures.View);

        model.Selected = "item:8";
        model.WindowClosed("gh-107-58c609");

        Assert.Equal("item:8", model.Selected);
        Assert.True(model.Row("item:8")!.IsSelected);
    }

    [Fact]
    public void TerminalSession_CodeModeAttachTerminal_NamesItsSessionAndNoOtherWindow()
    {
        var row = Fixtures.Row("item:8");
        var attach = new DockTerminal("claude", "s8", "D:/git/widgets", ["attach", "s8"], "gh-108-widgets-655280-s8", "Issue <8> · sb:gh-108-widgets-655280-s8", CodeMode: true);
        var resume = new DockTerminal("claude", "aaaa1111-native", "D:/git/widgets", ["--resume", "aaaa1111-native"], "gh-108-widgets-655280-aaaa1111", "Issue <8> · sb:gh-108-widgets-655280-aaaa1111");
        var view = Fixtures.View with
        {
            Groups = [new DockGroup("blocked", "Blocked on you", null, [row with { Terminal = attach }, Fixtures.Row("item:7") with { Key = "item:70", Terminal = resume }])],
        };
        var model = Model(view);

        Assert.Equal("s8", model.TerminalSession("gh-108-widgets-655280-s8"));
        // A held session's attach terminal, from the held list.
        Assert.Equal("cm15", model.TerminalSession(view.Held![1].Terminal!.Name));
        // A resume terminal cannot be typed into through the holder, and an item window is no terminal.
        Assert.Null(model.TerminalSession("gh-108-widgets-655280-aaaa1111"));
        Assert.Null(model.TerminalSession("gh-108-widgets-655280"));
    }

    [Fact]
    public async Task TerminalFocus_Reports_PostsEachChangeOnceInOrderAndAgainAfterAReconnect()
    {
        var hub = new FakeHub();
        var clock = 1000L;
        var focus = new TerminalFocus(hub, () => clock++);

        await focus.Resend();
        await focus.Report("cm15");
        await focus.Report("cm15");
        await focus.Report(null);
        await focus.Report(null);
        await focus.Resend();

        Assert.Equal(["focus cm15", "focus none", "focus none"], hub.Calls);
        // A resend carries when the focus changed, so the hub orders it against window reports.
        Assert.Equal([1000L, 1001L, 1001L], hub.FocusTimes);
    }

    [AvaloniaFact]
    public void ShowForeground_SessionTerminalThenAnotherApp_TellsTheHubWhichSessionsTerminalIsInFront()
    {
        var model = new DockViewModel(new DockSettings(), (_) => { });
        var hub = new FakeHub();
        var window = new MainWindow(model, null, hub, new FakeActions(), docked: false);

        model.Show(Fixtures.View);
        window.Show();
        window.ShowForeground("Issue <15> · sb:gh-115-widgets-655280-cm15");
        window.ShowForeground("Issue <15> · sb:gh-115-widgets-655280-cm15");
        window.ShowForeground("Inbox - Outlook");
        window.TerminalLeft();
        window.ShowForeground("Issue <15> · sb:gh-115-widgets-655280-cm15");
        window.TerminalLeft();
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(["focus cm15", "focus none", "focus cm15", "focus none"], hub.Calls);
    }

    [AvaloniaFact]
    public void ShowForeground_ItemWindowTitle_SelectsItsRowInTheDock()
    {
        var model = new DockViewModel(new DockSettings(), (_) => { });
        var window = new MainWindow(model, null, new FakeHub(), new FakeActions(), docked: false);

        model.Show(Fixtures.View);
        window.Show();
        window.ShowForeground("Issue <8> · notes.md · sb:gh-108-widgets-655280");
        Dispatcher.UIThread.RunJobs();

        Assert.Equal("item:8", model.Selected);

        window.ShowForeground("Inbox - Outlook");

        Assert.Equal("item:8", model.Selected);
    }

    [AvaloniaFact]
    public void ShowForeground_RowBelowTheFoldInClosedGroup_OpensTheGroupAndScrollsTheRowIntoView()
    {
        var filler = Enumerable.Range(1, 20).Select((n) => Fixtures.Row("item:9") with { Key = $"item:{100 + n}", Title = $"Filler {n}" }).ToList();
        var view = Fixtures.View with { Groups = [new DockGroup("blocked", "Blocked on you", null, filler), new DockGroup("unstarted", "Unstarted", null, [Fixtures.Row("item:8")])] };
        var model = new DockViewModel(new DockSettings { Groups = { ["unstarted"] = false } }, (_) => { });
        var window = new MainWindow(model, null, new FakeHub(), new FakeActions(), docked: false) { Height = 300 };

        model.Show(view);
        window.Show();
        Dispatcher.UIThread.RunJobs();
        window.ShowForeground("Issue <8> · sb:gh-108-widgets-655280");
        Dispatcher.UIThread.RunJobs();

        var scroller = window.FindControl<ScrollViewer>("RowScroller")!;
        var row = window.GetVisualDescendants().OfType<Border>().Single((border) => border.Classes.Contains("row") && border.DataContext is RowViewModel { Key: "item:8" });
        var top = row.TranslatePoint(new Point(0, 0), scroller)!.Value.Y;

        Assert.True(scroller.Offset.Y > 0);
        Assert.InRange(top, 0, scroller.Viewport.Height - row.Bounds.Height);
    }
}
