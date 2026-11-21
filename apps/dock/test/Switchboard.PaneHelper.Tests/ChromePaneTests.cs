using System.Text.Json.Nodes;

namespace Switchboard.PaneHelper.Tests;

public sealed class PaneGeometryTests
{
    static readonly PaneRect Rect = new(1300, 40, 600, 900, 1.25, 1900, 1000);

    [Fact]
    public void Column_AppFrameAndRect_PlacesTheColumnFromTheViewportAtTheFrameBottom()
    {
        // A 2385 px frame around a 1900 CSS px viewport at 125% leaves 5 px each side.
        var column = PaneGeometry.Column(new Box(100, 50, 2485, 1355), Rect);

        Assert.Equal(new Box(105 + 1625, 1355 - 5 - 1250 + 50, 105 + 2375, 1355 - 5 - 1250 + 1175), column);
    }

    [Fact]
    public void Column_ViewportWiderThanFrame_TakesNoNegativeBorder()
    {
        var column = PaneGeometry.Column(new Box(0, 0, 1000, 800), new PaneRect(500, 0, 500, 800, 1, 1004, 800));

        Assert.Equal(new Box(500, 0, 1000, 800), column);
    }

    [Fact]
    public void Inset_ColumnAtTheAppsRightAndBottomEdges_KeepsThePaneWindowInsideTheAppsVisibleFrame()
    {
        var appFrame = new Box(100, 50, 2100, 1250);
        var paneFrame = new Box(507, 0, 1107, 700);
        var paneBounds = new Box(500, 0, 1114, 707);
        var target = PaneGeometry.Inset(new Box(1400, 300, 2100, 1250), appFrame, paneFrame, paneBounds, appMaximized: false);

        Assert.Equal(new Box(1400, 300, 2093, 1243), target);
        // The pane window, with its invisible borders, ends where the app's visible frame ends; the app's resize borders lie outside it.
        var place = PaneGeometry.Placement(target, paneFrame, paneBounds);

        Assert.Equal((2100, 1250), (place.Right, place.Bottom));
    }

    [Fact]
    public void Inset_ColumnClearOfTheEdgesOrAppMaximized_LeavesTheColumn()
    {
        var appFrame = new Box(100, 50, 2100, 1250);
        var paneFrame = new Box(507, 0, 1107, 700);
        var paneBounds = new Box(500, 0, 1114, 707);

        Assert.Equal(new Box(1400, 300, 2000, 1100), PaneGeometry.Inset(new Box(1400, 300, 2000, 1100), appFrame, paneFrame, paneBounds, appMaximized: false));
        Assert.Equal(new Box(1400, 300, 2100, 1250), PaneGeometry.Inset(new Box(1400, 300, 2100, 1250), appFrame, paneFrame, paneBounds, appMaximized: true));
    }

    [Fact]
    public void Placement_InvisibleBorders_PutsTheVisibleFrameOnTheTarget()
    {
        var place = PaneGeometry.Placement(new Box(1000, 100, 1600, 900), new Box(507, 0, 1107, 700), new Box(500, 0, 1114, 707));

        Assert.Equal(new Box(993, 100, 1607, 907), place);
    }
}

public sealed class ChromePaneTests
{
    const nint AppWindow = 10;
    const nint PaneWindow = 20;
    static readonly PaneRect Rect = new(1300, 40, 600, 900, 1, 1900, 1000);

    sealed class FakeNative : IPaneNative
    {
        public readonly List<string> Calls = [];
        public bool AppVisible = true;
        public bool PaneVisible = true;
        public bool OwnWorks = true;
        public bool AppIconic;
        public bool PaneIconic;
        public bool PaneZoomed;
        public bool Alive = true;
        public Box AppFrame = new(0, 0, 1900, 1040);
        public Box PaneFrame = new(0, 0, 400, 300);
        // GetWindowRect adds 7 px of invisible border left, right and bottom.
        public Box PaneBounds => new(PaneFrame.Left - 7, PaneFrame.Top, PaneFrame.Right + 7, PaneFrame.Bottom + 7);
        public Queue<CompositorCheck> Checks = new();
        /// <summary>The narrowest frame Chrome lets the pane have.</summary>
        public int MinWidth;

