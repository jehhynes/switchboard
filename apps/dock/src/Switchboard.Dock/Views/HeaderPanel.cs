using Avalonia;
using Avalonia.Controls;

namespace Switchboard.Dock.Views;

/// <summary>
/// The title row: children left to right, the first taking the width the others leave. The others keep their width from the right, so Close
/// and the header's buttons always show on a narrow dock; one that no longer fits whole is hidden rather than cut.
/// </summary>
public sealed class HeaderPanel : Panel
{
    protected override Size MeasureOverride(Size availableSize)
    {
        var height = 0.0;
        var used = 0.0;

        foreach (var child in Children.Skip(1))
        {
            child.Measure(new Size(double.PositiveInfinity, availableSize.Height));
            used += child.DesiredSize.Width;
            height = Math.Max(height, child.DesiredSize.Height);
        }

        if (Children.Count > 0)
        {
            var rest = double.IsInfinity(availableSize.Width) ? double.PositiveInfinity : Math.Max(0, availableSize.Width - used);

            Children[0].Measure(new Size(rest, availableSize.Height));
            height = Math.Max(height, Children[0].DesiredSize.Height);
            used += Children[0].DesiredSize.Width;
        }

        return new Size(double.IsInfinity(availableSize.Width) ? used : Math.Min(used, availableSize.Width), height);
    }

    protected override Size ArrangeOverride(Size finalSize)
    {
        var right = finalSize.Width;

        for (var index = Children.Count - 1; index >= 1; index--)
        {
            var child = Children[index];
            var width = child.DesiredSize.Width;

            if (right - width < 0)
            {
                child.Arrange(default);
                right = 0;
                continue;
            }

            right -= width;
            child.Arrange(new Rect(right, 0, width, finalSize.Height));
        }

        if (Children.Count > 0)
        {
            Children[0].Arrange(new Rect(0, 0, right, finalSize.Height));
        }

        return finalSize;
    }
}
