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

    /// <summary>The work area among <paramref name="areas"/> that lies within <paramref name="monitor"/>; null when none does.</summary>
    public static PixelRect? WorkAreaOn(PixelRect monitor, IEnumerable<PixelRect> areas) =>
        areas.Cast<PixelRect?>().FirstOrDefault((area) => area is { } each && each.Width > 0 && each.Height > 0 && each.Left >= monitor.Left && each.Right <= monitor.Right && each.Top >= monitor.Top && each.Bottom <= monitor.Bottom);

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

    /// <summary>
    /// Whether an X11 strut can reserve <paramref name="strip"/> at <paramref name="edge"/> of <paramref name="monitor"/>. A strut runs from the X
    /// screen's edge to the strip, so at an edge between monitors it would also reserve the part of <paramref name="others"/> it crosses.
    /// </summary>
    public static bool CanReserve(DockEdge edge, PixelRect strip, PixelRect monitor, IEnumerable<PixelRect> others)
    {
        var strut = edge == DockEdge.Left ? strip with { Left = int.MinValue } : strip with { Right = int.MaxValue };

        return !others.Any((other) => other != monitor && other.Left < strut.Right && strut.Left < other.Right && other.Top < strut.Bottom && strut.Top < other.Bottom);
    }

    /// <summary>Whether the dock on <paramref name="monitor"/>, a RandR name, goes below other windows: a full-screen window covers that monitor.</summary>
    public static bool Below(string? monitor, IEnumerable<string> fullScreen) => monitor is not null && fullScreen.Contains(monitor);

    /// <summary>The width the inner edge of <paramref name="strip"/> has when dragged to <paramref name="x"/>; the outer edge stays.</summary>
    public static int WidthAt(DockEdge edge, PixelRect strip, int x) => edge == DockEdge.Left ? x - strip.Left : strip.Right - x;

    /// <summary>The device-independent pixels an auto-hidden dock leaves at its outer edge.</summary>
    public const double SliverWidth = 3;

    /// <summary>The part of a <paramref name="width"/> by <paramref name="height"/> window an auto-hidden dock shows, in window coordinates: its outer edge.</summary>
    public static PixelRect Sliver(DockEdge edge, int width, int height, double scale) =>
        edge == DockEdge.Left ? new(0, 0, Pixels(SliverWidth, scale), height) : new(width - Pixels(SliverWidth, scale), 0, width, height);

    /// <summary>A full-screen foreground window covers the monitor; maximized windows leave room for taskbars and app bars.</summary>
    public static bool FullScreen(PixelRect window, PixelRect monitor, bool maximized) =>
        window == monitor || (!maximized && window.Left <= monitor.Left && window.Top <= monitor.Top && window.Right >= monitor.Right && window.Bottom >= monitor.Bottom);

    /// <summary>Checks windows in front-to-back order, ignoring ordinary windows on other monitors.</summary>
    public static bool FullScreen(PixelRect monitor, IEnumerable<(PixelRect Bounds, bool Maximized, bool OnMonitor)> windows)
    {
        foreach (var window in windows)
        {
            if (FullScreen(window.Bounds, monitor, window.Maximized))
            {
                return true;
            }

            if (window.OnMonitor)
            {
                return false;
            }
        }

        return false;
    }

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
