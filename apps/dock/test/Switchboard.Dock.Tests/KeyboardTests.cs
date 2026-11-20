using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using Avalonia.Threading;
using Avalonia.VisualTree;
using Switchboard.Dock.Views;

namespace Switchboard.Dock.Tests;

/// <summary>The dock's list from the keyboard (PRD R71).</summary>
public sealed class KeyboardTests
{
    readonly FakeHub hub = new();
    readonly FakeActions actions = new();

    (MainWindow Window, DockViewModel Model) Open()
    {
        var model = new DockViewModel(new DockSettings(), (_) => { });
        var window = new MainWindow(model, null, hub, actions, docked: false);

        model.Show(Fixtures.View);
        window.Show();
        Dispatcher.UIThread.RunJobs();

        return (window, model);
    }

    static Border RowOf(Window window, string key) =>
        window.GetVisualDescendants().OfType<Border>().Single((border) => border.Classes.Contains("row") && border.DataContext is RowViewModel row && row.Key == key);

    static List<Border> Stops(Window window) =>
        window.GetVisualDescendants().OfType<Border>().Where((border) => (border.Classes.Contains("row") || border.Classes.Contains("group") || border.Classes.Contains("band")) && border.IsEffectivelyVisible).ToList();

    static void Press(Window window, Key key, RawInputModifiers modifiers = RawInputModifiers.None)
    {
        window.KeyPress(key, modifiers, PhysicalKey.None, null);
        Dispatcher.UIThread.RunJobs();
    }

    static object? Focused(Window window) => window.FocusManager!.GetFocusedElement();

    [AvaloniaFact]
    public void List_RowsHeadingsAndLinkPills_TakeTheFocus()
    {
        var (window, _) = Open();
        var row = RowOf(window, "item:7");

        Assert.True(row.Focusable);
        Assert.All(Stops(window), (stop) => Assert.True(stop.Focusable));
        Assert.All(row.GetVisualDescendants().OfType<Border>().Where((border) => border.Classes.Contains("pill")), (pill) => Assert.True(pill.Focusable));
        Assert.Contains(row.GetVisualDescendants().OfType<Border>(), (border) => border.Classes.Contains("returned"));
    }

    [AvaloniaFact]
    public void ArrowKeys_FromARow_MoveTheFocusAlongTheListAndSelectTheRow()
    {
        var (window, model) = Open();
        var stops = Stops(window);
        var first = stops.FindIndex((stop) => stop.Classes.Contains("row"));

        stops[first].Focus(NavigationMethod.Tab);
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(((RowViewModel)stops[first].DataContext!).Key, model.Selected);

        Press(window, Key.Down);
        Assert.Same(stops[first + 1], Focused(window));

        Press(window, Key.Up);
        Press(window, Key.Up);
        Assert.Same(stops[first - 1], Focused(window));
        Assert.Contains("group", stops[first - 1].Classes);
        Assert.Empty(actions.Clicked);
        window.Close();
    }

    [AvaloniaFact]
    public void Enter_OnARow_RunsItsClick()
    {
        var (window, _) = Open();

        RowOf(window, "item:7").Focus(NavigationMethod.Tab);
        Press(window, Key.Enter);

        Assert.Equal(["item:7"], actions.Clicked.Select((row) => row.Key));
        window.Close();
    }

    [AvaloniaFact]
    public void EnterAndSpace_OnAGroupHeading_CloseAndOpenIt()
    {
        var (window, model) = Open();
        var heading = Stops(window).First((stop) => stop.Classes.Contains("group"));
        var group = (GroupViewModel)heading.DataContext!;
        var open = group.IsOpen;

        heading.Focus(NavigationMethod.Tab);
        Press(window, Key.Enter);
        Assert.Equal(!open, group.IsOpen);
        Press(window, Key.Space);
        Assert.Equal(open, group.IsOpen);
        window.Close();
    }

    [AvaloniaTheory]
    [InlineData(Key.Apps, RawInputModifiers.None)]
    [InlineData(Key.F10, RawInputModifiers.Shift)]
    public void MenuKeys_OnARow_OpenItsMenu(Key key, RawInputModifiers modifiers)
    {
        var (window, model) = Open();

        RowOf(window, "item:7").Focus(NavigationMethod.Tab);
        Press(window, key, modifiers);

        Assert.Equal("item:7", model.Selected);
        Assert.Single(window.OpenMenus);
        window.Close();
    }

