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
}
