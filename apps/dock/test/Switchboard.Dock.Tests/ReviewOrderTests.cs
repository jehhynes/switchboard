using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Avalonia.VisualTree;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Views;

namespace Switchboard.Dock.Tests;

/// <summary>Ready for review's order, stripes and header count, dragging and the Move controls, and F8 (PRD R27, R73).</summary>
public sealed class ReviewOrderTests
{
    readonly FakeHub hub = new();
    readonly FakeActions actions = new();

    static DockRow Row(int id, string? turn = null, bool movable = false, Tone? stripe = null, bool dim = false, IReadOnlyList<DockControl>? controls = null, string? window = null) =>
        new(
            $"item:{id}",
            $"Item {id}",
            null,
            null,
            "dev:develop",
            $"gh {id}",
            "github",
            $"https://github.com/o/r/issues/{id}",
            null,
            [],
            stripe,
            window is null ? null : new DockWindow(window, $"Item {id}", ["D:/git/widgets"]),
            null,
            controls ?? [],
            null,
            null,
            [],
            [],
            [],
            $"Item {id} · gh {id}",
            [],
            0,
            Turn: turn,
            Dim: dim,
            Movable: movable);

    static DockRow Review(int id, string turn = "operator") => Row(id, turn, movable: true, stripe: turn == "operator" ? Tone.Turn : null, dim: turn == "agent");

    static DockGroup Group(string key, params DockRow[] rows) => new(key, key, null, rows);

    /// <summary>Blocked on you: 1 (yours); Ready for review: 2, 3 (agent), 4, 5; In progress: 6 (agent); Snoozed: 7 (no turn); Done: 8.</summary>
    static DockView View() =>
        new(
            [],
            [
                Group("blocked", Row(1, "operator", stripe: Tone.Warning)),
                Group("review", Review(2), Review(3, "agent"), Review(4), Review(5)),
                Group("progress", Row(6, "agent")),
                Group("snoozed", Row(7)),
                Group("done", Row(8)),
            ],
            [],
            [],
            []);

    (MainWindow Window, DockViewModel Model) Open(DockView? view = null, DockSettings? settings = null)
    {
        var model = new DockViewModel(settings ?? new DockSettings(), (_) => { });
        var window = new MainWindow(model, null, hub, actions, docked: false) { Height = 1200 };

        model.Show(view ?? View());
        window.Show();
        Dispatcher.UIThread.RunJobs();

        return (window, model);
    }

    static Border RowOf(Window window, string key) =>
        window.GetVisualDescendants().OfType<Border>().Single((border) => border.Classes.Contains("row") && border.DataContext is RowViewModel row && row.Key == key);

    /// <summary>A point on the row, <paramref name="fraction"/> of the way down it, in window coordinates.</summary>
    static Point On(Window window, string key, double fraction)
    {
        var row = RowOf(window, key);

        return row.TranslatePoint(new Point(row.Bounds.Width - 30, row.Bounds.Height * fraction), window)!.Value;
    }

    static void Drag(Window window, Point from, Point to, bool release = true)
    {
        window.MouseDown(from, MouseButton.Left);
        window.MouseMove(new Point(from.X, from.Y + ((to.Y - from.Y) / 2)), RawInputModifiers.LeftMouseButton);
        window.MouseMove(to, RawInputModifiers.LeftMouseButton);
        Dispatcher.UIThread.RunJobs();

        if (release)
        {
            window.MouseUp(to, MouseButton.Left);
            Dispatcher.UIThread.RunJobs();
        }
    }

    static void Press(Window window, Key key, RawInputModifiers modifiers = RawInputModifiers.None)
    {
        window.KeyPress(key, modifiers, PhysicalKey.None, null);
        Dispatcher.UIThread.RunJobs();
    }

    static List<string> Headers(MainWindow window, DockRow row) => window.MenuOf(row).Select((item) => item is MenuItem named ? (string)named.Header! : "").ToList();

