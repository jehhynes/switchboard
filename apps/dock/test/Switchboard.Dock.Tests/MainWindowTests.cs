using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using Avalonia.LogicalTree;
using Avalonia.Threading;
using Avalonia.VisualTree;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Views;

namespace Switchboard.Dock.Tests;

public sealed class MainWindowTests
{
    readonly FakeHub hub = new();
    readonly FakeActions actions = new();
    readonly List<string> saved = [];

    (MainWindow Window, DockViewModel Model) Open(DockSettings? settings = null)
    {
        var model = new DockViewModel(settings ?? new DockSettings(), (kept) => saved.Add(string.Join(",", kept.Groups.Select((group) => $"{group.Key}={group.Value}"))));
        var window = new MainWindow(model, null, hub, actions, docked: false);

        model.Show(Fixtures.View);
        window.Show();
        Dispatcher.UIThread.RunJobs();

        return (window, model);
    }

    static List<string> VisibleTexts(Control root) =>
        root.GetVisualDescendants().OfType<TextBlock>().Where((text) => text.IsEffectivelyVisible && !string.IsNullOrEmpty(text.Text)).Select((text) => text.Text!).ToList();

    static Border RowNamed(Window window, string title) =>
        window.GetVisualDescendants().OfType<Border>().First((border) => border.Classes.Contains("row") && border.DataContext is RowViewModel row && row.Title == title);