        public nint FindPane(string marker) => PaneVisible ? PaneWindow : 0;

        public nint FindApp(string marker, nint pane) => AppVisible ? AppWindow : 0;

        public string Survey(string marker) => $"survey {marker}";

        public bool IsAlive(nint window) => Alive;

        public bool PaneShown = true;

        public bool IsVisible(nint window) => window != PaneWindow || PaneShown;

        public bool IsIconic(nint window) => window == AppWindow ? AppIconic : PaneIconic;

        public bool AppZoomed;

        public bool IsZoomed(nint window) => window == PaneWindow ? PaneZoomed : AppZoomed;

        public Box Frame(nint window) => window == AppWindow ? AppFrame : PaneFrame;

        public Box Bounds(nint window) => window == AppWindow ? AppFrame : PaneBounds;

        public bool Own(nint pane, nint owner)
        {
            Calls.Add($"own {owner}");
            return OwnWorks || owner == 0;
        }

        public bool Raise(nint pane)
        {
            Calls.Add("raise");
            return RaiseWorks;
        }

        public bool Resize(nint pane, int width, int height)
        {
            Calls.Add($"resize {width}x{height}");
            PaneFrame = new Box(PaneFrame.Left, PaneFrame.Top, PaneFrame.Left + Math.Max(MinWidth, width - 14), PaneFrame.Top + height - 7);
            return true;
        }

        public bool Move(nint pane, int left, int top)
        {
            Calls.Add($"move {left},{top}");
            PaneFrame = new Box(left + 7, top, left + 7 + PaneFrame.Width, top + PaneFrame.Height);
            return true;
        }

        public bool HideWorks = true;
        public bool RaiseWorks = true;

        public bool Hide(nint pane, bool hidden)
        {
            Calls.Add(hidden ? "hide" : "show");
            return HideWorks;
        }

        public void Restore(nint pane)
        {
            Calls.Add("restore");
            PaneZoomed = false;
        }

        public CompositorCheck CheckCompositor(nint pane)
        {
            var check = Checks.Count > 0 ? Checks.Dequeue() : CompositorCheck.InPlace;

            Calls.Add($"compositor {check}");
            return check;
        }

        public void Watch(nint app) => Calls.Add($"watch {app}");

        public void Log(string line) => Calls.Add($"log {line}");
    }

    sealed class Timers
    {
        public readonly List<(TimeSpan Delay, Action Run, bool Cancelled)> All = [];

        public IDisposable After(TimeSpan delay, Action run)
        {
            var index = All.Count;

            All.Add((delay, run, false));
            return new Cancel(() => All[index] = All[index] with { Cancelled = true });
        }

        /// <summary>Runs the pending timers of that delay, as when it passes.</summary>
        public void Pass(TimeSpan delay)
        {
            // Timers set while these run wait for the next pass.
            for (int index = 0, count = All.Count; index < count; index++)
            {
                if (!All[index].Cancelled && All[index].Delay == delay)
                {
                    var run = All[index].Run;

                    All[index] = All[index] with { Cancelled = true };
                    run();
                }
            }
        }

        sealed class Cancel(Action cancel) : IDisposable
        {
            public void Dispose() => cancel();
        }
    }

    static (ChromePane Pane, FakeNative Native, List<JsonObject> Reports, Timers Timers) Make()
    {
        var native = new FakeNative();
        var reports = new List<JsonObject>();
        var timers = new Timers();

        return (new ChromePane(native, reports.Add, timers.After), native, reports, timers);
    }

    static string States(List<JsonObject> reports) => string.Join(",", reports.Select((report) => report["state"]!.GetValue<string>()));

