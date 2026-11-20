using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Avalonia.VisualTree;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Views;

namespace Switchboard.Dock.Tests;

/// <summary>The dock while no hub runs: the last rows stay, dimmed and disabled, with Start hub.</summary>
public sealed class NotRunningTests
{
    [AvaloniaFact]
    public void NotRunning_AfterAView_DimsAndDisablesTheRowsAndOffersStartHub()
    {
        var model = new DockViewModel(new DockSettings(), (_) => { });
        var actions = new FakeActions();
        var window = new MainWindow(model, null, new FakeHub(), actions, docked: false);
        var starts = 0;

        window.StartHub = () =>
        {
            starts++;
            return starts == 1 ? null : "Switchboard could not start the hub: node.exe is missing.";
        };
        model.Show(Fixtures.View);
        window.Show();
        Dispatcher.UIThread.RunJobs();

        var list = window.FindControl<ItemsControl>("GroupList")!;
        var start = window.FindControl<Button>("StartHubButton")!;

        Assert.True(list.IsEffectivelyEnabled);
        Assert.False(start.IsVisible);

        model.Show(Connection.NotRunning);
        Dispatcher.UIThread.RunJobs();

        Assert.False(list.IsEffectivelyEnabled);
        Assert.Equal(0.5, list.Opacity);
        Assert.Contains(list.GetVisualDescendants().OfType<Border>(), (border) => border.Classes.Contains("row"));
        Assert.All(list.GetVisualDescendants().OfType<Button>(), (button) => Assert.False(button.IsEffectivelyEnabled));
        Assert.True(start.IsEffectivelyVisible);

        start.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        Assert.Equal(1, starts);
        Assert.Null(model.Status);
        start.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        Assert.Equal("Switchboard could not start the hub: node.exe is missing.", model.Status);

        model.Show(Fixtures.View);
        Dispatcher.UIThread.RunJobs();
        Assert.True(list.IsEffectivelyEnabled);
        Assert.False(start.IsVisible);
        window.Close();
    }

    [AvaloniaFact]
    public void Connecting_IsNotLiveButOffersNoStart()
    {
        var model = new DockViewModel(new DockSettings(), (_) => { });

        Assert.False(model.IsLive);
        Assert.False(model.CanStartHub);
        model.Show(Connection.TooOld);
        Assert.False(model.CanStartHub);
    }
}