    [AvaloniaTheory]
    [InlineData(Tone.Error, "error")]
    [InlineData(Tone.Warning, "warning")]
    [InlineData(Tone.Turn, "turn")]
    [InlineData(null, null)]
    public void Stripe_EachValue_TakesItsClassAndColour(Tone? tone, string? expected)
    {
        var (window, _) = Open(new DockView([], [Group("progress", Row(1, stripe: tone))], [], [], []));
        var stripe = RowOf(window, "item:1").GetVisualDescendants().OfType<Border>().Single((border) => border.Classes.Contains("stripe"));
        string[] kinds = ["error", "warning", "turn"];

        Assert.Equal(expected is null ? [] : [expected], kinds.Where(stripe.Classes.Contains));
        Assert.Equal(
            expected is null ? null : window.FindResource(window.ActualThemeVariant, $"Dock{char.ToUpperInvariant(expected[0])}{expected[1..]}"),
            expected is null ? null : stripe.Background);
    }

    [AvaloniaFact]
    public void Stripe_Turn_UsesTheFocusBlue()
    {
        var (window, _) = Open();

        Assert.Equal(window.FindResource(window.ActualThemeVariant, "DockFocus")!.ToString(), window.FindResource(window.ActualThemeVariant, "DockTurn")!.ToString());
    }

    [AvaloniaFact]
    public void DimRow_AgentTurnInReview_DimsItsTextsAndShowsNoStripe()
    {
        var (window, model) = Open();
        var dim = RowOf(window, "item:3");
        var content = dim.GetVisualDescendants().OfType<Grid>().Single((grid) => grid.Classes.Contains("content"));

        model.Selected = "item:3";
        Dispatcher.UIThread.RunJobs();

        Assert.Contains("dim", dim.Classes);
        Assert.Contains("selected", dim.Classes);
        Assert.Equal(0.6, content.Opacity);
        Assert.Null(dim.GetVisualDescendants().OfType<Border>().Single((border) => border.Classes.Contains("stripe")).Background);
        Assert.DoesNotContain("dim", RowOf(window, "item:2").Classes);
        Assert.Equal(1, RowOf(window, "item:2").GetVisualDescendants().OfType<Grid>().Single((grid) => grid.Classes.Contains("content")).Opacity);
    }

    static readonly DockControl[] MoveControls =
    [
        new("Move to top", JsonNode.Parse("""{"type":"move","workItemId":4,"after":null}""")!.AsObject(), "\uEA78"),
        new("Move up", JsonNode.Parse("""{"type":"move","workItemId":4,"after":2}""")!.AsObject(), "\uEAA1"),
        new("Move down", JsonNode.Parse("""{"type":"move","workItemId":4,"after":5}""")!.AsObject(), "\uEA9A"),
        new("Reset position", JsonNode.Parse("""{"type":"reset-position","workItemId":4}""")!.AsObject(), "\uEA82"),
    ];

    [AvaloniaFact]
    public void MenuOf_ReviewRow_ListsTheMoveControlsWithTheirIcons()
    {
        var (window, _) = Open();
        var menu = window.MenuOf(Review(4) with { Controls = MoveControls });

        Assert.Equal(["Move to top", "Move up", "Move down", "Reset position", "", "Open ticket"], Headers(window, Review(4) with { Controls = MoveControls }));
        Assert.All(menu.Take(4), (item) => Assert.Equal(MoveControls[menu.IndexOf(item)].Glyph, ((TextBlock)((MenuItem)item).Icon!).Text));
    }

