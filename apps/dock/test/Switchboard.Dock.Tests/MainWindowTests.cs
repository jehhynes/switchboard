using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using Avalonia.LogicalTree;
using Avalonia.Media;
using Avalonia.Platform;
using Avalonia.Threading;
using Avalonia.VisualTree;
using System.Text.Json.Nodes;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Platform;
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

    [AvaloniaFact]
    public void Float_GripOnTheLeftDraggedOut_WidensTheDockAndKeepsItsRightEdge()
    {
        var (window, model) = Open(new DockSettings { Edge = "right", Width = 320 });

        window.Float();
        window.Position = new PixelPoint(500, 0);
        Dispatcher.UIThread.RunJobs();

        var grip = window.FindControl<Border>("GripLeft")!;
        var at = grip.TranslatePoint(new Point(2, 100), window)!.Value;

        window.MouseDown(at, MouseButton.Left);
        window.MouseMove(at - new Point(50, 0));
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(370, window.Width);
        Assert.Equal(450, window.Position.X);

        // The window moved 50 to the left under the still pointer, so the release is at the press's point in the window.
        window.MouseUp(at, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(370, model.Settings.Width);
    }

    /// <summary>
    /// A dock docked as an X11 dock window, opened on the headless platform's one screen, 1920 by 1280 pixels at scale 1 with its work area the whole
    /// screen, where no X display is used.
    /// </summary>
    (MainWindow Window, DockViewModel Model) OpenOnEdge(DockSettings settings)
    {
        var model = new DockViewModel(settings, (_) => saved.Add("saved"));
        var window = new MainWindow(model, null, hub, actions, docked: false);

        window.DockOnX11();
        model.Show(Fixtures.View);
        window.Show();
        Dispatcher.UIThread.RunJobs();

        return (window, model);
    }

    [AvaloniaFact]
    public void DockOnX11_Opened_TakesTheStripAtTheKeptEdgeAsTallAsTheWorkArea()
    {
        var (window, _) = OpenOnEdge(new DockSettings { Edge = "right", Width = 300 });

        Assert.Equal(new PixelPoint(1620, 0), window.Position);
        Assert.Equal(300, window.Width);
        Assert.Equal(1280, window.Height);
        Assert.False(window.ShowInTaskbar);
        Assert.False(window.FindControl<Button>("AutoHideButton")!.IsVisible);
    }

    /// <summary>A dock docked as an X11 dock window through <paramref name="edge"/>, a fake of its X11 calls.</summary>
    (MainWindow Window, DockViewModel Model) OpenOnEdge(DockSettings settings, FakeX11Edge edge)
    {
        var model = new DockViewModel(settings, (_) => saved.Add("saved"));
        var window = new MainWindow(model, null, hub, actions, docked: false);

        window.DockOnX11(edge);
        model.Show(Fixtures.View);
        window.Show();
        Dispatcher.UIThread.RunJobs();

        return (window, model);
    }

    // The monotonic time the hide timer's checks run at; the headless platform runs no timers.
    TimeSpan now = TimeSpan.FromSeconds(10);

    /// <summary>Runs the hide timer's check now and once the hide delay has passed.</summary>
    void Wait(MainWindow window)
    {
        Dispatcher.UIThread.RunJobs();
        Check(window, TimeSpan.Zero);
        Check(window, HideDelay.Delay);
        now += TimeSpan.FromSeconds(1);
    }

    /// <summary>Runs the hide timer's check <paramref name="after"/> the current time.</summary>
    void Check(MainWindow window, TimeSpan after)
    {
        window.CheckHide(now + after);
        Dispatcher.UIThread.RunJobs();
    }

    [AvaloniaFact]
    public void DockOnX11_WithShape_ShowsThePin()
    {
        var (window, _) = OpenOnEdge(new DockSettings(), new FakeX11Edge());

        Assert.True(window.FindControl<Button>("AutoHideButton")!.IsVisible);
    }

    [AvaloniaFact]
    public void DockOnX11_AutoHideKeptWithoutShape_HidesThePinAndReservesTheStrip()
    {
        var edge = new FakeX11Edge { CanShape = false };
        var (window, _) = OpenOnEdge(new DockSettings { AutoHide = true }, edge);

        Wait(window);

        Assert.False(window.FindControl<Button>("AutoHideButton")!.IsVisible);
        Assert.Equal(["reserve Left"], edge.Calls);
    }

    [AvaloniaFact]
    public void DockOnX11_AutoHideOff_ReservesTheStripAndNeverClips()
    {
        var edge = new FakeX11Edge();

        var (window, _) = OpenOnEdge(new DockSettings(), edge);
        Wait(window);

        Assert.Equal(["reserve Left"], edge.Calls);
    }

    [AvaloniaFact]
    public void DockOnX11_AutoHideOnAndNothingKeepsIt_ReleasesTheStripAndClipsToTheSliverAfterTheDelay()
    {
        var edge = new FakeX11Edge();
        var (window, _) = OpenOnEdge(new DockSettings { AutoHide = true }, edge);

        Assert.Equal(["release"], edge.Calls);
        Assert.False(window.FindControl<Control>("Sliver")!.IsVisible);

        Check(window, TimeSpan.Zero);
        Check(window, HideDelay.Delay - TimeSpan.FromMilliseconds(1));

        Assert.Equal(["release"], edge.Calls);

        Check(window, HideDelay.Delay);

        Assert.Equal(["release", "clip Left 3"], edge.Calls);
        var sliver = window.FindControl<Control>("Sliver")!;
        Assert.True(sliver.IsVisible);
        Assert.Equal(Avalonia.Layout.HorizontalAlignment.Left, sliver.HorizontalAlignment);
    }

    [AvaloniaFact]
    public void DockOnX11_KeptOpenDuringTheDelay_StartsTheDelayAgain()
    {
        var edge = new FakeX11Edge();
        var (window, _) = OpenOnEdge(new DockSettings { AutoHide = true }, edge);

        Check(window, TimeSpan.Zero);
        edge.Kept = true;
        Check(window, TimeSpan.FromMilliseconds(300));
        edge.Kept = false;
        Check(window, TimeSpan.FromMilliseconds(400));
        Check(window, TimeSpan.FromMilliseconds(799));

        Assert.Equal(["release"], edge.Calls);

        Check(window, TimeSpan.FromMilliseconds(800));

        Assert.Equal(["release", "clip Left 3"], edge.Calls);
    }

    [AvaloniaFact]
    public void DockOnX11_MenuOpen_DoesNotHideUntilItCloses()
    {
        var edge = new FakeX11Edge();
        var (window, _) = OpenOnEdge(new DockSettings { AutoHide = true }, edge);
        var more = window.FindControl<Button>("MoreButton")!;

        Tap(window, more);
        Wait(window);

        Assert.True(more.ContextMenu!.IsOpen);
        Assert.Equal(["release"], edge.Calls);

        more.ContextMenu.Close();
        Wait(window);

        Assert.Equal(["release", "clip Left 3"], edge.Calls);
    }

    [AvaloniaFact]
    public void DockOnX11_MenuOpenedByRightClick_DoesNotHide()
    {
        var edge = new FakeX11Edge();
        var (window, _) = OpenOnEdge(new DockSettings { AutoHide = true }, edge);
        var more = window.FindControl<Button>("MoreButton")!;

        var row = window.GetVisualDescendants().OfType<Border>().First((border) => border.Classes.Contains("row") && border.DataContext is RowViewModel);

        Tap(window, more);
        more.ContextMenu!.Close();
        // A row's menu opens after More Actions and closes, so the dock hides.
        row.RaiseEvent(new ContextRequestedEventArgs());
        window.KeyPress(Key.Escape, RawInputModifiers.None, PhysicalKey.Escape, null);
        Wait(window);
        window.WatchShow(TimeSpan.Zero);
        window.MouseMove(new Point(1, 300));
        window.CheckShow(TimeSpan.FromMilliseconds(100));
        window.CheckShow(TimeSpan.FromMilliseconds(500));
        // Avalonia opens a control's own context menu without the dock's code.
        more.RaiseEvent(new ContextRequestedEventArgs());
        Wait(window);

        Assert.True(more.ContextMenu.IsOpen);
        Assert.Equal(["release", "clip Left 3", "unclip"], edge.Calls);
    }

    [AvaloniaFact]
    public void DockOnX11_SearchBoxMenuOpen_DoesNotHideAndHidingClosesIt()
    {
        var edge = new FakeX11Edge();
        var (window, model) = OpenOnEdge(new DockSettings { AutoHide = true }, edge);

        model.SearchOpen = true;
        Dispatcher.UIThread.RunJobs();
        var search = window.FindControl<TextBox>("SearchBox")!;
        var flyout = search.ContextFlyout!;
        flyout.ShowAt(search);
        Wait(window);

        Assert.True(flyout.IsOpen);
        Assert.Equal(["release"], edge.Calls);

        flyout.Hide();
        Wait(window);
        flyout.ShowAt(search);
        window.Width = 400;
        Dispatcher.UIThread.RunJobs();

        Assert.False(flyout.IsOpen);
        Assert.Equal(["release", "clip Left 3", "clip Left 3"], edge.Calls);
    }

    /// <summary>Opens the menu of the first row, as a right-click does, which takes no focus by itself.</summary>
    static void OpenRowMenu(MainWindow window) =>
        window.GetVisualDescendants().OfType<Border>().First((border) => border.Classes.Contains("row") && border.DataContext is RowViewModel).RaiseEvent(new ContextRequestedEventArgs());

    [AvaloniaFact]
    public void DockOnX11_MenuOpen_TakesTheFocusAndClosesOnceItMovesToAnotherApp()
    {
        var edge = new FakeX11Edge();
        var (window, _) = OpenOnEdge(new DockSettings(), edge);

        OpenRowMenu(window);
        window.CheckPopups();

        Assert.Equal(1, window.FocusRequests);
        Assert.NotEmpty(window.OpenMenus);

        // A click on another app, which Avalonia does not see while the dock window does not have the focus.
        edge.Focused = false;
        window.CheckPopups();

        Assert.Empty(window.OpenMenus);
    }

    [AvaloniaFact]
    public void DockOnX11_FocusLostBeforeTheFirstCheck_ClosesTheMenu()
    {
        var edge = new FakeX11Edge();
        var (window, _) = OpenOnEdge(new DockSettings(), edge);

        OpenRowMenu(window);
        edge.Focused = false;
        window.CheckPopups();

        Assert.Empty(window.OpenMenus);
    }

    [AvaloniaFact]
    public void DockOnX11_MenuOpenAndFocusRefused_KeepsTheMenu()
    {
        var edge = new FakeX11Edge { Refuses = true };
        var (window, _) = OpenOnEdge(new DockSettings(), edge);

        OpenRowMenu(window);
        window.CheckPopups();
        window.CheckPopups();

        Assert.NotEmpty(window.OpenMenus);
    }

    [AvaloniaFact]
    public void DockOnX11_HiddenWithMenuOpen_ClosesTheMenu()
    {
        var edge = new FakeX11Edge();
        var (window, _) = OpenOnEdge(new DockSettings { AutoHide = true }, edge);
        var more = window.FindControl<Button>("MoreButton")!;

        Wait(window);
        // The headless tap moves no pointer, so the dock is still hidden when the menu opens.
        Tap(window, more);
        Assert.True(more.ContextMenu!.IsOpen);

        window.Width = 400;
        Dispatcher.UIThread.RunJobs();

        Assert.False(more.ContextMenu.IsOpen);
        Assert.Equal(["release", "clip Left 3", "clip Left 3"], edge.Calls);
    }

    [AvaloniaTheory]
    [InlineData("left", true)]
    [InlineData("right", true)]
    [InlineData("left", false)]
    [InlineData("right", false)]
    public void DockOnX11_ExpandedThenResized_RefreshesTheShape(string side, bool autoHide)
    {
        var edge = new FakeX11Edge();
        var (window, model) = OpenOnEdge(new DockSettings { AutoHide = true, Edge = side }, edge);
        Wait(window);
        window.Activate();
        Dispatcher.UIThread.RunJobs();
        Assert.Contains("unclip", edge.Calls);

        if (!autoHide)
        {
            Tap(window, window.FindControl<Button>("AutoHideButton")!);
            Assert.False(model.Settings.AutoHide);
        }

        edge.Calls.Clear();
        window.Width = 420;
        Dispatcher.UIThread.RunJobs();
        window.Width = 250;
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(["unclip", "unclip"], edge.Calls);
        Assert.False(window.FindControl<Control>("Sliver")!.IsVisible);
    }

    [AvaloniaFact]
    public void DockOnX11_HiddenAndResized_ClipsAgain()
    {
        var edge = new FakeX11Edge();
        var (window, _) = OpenOnEdge(new DockSettings { AutoHide = true, Edge = "right" }, edge);

        Wait(window);
        window.Width = 400;
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(["release", "clip Right 3", "clip Right 3"], edge.Calls);
    }

    [AvaloniaFact]
    public void DockOnX11_HiddenAndDialogOpens_Unclips()
    {
        var edge = new FakeX11Edge();
        var (window, _) = OpenOnEdge(new DockSettings { AutoHide = true }, edge);

        Wait(window);

        Assert.Same(window, window.ShownForDialog());
        Assert.Equal(["release", "clip Left 3", "unclip"], edge.Calls);
    }

    [AvaloniaFact]
    public void DockOnX11_AutoHideOnRightEdge_ClipsToTheRightSliver()
    {
        var edge = new FakeX11Edge();

        var (window, _) = OpenOnEdge(new DockSettings { AutoHide = true, Edge = "right" }, edge);
        Wait(window);

        Assert.Equal(["release", "clip Right 3"], edge.Calls);
        Assert.Equal(Avalonia.Layout.HorizontalAlignment.Right, window.FindControl<Control>("Sliver")!.HorizontalAlignment);
    }

    [AvaloniaFact]
    public void DockOnX11_AutoHideOnAndKeptOpen_DoesNotClip()
    {
        var edge = new FakeX11Edge { Kept = true };

        var (window, _) = OpenOnEdge(new DockSettings { AutoHide = true }, edge);
        Wait(window);

        Assert.Equal(["release"], edge.Calls);
    }

    [AvaloniaFact]
    public void DockOnX11_HiddenAndPointerHovers_WaitsBeforeShowingAndHidesAgainOnceNothingKeepsIt()
    {
        var edge = new FakeX11Edge();
        var (window, _) = OpenOnEdge(new DockSettings { AutoHide = true }, edge);

        Wait(window);
        window.WatchShow(TimeSpan.Zero);
        window.MouseMove(new Point(1, 300));
        window.CheckShow(TimeSpan.FromMilliseconds(100));
        window.MouseMove(new Point(1, 301));
        window.CheckShow(TimeSpan.FromMilliseconds(499));
        Assert.Equal(["release", "clip Left 3"], edge.Calls);
        Assert.True(window.FindControl<Control>("Sliver")!.IsVisible);
        window.CheckShow(TimeSpan.FromMilliseconds(500));
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(["release", "clip Left 3", "unclip"], edge.Calls);
        Assert.False(window.FindControl<Control>("Sliver")!.IsVisible);

        Wait(window);

        Assert.Equal(["release", "clip Left 3", "unclip", "clip Left 3"], edge.Calls);
    }

    [AvaloniaFact]
    public void DockOnX11_PointerLeavesBeforeShowDelay_CancelsAndRestartsOnReturn()
    {
        var edge = new FakeX11Edge();
        var (window, _) = OpenOnEdge(new DockSettings { AutoHide = true }, edge);
        Wait(window);

        window.WatchShow(TimeSpan.Zero);
        window.MouseMove(new Point(1, 300));
        window.CheckShow(TimeSpan.FromMilliseconds(100));
        window.MouseMove(new Point(-10, 300));
        window.CheckShow(TimeSpan.FromMilliseconds(600));
        Assert.Equal(["release", "clip Left 3"], edge.Calls);

        window.WatchShow(TimeSpan.FromMilliseconds(700));
        window.MouseMove(new Point(1, 300));
        window.CheckShow(TimeSpan.FromMilliseconds(800));
        window.CheckShow(TimeSpan.FromMilliseconds(1199));
        Assert.Equal(["release", "clip Left 3"], edge.Calls);
        window.CheckShow(TimeSpan.FromMilliseconds(1200));
        Assert.Equal(["release", "clip Left 3", "unclip"], edge.Calls);
    }

    [AvaloniaFact]
    public void DockOnX11_HiddenAndPinTurnedOff_UnclipsAndReservesTheStrip()
    {
        var edge = new FakeX11Edge();
        var (window, model) = OpenOnEdge(new DockSettings { AutoHide = true }, edge);

        Wait(window);
        // The headless tap moves no pointer, so the dock is still hidden when the click turns auto-hide off.
        Tap(window, window.FindControl<Button>("AutoHideButton")!);
        Wait(window);

        Assert.False(model.Settings.AutoHide);
        Assert.Equal(["release", "clip Left 3", "reserve Left", "unclip"], edge.Calls);
        Assert.False(window.FindControl<Control>("Sliver")!.IsVisible);
    }

    [AvaloniaFact]
    public void DockOnX11_PinTurnedOn_ReleasesTheStripAndHides()
    {
        var edge = new FakeX11Edge();
        var (window, model) = OpenOnEdge(new DockSettings(), edge);

        Tap(window, window.FindControl<Button>("AutoHideButton")!);
        Wait(window);

        Assert.True(model.Settings.AutoHide);
        Assert.Equal(["reserve Left", "release", "clip Left 3"], edge.Calls);
    }

    [AvaloniaFact]
    public void DockOnX11_HiddenAndActivated_Unclips()
    {
        var edge = new FakeX11Edge();
        var (window, _) = OpenOnEdge(new DockSettings { AutoHide = true }, edge);

        Wait(window);
        window.Activate();
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(["release", "clip Left 3", "unclip"], edge.Calls);
    }

    [AvaloniaFact]
    public void DockOnX11_KeptMonitorMissing_DocksOnThePrimaryMonitor()
    {
        var (window, model) = OpenOnEdge(new DockSettings { Edge = "right", Width = 300, Monitor = "HDMI-9" });

        Assert.Equal(new PixelPoint(1620, 0), window.Position);
        Assert.Equal(1280, window.Height);
        Assert.Equal("HDMI-9", model.Settings.Monitor);
    }

    [AvaloniaFact]
    public void ShowFullScreen_OnAnotherMonitor_KeepsTheDockAbove()
    {
        // The headless platform's screen has no name, so no report names it.
        var (window, _) = OpenOnEdge(new DockSettings());

        window.ShowFullScreen(["HDMI-9"]);

        Assert.False(window.Below);
    }

    [AvaloniaFact]
    public void DockOnX11_TitleDraggedPastTheMiddle_DocksAtTheOtherEdgeAndKeepsIt()
    {
        var (window, model) = OpenOnEdge(new DockSettings { Edge = "left", Width = 320 });
        var title = window.FindControl<TextBlock>("MoveHandle")!;
        var at = title.TranslatePoint(new Point(10, 5), window)!.Value;

        window.MouseDown(at, MouseButton.Left);
        // Short of the middle, x = 940: the dock stays at the left edge.
        window.MouseMove(new Point(940, at.Y));
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(DockEdge.Left, model.Settings.DockEdge);
        Assert.Equal(0, window.Position.X);

        window.MouseMove(new Point(970, at.Y));
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(DockEdge.Right, model.Settings.DockEdge);
        Assert.Equal(1600, window.Position.X);
        Assert.Null(model.Settings.Monitor);
        Assert.Contains("saved", saved);
    }

    [AvaloniaFact]
    public void DockOnX11_GripOnTheLeftDraggedOut_WidensTheDockAndKeepsTheScreensRightEdge()
    {
        var (window, model) = OpenOnEdge(new DockSettings { Edge = "right", Width = 320 });
        var grip = window.FindControl<Border>("GripLeft")!;
        var at = grip.TranslatePoint(new Point(2, 100), window)!.Value;

        window.MouseDown(at, MouseButton.Left);
        window.MouseMove(at - new Point(100, 0));
        Dispatcher.UIThread.RunJobs();
        window.MouseUp(at, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(420, model.Settings.Width);
        Assert.Equal(420, window.Width);
        Assert.Equal(1500, window.Position.X);
    }

    [AvaloniaFact]
    public void TapRow_FocusRefreshBetweenPressAndRelease_OpensOnFirstClick()
    {
        var (window, model) = Open();
        var row = RowNamed(window, "Issue <8>");
        var point = row.TranslatePoint(new Point(20, 8), window)!.Value;

        window.MouseDown(point, MouseButton.Left);
        model.Show(Fixtures.View with { Windows = new OpenWindows([], null, 1) });
        Dispatcher.UIThread.RunJobs();
        window.MouseUp(point, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();

        Assert.Single(actions.Clicked);
        Assert.Same(row, RowNamed(window, "Issue <8>"));
    }

    [AvaloniaFact]
    public void TapRow_ChangedViewBetweenPressAndRelease_OpensThenShowsLatestView()
    {
        var (window, model) = Open();
        var row = RowNamed(window, "Issue <8>");
        var point = row.TranslatePoint(new Point(20, 8), window)!.Value;
        window.MouseDown(point, MouseButton.Left);

        foreach (var title in new[] { "Intermediate issue", "Updated issue" })
        {
            var view = Fixtures.View;
            model.Show(view with
            {
                Groups = view.Groups.Select(group => group with
                {
                    Rows = group.Rows.Select(item => item.Key == "item:8" ? item with { Title = title } : item).ToList(),
                }).ToList(),
            });
            Dispatcher.UIThread.RunJobs();
        }

        Assert.Contains("Issue <8>", VisibleTexts(window));
        window.MouseUp(point, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();

        Assert.Single(actions.Clicked);
        Assert.Contains("Updated issue", VisibleTexts(window));
        Assert.DoesNotContain("Intermediate issue", VisibleTexts(window));
    }

    [AvaloniaFact]
    public void TapRow_HubDisconnectsWithAViewPending_KeepsTheDisconnectMessage()
    {
        var (window, model) = Open();
        var point = RowNamed(window, "Issue <8>").TranslatePoint(new Point(20, 8), window)!.Value;
        window.MouseDown(point, MouseButton.Left);
        model.Show(Fixtures.View);
        model.Show(Connection.NotRunning);
        var message = model.Connection;
        window.MouseUp(point, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();

        Assert.NotNull(message);
        Assert.Equal(message, model.Connection);
    }

    [AvaloniaFact]
    public void Show_ChangedRowAfterFocusRefresh_UpdatesTheRow()
    {
        var (window, model) = Open();

        model.Show(Fixtures.View with { Windows = new OpenWindows([], null, 1) });
        var view = Fixtures.View;
        model.Show(view with
        {
            Groups = view.Groups.Select(group => group with
            {
                Rows = group.Rows.Select(row => row.Key == "item:8" ? row with { Title = "Updated issue" } : row).ToList(),
            }).ToList(),
        });
        Dispatcher.UIThread.RunJobs();

        Assert.Contains("Updated issue", VisibleTexts(window));
        Assert.DoesNotContain("Issue <8>", VisibleTexts(window));
    }

    [AvaloniaFact]
    public void Show_ChangedNestedAction_UsesTheNewAction()
    {
        var (window, model) = Open();
        var view = Fixtures.View;
        model.Show(view);
        var action = view.Groups.SelectMany(group => group.Rows).Single(row => row.Key == "item:9").Controls[0].Action;
        action["guidance"] = "Updated guidance";
        model.Show(view);
        model.Selected = "item:9";
        Dispatcher.UIThread.RunJobs();
        hub.ActReplies.Enqueue(null);

        Tap(window, window.GetVisualDescendants().OfType<Button>().Single(button => button.Classes.Contains("main") && button.IsEffectivelyVisible));

        Assert.Contains(hub.Calls, call => call.Contains("Updated guidance", StringComparison.Ordinal));
    }

    [AvaloniaFact]
    public void TakeFocus_ClickOffTheRows_AsksForTheFocusAfterTheRelease()
    {
        var (window, _) = Open();
        var title = window.FindControl<TextBlock>("MoveHandle")!;
        var at = title.TranslatePoint(new Point(10, 5), window)!.Value;

        window.MouseDown(at, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(0, window.FocusRequests);

        window.MouseUp(at, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(1, window.FocusRequests);
    }

    [AvaloniaFact]
    public void TakeFocus_RowClickedWhileSearching_TakesTheCaretOutOfTheSearchBox()
    {
        var (window, _) = Open();
        var search = window.FindControl<TextBox>("SearchBox")!;

        Tap(window, window.FindControl<Button>("SearchButton")!);
        search.Focus();
        Dispatcher.UIThread.RunJobs();
        Assert.True(search.IsFocused);

        Tap(window, RowNamed(window, "Issue <8>"));

        Assert.False(search.IsFocused);
        Assert.Single(actions.Clicked);
    }

    [AvaloniaFact]
    public void TakeFocus_RowsMainControlClicked_LeavesTheFocusWhereItIs()
    {
        var (window, model) = Open();

        model.Selected = "item:9";
        Dispatcher.UIThread.RunJobs();

        var main = window.GetVisualDescendants().OfType<Button>().Single((button) => button.Classes.Contains("main") && button.IsEffectivelyVisible);

        hub.ActReplies.Enqueue(null);
        Tap(window, main);

        Assert.Equal(["act {\"type\":\"start\",\"workItemId\":9}"], hub.Calls);
        Assert.Equal(0, window.FocusRequests);
    }

    [AvaloniaFact]
    public void TakeFocus_RowClickedOnceAndTwice_LeavesTheFocusToVsCode()
    {
        var (window, _) = Open();
        var row = RowNamed(window, "Issue <8>");

        Tap(window, row);
        // A double-click, whose second release raises no tap.
        Tap(window, row);

        Assert.NotEmpty(actions.Clicked);
        Assert.Equal(0, window.FocusRequests);
    }

    [AvaloniaFact]
    public void TakeFocus_RowClickFails_AsksForTheFocusToShowWhy()
    {
        var (window, model) = Open();

        actions.ClickReply = "VS Code did not start: code was not found on PATH.";
        Tap(window, RowNamed(window, "Issue <8>"));

        Assert.Equal("VS Code did not start: code was not found on PATH.", model.Status);
        Assert.Equal(1, window.FocusRequests);
    }

    static List<string> VisibleTexts(Control root) =>
        root.GetVisualDescendants().OfType<TextBlock>().Where((text) => text.IsEffectivelyVisible && !string.IsNullOrEmpty(text.Text)).Select((text) => text.Text!).ToList();

    static Border RowNamed(Window window, string title) =>
        window.GetVisualDescendants().OfType<Border>().First((border) => border.Classes.Contains("row") && border.DataContext is RowViewModel row && row.Title == title);

    static Color Resource(Window window, string key) =>
        window.TryFindResource(key, window.ActualThemeVariant, out var brush) ? ((ISolidColorBrush)brush!).Color : throw new KeyNotFoundException(key);

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

        string[] headers = ["Blocked on you", "Ready for review", "In progress", "Unstarted", "Done", "0", "2", "3"];
        var headerTexts = window.GetVisualDescendants().OfType<Border>().Where((border) => border.Classes.Contains("group"))
            .SelectMany((header) => header.GetVisualDescendants().OfType<TextBlock>()).Select((text) => text.Text);

        Assert.Equal(["Ready for review", "3", "Blocked on you", "3", "In progress", "0", "Unstarted", "2", "Done", "2"], headerTexts.Where(headers.Contains));
        Assert.Contains("Nothing is in progress.", texts);
        Assert.Contains("Issue <7>", texts);
        Assert.Contains("gh 107", texts);
        Assert.Contains("Setup ended without a worktree.", texts);
        Assert.Contains("Answer a question", texts);
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
        Assert.True(window.FindControl<TextBlock>("StatusLine")!.IsEffectivelyVisible);
    }

    /// <summary>A dock whose status countdown reads <see cref="statusNow"/>.</summary>
    (MainWindow Window, DockViewModel Model) OpenWithStatusClock()
    {
        var (window, model) = Open();
        window.StatusClock = () => statusNow;

        return (window, model);
    }

    TimeSpan statusNow = TimeSpan.FromSeconds(100);

    void CheckStatus(MainWindow window, double seconds)
    {
        statusNow = TimeSpan.FromSeconds(seconds);
        window.CheckStatus(statusNow);
        Dispatcher.UIThread.RunJobs();
    }

    [AvaloniaFact]
    public void CheckStatus_ShownTenSeconds_HidesTheToast()
    {
        var (window, model) = OpenWithStatusClock();
        model.Status = "The terminal did not start: No such file or directory";

        CheckStatus(window, 109.9);
        Assert.Equal("The terminal did not start: No such file or directory", model.Status);
        Assert.True(window.FindControl<Border>("StatusToast")!.IsVisible);

        CheckStatus(window, 110);
        Assert.Null(model.Status);
        Assert.False(window.FindControl<Border>("StatusToast")!.IsVisible);
    }

    [AvaloniaFact]
    public void CheckStatus_PointerOnTheToast_KeepsItUntilTenSecondsAfterThePointerLeaves()
    {
        var (window, model) = OpenWithStatusClock();
        model.Status = "Copied Reply.";
        Dispatcher.UIThread.RunJobs();
        var toast = window.FindControl<Border>("StatusToast")!;

        window.MouseMove(toast.TranslatePoint(new Point(10, 10), window)!.Value);
        CheckStatus(window, 130);
        Assert.Equal("Copied Reply.", model.Status);

        window.MouseMove(new Point(-10, 300));
        CheckStatus(window, 139.9);
        Assert.Equal("Copied Reply.", model.Status);
        CheckStatus(window, 140);
        Assert.Null(model.Status);
    }

    [AvaloniaFact]
    public void CheckStatus_PointerOnTheToastBetweenChecks_RestartsItsTimeWhenThePointerLeaves()
    {
        var (window, model) = OpenWithStatusClock();
        model.Status = "Copied Reply.";
        Dispatcher.UIThread.RunJobs();
        var toast = window.FindControl<Border>("StatusToast")!;

        statusNow = TimeSpan.FromSeconds(109.2);
        window.MouseMove(toast.TranslatePoint(new Point(10, 10), window)!.Value);
        statusNow = TimeSpan.FromSeconds(109.8);
        window.MouseMove(new Point(-10, 300));

        CheckStatus(window, 119.7);
        Assert.Equal("Copied Reply.", model.Status);
        CheckStatus(window, 119.8);
        Assert.Null(model.Status);
    }

    [AvaloniaFact]
    public void Status_SameMessageAgain_RestartsItsTime()
    {
        var (window, model) = OpenWithStatusClock();
        model.Status = "Copied Reply.";

        statusNow = TimeSpan.FromSeconds(109);
        model.Status = "Copied Reply.";

        CheckStatus(window, 118.9);
        Assert.Equal("Copied Reply.", model.Status);
        CheckStatus(window, 119);
        Assert.Null(model.Status);
    }

    [AvaloniaFact]
    public void CheckStatus_DockHidden_KeepsTheToastUntilTenSecondsAfterItShows()
    {
        var (window, model) = OpenOnEdge(new DockSettings { AutoHide = true }, new FakeX11Edge());
        window.StatusClock = () => statusNow;
        Wait(window);
        model.Status = "The terminal did not start: No such file or directory";

        CheckStatus(window, 160);
        Assert.Equal("The terminal did not start: No such file or directory", model.Status);

        statusNow = TimeSpan.FromSeconds(165);
        window.Activate();
        Dispatcher.UIThread.RunJobs();
        CheckStatus(window, 174.9);
        Assert.Equal("The terminal did not start: No such file or directory", model.Status);
        CheckStatus(window, 175);
        Assert.Null(model.Status);
    }

    [AvaloniaFact]
    public void TapDismiss_StatusShown_HidesTheToast()
    {
        var (window, model) = Open();
        model.Status = "Copied Reply.";
        Dispatcher.UIThread.RunJobs();

        Tap(window, window.FindControl<Button>("DismissStatusButton")!);

        Assert.Null(model.Status);
        Assert.False(window.FindControl<Border>("StatusToast")!.IsVisible);
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
    public void MenuOf_Row_ListsHubControlsDeleteOpenTicketAndLinks()
    {
        var (window, _) = Open();
        var menu = window.MenuOf(Fixtures.Row("item:7"));

        Assert.Equal(
            ["Mark done", "Snooze…", "Add comment…", "Move to top", "Move up", "Move down", "Open Changes", "Open in terminal", "History", "", "Delete", "", "Open ticket", "Open PR #19002", "Open gh 20087"],
            menu.Select((item) => item is MenuItem named ? (string)named.Header! : ""));
        Assert.IsType<Separator>(menu[9]);
        Assert.IsType<Separator>(menu[11]);
        Assert.Null(((MenuItem)menu[1]).ItemsSource);
    }

    [AvaloniaFact]
    public void MenuOf_GroupedControls_ListsThemInASubmenuWithTheCheckedOneMarked()
    {
        var (window, _) = Open();
        DockControl Persona(string label, string? id, bool isChecked) =>
            new(label, new System.Text.Json.Nodes.JsonObject { ["type"] = "persona", ["sessionId"] = "s7", ["personaId"] = id }, Group: "Persona", Checked: isChecked);
        var row = Fixtures.Row("item:7") with { Controls = [Persona("Nova", "nova", false), Persona("Orion (pinned)", "orion", true), Persona("Clear pin", null, false)], Commands = [], Url = "", Links = [] };

        var menu = window.MenuOf(row);
        var persona = Assert.IsType<MenuItem>(Assert.Single(menu));
        var choices = ((IEnumerable<object>)persona.ItemsSource!).Cast<MenuItem>().ToList();

        Assert.Equal("Persona", persona.Header);
        Assert.Equal([("Nova", false), ("Orion (pinned)", true), ("Clear pin", false)], choices.Select((item) => ((string)item.Header!, item.IsChecked)));

        hub.ActReplies.Enqueue(null);
        choices[0].RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(["act {\"type\":\"persona\",\"sessionId\":\"s7\",\"personaId\":\"nova\"}"], hub.Calls);
    }

    [AvaloniaFact]
    public void MenuItem_Clicked_PostsItsActionOrOpensTheTicket()
    {
        var (window, model) = Open();
        var menu = window.MenuOf(Fixtures.Row("item:7"));

        hub.ActReplies.Enqueue(null);
        ((MenuItem)menu[0]).RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        actions.UrlReply = "The browser did not open it.";
        ((MenuItem)menu[12]).RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        ((MenuItem)menu[13]).RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(["act {\"type\":\"mark-done\",\"workItemId\":7}"], hub.Calls);
        Assert.Equal("The browser did not open it.", model.Status);
        Assert.Equal(["https://github.com/o/r/issues/107", "https://github.com/o/r/pull/19002"], actions.Urls);

        actions.RunReply = "Open a VS Code window first; this runs in VS Code.";
        ((MenuItem)menu[7]).RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();
        ((MenuItem)menu[8]).RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        // Open in terminal leaves the item window or terminal app to the switcher (PRD R28).
        Assert.Equal(["item:7"], actions.InTerminal.Select((row) => row.Key));
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

        Assert.IsType<Separator>(menu[11]);
        Assert.Equal(["Open PR #19002", "Open gh 20087"], menu.Skip(12).Select((item) => ((MenuItem)item).Header));
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
    public void StartWithGuidance_Clicked_AsksForTextAndPostsItOnlyAfterStart()
    {
        var (window, _) = Open();
        var row = Fixtures.Row("item:9");
        var menu = window.MenuOf(row);
        var guided = (MenuItem)menu[1];
        Window Dialog() => Assert.Single(window.OwnedWindows);
        Button DialogButton(string name) => Dialog().GetVisualDescendants().OfType<Button>().Single((button) => button.Name == name);
        TextBox Text() => Dialog().GetVisualDescendants().OfType<TextBox>().Single((box) => box.Name == "InputText");

        Assert.Equal(["Start", "Start with guidance…"], menu.Take(2).Select((item) => ((MenuItem)item).Header));

        guided.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(["Start with guidance", "Playbook", "dev:develop", "Switchboard adds your guidance to the end of the session's prompt."], VisibleTexts(Dialog()).Take(4));
        Assert.False(DialogButton("InputAction").IsEnabled);
        Assert.Equal((90, 300), (Text().MinHeight, Text().MaxHeight));

        Text().Text = "   ";
        Assert.False(DialogButton("InputAction").IsEnabled);
        Text().Text = "Check the 2024 thread.";
        DialogButton("InputCancel").RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        Assert.Empty(window.OwnedWindows);
        Assert.Empty(hub.Calls);

        hub.ActReplies.Enqueue(null);
        guided.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();
        Text().Text = "  Check the 2024 thread.\nKeep it short.  ";
        Assert.True(DialogButton("InputAction").IsEnabled);
        DialogButton("InputAction").RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(["act {\"type\":\"start\",\"workItemId\":9,\"guidance\":\"Check the 2024 thread.\\nKeep it short.\"}"], hub.Calls);
        Assert.Equal("{\"type\":\"start\",\"workItemId\":9}", row.Controls[1].Action.ToJsonString());
    }

    [AvaloniaFact]
    public void StartWithPrompt_Clicked_ShowsThePromptAndPostsTheEditedText()
    {
        var (window, _) = Open();
        var start = new JsonObject { ["type"] = "start", ["workItemId"] = 9 };
        var input = new DockInput("Start with prompt", "The session runs this prompt.", "prompt", "Start", Text: "Write hello.txt");
        var row = Fixtures.Row("item:9") with { Controls = [new DockControl("Start with prompt…", start, Input: input)] };
        var prompted = (MenuItem)window.MenuOf(row)[0];
        Window Dialog() => Assert.Single(window.OwnedWindows);
        Button Go() => Dialog().GetVisualDescendants().OfType<Button>().Single((button) => button.Name == "InputAction");
        TextBox Text() => Dialog().GetVisualDescendants().OfType<TextBox>().Single((box) => box.Name == "InputText");

        hub.ActReplies.Enqueue(null);
        prompted.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(630, Dialog().Width);
        Assert.Equal((150, 400), (Text().MinHeight, Text().MaxHeight));
        Assert.Equal("Write hello.txt", Text().Text);
        Assert.True(Go().IsEnabled);
        Text().Text = " ";
        Assert.False(Go().IsEnabled);
        Text().Text = "Write hello.txt\nthen report done ";
        Go().RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(["act {\"type\":\"start\",\"workItemId\":9,\"prompt\":\"Write hello.txt\\nthen report done\"}"], hub.Calls);
    }

    [AvaloniaFact]
    public void StartWithGuidance_PlaybookChosen_EnablesStartWithoutTextAndPostsThePlaybook()
    {
        var (window, _) = Open();
        var guided = (MenuItem)window.MenuOf(Fixtures.Row("item:9"))[1];
        Window Dialog() => Assert.Single(window.OwnedWindows);
        Button Go() => Dialog().GetVisualDescendants().OfType<Button>().Single((button) => button.Name == "InputAction");
        ComboBox Choice() => Dialog().GetVisualDescendants().OfType<ComboBox>().Single((box) => box.Name == "InputChoice");

        hub.ActReplies.Enqueue(null);
        guided.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(["dev:develop", "dev:other"], Choice().Items.Cast<string>());
        Assert.Equal("dev:develop", Choice().SelectedItem);
        Choice().SelectedItem = "dev:other";
        Assert.True(Go().IsEnabled);
        Choice().SelectedItem = "dev:develop";
        Assert.False(Go().IsEnabled);
        Choice().SelectedItem = "dev:other";
        Go().RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(["act {\"type\":\"start\",\"workItemId\":9,\"guidance\":\"\",\"playbook\":\"dev:other\"}"], hub.Calls);
    }

    [AvaloniaFact]
    public void Snooze_Clicked_AsksInADialogAndPostsTheChoiceAndTrimmedComment()
    {
        var (window, _) = Open();
        var snooze = (MenuItem)window.MenuOf(Fixtures.Row("item:7"))[1];
        Window Dialog() => Assert.Single(window.OwnedWindows);
        T Named<T>(string name) where T : Control => Dialog().GetVisualDescendants().OfType<T>().Single((control) => control.Name == name);
        void Press(string name) => Named<Button>(name).RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));

        snooze.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        Assert.Equal("Snooze Issue <7>", VisibleTexts(Dialog())[0]);
        Assert.Equal(Fixtures.View.Snooze.Select((choice) => choice.Description == "" ? choice.Label : $"{choice.Label} · {choice.Description}"), Dialog().GetVisualDescendants().OfType<RadioButton>().Where((radio) => radio.Name!.StartsWith("SnoozeChoice", StringComparison.Ordinal)).Select((radio) => radio.Content));
        Assert.True(Named<RadioButton>("SnoozeChoice0").IsChecked);
        Assert.True(Named<Button>("SnoozeAction").IsEnabled);
        Press("SnoozeCancel");
        Dispatcher.UIThread.RunJobs();

        Assert.Empty(window.OwnedWindows);
        Assert.Empty(hub.Calls);

        hub.ActReplies.Enqueue(null);
        hub.ActReplies.Enqueue(null);
        snooze.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();
        Named<RadioButton>($"SnoozeChoice{Fixtures.View.Snooze.Count - 1}").IsChecked = true;
        Named<TextBox>("SnoozeComment").Text = "  Waiting for the release.\nThen retry.  ";
        Press("SnoozeAction");
        Dispatcher.UIThread.RunJobs();
        snooze.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();
        Named<TextBox>("SnoozeComment").Text = "   ";
        Press("SnoozeAction");
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(
            [
                "act {\"type\":\"snooze\",\"ticketId\":7,\"until\":null,\"comment\":\"Waiting for the release.\\nThen retry.\"}",
                "act {\"type\":\"snooze\",\"ticketId\":7,\"until\":1791093600000}",
            ],
            hub.Calls);
    }

    [AvaloniaFact]
    public void Snooze_DateChosen_WakesThatDayAtTheChoicesTimeAndNeedsADateFromTomorrow()
    {
        var (window, _) = Open();
        var snooze = (MenuItem)window.MenuOf(Fixtures.Row("item:7"))[1];
        Window Dialog() => Assert.Single(window.OwnedWindows);
        T Named<T>(string name) where T : Control => Dialog().GetVisualDescendants().OfType<T>().Single((control) => control.Name == name);
        var first = SnoozeDialog.FirstDay(Fixtures.View.Snooze)!.Value;

        snooze.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(first, Named<CalendarDatePicker>("SnoozeDate").DisplayDateStart);
        Named<RadioButton>("SnoozeOnDate").IsChecked = true;
        Assert.False(Named<Button>("SnoozeAction").IsEnabled);
        Named<CalendarDatePicker>("SnoozeDate").SelectedDate = first.AddDays(-1);
        Assert.False(Named<Button>("SnoozeAction").IsEnabled);

        Named<RadioButton>("SnoozeChoice0").IsChecked = true;
        Named<CalendarDatePicker>("SnoozeDate").GetVisualDescendants().OfType<TextBox>().Single().Focus();
        Dispatcher.UIThread.RunJobs();
        Assert.True(Named<RadioButton>("SnoozeOnDate").IsChecked);
        Named<RadioButton>("SnoozeChoice0").IsChecked = true;
        Named<CalendarDatePicker>("SnoozeDate").SelectedDate = first.AddDays(10);
        Assert.True(Named<RadioButton>("SnoozeOnDate").IsChecked);
        Assert.True(Named<Button>("SnoozeAction").IsEnabled);

        hub.ActReplies.Enqueue(null);
        Named<Button>("SnoozeAction").RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        var until = SnoozeDialog.OnDate(first.AddDays(10), Fixtures.View.Snooze);
        var wake = DateTimeOffset.FromUnixTimeMilliseconds(until).LocalDateTime;

        Assert.Equal([$"act {{\"type\":\"snooze\",\"ticketId\":7,\"until\":{until}}}"], hub.Calls);
        Assert.Equal(first.AddDays(10), wake.Date);
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(Fixtures.View.Snooze[0].Until!.Value).LocalDateTime.TimeOfDay, wake.TimeOfDay);
    }

    [AvaloniaFact]
    public void Snooze_NoTimedChoice_OffersNoDate()
    {
        Assert.Null(SnoozeDialog.FirstDay([new SnoozeChoice("Indefinitely", "", null)]));
    }

    [AvaloniaFact]
    public void AddComment_Clicked_AsksForTextAndPostsItAsTheCommentText()
    {
        var (window, _) = Open();
        var add = (MenuItem)window.MenuOf(Fixtures.Row("item:7"))[2];
        Window Dialog() => Assert.Single(window.OwnedWindows);

        hub.ActReplies.Enqueue(null);
        add.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();
        Assert.Equal("Add comment", VisibleTexts(Dialog())[0]);
        Dialog().GetVisualDescendants().OfType<TextBox>().Single((box) => box.Name == "InputText").Text = " Waiting on Dana. ";
        Dialog().GetVisualDescendants().OfType<Button>().Single((button) => button.Name == "InputAction").RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(["act {\"type\":\"comment\",\"workItemId\":7,\"text\":\"Waiting on Dana.\"}"], hub.Calls);
    }

    [AvaloniaFact]
    public void Show_RowWithComments_ShowsTheCommentIconOnLineTwoWithTheCommentsAsItsTooltip()
    {
        var commented = Fixtures.Row("item:7") with { Comment = new RowComment("\uea6b", "Oct 3, 9:00 AM\nWaiting on Dana.") };
        var (window, model) = Open();

        model.Show(Fixtures.View with { Groups = [new DockGroup("review", "Ready for review", null, [commented, Fixtures.Row("item:10")])] });
        Dispatcher.UIThread.RunJobs();
        TextBlock IconOf(string key) => window.GetVisualDescendants().OfType<TextBlock>().Single((text) => text.Name == "CommentIcon" && text.DataContext is RowViewModel row && row.Key == key);

        Assert.True(IconOf("item:7").IsVisible);
        Assert.Equal("\uea6b", IconOf("item:7").Text);
        Assert.Equal("Oct 3, 9:00 AM\nWaiting on Dana.", ToolTip.GetTip(IconOf("item:7")));
        Assert.False(IconOf("item:10").IsVisible);
    }

    [AvaloniaFact]
    public void Show_RowWithUnreadItems_ShowsTheCountAfterTheTitleAndNoneWithoutThem()
    {
        var (window, model) = Open();

        model.Show(Fixtures.View with { Groups = [new DockGroup("progress", "In progress", null, [Fixtures.Row("item:15"), Fixtures.Row("item:8"), Fixtures.Row("item:13") with { Unread = 1 }])] });
        Dispatcher.UIThread.RunJobs();
        Border BadgeOf(string key) => window.GetVisualDescendants().OfType<Border>().Single((border) => border.Name == "UnreadBadge" && border.DataContext is RowViewModel row && row.Key == key);

        Assert.True(BadgeOf("item:15").IsVisible);
        Assert.Equal("2", BadgeOf("item:15").GetVisualDescendants().OfType<TextBlock>().Single().Text);
        Assert.Equal("2 unread replies and statuses in its Conversation view", ToolTip.GetTip(BadgeOf("item:15")));
        Assert.Equal("1 unread reply or status in its Conversation view", ToolTip.GetTip(BadgeOf("item:13")));
        Assert.False(BadgeOf("item:8").IsVisible);

        // The count goes once the window's view showed them.
        model.Show(Fixtures.View with { Groups = [new DockGroup("progress", "In progress", null, [Fixtures.Row("item:15") with { Unread = 0 }])] });
        Dispatcher.UIThread.RunJobs();
        Assert.False(BadgeOf("item:15").IsVisible);
    }

    [AvaloniaFact]
    public void Show_RowTheVoiceSpeaksFor_ShowsTheMicMarkWithItsTooltipAndNoneOnOtherRows()
    {
        var (window, model) = Open();

        model.Show(Fixtures.View with { Groups = [new DockGroup("progress", "In progress", null, [Fixtures.Row("item:15") with { Voice = new RowVoice("\uec12", "The voice speaks for this session.") }, Fixtures.Row("item:8")])] });
        Dispatcher.UIThread.RunJobs();
        TextBlock MarkOf(string key) => window.GetVisualDescendants().OfType<TextBlock>().Single((text) => text.Name == "VoiceMark" && text.DataContext is RowViewModel row && row.Key == key);

        Assert.True(MarkOf("item:15").IsVisible);
        Assert.Equal("\uec12", MarkOf("item:15").Text);
        Assert.Equal("The voice speaks for this session.", ToolTip.GetTip(MarkOf("item:15")));
        Assert.False(MarkOf("item:8").IsVisible);
    }

    [AvaloniaFact]
    public void Show_NarrowDockWithALongPlaybook_KeepsTheCommentIconInView()
    {
        var (window, model) = Open(new DockSettings { Width = 200 });
        var row = Fixtures.Row("item:7") with
        {
            Playbook = "dev:review-pr-followup",
            Comment = new RowComment("\uea6b", "Waiting on Dana."),
        };

        model.Show(Fixtures.View with { Groups = [new DockGroup("review", "Ready for review", null, [row])] });
        Dispatcher.UIThread.RunJobs();

        var border = window.GetVisualDescendants().OfType<Border>().Single((candidate) => candidate.Classes.Contains("row"));
        var icon = border.GetVisualDescendants().OfType<TextBlock>().Single((text) => text.Name == "CommentIcon");
        Rect InRow(Control control) => new(control.TranslatePoint(new Point(0, 0), border)!.Value, control.Bounds.Size);

        Assert.True(icon.Bounds.Width > 0);
        Assert.True(InRow(icon).Right <= border.Bounds.Width);
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
        var (window, model) = Open();

        model.Show(Fixtures.View with { HeldNote = null });
        Dispatcher.UIThread.RunJobs();
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
    public void OpenDone_RecordedView_ShowsTodayOpenAndTwoWeeksAgoClosedUntilTapped()
    {
        var settings = new DockSettings { Groups = { ["done"] = true } };
        var (window, model) = Open(settings);

        // Tall enough that the Two weeks ago band is on screen to tap.
        window.Height = 1400;
        Dispatcher.UIThread.RunJobs();

        var bands = window.GetVisualDescendants().OfType<Border>().Where((border) => border.Classes.Contains("band") && border.IsEffectivelyVisible).ToList();

        Assert.Equal(["Today", "Two weeks ago"], bands.Select((band) => ((BandViewModel)band.DataContext!).Title));
        Assert.Contains("Issue <11>", VisibleTexts(window));
        Assert.DoesNotContain("Issue <12>", VisibleTexts(window));

        Tap(window, bands[1]);

        Assert.Contains("Issue <12>", VisibleTexts(window));

        model.Show(Fixtures.View);
        Dispatcher.UIThread.RunJobs();

        Assert.Contains("Issue <12>", VisibleTexts(window));
        Assert.Empty(saved);
        Assert.DoesNotContain("done:Two weeks ago", settings.Groups.Keys);
    }

    [AvaloniaFact]
    public void OpenDone_QuickClicksOnBand_TogglesOnEveryClick()
    {
        var (window, shown) = Open(new DockSettings { Groups = { ["done"] = true } });

        shown.Show(Fixtures.View with { HeldNote = null });
        Dispatcher.UIThread.RunJobs();
        var band = window.GetVisualDescendants().OfType<Border>().First((border) => border.Classes.Contains("band") && border.IsEffectivelyVisible);
        var model = (BandViewModel)band.DataContext!;
        var seen = new List<bool>();

        for (var click = 0; click < 4; click++)
        {
            if (click == 3)
            {
                // A second press that moves past the tap distance and back raises DoubleTapped and then Tapped.
                var point = band.TranslatePoint(new Point(20, 8), window)!.Value;

                window.MouseDown(point, MouseButton.Left);
                window.MouseMove(point + new Vector(8, 0), RawInputModifiers.LeftMouseButton);
                window.MouseMove(point, RawInputModifiers.LeftMouseButton);
                window.MouseUp(point, MouseButton.Left);
                Dispatcher.UIThread.RunJobs();
            }
            else
            {
                Tap(window, band);
            }

            seen.Add(model.IsOpen);
        }

        Assert.Equal([false, true, false, true], seen);
    }

    [AvaloniaFact]
    public void OpenDone_NewRun_StartsTwoWeeksAgoClosedAfterTheLastRunOpenedIt()
    {
        var settings = new DockSettings { Groups = { ["done"] = true } };
        var (first, _) = Open(settings);

        first.Height = 1400;
        Dispatcher.UIThread.RunJobs();
        Tap(first, first.GetVisualDescendants().OfType<Border>().Single((border) => border.DataContext is BandViewModel { Title: "Two weeks ago" } && border.Classes.Contains("band")));
        first.Close();

        var (second, _) = Open(settings);

        second.Height = 1400;
        Dispatcher.UIThread.RunJobs();

        Assert.Contains("Issue <11>", VisibleTexts(second));
        Assert.DoesNotContain("Issue <12>", VisibleTexts(second));
    }

    [AvaloniaFact]
    public void OpenDone_RecordedView_DrawsBandsAsMutedLabelAndRuleWithoutStripe()
    {
        var (window, _) = Open(new DockSettings { Groups = { ["done"] = true } });
        var band = window.GetVisualDescendants().OfType<Border>().First((border) => border.Classes.Contains("band") && border.IsEffectivelyVisible);
        var title = band.GetVisualDescendants().OfType<TextBlock>().Single((text) => text.Text == "Today");
        var rule = band.GetVisualDescendants().OfType<Border>().Single((border) => border.Classes.Contains("band-rule"));

        Assert.Equal(default, band.BorderThickness);
        Assert.Equal(Colors.Transparent, Assert.IsAssignableFrom<ISolidColorBrush>(band.Background).Color);
        Assert.Equal(window.FindResource(window.ActualThemeVariant, "DockMuted"), title.Foreground);
        Assert.True(rule.IsEffectivelyVisible);
        Assert.Equal(1, rule.Bounds.Height);
        Assert.True(rule.Bounds.Width > band.Bounds.Width / 2);
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

        Assert.Equal(["github", "zoho", "Search", "Auto-hide", "More Actions", "Close the dock"], names);
    }

    [AvaloniaFact]
    public void AutoHideButton_Click_TurnsAutoHideOnAndOffAndKeepsIt()
    {
        var (window, model) = Open();
        var button = window.FindControl<Button>("AutoHideButton")!;
        string Glyph() => ((TextBlock)button.Presenter!.Child!).Text!;

        Assert.Equal("\uEBA0", Glyph());
        Assert.Equal("Auto-hide the dock", ToolTip.GetTip(button));

        Tap(window, button);

        Assert.True(model.Settings.AutoHide);
        Assert.Single(saved);
        Assert.Equal("\uEB2B", Glyph());
        Assert.Equal("Keep the dock open", ToolTip.GetTip(button));

        Tap(window, button);

        Assert.False(model.Settings.AutoHide);
        Assert.Equal(2, saved.Count);
        Assert.Equal("\uEBA0", Glyph());
    }

    [AvaloniaFact]
    public void SliverBars_RowsWithStripes_GiveTheirStripeAtTheRowsHeightInItsColour()
    {
        var (window, _) = Open();
        var striped = window.GetVisualDescendants().OfType<Border>()
            .Where((border) => border.Classes.Contains("row") && border.IsEffectivelyVisible && border.DataContext is RowViewModel row && (row.StripeWarning || row.StripeError || row.StripeTurn))
            .ToList();
        var bars = window.SliverBars();
        string Tone(RowViewModel row) => row.StripeError ? "DockError" : row.StripeWarning ? "DockWarning" : "DockTurn";

        Assert.NotEmpty(striped);
        Assert.Equal(striped.Count, bars.Count);

        foreach (var (row, bar) in striped.Zip(bars))
        {
            var stripe = row.GetVisualDescendants().OfType<Border>().First((border) => border.Classes.Contains("stripe"));

            Assert.Equal(stripe.TranslatePoint(default, window)!.Value.Y, bar.Top, 3);
            Assert.Equal(stripe.Bounds.Height, bar.Height, 3);
            Assert.True(bar.Height < row.Bounds.Height);
            Assert.Equal(Resource(window, Tone((RowViewModel)row.DataContext!)), ((ISolidColorBrush)bar.Brush).Color);
        }
    }

    [AvaloniaFact]
    public void SliverBars_RowsBelowTheView_AreLeftOut()
    {
        var (window, _) = Open();
        var all = window.SliverBars().Count;

        window.Height = window.SliverBars()[0].Top + 20;
        Dispatcher.UIThread.RunJobs();

        var bars = window.SliverBars();

        Assert.True(all > 1);
        Assert.Single(bars);
        Assert.True(bars[0].Top + bars[0].Height <= window.Height + 0.001);
    }

    [AvaloniaFact]
    public void SliverBars_RowScrolledPartlyAboveTheView_IsCutAtTheViewTop()
    {
        var (window, _) = Open();
        var scroller = window.FindControl<ScrollViewer>("RowScroller")!;
        var first = window.SliverBars()[0];
        var viewTop = scroller.TranslatePoint(default, window)!.Value.Y;

        window.Height = 300;
        Dispatcher.UIThread.RunJobs();
        scroller.Offset = new Vector(0, first.Top - viewTop + 10);
        Dispatcher.UIThread.RunJobs();

        var cut = window.SliverBars()[0];

        Assert.Equal(viewTop, cut.Top, 3);
        Assert.Equal(first.Height - 10, cut.Height, 3);
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
    public void Tooltip_PointerMoved_OpensAtThePointerAwayFromTheEdgeAndAdjustsOnlyVertically()
    {
        var (window, _) = Open();
        var close = window.FindControl<Button>("CloseButton")!;

        var text = new TextBlock { Text = "Close the dock" };
        ToolTip.SetTip(close, text);

        window.MouseMove(new Point(30, 40));
        ToolTip.SetIsOpen(close, true);
        Dispatcher.UIThread.RunJobs();
        var at = text.GetVisualAncestors().OfType<ToolTip>().Single().TranslatePoint(default, window);
        var placement = Placement(close);
        ToolTip.GetCustomPopupPlacementCallback(close)!(placement);

        Assert.Equal(PlacementMode.Custom, ToolTip.GetPlacement(close));
        // Below the pointer by the tooltip's default VerticalOffset of 20.
        Assert.Equal(new Point(30, 60), at);
        Assert.Equal(new Rect(30, 40, 1, 1), placement.AnchorRectangle);
        Assert.Equal(Avalonia.Controls.Primitives.PopupPositioning.PopupGravity.BottomRight, placement.Gravity);
        Assert.Equal(Avalonia.Controls.Primitives.PopupPositioning.PopupPositionerConstraintAdjustment.FlipY | Avalonia.Controls.Primitives.PopupPositioning.PopupPositionerConstraintAdjustment.SlideY, placement.ConstraintAdjustment);
    }

    [AvaloniaFact]
    public void PlaceTip_DockOnRight_ExtendsLeftOfThePointer()
    {
        var target = new Button();
        var placement = Placement(target);

        MainWindow.PlaceTip(placement, dockOnRight: true, new Point(30, 40));

        Assert.Equal(Avalonia.Controls.Primitives.PopupPositioning.PopupAnchor.TopLeft, placement.Anchor);
        Assert.Equal(Avalonia.Controls.Primitives.PopupPositioning.PopupGravity.BottomLeft, placement.Gravity);
    }

    // Avalonia builds the placement only while positioning a popup, with the popup's default adjustments.
    static Avalonia.Controls.Primitives.PopupPositioning.CustomPopupPlacement Placement(Visual target)
    {
        var placement = (Avalonia.Controls.Primitives.PopupPositioning.CustomPopupPlacement)Activator.CreateInstance(
            typeof(Avalonia.Controls.Primitives.PopupPositioning.CustomPopupPlacement),
            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance, null, [new Size(200, 30), default(Thickness), target], null)!;
        placement.ConstraintAdjustment = Avalonia.Controls.Primitives.PopupPositioning.PopupPositionerConstraintAdjustment.All;
        return placement;
    }

    [AvaloniaFact]
    public void TapPill_KeyAndPullRequest_OpenTheirLinksWithoutTheRowClick()
    {
        var (window, _) = Open();
        var pills = RowNamed(window, "Issue <7>").GetVisualDescendants().OfType<Border>().Where((border) => border.Classes.Contains("pill") && border.IsEffectivelyVisible).ToList();

        Assert.Equal(["gh 107", "19002", "gh 20087", "2"], pills.Select((pill) => pill.GetVisualDescendants().OfType<TextBlock>().Last().Text));
        Assert.Contains("pr", pills[1].Classes);
        Assert.Equal("\uEAE2", pills[3].GetVisualDescendants().OfType<TextBlock>().First().Text);
        Assert.StartsWith("Returned:", Assert.IsType<string>(ToolTip.GetTip(pills[3])));

        Tap(window, pills[0]);
        Tap(window, pills[1]);
        Tap(window, pills[3]);

        Assert.Equal(["https://github.com/o/r/issues/107", "https://github.com/o/r/pull/19002"], actions.Urls);
        Assert.Empty(actions.Clicked);
    }

    [AvaloniaFact]
    public void LinkPill_Mentioned_IsGreyWithItsTooltipWhileTheWorkLinkKeepsItsColour()
    {
        var (window, _) = Open(new DockSettings { Edge = "right", Width = 480 });
        var pills = RowNamed(window, "Issue <7>").GetVisualDescendants().OfType<Border>().Where((border) => border.Classes.Contains("pill") && border.IsEffectivelyVisible).ToList();
        var muted = window.FindResource(window.ActualThemeVariant, "DockMuted");
        var mentioned = pills[2];

        Assert.Equal(muted, mentioned.BorderBrush);
        Assert.Equal(window.FindResource(window.ActualThemeVariant, "DockPillFill"), mentioned.Background);
        Assert.Equal(muted, mentioned.GetVisualDescendants().OfType<TextBlock>().Last().Foreground);
        Assert.Equal("Named in the ticket: https://github.com/o/r/issues/20087", ToolTip.GetTip(mentioned));
        Assert.Equal(window.FindResource(window.ActualThemeVariant, "DockPullRequest"), pills[1].BorderBrush);
        Assert.Equal("https://github.com/o/r/pull/19002", ToolTip.GetTip(pills[1]));

        Tap(window, mentioned);

        Assert.Equal(["https://github.com/o/r/issues/20087"], actions.Urls);
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
