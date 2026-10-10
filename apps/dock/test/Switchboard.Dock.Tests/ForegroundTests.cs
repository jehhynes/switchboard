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
