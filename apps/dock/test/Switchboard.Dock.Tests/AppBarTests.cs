using Switchboard.Dock.Platform;

namespace Switchboard.Dock.Tests;

public sealed class AppBarTests
{
    // A 453-pixel strip, the width a 259-unit dock takes at 175% scaling, on a 2160-pixel-high monitor.
    static readonly Native.Rect Strip = new() { Left = 0, Top = 0, Right = 453, Bottom = 2160 };

    [Fact]
    public void Hold_MoveIntoTheWorkArea_KeepsTheWindowInItsStrip()
    {
        // Avalonia's resize, rounded to 452 pixels, moving the window to where the work area starts.
        var position = new Native.WindowPos { X = 453, Y = 0, Width = 452, Height = 2160 };

        Assert.True(AppBar.Hold(ref position, Strip));
        Assert.Equal((0, 0, 453, 2160), (position.X, position.Y, position.Width, position.Height));
    }

    [Fact]
    public void Hold_MoveOnly_KeepsTheSizeTheCallerLeftAlone()
    {
        var position = new Native.WindowPos { X = 600, Y = 40, Width = 7, Height = 9, Flags = Native.SwpNoSize };

        Assert.True(AppBar.Hold(ref position, Strip));
        Assert.Equal((0, 0, 7, 9), (position.X, position.Y, position.Width, position.Height));
    }

    [Fact]
    public void Hold_ZOrderChangeOnly_ChangesNothing()
    {
        var position = new Native.WindowPos { X = 5, Y = 6, Width = 7, Height = 8, Flags = Native.SwpNoMove | Native.SwpNoSize };

        Assert.False(AppBar.Hold(ref position, Strip));
        Assert.Equal((5, 6, 7, 8), (position.X, position.Y, position.Width, position.Height));
    }

    [Fact]
    public void Hold_PositionAlreadyInTheStrip_ReportsNoChange()
    {
        var position = new Native.WindowPos { X = 0, Y = 0, Width = 453, Height = 2160 };

        Assert.False(AppBar.Hold(ref position, Strip));
    }
}