    [Fact]
    public void Order_WindowsFound_OwnsRaisesOnceAndAlignsWithSeparateResizeAndMove()
    {
        var (pane, native, reports, timers) = Make();

        pane.Order(new PaneOrder("0123456789ab", Rect));

        Assert.Equal(["own 10", "watch 10", "log pane found: app A, pane 14", "raise", "resize 607x907", "move 1293,80"], native.Calls);
        Assert.Equal("found,shown", States(reports));
        Assert.Equal("0123456789ab", reports[0]["marker"]!.GetValue<string>());
        // The visible frame lands on the column, its right edge pulled in by the pane's 7 px invisible border so the page window's resize border stays
        // clear: the viewport ends at the frame's bottom, and the column starts 40 px into it.
        Assert.Equal(new Box(1300, 80, 1893, 980), native.PaneFrame);

        native.Calls.Clear();
        pane.Order(new PaneOrder("0123456789ab", Rect with { Width = 650, Left = 1250 }));
        Assert.Equal(["resize 657x907", "move 1243,80"], native.Calls);

        native.Calls.Clear();
        timers.Pass(ChromePane.SettleDelay);
        Assert.Equal(["compositor InPlace"], native.Calls);
        Assert.Equal("found,shown", States(reports));
    }

    [Fact]
    public void Order_AppMaximized_CoversTheColumnToTheAppsEdges()
    {
        var (pane, native, _, _) = Make();

        native.AppZoomed = true;
        pane.Order(new PaneOrder("0123456789ab", Rect));

        Assert.Contains("resize 614x907", native.Calls);
        Assert.Equal(new Box(1300, 80, 1900, 980), native.PaneFrame);
    }

    [Fact]
    public void Order_WindowsNotYetThere_SearchesAgainThenFailsAfterTheLastTry()
    {
        var (pane, native, reports, timers) = Make();

        native.PaneVisible = false;
        pane.Order(new PaneOrder("0123456789ab", Rect));
        timers.Pass(ChromePane.SearchEvery);
        Assert.Empty(reports);

        native.PaneVisible = true;
        timers.Pass(ChromePane.SearchEvery);
        Assert.Equal("found,shown", States(reports));

        var (other, otherNative, otherReports, otherTimers) = Make();

        otherNative.AppVisible = false;
        other.Order(new PaneOrder("0123456789ab", Rect));

        for (var tries = 1; tries < ChromePane.SearchFastTries; tries++)
        {
            otherTimers.Pass(ChromePane.SearchEvery);
        }

        // Ten seconds in, the log says what the search sees, and it goes on every second.
        Assert.Contains("log pane: looked 40 times for marker 0123456789ab: page's window missing, pane window found; survey 0123456789ab", otherNative.Calls);
        Assert.Empty(otherReports);

        for (var tries = ChromePane.SearchFastTries; tries < ChromePane.SearchTries; tries++)
        {
            Assert.Empty(otherReports);
            otherTimers.Pass(ChromePane.SearchSlowEvery);
        }

        Assert.Equal("failed", States(otherReports));
        Assert.Equal("Switchboard did not find the installed page's window. Reload the page to try again.", otherReports[0]["reason"]!.GetValue<string>());
        Assert.Contains("log pane: looked 90 times for marker 0123456789ab: page's window missing, pane window found; survey 0123456789ab", otherNative.Calls);

        var (third, thirdNative, thirdReports, thirdTimers) = Make();

        thirdNative.PaneVisible = false;
        third.Order(new PaneOrder("0123456789ab", Rect));

        for (var tries = 1; tries < ChromePane.SearchTries; tries++)
        {
            thirdTimers.Pass(tries < ChromePane.SearchFastTries ? ChromePane.SearchEvery : ChromePane.SearchSlowEvery);
        }

        Assert.Equal("Switchboard did not find the pane window the Chrome extension opens. Reload the page to try again.", thirdReports[0]["reason"]!.GetValue<string>());
    }

    [Fact]
    public void Order_PaneLeftHiddenByAnEarlierHelper_FindsItAndShowsItWithTheColumn()
    {
        var (pane, native, reports, _) = Make();

        native.PaneShown = false;
        pane.Order(new PaneOrder("0123456789ab", null));
        Assert.DoesNotContain("hide", native.Calls);
        Assert.Equal("found,hidden", States(reports));

        native.Calls.Clear();
        pane.Order(new PaneOrder("0123456789ab", Rect));
        Assert.Equal("show", native.Calls[0]);
        Assert.Equal("found,hidden,shown", States(reports));
    }

