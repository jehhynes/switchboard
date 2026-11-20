using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.VisualTree;

namespace Switchboard.Dock.Views;

/// <summary>
/// A row's line 2 (PRD R27, R52): its children left to right, the one with the &lt;c&gt;fill&lt;/c&gt; class, the playbook, taking the width the others leave
/// and ending in an ellipsis. When the line has too little room its pills shrink to their icon, with their full text in their tooltip, rather
/// than being cut: the longest first, while the playbook keeps its width; then the rest, longest first, once the playbook is down to
/// &lt;see cref="FillMin"/&gt;; Returned last. A pill of &lt;see cref="ShortPill"/&gt; or less keeps its text until the playbook is that short. A pill's
/// label is never cut: pills that do not fit even as icons are left out whole, the last first, and Returned only when it alone does not fit.
/// </summary>
public sealed class PillLine : Panel
{
    public static readonly StyledProperty<double> SpacingProperty = AvaloniaProperty.Register<PillLine, double>(nameof(Spacing));

    /// <summary>A pill this wide or narrower, such as &lt;c&gt;gh 107&lt;/c&gt;, keeps its text while a longer one can shrink instead.</summary>
    public const double ShortPill = 56;

    /// <summary>The width the playbook keeps, or its whole width when shorter, before the short pills shrink.</summary>
    public const double FillMin = 60;

    public double Spacing
    {
        get => GetValue(SpacingProperty);
        set => SetValue(SpacingProperty, value);
    }

    // The width the fill child gets, which the arrange gives it.
    double fillWidth;

    static PillLine() => AffectsMeasure<PillLine>(SpacingProperty);

    /// <summary>The pills, the borders with the &lt;c&gt;pill&lt;/c&gt; class among the children and their descendants, that show.</summary>
    List<Border> Pills() =>
        Children.Where((child) => child.IsVisible).SelectMany((child) => child.GetSelfAndVisualDescendants()).OfType<Border>()
            .Where((border) => border.Classes.Contains("pill") && border.GetSelfAndVisualAncestors().TakeWhile((visual) => visual != this).All((visual) => visual is not Visual { IsVisible: false })).ToList();

    void SetCompact(Border pill, bool compact) => SetClass(pill, "compact", compact);

    /// <summary>Sets a pill's class, such as its compact state, and has the controls between it and the line measure again.</summary>
    void SetClass(Border pill, string name, bool on)
    {
        if (pill.Classes.Contains(name) == on)
        {
            return;
        }

        pill.Classes.Set(name, on);

        for (var visual = (Visual?)pill; visual is not null && visual != this; visual = visual.GetVisualParent())
        {
            (visual as Layoutable)?.InvalidateMeasure();
        }
    }

    // The width the last measure decided the pills for.
    double measuredFor = double.PositiveInfinity;

    /// <summary>A child that shows nothing: hidden, or holding only pills that are left out, such as the links once none fits.</summary>
    static bool Empty(Control child)
    {
        if (!child.IsVisible)
        {
            return true;
        }

        var pills = child.GetSelfAndVisualDescendants().OfType<Border>().Where((border) => border.Classes.Contains("pill")).ToList();

        return child is not Border && pills.Count > 0 && pills.All((pill) => !pill.IsVisible);
    }

