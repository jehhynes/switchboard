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

    /// <summary>
    /// The X11 <c>_NET_WM_STRUT_PARTIAL</c> that reserves <paramref name="strip"/> at <paramref name="edge"/> of an X screen <paramref name="screenWidth"/>
    /// pixels wide: the left, right, top and bottom widths from the screen's edges, then the rows or columns each covers, the end inclusive.
    /// </summary>
    public static nint[] Strut(DockEdge edge, PixelRect strip, int screenWidth) => edge == DockEdge.Left
        ? [strip.Right, 0, 0, 0, strip.Top, strip.Bottom - 1, 0, 0, 0, 0, 0, 0]
        : [0, screenWidth - strip.Left, 0, 0, 0, 0, strip.Top, strip.Bottom - 1, 0, 0, 0, 0];

    /// <summary>The width the inner edge of <paramref name="strip"/> has when dragged to <paramref name="x"/>; the outer edge stays.</summary>
    public static int WidthAt(DockEdge edge, PixelRect strip, int x) => edge == DockEdge.Left ? x - strip.Left : strip.Right - x;

    /// <summary>The pixels an auto-hidden dock leaves on screen at its outer edge, as many as the Windows taskbar leaves.</summary>
    public const int SliverWidth = 2;

    /// <summary>The part of a <paramref name="width"/> by <paramref name="height"/> window an auto-hidden dock shows, in window coordinates: its outer edge.</summary>
    public static PixelRect Sliver(DockEdge edge, int width, int height) =>
        edge == DockEdge.Left ? new(0, 0, SliverWidth, height) : new(width - SliverWidth, 0, width, height);

    /// <summary>Device-independent pixels at a monitor's scale, rounded to whole pixels.</summary>
    public static int Pixels(double dips, double scale) => (int)Math.Round(dips * scale);
}

/// <summary>
/// When a shown auto-hidden dock hides again (PRD R71): once nothing has kept it open, neither the pointer, its focus nor a drag, for <see cref="Delay"/>.
/// </summary>
public sealed class HideDelay
{
    public static readonly TimeSpan Delay = TimeSpan.FromMilliseconds(400);

    TimeSpan? since;

    /// <summary>Records whether the dock is kept open at <paramref name="now"/>, a monotonic time; returns whether it should hide.</summary>
    public bool Hides(bool kept, TimeSpan now)
    {
        if (kept)
        {
            since = null;
            return false;
        }

        since ??= now;

        return now - since >= Delay;
    }

    /// <summary>Starts over, as when the dock shows.</summary>
    public void Reset() => since = null;

    /// <summary>
    /// Whether <paramref name="window"/>, a top-level window, is the dock or owned by it through any chain of owners: its menus are owned popups
    /// and its dialogs owned windows, whose root owner is themselves.
    /// </summary>
    public static bool OwnedBy(nint window, nint dock, Func<nint, nint> ownerOf)
    {
        for (var at = window; at != 0; at = ownerOf(at))
        {
            if (at == dock)
            {
                return true;
            }
        }

        return false;
    }
}
