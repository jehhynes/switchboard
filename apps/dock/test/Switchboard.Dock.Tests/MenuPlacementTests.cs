using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Avalonia.VisualTree;
using Switchboard.Dock.Views;

namespace Switchboard.Dock.Tests;

public sealed class MenuPlacementTests
{
    // A phone-sized monitor, as over Remote Desktop from a phone: the dock's strip, 280 pixels, at one edge and a 40-pixel taskbar at the bottom.
    static readonly PixelRect Monitor = new(0, 0, 400, 780);

    static MenuScreen Phone(bool dockOnRight) => new(Monitor, dockOnRight ? new PixelRect(0, 0, 120, 740) : new PixelRect(280, 0, 120, 740));

    static PixelRect Dock(bool dockOnRight) => dockOnRight ? new PixelRect(120, 0, 280, 740) : new PixelRect(0, 0, 280, 740);

    [Fact]
    public void Area_DockOnEitherSide_TakesTheWorkAreaWidenedToTheMonitorEdgeOnTheDockSide()
    {
        Assert.Equal(new PixelRect(0, 0, 400, 740), MenuPlacement.Area(Phone(dockOnRight: true), dockOnRight: true));
        Assert.Equal(new PixelRect(0, 0, 400, 740), MenuPlacement.Area(Phone(dockOnRight: false), dockOnRight: false));
        // A taskbar on the far side stays out.
        Assert.Equal(new PixelRect(0, 0, 360, 740), MenuPlacement.Area(new MenuScreen(Monitor, new PixelRect(0, 0, 360, 740)), dockOnRight: false));
    }

    [Fact]
    public void Area_NoWorkArea_TakesTheMonitor()
    {
        Assert.Equal(Monitor, MenuPlacement.Area(new MenuScreen(Monitor, default), dockOnRight: true));
    }

    [Theory]
    [InlineData(true, 300)]
    [InlineData(false, 100)]
    public void Fit_RoomAwayFromTheDock_OpensThereDownwardFromThePointer(bool towardRight, int x)
    {
        Assert.Equal(new PixelPoint(x, 100), MenuPlacement.Fit(new Rect(300, 100, 0, 0), new Size(200, 300), towardRight, 0, new PixelRect(0, 0, 1000, 700)));
    }

    [Fact]
    public void Fit_NoRoomAwayFromTheDock_OpensTowardTheDock()
    {
        Assert.Equal(new PixelPoint(300, 100), MenuPlacement.Fit(new Rect(300, 100, 0, 0), new Size(200, 300), towardRight: false, 0, new PixelRect(250, 0, 400, 700)));
    }

    [Fact]
    public void Fit_NoRoomOnEitherSide_MovesInsideTheArea()
    {
        Assert.Equal(new PixelPoint(0, 100), MenuPlacement.Fit(new Rect(150, 100, 0, 0), new Size(300, 300), towardRight: false, 0, new PixelRect(0, 0, 400, 700)));
        Assert.Equal(new PixelPoint(100, 100), MenuPlacement.Fit(new Rect(250, 100, 0, 0), new Size(300, 300), towardRight: true, 0, new PixelRect(0, 0, 400, 700)));
    }

    [Fact]
    public void Fit_NoRoomBelow_OpensUpwardFromThePointer()
    {
        Assert.Equal(new PixelPoint(300, 300), MenuPlacement.Fit(new Rect(300, 600, 0, 0), new Size(200, 300), towardRight: true, 0, new PixelRect(0, 0, 1000, 700)));
    }

    [Fact]
    public void Fit_NoRoomAboveOrBelow_MovesInsideTheArea()
    {
        Assert.Equal(new PixelPoint(300, 200), MenuPlacement.Fit(new Rect(300, 250, 0, 0), new Size(200, 500), towardRight: true, 0, new PixelRect(0, 0, 1000, 700)));
        Assert.Equal(new PixelPoint(300, 0), MenuPlacement.Fit(new Rect(300, 250, 0, 0), new Size(200, 700), towardRight: true, 0, new PixelRect(0, 0, 1000, 700)));
    }

    [Fact]
    public void Fit_Submenu_OverlapsItsItemOnTheSideItOpens()
    {
        var item = new Rect(500, 100, 200, 30);

        Assert.Equal(new PixelPoint(696, 100), MenuPlacement.Fit(item, new Size(150, 200), towardRight: true, 4, new PixelRect(0, 0, 1000, 700)));
        Assert.Equal(new PixelPoint(354, 100), MenuPlacement.Fit(item, new Size(150, 200), towardRight: false, 4, new PixelRect(0, 0, 1000, 700)));
        // No room to the right: it opens to the left of its item instead; with no room below or above, it moves up into the area.
        Assert.Equal(new PixelPoint(354, 50), MenuPlacement.Fit(item, new Size(150, 200), towardRight: true, 4, new PixelRect(0, 0, 800, 250)));
    }

