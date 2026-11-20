using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Threading;
using Switchboard.Dock.Views;

namespace Switchboard.Dock.Tests;

/// <summary>The dock's title row at narrow widths.</summary>
public sealed class HeaderTests
{
    [AvaloniaTheory]
    [InlineData(200)]
    [InlineData(320)]
    public void Header_NarrowDock_KeepsCloseWhollyInsideAndTrimsTheTitle(double width)
    {
        var model = new DockViewModel(new DockSettings { Width = width }, (_) => { });
        var window = new MainWindow(model, null, new FakeHub(), new FakeActions(), docked: false);

        model.Show(Fixtures.View);
        window.Show();
        Dispatcher.UIThread.RunJobs();

        var close = window.FindControl<Button>("CloseButton")!;
        var title = window.FindControl<TextBlock>("MoveHandle")!;
        var right = close.TranslatePoint(new Point(close.Bounds.Width, 0), window)!.Value.X;

        Assert.Equal(28, close.Bounds.Width);
        Assert.True(right <= window.Bounds.Width, $"Close ends at {right} in a {window.Bounds.Width} px window.");
        Assert.Equal(Avalonia.Media.TextTrimming.CharacterEllipsis, title.TextTrimming);

        // The source icons show whole or not at all.
        var sources = window.FindControl<ItemsControl>("SourceList")!;
        Assert.Contains(sources.Bounds.Width, new[] { 0, sources.DesiredSize.Width });
        Assert.True(title.TranslatePoint(default, window)!.Value.X + title.Bounds.Width <= close.TranslatePoint(default, window)!.Value.X);
        window.Close();
    }
}
