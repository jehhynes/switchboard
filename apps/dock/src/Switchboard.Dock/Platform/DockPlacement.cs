namespace Switchboard.Dock.Platform;

/// <summary>The screen edge the dock reserves its strip at; the list is vertical, so only the left and right edges (PRD R71).</summary>
public enum DockEdge
{
    Left,
    Right,
}

/// <summary>A rectangle in physical screen pixels.</summary>
public readonly record struct PixelRect(int Left, int Top, int Right, int Bottom)
{
    public int Width => Right - Left;

    public int Height => Bottom - Top;
}

/// <summary>Where the dock goes on a monitor: the strip at an edge, the edge a drop chooses, and the width a drag on the inner edge sets.</summary>
public static class DockPlacement
{
    /// <summary>The edge a header dropped at <paramref name="x"/> docks to: the nearer of the monitor's left and right edges.</summary>
    public static DockEdge EdgeAt(int x, PixelRect monitor) => x < (monitor.Left + monitor.Right) / 2 ? DockEdge.Left : DockEdge.Right;

    /// <summary>The strip <paramref name="width"/> pixels wide at <paramref name="edge"/> of <paramref name="area"/>, as tall as the area.</summary>
    public static PixelRect Strip(DockEdge edge, PixelRect area, int width) =>
        edge == DockEdge.Left ? area with { Right = area.Left + width } : area with { Left = area.Right - width };

    /// <summary>The width the inner edge of <paramref name="strip"/> has when dragged to <paramref name="x"/>; the outer edge stays.</summary>
    public static int WidthAt(DockEdge edge, PixelRect strip, int x) => edge == DockEdge.Left ? x - strip.Left : strip.Right - x;

    /// <summary>Device-independent pixels at a monitor's scale, rounded to whole pixels.</summary>
    public static int Pixels(double dips, double scale) => (int)Math.Round(dips * scale);
}
