namespace Switchboard.PaneHelper;

/// <summary>The page's right column as the hub passes it on: <c>getBoundingClientRect</c> in CSS pixels, the page's scale and its viewport.</summary>
public sealed record PaneRect(double Left, double Top, double Width, double Height, double Dpr, double InnerWidth, double InnerHeight);

/// <summary>The hub's <c>pane</c> event: the handshake marker, or null for no pane, and the column, or null to hide the pane.</summary>
public sealed record PaneOrder(string? Marker, PaneRect? Rect);

/// <summary>A rectangle in physical screen pixels.</summary>
public readonly record struct Box(int Left, int Top, int Right, int Bottom)
{
    public int Width => Right - Left;

    public int Height => Bottom - Top;
}

/// <summary>Where the Chrome pane goes (architecture.md § Pane helper), as pure arithmetic.</summary>
public static class PaneGeometry
{
    /// <summary>
    /// The column on screen, in physical pixels: the page's viewport sits at the bottom of the app window's visible frame, inset on each side by
    /// half of what the viewport leaves of the frame's width (mechanics M103).
    /// </summary>
    public static Box Column(Box appFrame, PaneRect rect)
    {
        var side = Math.Max(0, (appFrame.Width - rect.InnerWidth * rect.Dpr) / 2);
        var left = appFrame.Left + side;
        var top = appFrame.Bottom - side - rect.InnerHeight * rect.Dpr;

        return new Box(
            (int)Math.Round(left + rect.Left * rect.Dpr),
            (int)Math.Round(top + rect.Top * rect.Dpr),
            (int)Math.Round(left + (rect.Left + rect.Width) * rect.Dpr),
            (int)Math.Round(top + (rect.Top + rect.Height) * rect.Dpr));
    }

    /// <summary>
    /// Where the pane's visible frame goes: the column, with its right and bottom edges pulled in so that the pane window's invisible resize
    /// borders end at the app window's visible frame. The app window's own resize borders lie outside its visible frame (mechanics M103), so the
    /// pointer still reaches them to resize the app from its right or bottom edge or corner. A maximized app window has none to keep clear.
    /// </summary>
    public static Box Inset(Box column, Box appFrame, Box paneFrame, Box paneBounds, bool appMaximized) =>
        appMaximized
            ? column
            : column with
            {
                Right = Math.Min(column.Right, appFrame.Right - (paneBounds.Right - paneFrame.Right)),
                Bottom = Math.Min(column.Bottom, appFrame.Bottom - (paneBounds.Bottom - paneFrame.Bottom)),
            };

    /// <summary>
    /// The window rectangle that puts the pane's visible frame on <paramref name="target"/>: <c>GetWindowRect</c> includes the invisible resize
    /// borders that the DWM frame leaves out, read fresh each time since they change with the monitor's scale.
    /// </summary>
    public static Box Placement(Box target, Box paneFrame, Box paneBounds) =>
        new(target.Left - (paneFrame.Left - paneBounds.Left), target.Top - (paneFrame.Top - paneBounds.Top), target.Right + (paneBounds.Right - paneFrame.Right), target.Bottom + (paneBounds.Bottom - paneFrame.Bottom));
}
