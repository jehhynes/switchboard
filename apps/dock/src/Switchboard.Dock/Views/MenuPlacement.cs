using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Controls.Primitives.PopupPositioning;

namespace Switchboard.Dock.Views;

/// <summary>A monitor's bounds and work area, in physical pixels, and its scale.</summary>
internal readonly record struct MenuScreen(PixelRect Bounds, PixelRect WorkArea, double Scaling = 1);

/// <summary>The monitor at <paramref name="point"/>, in physical pixels, for a menu opened from <paramref name="visual"/>; null when none is known.</summary>
internal delegate MenuScreen? MenuScreenAt(Visual visual, PixelPoint point);

/// <summary>
/// Keeps a dock menu and its submenus on the monitor it opens on (architecture.md § Dock). The menu may take the monitor's work area, widened to the
/// monitor's edge on the dock's side, since the work area leaves out the dock's own strip: it is at most that wide and tall, so a taller menu scrolls,
/// and it opens away from the dock's edge and downward, else on the other side or upward when only that fits, else as near as fits. Avalonia's own
/// limits do not do this: on Windows a popup is at most the size of the work area of the monitor it was created on, the primary's or, on a narrow
/// monitor, the work area beside the dock's strip, and a horizontal adjustment would move the menu beside the dock.
/// </summary>
internal sealed class MenuPlacement(bool dockOnRight, Point at, MenuScreenAt screenAt)
{
    /// <summary>The Fluent theme's overlap of a submenu with its item.</summary>
    internal const double SubmenuOverlap = 4;

    /// <summary>Where the menu may go, in physical pixels; found as the menu opens.</summary>
    PixelRect? area;

    /// <summary>The scale of that monitor, which a popup takes once it is placed there, whatever scale it was created at.</summary>
    double areaScale = 1;

    /// <summary>
    /// A menu of <paramref name="items"/> at <paramref name="at"/> in the control it opens on, opening away from the screen edge the dock is on.
    /// With no monitor known it opens at that point, away from the dock's edge, adjusted only vertically, as its properties say.
    /// </summary>
    internal static ContextMenu Menu(IReadOnlyList<Control> items, bool dockOnRight, Point at, MenuScreenAt? screenAt = null)
    {
        var placement = new MenuPlacement(dockOnRight, at, screenAt ?? ScreenOf);
        var menu = new ContextMenu
        {
            ItemsSource = items,
            Placement = PlacementMode.Custom,
            PlacementRect = new Rect(at, new Size(1, 1)),
            PlacementAnchor = PopupAnchor.TopLeft,
            PlacementGravity = dockOnRight ? PopupGravity.BottomLeft : PopupGravity.BottomRight,
            PlacementConstraintAdjustment = PopupPositionerConstraintAdjustment.FlipY | PopupPositionerConstraintAdjustment.SlideY,
        };

        menu.CustomPopupPlacementCallback = (custom) => placement.PlaceMenu(custom, menu);
        // ContextMenu.Open makes the menu its popup's child, with the control it opens on as the popup's parent, before the popup opens: the
        // last moment to limit the popup's size.
        menu.AttachedToLogicalTree += (_, _) =>
        {
            if (menu.Parent is Popup popup && popup.Parent is Visual target)
            {
                placement.Opening(popup, target);
            }
        };
        placement.Submenus(items);

        return menu;
    }

    /// <summary>Avalonia's monitor at <paramref name="point"/>, else the one <paramref name="visual"/> is on.</summary>
    internal static MenuScreen? ScreenOf(Visual visual, PixelPoint point) =>
        TopLevel.GetTopLevel(visual)?.Screens is { } screens && (screens.ScreenFromPoint(point) ?? screens.ScreenFromVisual(visual)) is { } screen
            ? new MenuScreen(screen.Bounds, screen.WorkingArea, screen.Scaling)
            : null;

    /// <summary>
    /// The area a menu may take on <paramref name="screen"/>: the work area's top and bottom, its far side from the dock, and the monitor's edge on
    /// the dock's side, or the monitor's bounds when it reports no work area.
    /// </summary>
    internal static PixelRect Area(MenuScreen screen, bool dockOnRight)
    {
        var (bounds, work, _) = screen;

        if (work.Width <= 0 || work.Height <= 0)
        {
            return bounds;
        }

        var left = dockOnRight ? work.X : bounds.X;
        var right = dockOnRight ? bounds.Right : work.Right;

        return new PixelRect(left, work.Y, right - left, work.Height);
    }

    /// <summary>
    /// The top left corner, in pixels, of a menu of <paramref name="size"/> beside <paramref name="anchor"/> (a point for a menu, its item for a
    /// submenu, which it overlaps by <paramref name="overlap"/>): toward the right when <paramref name="towardRight"/>, else toward the left, and
    /// from the anchor's top down; on the other side, or up from its bottom, when only that fits in <paramref name="area"/>; else moved into it.
    /// </summary>
    internal static PixelPoint Fit(Rect anchor, Size size, bool towardRight, double overlap, PixelRect area)
    {
        var right = anchor.Right - overlap;
        var left = anchor.Left - size.Width + overlap;
        var x = Choose(towardRight ? right : left, towardRight ? left : right, size.Width, area.X, area.Right);
        var y = Choose(anchor.Top, anchor.Bottom - size.Height, size.Height, area.Y, area.Bottom);

        return new PixelPoint((int)Math.Round(x), (int)Math.Round(y));
    }

