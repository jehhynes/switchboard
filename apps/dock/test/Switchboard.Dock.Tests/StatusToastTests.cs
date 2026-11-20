using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Threading;
using Switchboard.Dock.Views;

namespace Switchboard.Dock.Tests;

/// <summary>The status toast's colours follow whether its message is a problem.</summary>
public sealed class StatusToastTests
{
    static (MainWindow Window, DockViewModel Model) Open()
    {
        var model = new DockViewModel(new DockSettings(), (_) => { });
        var window = new MainWindow(model, null, new FakeHub(), new FakeActions(), docked: false);

        model.Show(Fixtures.View);
        window.Show();
        Dispatcher.UIThread.RunJobs();

        return (window, model);
    }

    static object? Brush(Window window, string key) => window.TryFindResource(key, window.ActualThemeVariant, out var value) ? value : null;

    [AvaloniaFact]
    public void Toast_InfoThenProblem_IsNeutralThenWarning()
    {
        var (window, model) = Open();
        var toast = window.FindControl<Border>("StatusToast")!;
        var line = window.FindControl<TextBlock>("StatusLine")!;

        model.ShowInfo("Copied Customer reply.");
        Dispatcher.UIThread.RunJobs();
        Assert.True(toast.IsVisible);
        Assert.DoesNotContain("warning", toast.Classes);
        Assert.DoesNotContain("warning", line.Classes);
        Assert.Equal(Brush(window, "DockMuted"), toast.BorderBrush);

        model.Status = "The terminal did not open";
        Dispatcher.UIThread.RunJobs();
        Assert.Contains("warning", toast.Classes);
        Assert.Contains("warning", line.Classes);
        Assert.Equal(Brush(window, "DockWarning"), toast.BorderBrush);

        model.Status = null;
        Assert.False(model.StatusIsProblem);
        window.Close();
    }

    [AvaloniaFact]
    public void Toast_NeedsYouMessage_IsNeutral()
    {
        var (window, model) = Open();

        window.ShowNeedsYou("item:7", "Switchboard: Fix the inbox badge — Approve to send");
        Dispatcher.UIThread.RunJobs();

        Assert.False(model.StatusIsProblem);
        Assert.DoesNotContain("warning", window.FindControl<Border>("StatusToast")!.Classes);
        window.Close();
    }
}
