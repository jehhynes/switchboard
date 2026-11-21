using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using Avalonia.Media;
using Avalonia.Threading;
using Avalonia.VisualTree;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Views;

namespace Switchboard.Dock.Tests;

/// <summary>The dock's group headings, pinned at the top of the list while their rows scroll under them.</summary>
public sealed class StickyGroupTests
{
    readonly FakeHub hub = new();
    readonly FakeActions actions = new();

    /// <summary>A dock short enough that the recorded view's groups scroll.</summary>
    (MainWindow Window, DockViewModel Model) Open()
    {
        var model = new DockViewModel(new DockSettings(), (_) => { });
        var window = new MainWindow(model, null, hub, actions, docked: false) { Height = 260 };

        model.Show(Fixtures.View);
        window.Show();
        Dispatcher.UIThread.RunJobs();

        return (window, model);
    }

    static ScrollViewer Scroller(Window window) => window.FindControl<ScrollViewer>("RowScroller")!;

    /// <summary>Each shown group's section, its pinning wrapper and its view model, in list order.</summary>
    static List<(StackPanel Section, Border Pin, GroupViewModel Group)> Groups(Window window) =>
        window.GetVisualDescendants().OfType<Border>().Where((border) => border.Classes.Contains("group-pin") && border.IsEffectivelyVisible)
            .Select((pin) => ((StackPanel)pin.GetVisualParent()!, pin, (GroupViewModel)pin.DataContext!)).ToList();

    /// <summary>Where a control's top is drawn in the list's viewport; `TranslatePoint` includes a render offset.</summary>
    static double DrawnTop(Window window, Visual visual) => visual.TranslatePoint(default, Scroller(window))!.Value.Y;

    static double Offset(Visual visual) => visual.RenderTransform is TranslateTransform offset ? offset.Y : 0;

    /// <summary>The top of a section in the list's content, whatever the scroll.</summary>
    static double ContentTop(Window window, Visual section) => section.TranslatePoint(default, Scroller(window))!.Value.Y + Scroller(window).Offset.Y;

    static void ScrollTo(Window window, double y)
    {
        Scroller(window).Offset = new Vector(0, y);
        Dispatcher.UIThread.RunJobs();
    }

    /// <summary>The first group with more rows than fit under its heading in 30 px, and the group after it.</summary>
    static (int First, int Next) TallGroup(Window window)
    {
        var groups = Groups(window);
        var first = groups.FindIndex((group) => group.Section.Bounds.Height > group.Pin.Bounds.Height + 30);

        Assert.True(first >= 0 && first + 1 < groups.Count, "the recorded view needs a group with rows before another group");

        return (first, first + 1);
    }

    [AvaloniaFact]
    public void Scroll_IntoAGroupsRows_PinsItsHeadingAtTheListTop()
    {
        var (window, _) = Open();
        var (first, _) = TallGroup(window);
        var (section, pin, _) = Groups(window)[first];

        ScrollTo(window, ContentTop(window, section) + 20);

        Assert.Equal(20, Offset(pin), 1);
        Assert.Equal(0, DrawnTop(window, pin), 1);
        // Drawn over the rows that scroll under it, on an opaque background.
        Assert.Equal(1, pin.ZIndex);
        Assert.Equal(255, Assert.IsAssignableFrom<ISolidColorBrush>(pin.Background).Color.A);

        // Back above the group, its heading returns to its place.
        ScrollTo(window, 0);
        Assert.Equal(0, Offset(pin), 1);
    }

    [AvaloniaFact]
    public void Scroll_NextHeadingReachesTheTop_PushesThePinnedHeadingUp()
    {
        var (window, _) = Open();
        var (first, next) = TallGroup(window);
        var groups = Groups(window);
        var height = groups[first].Pin.Bounds.Height;

        // The next group's heading 10 px below the list's top: the pinned heading ends where it starts.
        ScrollTo(window, ContentTop(window, groups[next].Section) - 10);

        Assert.Equal(10, DrawnTop(window, groups[next].Pin), 1);
        Assert.Equal(10 - height, DrawnTop(window, groups[first].Pin), 1);

        // At the top, the next heading is the pinned one and the first has gone above it.
        ScrollTo(window, ContentTop(window, groups[next].Section));
        Assert.Equal(0, DrawnTop(window, groups[next].Pin), 1);
        Assert.True(DrawnTop(window, groups[first].Pin) <= -height + 1);
    }