    static double Choose(double first, double second, double length, double min, double max) =>
        first >= min && first + length <= max ? first
        : second >= min && second + length <= max ? second
        : Math.Max(min, Math.Min(first, max - length));

    /// <summary>Finds the area on the monitor at the menu's anchor and limits the menu's popup to it.</summary>
    void Opening(Popup popup, Visual target)
    {
        var screen = screenAt(target, target.PointToScreen(at));

        area = screen is { } found ? Area(found, dockOnRight) : null;
        areaScale = screen is { Scaling: > 0 } scaled ? scaled.Scaling : 1;
        Limit(popup);
    }

    /// <summary>
    /// Limits <paramref name="popup"/> to the area, in device-independent pixels at the monitor's scale, before it opens: a submenu's parent popup can
    /// still have the scale of the monitor it was created on.
    /// </summary>
    void Limit(Popup popup)
    {
        if (area is { } bounds)
        {
            popup.MaxWidth = bounds.Width / areaScale;
            popup.MaxHeight = bounds.Height / areaScale;
        }
    }

    /// <summary>The menu's submenus, and theirs, open away from the dock's edge and fit as the menu does.</summary>
    void Submenus(IEnumerable<object?> items)
    {
        foreach (var item in items.OfType<MenuItem>().Where((item) => item.ItemsSource is not null))
        {
            item.TemplateApplied += (_, e) =>
            {
                if (e.NameScope.Find<Popup>("PART_Popup") is { } popup)
                {
                    // PlaceSubmenu fits it; the vertical adjustment is used only when no monitor is known.
                    popup.Placement = PlacementMode.Custom;
                    popup.PlacementConstraintAdjustment = PopupPositionerConstraintAdjustment.FlipY | PopupPositionerConstraintAdjustment.SlideY;
                    popup.CustomPopupPlacementCallback = (custom) => PlaceSubmenu(custom, popup);
                    Limit(popup);
                }
            };
            Submenus(item.ItemsSource!.Cast<object?>());
        }
    }

    void PlaceMenu(CustomPopupPlacement placement, ContextMenu menu)
    {
        if (Frame(placement.Target, menu) is not var (top, scale, bounds))
        {
            // At the anchor, which Avalonia would move to the control's corner when it lies on the control's edge, as below a button.
            if (TopLevel.GetTopLevel(placement.Target) is { } window && placement.Target.TranslatePoint(at, window) is { } inWindow)
            {
                placement.AnchorRectangle = new Rect(inWindow, new Size(1, 1));
            }

            placement.Anchor = PopupAnchor.TopLeft;
            placement.Gravity = dockOnRight ? PopupGravity.BottomLeft : PopupGravity.BottomRight;
            return;
        }

        var point = placement.Target.PointToScreen(at);

        Place(placement, top, scale, Fit(new Rect(point.X, point.Y, 0, 0), Pixels(placement, scale), !dockOnRight, 0, bounds));
    }

    void PlaceSubmenu(CustomPopupPlacement placement, Popup popup)
    {
        var target = placement.Target;

        if (Frame(target, popup.Child) is not var (top, scale, bounds))
        {
            placement.Anchor = dockOnRight ? PopupAnchor.TopLeft : PopupAnchor.TopRight;
            placement.Gravity = dockOnRight ? PopupGravity.BottomLeft : PopupGravity.BottomRight;
            placement.Offset = new Point(dockOnRight ? SubmenuOverlap : -SubmenuOverlap, 0);
            return;
        }

        var from = target.PointToScreen(default);
        var to = target.PointToScreen(new Point(target.Bounds.Width, target.Bounds.Height));
        var anchor = new Rect(from.X, from.Y, to.X - from.X, to.Y - from.Y);

        Place(placement, top, scale, Fit(anchor, Pixels(placement, scale), !dockOnRight, SubmenuOverlap * scale, bounds));
    }

    /// <summary>
    /// The window a popup is placed in, its scale and the area to fit in: the monitor's, or the window's own when the popup is drawn inside the
    /// window rather than as a window of its own, as on a platform without popup windows. Null when no monitor is known.
    /// </summary>
    (TopLevel Top, double Scale, PixelRect Area)? Frame(Visual target, Control? child)
    {
        if (TopLevel.GetTopLevel(target) is not { } top || area is not { } bounds)
        {
            return null;
        }

        var scale = Scale(top);

        if (child is not null && TopLevel.GetTopLevel(child) is not PopupRoot)
        {
            var origin = top.PointToScreen(default);

            bounds = new PixelRect(origin, PixelSize.FromSize(top.ClientSize, scale));
        }

        return (top, scale, bounds);
    }

    /// <summary>The popup positioner's scale: the desktop scale of the window it is placed in.</summary>
    static double Scale(TopLevel top) => top is WindowBase window ? window.DesktopScaling : top.RenderScaling;

    static Size Pixels(CustomPopupPlacement placement, double scale) => placement.PopupSize.Deflate(placement.Deflate) * scale;

    /// <summary>Places the popup's top left corner at <paramref name="corner"/>, with no adjustment by Avalonia.</summary>
    static void Place(CustomPopupPlacement placement, TopLevel top, double scale, PixelPoint corner)
    {
        var origin = top.PointToScreen(default);

        placement.AnchorRectangle = new Rect((corner.X - origin.X) / scale, (corner.Y - origin.Y) / scale, 1, 1);
        placement.Anchor = PopupAnchor.TopLeft;
        placement.Gravity = PopupGravity.BottomRight;
        placement.Offset = default;
        placement.ConstraintAdjustment = PopupPositionerConstraintAdjustment.None;
    }
}