    [AvaloniaFact]
    public void Tab_FromTheSelectedRow_ReachesItsMainButton()
    {
        var (window, _) = Open();
        var row = RowOf(window, "item:10");
        var main = row.GetVisualDescendants().OfType<Button>().Single((button) => button.Classes.Contains("main"));

        row.Focus(NavigationMethod.Tab);
        Dispatcher.UIThread.RunJobs();

        for (var step = 0; step < 10 && Focused(window) != main; step++)
        {
            Press(window, Key.Tab);
        }

        Assert.Same(main, Focused(window));
        Assert.Equal("item:10", window.FocusedRow());
        window.Close();
    }

    [AvaloniaFact]
    public void HubGone_WithARowMenuOpen_ClosesItAndActsOnNothing()
    {
        var (window, model) = Open();

        RowOf(window, "item:10").Focus(NavigationMethod.Tab);
        Press(window, Key.Apps);
        Assert.Single(window.OpenMenus);

        model.Show(Switchboard.Dock.Hub.Connection.NotRunning);
        Dispatcher.UIThread.RunJobs();

        Assert.Empty(window.OpenMenus);
        Press(window, Key.Enter);
        Assert.Empty(actions.Clicked);
        Assert.Empty(hub.Calls);
        window.Close();
    }

    [AvaloniaFact]
    public void Enter_OnALinkPill_OpensItsLink()
    {
        var (window, _) = Open();
        var pill = RowOf(window, "item:7").GetVisualDescendants().OfType<Border>().First((border) => border.Classes.Contains("pill") && border.Tag is string { Length: > 0 });

        pill.Focus(NavigationMethod.Tab);
        Press(window, Key.Enter);

        Assert.Equal([(string)pill.Tag!], actions.Urls);
        window.Close();
    }

    [AvaloniaFact]
    public void HubView_FocusedRowMovedIntoAClosedGroup_FocusesThatGroupsHeading()
    {
        var (window, model) = Open();
        var view = Fixtures.View;
        var from = view.Groups.First((group) => group.Rows.Any((each) => each.Key == "item:7"));
        var done = model.Groups.Single((group) => group.Key == "done");
        var moved = view with { Groups = view.Groups.Select((group) => group.Key == from.Key ? group with { Rows = group.Rows.Where((each) => each.Key != "item:7").ToList() } : group.Key == "done" ? group with { Rows = [.. group.Rows, Fixtures.Row("item:7") with { Band = group.Rows.FirstOrDefault()?.Band }] } : group).ToList() };

        Assert.False(done.IsOpen);
        RowOf(window, "item:7").Focus(NavigationMethod.Tab);
        Dispatcher.UIThread.RunJobs();
        model.Show(moved);
        window.RestoreFocus("item:7");
        Dispatcher.UIThread.RunJobs();

        Assert.Same(Stops(window).Single((stop) => stop.DataContext == done && stop.Classes.Contains("group")), Focused(window));
        window.Close();
    }

    [AvaloniaFact]
    public void HubView_FocusedRowMovedToAnotherGroup_KeepsTheFocusOnIt()
    {
        var (window, model) = Open();
        var row = Fixtures.Row("item:7");
        var view = Fixtures.View;
        var from = view.Groups.First((group) => group.Rows.Any((each) => each.Key == "item:7"));
        var to = view.Groups.First((group) => group.Key != from.Key);
        var moved = view with { Groups = view.Groups.Select((group) => group.Key == from.Key ? group with { Rows = group.Rows.Where((each) => each.Key != "item:7").ToList() } : group.Key == to.Key ? group with { Rows = [.. group.Rows, row] } : group).ToList() };

        RowOf(window, "item:7").GetVisualDescendants().OfType<Border>().First((border) => border.Classes.Contains("pill")).Focus(NavigationMethod.Tab);
        Dispatcher.UIThread.RunJobs();
        var focused = window.FocusedRow();
        Assert.Equal("item:7", focused);
        model.Show(moved);
        window.RestoreFocus(focused);
        Dispatcher.UIThread.RunJobs();

        Assert.Same(RowOf(window, "item:7"), Focused(window));
        window.Close();
    }
}