    [AvaloniaFact]
    public void Click_OnThePinnedHeading_ClosesItsGroup()
    {
        var (window, _) = Open();
        var (first, _) = TallGroup(window);
        var (section, _, group) = Groups(window)[first];

        ScrollTo(window, ContentTop(window, section) + 20);
        Assert.True(group.IsOpen);

        var at = Scroller(window).TranslatePoint(new Point(60, 5), window)!.Value;

        window.MouseDown(at, MouseButton.Left);
        window.MouseUp(at, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();

        Assert.False(group.IsOpen);
    }

    [AvaloniaFact]
    public void ShowItemWindow_DoneRowNotYetDrawnAboveTheList_ScrollsItBelowThePinnedHeading()
    {
        // Done open with 40 rows, so it draws only those in view, its first row the item window's.
        var json = JsonNode.Parse(Fixtures.DockJson)!.AsObject();
        var groups = json["groups"]!.AsArray();
        var done = groups.Single((group) => (string?)group!["key"] == "done")!["rows"]!.AsArray();
        var window = groups.SelectMany((group) => group!["rows"]!.AsArray()).First((row) => row!["window"] is JsonObject)!["window"]!.DeepClone();
        var template = done[0]!.ToJsonString();

        window["name"] = "done-window";
        done.Clear();
        for (var index = 0; index < 40; index++)
        {
            var row = JsonNode.Parse(template)!;

            row["key"] = $"item:{1000 + index}";
            row["band"] = "Today";
            row["window"] = index == 0 ? window.DeepClone() : null;
            done.Add(row);
        }

        var model = new DockViewModel(new DockSettings { Groups = { ["done"] = true } }, (_) => { });
        var dock = new MainWindow(model, null, hub, actions, docked: false) { Height = 260 };

        model.Show(Fixtures.View with { Groups = DockView.Parse(json.ToJsonString()).Groups });
        dock.Show();
        Dispatcher.UIThread.RunJobs();
        Scroller(dock).Offset = new Vector(0, Scroller(dock).Extent.Height);
        Dispatcher.UIThread.RunJobs();
        Assert.DoesNotContain(dock.GetVisualDescendants().OfType<Border>(), (border) => border.DataContext is RowViewModel { Key: "item:1000" } && border.Classes.Contains("row"));

        dock.ShowItemWindow("done-window");
        Dispatcher.UIThread.RunJobs();
        Dispatcher.UIThread.RunJobs();

        var shown = dock.GetVisualDescendants().OfType<Border>().Single((border) => border.Classes.Contains("row") && border.DataContext is RowViewModel { Key: "item:1000" });
        var pin = Groups(dock).Single((group) => group.Group.Key == "done").Pin;

        Assert.Equal(0, DrawnTop(dock, pin), 1);
        Assert.True(DrawnTop(dock, shown) >= pin.Bounds.Height - 1, $"row at {DrawnTop(dock, shown)}, under the heading of {pin.Bounds.Height}");
    }

    [AvaloniaFact]
    public void Focus_OnARowAboveTheList_ScrollsItBelowThePinnedHeading()
    {
        var (window, _) = Open();
        var (first, _) = TallGroup(window);
        var (section, pin, _) = Groups(window)[first];
        var row = section.GetVisualDescendants().OfType<Border>().First((border) => border.Classes.Contains("row") && border.IsEffectivelyVisible);

        // Scrolled to the group's end, with its first row above the list's top.
        ScrollTo(window, ContentTop(window, section) + section.Bounds.Height - 10);
        Assert.True(DrawnTop(window, row) < 0);

        row.Focus(NavigationMethod.Tab);
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(0, DrawnTop(window, pin), 1);
        Assert.Equal(pin.Bounds.Height, DrawnTop(window, row), 1);
    }
}