    [Fact]
    public void Order_OwnerRefused_FailsAndLetsThePaneGo()
    {
        var (pane, native, reports, _) = Make();

        native.OwnWorks = false;
        pane.Order(new PaneOrder("0123456789ab", Rect));

        Assert.Equal("failed", States(reports));
        Assert.Contains("own 0", native.Calls);
    }

    [Fact]
    public void Order_NoColumn_HidesThePaneAndShowsItAgainInPlace()
    {
        var (pane, native, reports, _) = Make();

        pane.Order(new PaneOrder("0123456789ab", Rect));
        native.Calls.Clear();
        pane.Order(new PaneOrder("0123456789ab", null));
        pane.Order(new PaneOrder("0123456789ab", null));
        Assert.Equal(["hide"], native.Calls);
        Assert.Equal("found,shown,hidden", States(reports));

        native.Calls.Clear();
        pane.Order(new PaneOrder("0123456789ab", Rect));
        Assert.Equal(["show"], native.Calls);
        Assert.Equal("found,shown,hidden,shown", States(reports));
    }

    [Fact]
    public void Order_HideRefused_FailsAndLetsThePaneGo()
    {
        var (pane, native, reports, _) = Make();

        pane.Order(new PaneOrder("0123456789ab", Rect));
        native.HideWorks = false;
        pane.Order(new PaneOrder("0123456789ab", null));

        Assert.Equal("found,shown,failed", States(reports));
        Assert.Equal("Windows did not hide the pane.", reports[^1]["reason"]!.GetValue<string>());
        Assert.Equal("own 0", native.Calls[^1]);
    }

    [Fact]
    public void Settled_RaiseRefused_TriesAgainAndFailsAfterThreeRefusals()
    {
        var (pane, native, reports, timers) = Make();

        native.RaiseWorks = false;
        pane.Order(new PaneOrder("0123456789ab", Rect));
        Assert.Contains("log pane: Windows did not raise the pane; trying again when it settles", native.Calls);
        native.RaiseWorks = true;
        timers.Pass(ChromePane.SettleDelay);
        Assert.Equal(2, native.Calls.Count((call) => call == "raise"));
        Assert.Equal("found,shown", States(reports));

        var (other, otherNative, otherReports, otherTimers) = Make();

        otherNative.RaiseWorks = false;
        other.Order(new PaneOrder("0123456789ab", Rect));
        otherTimers.Pass(ChromePane.SettleDelay);
        otherTimers.Pass(ChromePane.SettleDelay);
        Assert.Equal("found,shown", States(otherReports));
        otherTimers.Pass(ChromePane.SettleDelay);
        Assert.Equal("found,shown,failed", States(otherReports));
        Assert.Equal("Windows did not put the pane above the page's window.", otherReports[^1]["reason"]!.GetValue<string>());
    }

    [Fact]
    public void Moved_AppMinimizedOrPaneMinimizedByTheOperator_LeavesThePaneAlone()
    {
        var (pane, native, _, timers) = Make();

        pane.Order(new PaneOrder("0123456789ab", Rect));
        native.Calls.Clear();
        native.AppIconic = true;
        native.AppFrame = new Box(-32000, -32000, -31840, -31972);
        pane.Moved(AppWindow);
        timers.Pass(ChromePane.SettleDelay);
        Assert.Empty(native.Calls);

        native.AppIconic = false;
        native.PaneIconic = true;
        native.AppFrame = new Box(100, 0, 2000, 1040);
        pane.Moved(AppWindow);
        Assert.Empty(native.Calls);

        // Restored, the page's next move puts it back.
        native.PaneIconic = false;
        pane.Moved(AppWindow);
        Assert.Equal(["move 1393,80"], native.Calls);
    }

