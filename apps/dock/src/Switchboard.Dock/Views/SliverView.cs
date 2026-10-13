using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;

namespace Switchboard.Dock.Views;

/// <summary>A row's stripe as the hidden dock's sliver shows it: its top and height in the sliver, and its colour.</summary>
public readonly record struct SliverBar(double Top, double Height, IBrush Brush);

/// <summary>
/// The hidden dock's sliver (PRD R71): the dock's background with the stripe of each row in view at that row's height. It draws instead of laying out,
/// so new bars after each layout cause no further layout.
/// </summary>
public sealed class SliverView : Control
{
    public static readonly StyledProperty<IBrush?> BackgroundProperty = Border.BackgroundProperty.AddOwner<SliverView>();

    IReadOnlyList<SliverBar> bars = [];

    static SliverView() => AffectsRender<SliverView>(BackgroundProperty);

    public IBrush? Background
    {
        get => GetValue(BackgroundProperty);
        set => SetValue(BackgroundProperty, value);
    }

    public IReadOnlyList<SliverBar> Bars
    {
        get => bars;
        set
        {
            if (!bars.SequenceEqual(value))
            {
                bars = value;
                InvalidateVisual();
            }
        }
    }

    public override void Render(DrawingContext context)
    {
        context.FillRectangle(Background ?? Brushes.Transparent, new Rect(Bounds.Size));

        foreach (var bar in bars)
        {
            context.FillRectangle(bar.Brush, new Rect(0, bar.Top, Bounds.Width, bar.Height));
        }
    }
}