    /// <summary>
    /// A dock on the phone-sized monitor at either edge, with popups as windows of their own, as on Windows and X11, and the monitor given to its
    /// menus. The headless platform's own screen is 1920 by 1280.
    /// </summary>
    static MainWindow OpenOnPhone(bool dockOnRight)
    {
        var model = new DockViewModel(new DockSettings { Edge = dockOnRight ? "right" : "left", Width = 280 }, (_) => { });
        var dock = Dock(dockOnRight);
        var window = new MainWindow(model, null, new FakeHub(), new FakeActions(), docked: false)
        {
            Position = dock.Position,
            Width = dock.Width,
            Height = dock.Height,
            MenuScreenAt = (_, _) => Phone(dockOnRight),
        };

        model.Show(Fixtures.View);
        window.Show();
        Dispatcher.UIThread.RunJobs();

        return window;
    }

    /// <summary>Runs <paramref name="test"/> with popups as windows of their own.</summary>
    static void WithPopupWindows(Action test)
    {
        TestApp.Options.OverlayPopups = false;

        try
        {
            test();
        }
        finally
        {
            TestApp.Options.OverlayPopups = true;
        }
    }

    /// <summary>The popup window that shows <paramref name="content"/>, and its rectangle on the screen.</summary>
    static PixelRect OnScreen(Control content)
    {
        var root = Assert.IsType<PopupRoot>(TopLevel.GetTopLevel(content));

        return new PixelRect(root.PointToScreen(default), PixelSize.FromSize(root.ClientSize, 1));
    }

    static bool Inside(PixelRect outer, PixelRect inner) => inner.X >= outer.X && inner.Y >= outer.Y && inner.Right <= outer.Right && inner.Bottom <= outer.Bottom;

    static List<Control> Items(int count, string prefix, string label = " with a long enough label") => Enumerable.Range(1, count).Select((index) => (Control)new MenuItem { Header = $"{prefix} {index}{label}" }).ToList();

    [AvaloniaTheory]
    [InlineData(false)]
    [InlineData(true)]
    public void RowMenu_PhoneSizedScreen_FitsTheMenuAndSubmenuOnTheScreenAndScrollsTheRest(bool dockOnRight) => WithPopupWindows(() =>
    {
        var window = OpenOnPhone(dockOnRight);
        var submenu = new MenuItem { Header = "Persona", ItemsSource = Items(30, "Persona") };
        var items = Items(30, "Action");
        var area = new PixelRect(0, 0, 400, 740);

        items.Insert(3, submenu);
        // The pointer on a row near the bottom of the dock.
        var menu = MainWindow.RowMenu(items, dockOnRight, new Point(140, 600), window.MenuScreenAt);

        menu.Open(window);
        Dispatcher.UIThread.RunJobs();

        var rect = OnScreen(menu);

        Assert.True(Inside(area, rect), $"The menu at {rect} leaves {area}.");
        Assert.Equal(740, rect.Height);
        var scroller = menu.GetVisualDescendants().OfType<ScrollViewer>().First();
        Assert.True(scroller.Extent.Height > scroller.Viewport.Height, "The menu taller than the screen does not scroll.");

        submenu.IsSubMenuOpen = true;
        Dispatcher.UIThread.RunJobs();

        var popup = submenu.GetVisualDescendants().OfType<Popup>().Single((each) => each.Name == "PART_Popup");
        var inner = OnScreen(popup.Child!);

        Assert.True(Inside(area, inner), $"The submenu at {inner} leaves {area}.");
        Assert.Equal(740, inner.Height);
        menu.Close();
    });

    [AvaloniaTheory]
    [InlineData(false)]
    [InlineData(true)]
    public void RowMenu_RoomOnTheScreen_OpensAtThePointerAwayFromTheDockAndItsSubmenuBesideIt(bool dockOnRight) => WithPopupWindows(() =>
    {
        var window = OpenOnPhone(dockOnRight);
        var submenu = new MenuItem { Header = "Persona", ItemsSource = Items(2, "P", "") };
        var menu = MainWindow.RowMenu([submenu, .. Items(2, "A", "")], dockOnRight, new Point(140, 100), (_, _) => new MenuScreen(new PixelRect(0, 0, 2000, 1000), new PixelRect(0, 0, 2000, 1000)));

        menu.Open(window);
        Dispatcher.UIThread.RunJobs();
        submenu.IsSubMenuOpen = true;
        Dispatcher.UIThread.RunJobs();

        var pointer = window.PointToScreen(new Point(140, 100));
        var rect = OnScreen(menu);
        var item = new PixelRect(submenu.PointToScreen(default), PixelSize.FromSize(submenu.Bounds.Size, 1));
        var inner = OnScreen(submenu.GetVisualDescendants().OfType<Popup>().Single((each) => each.Name == "PART_Popup").Child!);

        Assert.Equal(pointer.Y, rect.Y);
        Assert.Equal(pointer.X, dockOnRight ? rect.Right : rect.X);
        Assert.Equal(item.Y, inner.Y);
        // The submenu overlaps its item by the theme's 4 pixels, on the side away from the dock.
        Assert.Equal(dockOnRight ? item.X + 4 : item.Right - 4, dockOnRight ? inner.Right : inner.X);
        menu.Close();
    });