    [Fact]
    public void Moved_PaneMaximized_RestoresItWithoutActivatingThenAligns()
    {
        var (pane, native, _, timers) = Make();

        pane.Order(new PaneOrder("0123456789ab", Rect));
        native.Calls.Clear();
        native.PaneZoomed = true;
        native.PaneFrame = new Box(0, 0, 1900, 1040);
        pane.Moved(PaneWindow);
        Assert.Empty(native.Calls);
        timers.Pass(ChromePane.SettleDelay);
        Assert.Equal(["restore", "resize 607x907", "move 1293,80", "compositor InPlace"], native.Calls);
    }

    [Fact]
    public void Settled_CompositorOffset_RepairsAndLogsIt()
    {
        var (pane, native, reports, timers) = Make();

        native.Checks.Enqueue(CompositorCheck.Repaired);
        pane.Order(new PaneOrder("0123456789ab", Rect));
        timers.Pass(ChromePane.SettleDelay);

        Assert.Contains("log pane: moved Chrome's compositor window back into place", native.Calls);
        Assert.Equal("found,shown", States(reports));
    }

    [Fact]
    public void Settled_CompositorMissingThreeTimes_FailsAndUnownsThePane()
    {
        var (pane, native, reports, timers) = Make();

        foreach (var check in new[] { CompositorCheck.Missing, CompositorCheck.Failed, CompositorCheck.Missing })
        {
            native.Checks.Enqueue(check);
        }

        pane.Order(new PaneOrder("0123456789ab", Rect));
        timers.Pass(ChromePane.SettleDelay);
        timers.Pass(ChromePane.SettleDelay);
        Assert.Equal("found,shown", States(reports));
        timers.Pass(ChromePane.SettleDelay);

        Assert.Equal("found,shown,failed", States(reports));
        Assert.Contains("drawing surface", reports[^1]["reason"]!.GetValue<string>());
        Assert.Equal("own 0", native.Calls.Last((call) => call.StartsWith("own", StringComparison.Ordinal)));

        // Stopped: moves are ignored until another marker.
        native.Calls.Clear();
        pane.Moved(AppWindow);
        pane.Order(new PaneOrder("0123456789ab", Rect));
        Assert.Empty(native.Calls);
        pane.Order(new PaneOrder("ba9876543210", Rect));
        Assert.Contains("own 10", native.Calls);
    }

    [Fact]
    public void Settled_ChromeKeepsThePaneWiderThanTheColumn_Fails()
    {
        var (pane, native, reports, timers) = Make();

        native.MinWidth = 643;
        pane.Order(new PaneOrder("0123456789ab", Rect));
        timers.Pass(ChromePane.SettleDelay);

        Assert.Equal("found,shown,failed", States(reports));
        Assert.Contains("narrower than Chrome lets the pane be", reports[^1]["reason"]!.GetValue<string>());
    }

    [Fact]
    public void Destroyed_PaneOrApp_ReportsLostAndForgetsTheWindows()
    {
        var (pane, native, reports, _) = Make();

        pane.Order(new PaneOrder("0123456789ab", Rect));
        pane.Destroyed(99);
        Assert.Equal("found,shown", States(reports));

        native.Alive = false;
        pane.Destroyed(PaneWindow);
        Assert.Equal("found,shown,lost", States(reports));
        Assert.Equal((0, 0), (pane.App, pane.Pane));
    }

    [Fact]
    public void Foreground_Pane_ReportsTheFocusUntilAnotherWindowComesForward()
    {
        var (pane, _, reports, _) = Make();

        pane.Order(new PaneOrder("0123456789ab", Rect));
        pane.Foreground(PaneWindow);
        pane.Foreground(PaneWindow);
        pane.Foreground(AppWindow);

        Assert.Equal([false, false, true, false], reports.Select((report) => report["focused"]!.GetValue<bool>()));
    }

    [Fact]
    public void Order_NoMarker_ShowsAndUnownsThePane()
    {
        var (pane, native, reports, _) = Make();

        pane.Order(new PaneOrder("0123456789ab", null));
        native.Calls.Clear();
        pane.Order(new PaneOrder(null, null));

        Assert.Equal(["show", "own 0"], native.Calls);
        Assert.Equal("found,hidden", States(reports));
    }
}
