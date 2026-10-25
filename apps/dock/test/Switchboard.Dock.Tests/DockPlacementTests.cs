using Switchboard.Dock.Platform;

namespace Switchboard.Dock.Tests;

public sealed class DockPlacementTests
{
    // A second monitor to the right of a 1920-pixel primary one.
    static readonly PixelRect Second = new(1920, 0, 4480, 1440);

    [Theory]
    [InlineData(1921, DockEdge.Left)]
    [InlineData(3199, DockEdge.Left)]
    [InlineData(3200, DockEdge.Right)]
    [InlineData(4479, DockEdge.Right)]
    public void EdgeAt_DropOnAMonitor_ChoosesTheNearerEdge(int x, DockEdge edge) => Assert.Equal(edge, DockPlacement.EdgeAt(x, Second));

    [Fact]
    public void Strip_EachEdge_KeepsTheOuterEdgeAndTheHeight()
    {
        Assert.Equal(new PixelRect(1920, 0, 2240, 1440), DockPlacement.Strip(DockEdge.Left, Second, 320));
        Assert.Equal(new PixelRect(4160, 0, 4480, 1440), DockPlacement.Strip(DockEdge.Right, Second, 320));
    }

    [Fact]
    public void Strut_EachEdge_ReservesTheStripFromTheScreensEdgeOverItsRows()
    {
        // A strip below a 32-pixel top bar on a 1920 by 1080 screen, the end row inclusive.
        Assert.Equal([320, 0, 0, 0, 32, 1079, 0, 0, 0, 0, 0, 0], DockPlacement.Strut(DockEdge.Left, new PixelRect(0, 32, 320, 1080), 1920));
        Assert.Equal([0, 420, 0, 0, 0, 0, 32, 1079, 0, 0, 0, 0], DockPlacement.Strut(DockEdge.Right, new PixelRect(1500, 32, 1920, 1080), 1920));
    }

    [Fact]
    public void CanReserve_MonitorsStacked_ReservesEachEdge()
    {
        // A 5120 by 2880 monitor above a 3840 by 2160 one that starts 1280 pixels in; the gap left of the lower one is no monitor.
        PixelRect top = new(0, 0, 5120, 2880), bottom = new(1280, 2880, 5120, 5040);
        PixelRect[] all = [top, bottom];

        Assert.True(DockPlacement.CanReserve(DockEdge.Left, new PixelRect(0, 0, 640, 2880), top, all));
        Assert.True(DockPlacement.CanReserve(DockEdge.Right, new PixelRect(4480, 0, 5120, 2880), top, all));
        Assert.True(DockPlacement.CanReserve(DockEdge.Left, new PixelRect(1280, 2880, 1920, 5040), bottom, all));
        Assert.True(DockPlacement.CanReserve(DockEdge.Right, new PixelRect(4480, 2880, 5120, 5040), bottom, all));
    }

    [Fact]
    public void CanReserve_EdgeBetweenMonitorsSideBySide_DoesNotReserve()
    {
        PixelRect left = new(0, 0, 1920, 1080), right = new(1920, 0, 4480, 1440);
        PixelRect[] all = [left, right];

        Assert.False(DockPlacement.CanReserve(DockEdge.Right, new PixelRect(1600, 0, 1920, 1080), left, all));
        Assert.False(DockPlacement.CanReserve(DockEdge.Left, new PixelRect(1920, 0, 2240, 1440), right, all));
        Assert.True(DockPlacement.CanReserve(DockEdge.Left, new PixelRect(0, 0, 320, 1080), left, all));
        Assert.True(DockPlacement.CanReserve(DockEdge.Right, new PixelRect(4160, 0, 4480, 1440), right, all));
        // The right monitor's rows below the left one have no monitor to their left.
        Assert.True(DockPlacement.CanReserve(DockEdge.Left, new PixelRect(1920, 1080, 2240, 1440), right, all));
    }

    [Fact]
    public void WorkAreaOn_MutterWorkAreas_TakesTheMonitorsOwn()
    {
        // The upper monitor has a 96-pixel panel at its bottom; the lower one's work area leaves out a dock strip at its left.
        PixelRect[] areas = [new(1912, 2880, 5120, 5040), new(0, 0, 5120, 2784)];

        Assert.Equal(new PixelRect(0, 0, 5120, 2784), DockPlacement.WorkAreaOn(new PixelRect(0, 0, 5120, 2880), areas));
        Assert.Equal(new PixelRect(1912, 2880, 5120, 5040), DockPlacement.WorkAreaOn(new PixelRect(1280, 2880, 5120, 5040), areas));
        Assert.Null(DockPlacement.WorkAreaOn(new PixelRect(5120, 0, 7680, 1440), areas));
        Assert.Null(DockPlacement.WorkAreaOn(new PixelRect(0, 0, 5120, 2880), []));
    }

    [Fact]
    public void Below_FullScreenOnTheDocksMonitorOnly_GoesBelow()
    {
        Assert.True(DockPlacement.Below("HDMI-2", ["HDMI-1", "HDMI-2"]));
        Assert.False(DockPlacement.Below("HDMI-2", ["HDMI-1"]));
        Assert.False(DockPlacement.Below("HDMI-2", []));
        Assert.False(DockPlacement.Below(null, ["HDMI-1"]));
    }