    [AvaloniaFact]
    public void RowMenu_MonitorAtTwiceTheScale_LimitsTheMenuAndSubmenuAtThatScale() => WithPopupWindows(() =>
    {
        var window = OpenOnPhone(dockOnRight: true);
        var submenu = new MenuItem { Header = "Persona", ItemsSource = Items(2, "P", "") };
        var menu = MainWindow.RowMenu([submenu, .. Items(2, "A", "")], dockOnRight: true, new Point(140, 100), (_, _) => Phone(dockOnRight: true) with { Scaling = 2 });

        menu.Open(window);
        Dispatcher.UIThread.RunJobs();
        submenu.IsSubMenuOpen = true;
        Dispatcher.UIThread.RunJobs();

        // The window still has scale 1, as a popup created on another monitor would.
        Assert.Equal(370, ((Popup)menu.Parent!).MaxHeight);
        Assert.Equal(200, ((Popup)menu.Parent!).MaxWidth);
        Assert.Equal(370, submenu.GetVisualDescendants().OfType<Popup>().Single((each) => each.Name == "PART_Popup").MaxHeight);
        menu.Close();
    });

    [AvaloniaFact]
    public void MoreActions_ContextRequestAfterClose_OpensANewMenuBelowTheButtonOnTheScreen() => WithPopupWindows(() =>
    {
        var window = OpenOnPhone(dockOnRight: true);
        var more = window.FindControl<Button>("MoreButton")!;

        more.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        Dispatcher.UIThread.RunJobs();
        var first = more.ContextMenu!;
        first.Close();
        Dispatcher.UIThread.RunJobs();

        Assert.Null(more.ContextMenu);

        // A right-click or the context-menu key, which Avalonia would answer by opening a kept menu at the button's bottom with its own placement.
        more.RaiseEvent(new ContextRequestedEventArgs());
        Dispatcher.UIThread.RunJobs();

        var menu = Assert.IsType<ContextMenu>(more.ContextMenu);
        var rect = OnScreen(menu);
        var button = new PixelRect(more.PointToScreen(default), PixelSize.FromSize(more.Bounds.Size, 1));

        Assert.NotSame(first, menu);
        Assert.True(menu.IsOpen);
        Assert.Equal(button.Bottom, rect.Y);
        Assert.True(Inside(new PixelRect(0, 0, 400, 740), rect), $"The menu at {rect} leaves the screen.");
        Assert.Equal(400, ((Popup)menu.Parent!).MaxWidth);
        menu.Close();
    });

    [AvaloniaTheory]
    [InlineData(false)]
    [InlineData(true)]
    public void MoreActions_PhoneSizedScreen_OpensBelowTheButtonOnTheScreen(bool dockOnRight) => WithPopupWindows(() =>
    {
        var window = OpenOnPhone(dockOnRight);
        var more = window.FindControl<Button>("MoreButton")!;

        more.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        var menu = Assert.IsType<ContextMenu>(more.ContextMenu);
        var rect = OnScreen(menu);
        var button = new PixelRect(more.PointToScreen(default), PixelSize.FromSize(more.Bounds.Size, 1));

        Assert.True(Inside(new PixelRect(0, 0, 400, 740), rect), $"The menu at {rect} leaves the screen.");
        Assert.Equal(button.Bottom, rect.Y);
        menu.Close();
    });

    [AvaloniaTheory]
    [InlineData(false)]
    [InlineData(true)]
    public void RowMenu_NoMonitorKnown_OpensAtThePointerAwayFromTheDockWithNoLimit(bool dockOnRight) => WithPopupWindows(() =>
    {
        var window = OpenOnPhone(dockOnRight);
        var submenu = new MenuItem { Header = "Persona", ItemsSource = Items(2, "P", "") };
        var menu = MainWindow.RowMenu([submenu, .. Items(2, "A", "")], dockOnRight, new Point(140, 100), (_, _) => null);

        menu.Open(window);
        Dispatcher.UIThread.RunJobs();
        submenu.IsSubMenuOpen = true;
        Dispatcher.UIThread.RunJobs();

        var pointer = window.PointToScreen(new Point(140, 100));
        var rect = OnScreen(menu);
        var item = new PixelRect(submenu.PointToScreen(default), PixelSize.FromSize(submenu.Bounds.Size, 1));
        var inner = OnScreen(submenu.GetVisualDescendants().OfType<Popup>().Single((each) => each.Name == "PART_Popup").Child!);

        Assert.Equal(pointer.Y, rect.Y);
        Assert.Equal(pointer.X, dockOnRight ? rect.Right : rect.X);
        Assert.True(double.IsPositiveInfinity(((Popup)menu.Parent!).MaxHeight));
        Assert.Equal(item.Y, inner.Y);
        Assert.Equal(dockOnRight ? item.X + 4 : item.Right - 4, dockOnRight ? inner.Right : inner.X);
        menu.Close();
    });
}