    protected override Size MeasureOverride(Size availableSize)
    {
        measuredFor = availableSize.Width;

        var height = availableSize.Height;

        // Each measure starts from whole pills, so they show whole again when the line widens; the children are read after, so a pill shown
        // again counts.
        foreach (var pill in Children.SelectMany((child) => child.GetSelfAndVisualDescendants()).OfType<Border>().Where((border) => border.Classes.Contains("overflow")).ToList())
        {
            SetClass(pill, "overflow", false);
        }

        var shown = Children.Where((child) => child.IsVisible).ToList();
        var fill = shown.FirstOrDefault((child) => child.Classes.Contains("fill"));
        var parts = 0;

        foreach (var pill in Pills())
        {
            SetCompact(pill, false);
        }

        double Others()
        {
            foreach (var child in shown.Where((child) => child != fill))
            {
                child.Measure(new Size(double.PositiveInfinity, height));
            }

            var showing = shown.Where((child) => child != fill && !Empty(child)).ToList();

            parts = showing.Count;

            return (Math.Max(0, parts - 1) * Spacing) + showing.Sum((child) => child.DesiredSize.Width);
        }

        // The playbook's width with its spacing, or nothing when it gets no width, so a line of only pills spends no space on it.
        double FillPart(double width) => width > 0 ? width + (parts > 0 ? Spacing : 0) : 0;

        var others = Others();
        fill?.Measure(new Size(double.PositiveInfinity, height));
        var fillFull = fill?.DesiredSize.Width ?? 0;

        if (!double.IsInfinity(availableSize.Width) && others + fillFull > availableSize.Width)
        {
            var room = availableSize.Width;
            var pills = Pills();
            var widths = pills.ToDictionary((pill) => pill, (pill) =>
            {
                var full = pill.DesiredSize.Width;

                SetCompact(pill, true);
                pill.Measure(new Size(double.PositiveInfinity, height));
                var compact = pill.DesiredSize.Width;
                SetCompact(pill, false);
                pill.Measure(new Size(double.PositiveInfinity, height));

                return (Full: full, Saves: Math.Max(0, full - compact));
            });
            var order = pills.Where((pill) => !pill.Classes.Contains("returned")).OrderByDescending((pill) => widths[pill].Full).ToList();
            HashSet<Border> compacted = [];

            void Shrink(IEnumerable<Border> candidates, double fillWidth)
            {
                foreach (var pill in candidates.Where((pill) => !compacted.Contains(pill)))
                {
                    if (others + FillPart(fillWidth) <= room)
                    {
                        return;
                    }

                    compacted.Add(pill);
                    others -= widths[pill].Saves;
                }
            }

            Shrink(order.Where((pill) => widths[pill].Full > ShortPill), fillFull);
            Shrink(order, Math.Min(fillFull, FillMin));
            Shrink(pills.Where((pill) => pill.Classes.Contains("returned")), Math.Min(fillFull, FillMin));

            foreach (var pill in compacted)
            {
                SetCompact(pill, true);
            }

            others = Others();

            // Pills that do not fit even as icons are left out whole rather than cut, the last first and Returned only when it alone does not fit.
            foreach (var pill in pills.Where((pill) => !pill.Classes.Contains("returned")).Reverse().Concat(pills.Where((pill) => pill.Classes.Contains("returned"))))
            {
                if (others <= room)
                {
                    break;
                }

                SetClass(pill, "overflow", true);
                others = Others();
            }
        }

        var total = others;

        if (fill is not null)
        {
            fillWidth = double.IsInfinity(availableSize.Width) ? fillFull : Math.Max(0, Math.Min(fillFull, availableSize.Width - others - (parts > 0 ? Spacing : 0)));
            fill.Measure(new Size(fillWidth, height));
            total += FillPart(fillWidth);
        }

        var tallest = shown.Select((child) => child.DesiredSize.Height).DefaultIfEmpty(0).Max();

        return new Size(double.IsInfinity(availableSize.Width) ? total : Math.Min(total, availableSize.Width), tallest);
    }

    protected override Size ArrangeOverride(Size finalSize)
    {
        // A parent can arrange the line narrower than it measured it, as a row's Grid does once its buttons show, so the pills are decided again
        // for the width the line gets.
        if (finalSize.Width < measuredFor - 0.5)
        {
            MeasureOverride(finalSize);
        }

        var x = 0.0;
        var first = true;

        foreach (var child in Children)
        {
            var isFill = child.Classes.Contains("fill");
            var width = isFill ? fillWidth : child.DesiredSize.Width;

            // A child that shows nothing, or the playbook with no width, takes no place and no spacing.
            if ((!isFill && Empty(child)) || (isFill && width <= 0))
            {
                child.Arrange(default);
                continue;
            }

            x += first ? 0 : Spacing;
            first = false;
            child.Arrange(new Rect(x, 0, width, finalSize.Height));
            x += width;
        }

        return finalSize;
    }
}
