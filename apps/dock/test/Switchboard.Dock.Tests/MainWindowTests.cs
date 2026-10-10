using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using Avalonia.LogicalTree;
using Avalonia.Media;
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
        var point = control.TranslatePoint(new Point(Math.Min(20, control.Bounds.Width / 2), Math.Min(8, control.Bounds.Height / 2)), window)!.Value;

        window.MouseDown(point, MouseButton.Left);
        window.MouseUp(point, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();
    }

    [AvaloniaFact]
    public void Show_RecordedView_ListsOpenGroupsWithCountsAndRows()
    {
        var (window, _) = Open();
        var texts = VisibleTexts(window);

        string[] headers = ["Blocked on you", "Ready for review", "In progress", "Unstarted", "Done", "0", "2", "3", "2 yours"];

        Assert.Equal(["Ready for review", "2 yours", "3", "Blocked on you", "2", "In progress", "0", "Unstarted", "2", "Done", "2"], texts.Where(headers.Contains));
        Assert.Contains("Nothing is in progress.", texts);
        Assert.Contains("Issue <7>", texts);
        Assert.Contains("gh 107", texts);
        Assert.Contains("Setup ended without a worktree.", texts);
        Assert.Contains("Which branch?", texts);
        Assert.DoesNotContain("Nothing waits to be started.", texts);
    }

    [AvaloniaFact]
    public void Show_GroupClosedBefore_KeepsItClosedAndOthersAtTheirDefault()
    {
        var (window, model) = Open(new DockSettings { Groups = { ["review"] = false } });

        Assert.DoesNotContain("Issue <7>", VisibleTexts(window));
        Assert.Contains("Issue <8>", VisibleTexts(window));
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
        var header = window.GetVisualDescendants().OfType<Border>().First((border) => border.Classes.Contains("group") && border.DataContext is GroupViewModel { Key: "review" });

        Tap(window, header);

        Assert.DoesNotContain("Issue <7>", VisibleTexts(window));
        Assert.Equal(["review=False"], saved);
        Assert.Empty(actions.Clicked);

        model.Show(Fixtures.View);
        Dispatcher.UIThread.RunJobs();

        Assert.DoesNotContain("Issue <7>", VisibleTexts(window));
    }

    [AvaloniaFact]
    public void MenuOf_Row_ListsHubControlsSnoozeChoicesDeleteOpenTicketAndLinks()
    {
        var (window, _) = Open();
        var menu = window.MenuOf(Fixtures.Row("item:7"));
        var snooze = (MenuItem)menu[2];

        Assert.Equal(
            ["Triage again", "Mark done", "Snooze", "Move to top", "Move up", "Move down", "Open Changes", "Open in terminal", "History", "", "Delete", "", "Open ticket", "Open PR #19002"],
            menu.Select((item) => item is MenuItem named ? (string)named.Header! : ""));
        Assert.IsType<Separator>(menu[9]);
        Assert.IsType<Separator>(menu[11]);
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
        ((MenuItem)menu[12]).RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        ((MenuItem)menu[13]).RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(["act {\"type\":\"mark-done\",\"workItemId\":7}", "act {\"type\":\"snooze\",\"ticketId\":7,\"until\":1791093600000}"], hub.Calls);
        Assert.Equal("The browser did not open it.", model.Status);
        Assert.Equal(["https://github.com/o/r/issues/107", "https://github.com/o/r/pull/19002"], actions.Urls);

        actions.RunReply = "Open a VS Code window first; this runs in VS Code.";
        ((MenuItem)menu[7]).RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();
        ((MenuItem)menu[8]).RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(
            [
                "item:7 {\"type\":\"terminal\",\"sessionId\":\"aaaa1111-native\",\"cwd\":\"D:/git/widgets/.worktrees/107-fix\",\"name\":\"gh 107\",\"shortId\":null,\"active\":false}",
                "item:7 {\"type\":\"history\",\"ticketId\":7,\"key\":\"gh 107\"}",
            ],
            actions.Runs);
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

        Assert.IsType<Separator>(menu[11]);
        Assert.Equal("Open PR #19002", ((MenuItem)menu[12]).Header);
        Assert.Equal(13, menu.Count);
    }

    [AvaloniaFact]
    public void MenuOf_RowWithOnlyDelete_ListsItWithoutASeparator()
    {
        var (window, _) = Open();
        var row = Fixtures.Row("item:7");
        var menu = window.MenuOf(row with { Controls = row.Controls.Where((control) => control.Label == "Delete").ToList(), Commands = [], Url = "", Links = [] });

        Assert.Equal(["Delete"], menu.Select((item) => ((MenuItem)item).Header));
    }

    [AvaloniaFact]
    public void Delete_Clicked_AsksInADialogAndPostsOnlyAfterDelete()
    {
        var (window, _) = Open();
        var delete = (MenuItem)window.MenuOf(Fixtures.Row("item:7"))[10];
        Button DialogButton(string name) => Assert.Single(window.OwnedWindows).GetVisualDescendants().OfType<Button>().Single((button) => button.Name == name);

        delete.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        var texts = VisibleTexts(Assert.Single(window.OwnedWindows));

        Assert.Equal("Delete gh 107?", texts[0]);
        Assert.StartsWith("Switchboard deletes the work item", texts[1]);
        DialogButton("ConfirmCancel").RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        Assert.Empty(window.OwnedWindows);
        Assert.Empty(hub.Calls);

        hub.ActReplies.Enqueue(null);
        delete.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();
        DialogButton("ConfirmAction").RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(["act {\"type\":\"delete\",\"workItemId\":7}"], hub.Calls);
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
    [AvaloniaFact]
    public void Show_RecordedView_GivesEachGroupItsGlyphAndMutesAnEmptyCount()
    {
        var (window, _) = Open();
        var headers = window.GetVisualDescendants().OfType<Border>().Where((border) => border.Classes.Contains("group")).ToList();

        Assert.Equal(["\uEA70", "\uEAA2", "\uEBA6", "\uEB09", "\uEBA4"], headers.Select((header) => header.GetVisualDescendants().OfType<TextBlock>().Single((text) => text.Classes.Contains("group-icon")).Text));
        var muted = window.FindResource(window.ActualThemeVariant, "DockBadgeZero");

        Assert.Equal([false, false, true, false, false], headers.Select((header) => header.GetVisualDescendants().OfType<Border>().Single((badge) => badge.Classes.Contains("badge")).Background == muted));
    }

    [AvaloniaFact]
    public void Show_SearchClosed_PutsTheFirstGroupDirectlyBelowTheTitleBar()
    {
        var (window, _) = Open();
        var titleBar = (Control)window.FindControl<TextBlock>("MoveHandle")!.Parent!;
        var first = window.GetVisualDescendants().OfType<Border>().First((border) => border.Classes.Contains("group"));

        Assert.Equal(titleBar.TranslatePoint(new Point(0, titleBar.Bounds.Height), window)!.Value.Y, first.TranslatePoint(default, window)!.Value.Y);
    }

    [AvaloniaFact]
    public void Show_EmptyGroup_ShowsItsMessageItalicMutedPaddedAndAlignedWithRowText()
    {
        var (window, _) = Open();
        var empty = window.GetVisualDescendants().OfType<TextBlock>().Single((text) => text.Text == "Nothing is in progress.");
        var rowText = window.GetVisualDescendants().OfType<TextBlock>().First((text) => text.Text == "Issue <7>");

        Assert.True(empty.IsEffectivelyVisible);
        Assert.Equal(FontStyle.Italic, empty.FontStyle);
        Assert.Equal(1, empty.Opacity);
        Assert.Equal(window.FindResource(window.ActualThemeVariant, "DockMuted"), empty.Foreground);
        Assert.Equal(new Thickness(11, 8, 8, 8), empty.Margin);
        Assert.Equal(rowText.TranslatePoint(default, window)!.Value.X, empty.TranslatePoint(default, window)!.Value.X);
    }

    [AvaloniaFact]
    public void OpenDone_RecordedView_ShowsTodayOpenAndOlderClosedUntilTapped()
    {
        var (window, _) = Open(new DockSettings { Groups = { ["done"] = true } });

        // Tall enough that the Older band is on screen to tap.
        window.Height = 1400;
        Dispatcher.UIThread.RunJobs();

        var bands = window.GetVisualDescendants().OfType<Border>().Where((border) => border.Classes.Contains("band") && border.IsEffectivelyVisible).ToList();

        Assert.Equal(["Today", "Older"], bands.Select((band) => ((BandViewModel)band.DataContext!).Title));
        Assert.Contains("Issue <11>", VisibleTexts(window));
        Assert.DoesNotContain("Issue <12>", VisibleTexts(window));

        Tap(window, bands[1]);

        Assert.Contains("Issue <12>", VisibleTexts(window));
        Assert.Contains("done:Older=True", saved.Last().Split(','));
    }

    [AvaloniaFact]
    public void SelectRow_TwoLineRowWithButton_KeepsTheRowHeight()
    {
        var (window, model) = Open();
        var row = window.GetVisualDescendants().OfType<Border>().Single((border) => border.Classes.Contains("row") && border.DataContext is RowViewModel { Key: "item:9" });
        var before = row.Bounds.Height;

        model.Selected = "item:9";
        Dispatcher.UIThread.RunJobs();

        Assert.True(row.GetVisualDescendants().OfType<Button>().Single((button) => button.Classes.Contains("main")).IsEffectivelyVisible);
        Assert.Equal(before, row.Bounds.Height);
    }

    [AvaloniaFact]
    public void Header_IconButtons_HaveAccessibleNames()
    {
        var (window, _) = Open();
        var names = window.GetVisualDescendants().OfType<Button>().Where((button) => button.Classes.Contains("header")).Select((button) => Avalonia.Automation.Peers.ControlAutomationPeer.CreatePeerForElement(button).GetName());

        Assert.Equal(["github", "zoho", "Search", "New Ad-hoc Session", "Open Settings", "Close the dock"], names);
    }

    [AvaloniaFact]
    public void Header_IconButtons_AreSquaresOfOneSize()
    {
        var (window, _) = Open();
        var sizes = window.GetVisualDescendants().OfType<Button>().Where((button) => button.Classes.Contains("header")).Select((button) => button.Bounds.Size).ToList();

        Assert.Equal(6, sizes.Count);
        Assert.All(sizes, (size) => Assert.Equal(new Size(28, 28), size));
    }

    [AvaloniaFact]
    public void Header_IconsAndSeparators_AreCentredOnTheButtons()
    {
        var (window, _) = Open();
        var buttons = window.GetVisualDescendants().OfType<Button>().Where((button) => button.Classes.Contains("header")).ToList();
        var separators = window.GetVisualDescendants().OfType<Border>().Where((border) => border.Classes.Contains("separator") && border.IsEffectivelyVisible).ToList();
        // A TextBlock's padding moves its glyph within its bounds, so the middle is taken inside the padding.
        double Middle(Control control)
        {
            var padding = control is TextBlock text ? text.Padding : default;
            return control.TranslatePoint(new Point(0, padding.Top + (control.Bounds.Height - padding.Top - padding.Bottom) / 2), window)!.Value.Y;
        }

        Assert.All(buttons, (button) => Assert.Equal(Middle(button), Middle((Control)button.Presenter!.Child!)));
        Assert.Equal(2, separators.Count);
        Assert.All(separators, (separator) => Assert.Equal(Middle(buttons[0]), Middle(separator)));
    }

    [AvaloniaFact]
    public void Header_CloseButton_EndsAtTheListEdgeAndSearchKeepsItsInset()
    {
        var (window, _) = Open();
        var panel = window.FindControl<DockPanel>("ListPanel")!;
        var close = window.FindControl<Button>("CloseButton")!;
        var search = window.FindControl<TextBox>("SearchBox")!;
        double Right(Control control) => control.TranslatePoint(new Point(control.Bounds.Width, 0), panel)!.Value.X;

        Tap(window, window.FindControl<Button>("SearchButton")!);
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(panel.Bounds.Width, Right(close));
        Assert.Equal(panel.Bounds.Width - 8, Right(search));
    }

    [AvaloniaFact]
    public void RowMenu_DockOnEitherEdge_OpensAwayFromTheEdgeAndAdjustsOnlyVertically()
    {
        var vertical = Avalonia.Controls.Primitives.PopupPositioning.PopupPositionerConstraintAdjustment.FlipY | Avalonia.Controls.Primitives.PopupPositioning.PopupPositionerConstraintAdjustment.SlideY;

        Assert.Equal(Avalonia.Controls.Primitives.PopupPositioning.PopupGravity.BottomRight, MainWindow.RowMenu([], dockOnRight: false, new Point(30, 40)).PlacementGravity);
        Assert.Equal(Avalonia.Controls.Primitives.PopupPositioning.PopupGravity.BottomLeft, MainWindow.RowMenu([], dockOnRight: true, new Point(30, 40)).PlacementGravity);
        Assert.Equal(vertical, MainWindow.RowMenu([], dockOnRight: true, new Point(30, 40)).PlacementConstraintAdjustment);
        Assert.Equal(new Rect(30, 40, 1, 1), MainWindow.RowMenu([], dockOnRight: true, new Point(30, 40)).PlacementRect);
    }

    [AvaloniaTheory]
    [InlineData(false, PlacementMode.RightEdgeAlignedTop, -4)]
    [InlineData(true, PlacementMode.LeftEdgeAlignedTop, 4)]
    public void RowMenu_Submenu_OpensAwayFromTheEdgeOverlapsItsItemAndAdjustsOnlyVertically(bool dockOnRight, PlacementMode placement, double offset)
    {
        var (window, _) = Open();
        var submenu = new MenuItem { Header = "Snooze", ItemsSource = new List<string> { "Tomorrow" } };

        MainWindow.RowMenu([submenu], dockOnRight, new Point(30, 40)).Open(window);
        Dispatcher.UIThread.RunJobs();

        var popup = submenu.GetVisualDescendants().OfType<Avalonia.Controls.Primitives.Popup>().Single((popup) => popup.Name == "PART_Popup");

        Assert.Equal(placement, popup.Placement);
        Assert.Equal(offset, popup.HorizontalOffset);
        Assert.Equal(Avalonia.Controls.Primitives.PopupPositioning.PopupPositionerConstraintAdjustment.FlipY | Avalonia.Controls.Primitives.PopupPositioning.PopupPositionerConstraintAdjustment.SlideY, popup.PlacementConstraintAdjustment);
    }

    [AvaloniaFact]
    public void TapPill_KeyAndPullRequest_OpenTheirLinksWithoutTheRowClick()
    {
        var (window, _) = Open();
        var pills = RowNamed(window, "Issue <7>").GetVisualDescendants().OfType<Border>().Where((border) => border.Classes.Contains("pill") && border.IsEffectivelyVisible).ToList();

        Assert.Equal(["gh 107", "19002", "Returned ×2"], pills.Select((pill) => pill.GetVisualDescendants().OfType<TextBlock>().Last().Text));
        Assert.Contains("pr", pills[1].Classes);

        Tap(window, pills[0]);
        Tap(window, pills[1]);
        Tap(window, pills[2]);

        Assert.Equal(["https://github.com/o/r/issues/107", "https://github.com/o/r/pull/19002"], actions.Urls);
        Assert.Empty(actions.Clicked);
    }

    [AvaloniaFact]
    public void SelectRow_NoButtons_KeepsLineThreeItsFullWidth()
    {
        var (window, model) = Open();
        var row = window.GetVisualDescendants().OfType<Border>().Single((border) => border.Classes.Contains("row") && border.DataContext is RowViewModel { Key: "item:7" });
        var line = row.GetVisualDescendants().OfType<DockPanel>().First((panel) => panel.IsVisible);
        var before = line.Bounds.Width;

        model.Selected = "item:7";
        Dispatcher.UIThread.RunJobs();

        Assert.False(row.GetVisualDescendants().OfType<StackPanel>().Single((panel) => panel.Classes.Contains("actions")).IsVisible);
        Assert.Equal(before, line.Bounds.Width);
    }

    [AvaloniaFact]
    public void HoverRow_WithButton_ShowsItOnlyOnceSelected()
    {
        var (window, model) = Open();
        var row = window.GetVisualDescendants().OfType<Border>().Single((border) => border.Classes.Contains("row") && border.DataContext is RowViewModel { Key: "item:9" });
        var actions = row.GetVisualDescendants().OfType<StackPanel>().Single((panel) => panel.Classes.Contains("actions"));

        window.MouseMove(row.TranslatePoint(new Point(20, 8), window)!.Value);
        Dispatcher.UIThread.RunJobs();
        Assert.True(row.IsPointerOver);
        Assert.False(actions.IsVisible);

        model.Selected = "item:9";
        Dispatcher.UIThread.RunJobs();
        Assert.True(actions.IsVisible);
    }
}