    [Fact]
    public void WidthAt_DragOfTheInnerEdge_MeasuresFromTheOuterEdge()
    {
        Assert.Equal(400, DockPlacement.WidthAt(DockEdge.Left, new PixelRect(1920, 0, 2240, 1440), 2320));
        Assert.Equal(400, DockPlacement.WidthAt(DockEdge.Right, new PixelRect(4160, 0, 4480, 1440), 4080));
    }

    [Theory]
    [InlineData(320, 1.0, 320)]
    [InlineData(40, 1.75, 70)]
    [InlineData(259, 1.75, 453)]
    public void Pixels_Scale_RoundsToWholePixels(double dips, double scale, int pixels) => Assert.Equal(pixels, DockPlacement.Pixels(dips, scale));

    [Theory]
    [InlineData(1, 3)]
    [InlineData(1.5, 4)]
    [InlineData(1.75, 5)]
    [InlineData(2, 6)]
    public void Sliver_EachEdge_KeepsThreeScaledPixels(double scale, int pixels)
    {
        Assert.Equal(new PixelRect(0, 0, pixels, 1440), DockPlacement.Sliver(DockEdge.Left, 320, 1440, scale));
        Assert.Equal(new PixelRect(320 - pixels, 0, 320, 1440), DockPlacement.Sliver(DockEdge.Right, 320, 1440, scale));
    }

    [Fact]
    public void FullScreen_ForegroundBounds_YieldsOnlyWhenTheDockMonitorIsCovered()
    {
        var monitor = new PixelRect(1920, 0, 3840, 1080);
        Assert.True(DockPlacement.FullScreen(monitor, monitor, false));
        Assert.True(DockPlacement.FullScreen(monitor, monitor, true));
        Assert.True(DockPlacement.FullScreen(new PixelRect(1900, 0, 3900, 1080), monitor, false));
        Assert.False(DockPlacement.FullScreen(new PixelRect(1912, -8, 3848, 1048), monitor, true));
        Assert.False(DockPlacement.FullScreen(new PixelRect(1912, -8, 3848, 1088), monitor, true));
        Assert.False(DockPlacement.FullScreen(new PixelRect(0, 0, 1920, 1080), monitor, false));
        Assert.False(DockPlacement.FullScreen(new PixelRect(2000, 100, 3000, 900), monitor, false));
    }

    [Fact]
    public void FullScreen_WindowOrder_KeepsYieldingWhenAnotherMonitorGainsFocus()
    {
        var monitor = new PixelRect(1920, 0, 3840, 1080);
        var other = (new PixelRect(100, 100, 1000, 900), false, false);
        var full = (monitor, false, true);
        var ordinary = (new PixelRect(2000, 100, 3000, 900), false, true);

        Assert.True(DockPlacement.FullScreen(monitor, [other, full]));
        Assert.False(DockPlacement.FullScreen(monitor, [other, ordinary, full]));
        Assert.False(DockPlacement.FullScreen(monitor, [other]));
        Assert.False(DockPlacement.FullScreen(monitor, []));
    }

    static readonly TimeSpan Start = TimeSpan.FromSeconds(10);

    [Fact]
    public void HideDelay_NotKeptForTheDelay_Hides()
    {
        var delay = new HideDelay();

        Assert.False(delay.Hides(false, Start));
        Assert.False(delay.Hides(false, Start + TimeSpan.FromMilliseconds(399)));
        Assert.True(delay.Hides(false, Start + HideDelay.Delay));
    }

    [Fact]
    public void HideDelay_KeptInBetween_StartsTheDelayAgain()
    {
        var delay = new HideDelay();

        delay.Hides(false, Start);
        Assert.False(delay.Hides(true, Start + TimeSpan.FromMilliseconds(300)));
        Assert.False(delay.Hides(false, Start + TimeSpan.FromMilliseconds(500)));
        Assert.False(delay.Hides(false, Start + TimeSpan.FromMilliseconds(899)));
        Assert.True(delay.Hides(false, Start + TimeSpan.FromMilliseconds(900)));
    }

    [Fact]
    public void HideDelay_Reset_StartsTheDelayAgain()
    {
        var delay = new HideDelay();

        delay.Hides(false, Start);
        delay.Reset();

        Assert.False(delay.Hides(false, Start + HideDelay.Delay));
    }

    // The dock is 1; a dialog 3 is owned by the dock, a submenu 5 by a menu 4 owned by the dock, and 7 by an unrelated 6.
    static nint OwnerOf(nint window) => window switch { 3 => 1, 4 => 1, 5 => 4, 7 => 6, _ => 0 };

    [Theory]
    [InlineData(1, true)]
    [InlineData(3, true)]
    [InlineData(5, true)]
    [InlineData(7, false)]
    [InlineData(0, false)]
    public void OwnedBy_OwnerChain_ReachesTheDockOnlyThroughItsOwners(int window, bool owned) => Assert.Equal(owned, HideDelay.OwnedBy(window, 1, OwnerOf));

    [Fact]
    public void OwnedBy_OwnersInALoop_StopsWithoutReachingTheDock()
    {
        var asked = 0;

        // 8 and 9 own each other, as X11 owner hints can.
        Assert.False(HideDelay.OwnedBy(8, 1, (window) =>
        {
            // Fails fast instead of hanging if the walk does not stop.
            Assert.True(++asked <= 100);
            return window == 8 ? 9 : 8;
        }));
    }
}