    [AvaloniaFact]
    public void MenuItem_MoveControls_PostTheirActions()
    {
        var (window, _) = Open();
        var menu = window.MenuOf(Review(4) with { Controls = MoveControls });

        foreach (var item in menu.Take(4).Cast<MenuItem>())
        {
            hub.ActReplies.Enqueue(null);
            item.RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent));
        }

        Dispatcher.UIThread.RunJobs();

        Assert.Equal(
            [
                "act {\"type\":\"move\",\"workItemId\":4,\"after\":null}",
                "act {\"type\":\"move\",\"workItemId\":4,\"after\":2}",
                "act {\"type\":\"move\",\"workItemId\":4,\"after\":5}",
                "act {\"type\":\"reset-position\",\"workItemId\":4}",
            ],
            hub.Calls);
    }

    [AvaloniaTheory]
    [InlineData("item:5", "item:2", 0.2, "null")]
    [InlineData("item:2", "item:4", 0.2, "3")]
    [InlineData("item:2", "item:4", 0.8, "4")]
    [InlineData("item:2", "item:5", 0.8, "5")]
    [InlineData("item:5", "item:3", 0.8, "3")]
    public void DragRow_ToAnotherPlaceInReview_PostsMoveAfterTheRowAbove(string dragged, string target, double fraction, string after)
    {
        var (window, _) = Open();
        var id = dragged[5..];

        hub.ActReplies.Enqueue(null);
        Drag(window, On(window, dragged, 0.5), On(window, target, fraction));

        Assert.Equal([$"act {{\"type\":\"move\",\"workItemId\":{id},\"after\":{after}}}"], hub.Calls);
        Assert.Empty(actions.Clicked);
        Assert.False(window.FindControl<Border>("DropLine")!.IsVisible);
    }

    [AvaloniaTheory]
    [InlineData("item:3", 0.2)]
    [InlineData("item:3", 0.8)]
    [InlineData("item:2", 0.8)]
    [InlineData("item:4", 0.2)]
    public void DragRow_ToItsOwnPlace_PostsNothing(string target, double fraction)
    {
        var (window, _) = Open();

        Drag(window, On(window, "item:3", 0.5), On(window, target, fraction));

        Assert.Empty(hub.Calls);
        Assert.Empty(actions.Clicked);
    }

    [AvaloniaTheory]
    [InlineData("item:1")]
    [InlineData("item:6")]
    public void DragRow_OutsideReview_PostsNothing(string target)
    {
        var (window, _) = Open();

        Drag(window, On(window, "item:2", 0.5), On(window, target, 0.5));

        Assert.Empty(hub.Calls);
        Assert.Empty(actions.Clicked);
        Assert.False(window.FindControl<Border>("DropLine")!.IsVisible);
    }

    [AvaloniaFact]
    public void DragRow_Dragging_DrawsTheDropLineOnTheEdgeBetweenTwoRows()
    {
        var (window, _) = Open();
        var line = window.FindControl<Border>("DropLine")!;

        Drag(window, On(window, "item:5", 0.5), On(window, "item:4", 0.3), release: false);

        var edge = RowOf(window, "item:4").TranslatePoint(default, window)!.Value.Y;
        var top = line.TranslatePoint(default, window)!.Value.Y;

        Assert.True(line.IsEffectivelyVisible);
        Assert.InRange(top, edge - 1.5, edge);
        Assert.Equal(RowOf(window, "item:4").Bounds.Width, line.Bounds.Width);
    }

    [AvaloniaFact]
    public void DragRow_EscapePressed_CancelsWithoutAMoveOrClick()
    {
        var (window, _) = Open();
        var from = On(window, "item:5", 0.5);

        Drag(window, from, On(window, "item:2", 0.2), release: false);
        Press(window, Key.Escape);
        Assert.False(window.FindControl<Border>("DropLine")!.IsVisible);

        // Released back on the pressed row, where a tap would run the row's click.
        window.MouseMove(from, RawInputModifiers.LeftMouseButton);
        window.MouseUp(from, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();

        Assert.Empty(hub.Calls);
        Assert.Empty(actions.Clicked);
    }

    [AvaloniaFact]
    public void DragRow_CaptureLost_CancelsWithoutAMoveOrClick()
    {
        var (window, _) = Open();
        var from = On(window, "item:5", 0.5);
        var other = window.FindControl<TextBlock>("ConnectionLine")!;

        Drag(window, from, On(window, "item:2", 0.2), release: false);
        Assert.True(window.FindControl<Border>("DropLine")!.IsVisible);

        // Another element takes the pointer, as another window would.
        window.AddHandler(InputElement.PointerMovedEvent, (_, e) => e.Pointer.Capture(other), RoutingStrategies.Tunnel, handledEventsToo: true);
        window.MouseMove(On(window, "item:2", 0.3), RawInputModifiers.LeftMouseButton);
        Dispatcher.UIThread.RunJobs();
        Assert.False(window.FindControl<Border>("DropLine")!.IsVisible);

        window.MouseUp(from, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();

        Assert.Empty(hub.Calls);
        Assert.Empty(actions.Clicked);
    }

    [AvaloniaTheory]
    [InlineData(-40)]
    [InlineData(520)]
    public void DragRow_ReleasedPastTheListEdge_PostsNothingAndHidesTheLine(double x)
    {
        var (window, _) = Open();
        var to = On(window, "item:2", 0.2);

        Drag(window, On(window, "item:5", 0.5), new Point(x, to.Y), release: false);
        Assert.False(window.FindControl<Border>("DropLine")!.IsVisible);

        window.MouseUp(new Point(x, to.Y), MouseButton.Left);
        Dispatcher.UIThread.RunJobs();

        Assert.Empty(hub.Calls);
        Assert.Empty(actions.Clicked);
    }

    [AvaloniaFact]
    public void DragRow_ReleasedBelowTheVisibleList_PostsNothing()
    {
        var (window, _) = Open();

        // Short enough that item:5 is laid out below the visible list.
        window.Height = RowOf(window, "item:4").TranslatePoint(default, window)!.Value.Y + 20;
        Dispatcher.UIThread.RunJobs();

        var hidden = On(window, "item:5", 0.5);

        Assert.True(hidden.Y > window.FindControl<ScrollViewer>("RowScroller")!.TranslatePoint(new Point(0, window.FindControl<ScrollViewer>("RowScroller")!.Bounds.Height), window)!.Value.Y);

        Drag(window, On(window, "item:2", 0.5), hidden, release: false);
        Assert.False(window.FindControl<Border>("DropLine")!.IsVisible);

        window.MouseUp(hidden, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();

        Assert.Empty(hub.Calls);
        Assert.Empty(actions.Clicked);
    }

    [AvaloniaFact]
    public void DragRow_HubUpdateWithoutAPointerMove_MovesTheLineToWhereTheReleasePosts()
    {
        var (window, model) = Open();
        var line = window.FindControl<Border>("DropLine")!;
        var to = On(window, "item:2", 0.2);

        Drag(window, On(window, "item:5", 0.5), to, release: false);

        var before = line.TranslatePoint(default, window)!.Value.Y;

        // Blocked on you empties, so Ready for review moves up under the still pointer.
        model.Show(View() with { Groups = [.. View().Groups.Skip(1)] });
        Dispatcher.UIThread.RunJobs();

        Assert.NotEqual(before, line.TranslatePoint(default, window)!.Value.Y);
        ReleaseWhereTheLineIs(window, to, ["item:2", "item:3", "item:4", "item:5"], 5);
    }

    [AvaloniaFact]
    public void DragRow_NotesAppearWithoutAPointerMove_MovesTheLineToWhereTheReleasePosts()
    {
        var (window, model) = Open();
        var line = window.FindControl<Border>("DropLine")!;
        var to = On(window, "item:5", 0.8);

        Drag(window, On(window, "item:2", 0.5), to, release: false);

        var before = line.TranslatePoint(default, window)!.Value.Y;

        // A note above the list pushes Ready for review down under the still pointer.
        model.Show(View() with { Notes = ["Settings: bad JSON"] });
        Dispatcher.UIThread.RunJobs();

        Assert.NotEqual(before, line.TranslatePoint(default, window)!.Value.Y);
        ReleaseWhereTheLineIs(window, to, ["item:2", "item:3", "item:4", "item:5"], 2);
    }

    [AvaloniaFact]
    public void DragRow_ListScrollsWithoutAPointerMove_MovesTheLineToWhereTheReleasePosts()
    {
        var keys = Enumerable.Range(20, 10).Select((id) => $"item:{id}").ToArray();
        var view = new DockView([], [Group("review", [.. Enumerable.Range(20, 10).Select((id) => Review(id))])], [], [], []);
        var model = new DockViewModel(new DockSettings(), (_) => { });
        var window = new MainWindow(model, null, hub, actions, docked: false) { Height = 400 };

        model.Show(view);
        window.Show();
        Dispatcher.UIThread.RunJobs();

        var line = window.FindControl<Border>("DropLine")!;
        var scroller = window.FindControl<ScrollViewer>("RowScroller")!;
        var to = On(window, "item:23", 0.3);

        Drag(window, On(window, "item:20", 0.5), to, release: false);

        var before = line.TranslatePoint(default, window)!.Value.Y;

        scroller.Offset = new Vector(0, 60);
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(60, scroller.Offset.Y);
        Assert.NotEqual(before, line.TranslatePoint(default, window)!.Value.Y);
        ReleaseWhereTheLineIs(window, to, keys, 20);
    }

    /// <summary>Releases the drag at <paramref name="to"/> and asserts the drop line was on the edge below the row the posted move names.</summary>
    void ReleaseWhereTheLineIs(Window window, Point to, string[] order, int dragged)
    {
        var line = window.FindControl<Border>("DropLine")!;

        Assert.True(line.IsVisible);

        var shown = line.TranslatePoint(default, window)!.Value.Y;
        var edges = order.Select((key) => RowOf(window, key).TranslatePoint(default, window)!.Value.Y).Append(RowOf(window, order[^1]).TranslatePoint(new Point(0, RowOf(window, order[^1]).Bounds.Height), window)!.Value.Y).ToList();

        hub.ActReplies.Enqueue(null);
        window.MouseUp(to, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();

        var posted = System.Text.Json.Nodes.JsonNode.Parse(Assert.Single(hub.Calls)["act ".Length..])!;
        var above = posted["after"] is { } id ? Array.IndexOf(order, $"item:{id.GetValue<int>()}") : -1;

        Assert.Equal(dragged, posted["workItemId"]!.GetValue<int>());
        Assert.InRange(shown, edges[above + 1] - 1.5, edges[above + 1]);
    }

    [AvaloniaFact]
    public void DragRow_DraggedRowGoneAfterAHubUpdate_HidesTheLineAndPostsNothing()
    {
        var (window, model) = Open();
        var to = On(window, "item:2", 0.2);

        Drag(window, On(window, "item:5", 0.5), to, release: false);
        model.Show(View() with { Groups = [.. View().Groups.Select((group) => group with { Rows = [.. group.Rows.Where((row) => row.Key != "item:5")] })] });
        Dispatcher.UIThread.RunJobs();

        Assert.False(window.FindControl<Border>("DropLine")!.IsVisible);

        window.MouseUp(to, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();

        Assert.Empty(hub.Calls);
    }

    [AvaloniaFact]
    public void DragRow_HubUpdateDuringTheDrag_DropsTheRowFoundByItsKey()
    {
        var (window, model) = Open();
        var to = On(window, "item:2", 0.2);

        Drag(window, On(window, "item:5", 0.5), to, release: false);
        model.Show(View());
        Dispatcher.UIThread.RunJobs();
        hub.ActReplies.Enqueue(null);
        window.MouseMove(to, RawInputModifiers.LeftMouseButton);
        window.MouseUp(to, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(["act {\"type\":\"move\",\"workItemId\":5,\"after\":null}"], hub.Calls);
    }

    [AvaloniaFact]
    public void DragRow_NotMovable_PostsNothing()
    {
        var (window, _) = Open();

        Drag(window, On(window, "item:6", 0.5), On(window, "item:2", 0.2));

        Assert.Empty(hub.Calls);
    }

    [AvaloniaFact]
    public void TapRow_MovedUnderFourPixels_RunsTheClickWithoutAMove()
    {
        var (window, _) = Open();
        var from = On(window, "item:4", 0.5);

        window.MouseDown(from, MouseButton.Left);
        window.MouseMove(new Point(from.X, from.Y + 3), RawInputModifiers.LeftMouseButton);
        window.MouseUp(new Point(from.X, from.Y + 3), MouseButton.Left);
        Dispatcher.UIThread.RunJobs();

        Assert.Empty(hub.Calls);
        Assert.Equal(["item:4"], actions.Clicked.Select((row) => row.Key));
    }

    [AvaloniaTheory]
    [InlineData(Key.Up, "act {\"type\":\"move\",\"workItemId\":4,\"after\":2}")]
    [InlineData(Key.Down, "act {\"type\":\"move\",\"workItemId\":4,\"after\":5}")]
    public void AltArrow_SelectedReviewRow_RunsItsMoveControl(Key key, string call)
    {
        var view = View();
        var (window, model) = Open(view with { Groups = [.. view.Groups.Select((group) => group with { Rows = [.. group.Rows.Select((row) => row.Key == "item:4" ? row with { Controls = MoveControls } : row)] })] });

        model.Selected = "item:4";
        hub.ActReplies.Enqueue(null);
        Press(window, key, RawInputModifiers.Alt);

        Assert.Equal([call], hub.Calls);
    }

    [AvaloniaFact]
    public void AltArrow_RowWithoutTheControlOrNotMovable_PostsNothing()
    {
        var (window, model) = Open(new DockView([], [Group("review", Review(2) with { Controls = [MoveControls[2]] }), Group("progress", Row(6, controls: MoveControls))], [], [], []));

        model.Selected = "item:2";
        Press(window, Key.Up, RawInputModifiers.Alt);
        model.Selected = "item:6";
        Press(window, Key.Down, RawInputModifiers.Alt);
        model.Selected = null;
        Press(window, Key.Down, RawInputModifiers.Alt);

        Assert.Empty(hub.Calls);
    }

    static DockViewModel Model(DockView view, DockSettings? settings = null)
    {
        var model = new DockViewModel(settings ?? new DockSettings(), (_) => { });

        model.Show(view);

        return model;
    }

    [Fact]
    public void SelectNextTurn_Repeated_VisitsOperatorRowsInBlockedAndReviewInListOrderAndWraps()
    {
        var model = Model(View());
        List<string?> visited = [];

        for (var step = 0; step < 5; step++)
        {
            visited.Add(model.SelectNextTurn(backwards: false)?.Key);
        }

        Assert.Equal(["item:1", "item:2", "item:4", "item:5", "item:1"], visited);
        Assert.Equal("item:1", model.Selected);
    }

    [Fact]
    public void SelectNextTurn_ReviewAboveBlocked_VisitsReviewThenBlockedAndWraps()
    {
        var view = View();
        var model = Model(view with { Groups = [view.Groups[1], view.Groups[0], .. view.Groups.Skip(2)] });

        model.Selected = "item:4";

        List<string?> visited = [model.SelectNextTurn(backwards: false)?.Key, model.SelectNextTurn(backwards: false)?.Key, model.SelectNextTurn(backwards: false)?.Key];

        Assert.Equal(["item:5", "item:1", "item:2"], visited);
        Assert.Equal("item:1", model.SelectNextTurn(backwards: true)?.Key);
    }

    [Fact]
    public void SelectNextTurn_Backwards_VisitsInReverseFromTheSelection()
    {
        var model = Model(View());

        model.Selected = "item:4";

        Assert.Equal("item:2", model.SelectNextTurn(backwards: true)?.Key);
        Assert.Equal("item:1", model.SelectNextTurn(backwards: true)?.Key);
        Assert.Equal("item:5", model.SelectNextTurn(backwards: true)?.Key);
    }

    [Fact]
    public void SelectNextTurn_NoSelectionBackwards_SelectsTheLastOperatorRow()
    {
        Assert.Equal("item:5", Model(View()).SelectNextTurn(backwards: true)?.Key);
    }

    [Fact]
    public void SelectNextTurn_SelectionOutsideTheTurnGroups_ContinuesAfterIt()
    {
        var model = Model(View());

        model.Selected = "item:6";

        Assert.Equal("item:1", model.SelectNextTurn(backwards: false)?.Key);
    }

    [Fact]
    public void SelectNextTurn_NoOperatorRow_SelectsNothing()
    {
        var model = Model(new DockView([], [Group("review", Review(3, "agent")), Group("progress", Row(6, "agent")), Group("snoozed", Row(7)), Group("unstarted", Row(9, "operator"))], [], [], []));

        model.Selected = "item:6";

        Assert.Null(model.SelectNextTurn(backwards: false));
        Assert.Null(model.SelectNextTurn(backwards: true));
        Assert.Equal("item:6", model.Selected);
    }

    [Fact]
    public void SelectNextTurn_RowInClosedGroup_OpensTheGroupAndKeepsThatChoice()
    {
        var settings = new DockSettings { Groups = { ["review"] = false } };
        var model = Model(View(), settings);

        model.Selected = "item:1";

        Assert.Equal("item:2", model.SelectNextTurn(backwards: false)?.Key);
        Assert.True(model.Groups.Single((group) => group.Key == "review").IsOpen);
        Assert.True(settings.Groups["review"]);
    }

    [Fact]
    public void SelectNextTurn_RowHiddenBySearch_ClearsTheSearch()
    {
        var model = Model(View());

        model.Filter = "gh 4";
        model.Selected = "item:4";

        Assert.Equal("item:5", model.SelectNextTurn(backwards: false)?.Key);
        Assert.Equal("", model.Filter);
    }

    [Fact]
    public void SelectNextTurn_RowShownBySearch_KeepsTheSearch()
    {
        var model = Model(View());

        model.Selected = "item:4";
        model.Filter = "gh 5";

        Assert.Equal("item:5", model.SelectNextTurn(backwards: false)?.Key);
        Assert.Equal("gh 5", model.Filter);
    }

    [AvaloniaFact]
    public void F8_Pressed_SelectsTheNextOperatorRowAndRunsItsClick()
    {
        var (window, model) = Open();

        model.Selected = "item:2";
        Press(window, Key.F8);

        Assert.Equal("item:4", model.Selected);
        Assert.Equal(["item:4"], actions.Clicked.Select((row) => row.Key));

        Press(window, Key.F8, RawInputModifiers.Shift);

        Assert.Equal("item:2", model.Selected);
        Assert.Equal(["item:4", "item:2"], actions.Clicked.Select((row) => row.Key));
    }

    [AvaloniaFact]
    public void F8_NoOperatorRow_DoesNothing()
    {
        var (window, model) = Open(new DockView([], [Group("review", Review(3, "agent")), Group("snoozed", Row(7))], [], [], []));

        Press(window, Key.F8);

        Assert.Null(model.Selected);
        Assert.Empty(actions.Clicked);
    }

    [AvaloniaFact]
    public void F8_RowBelowTheFoldInClosedGroup_OpensItAndScrollsTheRowIntoView()
    {
        var filler = Enumerable.Range(10, 20).Select((id) => Row(id, "agent")).ToArray();
        var view = new DockView([], [Group("progress", filler), Group("review", Review(3, "agent"), Review(4))], [], [], []);
        var model = new DockViewModel(new DockSettings { Groups = { ["review"] = false } }, (_) => { });
        var window = new MainWindow(model, null, hub, actions, docked: false) { Height = 300 };

        model.Show(view);
        window.Show();
        Dispatcher.UIThread.RunJobs();
        Press(window, Key.F8);
        Dispatcher.UIThread.RunJobs();

        var scroller = window.FindControl<ScrollViewer>("RowScroller")!;
        var row = RowOf(window, "item:4");
        var top = row.TranslatePoint(new Point(0, 0), scroller)!.Value.Y;

        Assert.Equal("item:4", model.Selected);
        Assert.True(scroller.Offset.Y > 0);
        Assert.InRange(top, 0, scroller.Viewport.Height - row.Bounds.Height);
    }
}
