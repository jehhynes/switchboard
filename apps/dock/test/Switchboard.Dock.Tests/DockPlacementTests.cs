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

    [Fact]
    public void Sliver_EachEdge_KeepsTheOuterTwoPixels()
    {
        Assert.Equal(new PixelRect(0, 0, 2, 1440), DockPlacement.Sliver(DockEdge.Left, 320, 1440));
        Assert.Equal(new PixelRect(318, 0, 320, 1440), DockPlacement.Sliver(DockEdge.Right, 320, 1440));
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
}