    static void Tap(Window window, Control control)
    {
        var point = control.TranslatePoint(new Point(20, 8), window)!.Value;

        window.MouseDown(point, MouseButton.Left);
        window.MouseUp(point, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();
    }

    [AvaloniaFact]
    public void Show_RecordedView_ListsOpenGroupsWithCountsAndRows()
    {
        var (window, _) = Open();
        var texts = VisibleTexts(window);

        Assert.Equal(["Needs you", "3", "Working", "0", "Unstarted", "2", "Done", "0"], texts.Where((text) => text is "Needs you" or "Working" or "Unstarted" or "Done" or "0" or "2" or "3"));
        Assert.Contains("Nothing is running.", texts);
        Assert.Contains("Issue <7>", texts);
        Assert.Contains("gh 107", texts);
        Assert.Contains("The session finished its turn.", texts);
        Assert.Contains("Which branch?", texts);
        Assert.DoesNotContain("Nothing waits to be started.", texts);
    }

    [AvaloniaFact]
    public void Show_GroupClosedBefore_KeepsItClosedAndOthersAtTheirDefault()
    {
        var (window, model) = Open(new DockSettings { Groups = { ["needs"] = false } });

        Assert.DoesNotContain("Issue <7>", VisibleTexts(window));
        Assert.Contains("Issue <9>", VisibleTexts(window));
        Assert.False(model.Groups.Single((group) => group.Key == "done").IsOpen);
    }

    [AvaloniaFact]
    public void Show_SnoozedGroupOpenedBefore_ShowsItsRowsAcrossViews()
    {
        var snoozed = Fixtures.View with { Groups = [.. Fixtures.View.Groups, new DockGroup("snoozed", "Snoozed", null, [Fixtures.Row("item:9") with { Key = "item:5", Title = "Snoozed issue" }])] };
        var (window, model) = Open(new DockSettings { Groups = { ["snoozed"] = true } });

        model.Show(snoozed);
        Dispatcher.UIThread.RunJobs();
        Assert.Contains("Snoozed issue", VisibleTexts(window));

        model.Show(snoozed);
        Dispatcher.UIThread.RunJobs();
        Assert.Contains("Snoozed issue", VisibleTexts(window));

        var (other, otherModel) = Open();

        otherModel.Show(snoozed);
        Dispatcher.UIThread.RunJobs();
        Assert.DoesNotContain("Snoozed issue", VisibleTexts(other));
        Assert.Contains("Snoozed", VisibleTexts(other));
    }

    [AvaloniaFact]
    public void TapRow_WhileAnotherRowSwitches_CancelsTheFirstAndKeepsOnlyTheLatestStatus()
    {
        actions.Pending = new TaskCompletionSource<string?>();

        var (window, model) = Open();

        Tap(window, RowNamed(window, "Issue <8>"));
        Tap(window, RowNamed(window, "Issue <8>"));
        Tap(window, RowNamed(window, "Issue <7>"));

        Assert.Equal(["item:8", "item:7"], actions.Clicked.Select((row) => row.Key));
        Assert.True(actions.Cancels[0].IsCancellationRequested);
        Assert.False(actions.Cancels[1].IsCancellationRequested);

        actions.Pending!.SetResult("The first click's late answer.");
        Dispatcher.UIThread.RunJobs();

        Assert.Null(model.Status);
        Assert.Equal("item:7", model.Selected);
    }

    [AvaloniaFact]
    public void TapRow_ClickThrows_ShowsTheFailureInsteadOfClosing()
    {
        actions.Pending = new TaskCompletionSource<string?>();
        actions.Pending!.SetException(new IOException("disk full"));

        var (window, model) = Open();

        Tap(window, RowNamed(window, "Issue <8>"));

        Assert.Equal("The click failed: disk full", model.Status);
    }

    [AvaloniaFact]
    public void TapRow_Row_SelectsItRunsTheClickAndShowsItsStatus()
    {
        actions.ClickReply = "Windows kept another window in front. Click the row again.";

        var (window, model) = Open();

        Tap(window, RowNamed(window, "Issue <8>"));

        Assert.Equal(["item:8"], actions.Clicked.Select((row) => row.Key));
        Assert.Equal("item:8", model.Selected);
        Assert.Contains("selected", RowNamed(window, "Issue <8>").Classes);
        Assert.DoesNotContain("selected", RowNamed(window, "Issue <7>").Classes);
        Assert.Equal(actions.ClickReply, window.FindControl<TextBlock>("StatusLine")!.Text);
        Assert.True(window.FindControl<TextBlock>("StatusLine")!.IsVisible);
    }

    [AvaloniaFact]
    public void TapGroup_OpenGroup_ClosesItAndKeepsTheChoice()
    {
        var (window, model) = Open();
        var header = window.GetVisualDescendants().OfType<Border>().First((border) => border.Classes.Contains("group") && border.DataContext is GroupViewModel { Key: "needs" });

        Tap(window, header);

        Assert.DoesNotContain("Issue <7>", VisibleTexts(window));
        Assert.Equal(["needs=False"], saved);
        Assert.Empty(actions.Clicked);

        model.Show(Fixtures.View);
        Dispatcher.UIThread.RunJobs();

        Assert.DoesNotContain("Issue <7>", VisibleTexts(window));
    }

    [AvaloniaFact]
    public void MenuOf_Row_ListsHubControlsSnoozeChoicesOpenTicketAndLinks()
    {
        var (window, _) = Open();
        var menu = window.MenuOf(Fixtures.Row("item:7"));
        var snooze = (MenuItem)menu[2];

        Assert.Equal(["Triage again", "Mark done", "Snooze", "Open Changes", "History", "", "Open ticket", "Open PR #19002"], menu.Select((item) => item is MenuItem named ? (string)named.Header! : ""));
        Assert.IsType<Separator>(menu[5]);
        Assert.Equal(7, snooze.ItemsSource!.Cast<MenuItem>().Count());
        Assert.Equal("Indefinitely", snooze.ItemsSource!.Cast<MenuItem>().Last().Header);
        Assert.StartsWith("Tomorrow · ", (string)snooze.ItemsSource!.Cast<MenuItem>().First().Header!);
    }

    [AvaloniaFact]
    public void MenuItem_Clicked_PostsItsActionOrOpensTheTicket()
    {
        var (window, model) = Open();
        var menu = window.MenuOf(Fixtures.Row("item:7"));
        var snooze = ((MenuItem)menu[2]).ItemsSource!.Cast<MenuItem>().ToList();

        hub.ActReplies.Enqueue(null);
        hub.ActReplies.Enqueue("A wake time that has passed.");
        ((MenuItem)menu[1]).RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        snooze[0].RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        actions.UrlReply = "The browser did not open it.";
        ((MenuItem)menu[6]).RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        ((MenuItem)menu[7]).RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(["act {\"type\":\"mark-done\",\"workItemId\":7}", "act {\"type\":\"snooze\",\"ticketId\":7,\"until\":1791093600000}"], hub.Calls);
        Assert.Equal("The browser did not open it.", model.Status);
        Assert.Equal(["https://github.com/o/r/issues/107", "https://github.com/o/r/pull/19002"], actions.Urls);

        actions.RunReply = "Open a VS Code window first; this runs in VS Code.";
        ((MenuItem)menu[4]).RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(["item:7 {\"type\":\"history\",\"ticketId\":7,\"key\":\"gh 107\"}"], actions.Runs);
        Assert.Equal(actions.RunReply, model.Status);
    }

    [AvaloniaFact]
    public void MenuOf_RowWithoutControlsUrlOrLinks_IsEmpty()
    {
        var (window, _) = Open();

        Assert.Empty(window.MenuOf(Fixtures.Row("item:7") with { Controls = [], Commands = [], Url = "", Links = [] }));
    }

    [AvaloniaFact]
    public void MenuOf_RowWithLinksButNoUrl_ListsTheLinksAfterASeparator()
    {
        var (window, _) = Open();
        var menu = window.MenuOf(Fixtures.Row("item:7") with { Url = "" });

        Assert.IsType<Separator>(menu[5]);
        Assert.Equal("Open PR #19002", ((MenuItem)menu[6]).Header);
        Assert.Equal(7, menu.Count);
    }

    [AvaloniaFact]
    public void Show_NotRunning_SaysSoAboveTheList()
    {
        var (window, model) = Open();

        model.Show(Connection.NotRunning);
        Dispatcher.UIThread.RunJobs();

        Assert.Equal("Switchboard is not running. Open VS Code to start it.", window.FindControl<TextBlock>("ConnectionLine")!.Text);
        Assert.True(window.FindControl<TextBlock>("ConnectionLine")!.IsVisible);

        model.Show(Fixtures.View);
        Dispatcher.UIThread.RunJobs();

        Assert.False(window.FindControl<TextBlock>("ConnectionLine")!.IsVisible);
    }

    [AvaloniaFact]
    public void CloseButton_Clicked_ClosesTheDock()
    {
        var (window, _) = Open();
        var closed = false;

        window.Closed += (_, _) => closed = true;
        Tap(window, window.FindControl<Button>("CloseButton")!);

        Assert.True(closed);
        Assert.Empty(actions.Clicked);
    }
}
