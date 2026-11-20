using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Switchboard.Dock.Views;

namespace Switchboard.Dock.Tests;

/// <summary>The search box's results.</summary>
public sealed class SearchTests
{
    [AvaloniaFact]
    public void Search_NoRowMatches_SaysNoMatchesAndClearSearchShowsTheListAgain()
    {
        var model = new DockViewModel(new DockSettings(), (_) => { });
        var window = new MainWindow(model, null, new FakeHub(), new FakeActions(), docked: false);

        model.Show(Fixtures.View);
        window.Show();
        Dispatcher.UIThread.RunJobs();

        var none = window.FindControl<TextBlock>("NoMatchLine")!;
        var clear = window.FindControl<Button>("NoMatchesClear")!;

        Assert.False(none.IsEffectivelyVisible);

        model.SearchOpen = true;
        model.Filter = "zzznothing";
        Dispatcher.UIThread.RunJobs();
        Assert.True(none.IsEffectivelyVisible);
        Assert.True(clear.IsEffectivelyVisible);
        Assert.True(model.NoMatches);

        model.Filter = Fixtures.Row("item:7").Title;
        Dispatcher.UIThread.RunJobs();
        Assert.False(none.IsEffectivelyVisible);

        model.Filter = "zzznothing";
        Dispatcher.UIThread.RunJobs();
        window.FindControl<Button>("NoMatchesClear")!.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        Assert.Equal("", model.Filter);
        Assert.False(none.IsEffectivelyVisible);
        Assert.False(clear.IsEffectivelyVisible);
        Assert.All(model.Groups, (group) => Assert.True(group.IsShown));
        window.Close();
    }

    [AvaloniaFact]
    public void Search_NewViewHidesTheLastMatch_SaysNoMatches()
    {
        var model = new DockViewModel(new DockSettings(), (_) => { });

        model.Show(Fixtures.View);
        model.Filter = Fixtures.Row("item:7").Title;
        Assert.False(model.NoMatches);

        model.Show(Fixtures.View with { Groups = Fixtures.View.Groups.Select((group) => group with { Rows = group.Rows.Where((row) => row.Key != "item:7").ToList() }).ToList() });

        Assert.True(model.NoMatches);
    }
}
