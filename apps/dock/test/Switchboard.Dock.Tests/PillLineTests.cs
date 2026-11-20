using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Threading;
using Avalonia.VisualTree;
using Switchboard.Dock.Views;

namespace Switchboard.Dock.Tests;

/// <summary>Line 2's pills shrink to their icon instead of being cut (PRD R27, R52).</summary>
public sealed class PillLineTests
{
    static (MainWindow Window, List<Border> Pills, TextBlock Playbook) Open(double width)
    {
        var model = new DockViewModel(new DockSettings { Width = width }, (_) => { });
        var window = new MainWindow(model, null, new FakeHub(), new FakeActions(), docked: false);

        model.Show(Fixtures.View);
        window.Show();
        Dispatcher.UIThread.RunJobs();

        var row = window.GetVisualDescendants().OfType<Border>().Single((border) => border.Classes.Contains("row") && border.DataContext is RowViewModel { Key: "item:7" });
        var line = row.GetVisualDescendants().OfType<PillLine>().Single();

        return (window, row.GetVisualDescendants().OfType<Border>().Where((border) => border.Classes.Contains("pill") && border.IsEffectivelyVisible).ToList(), line.Children.OfType<TextBlock>().Single((text) => text.Classes.Contains("fill")));
    }

    static bool Compact(Border pill) => pill.Classes.Contains("compact");

    static TextBlock Label(Border pill) => pill.GetVisualDescendants().OfType<TextBlock>().Single((text) => text.Classes.Contains("pill-text"));

    [AvaloniaFact]
    public void Line_WideDock_ShowsEveryPillWhole()
    {
        var (window, pills, playbook) = Open(800);

        Assert.All(pills, (pill) => Assert.False(Compact(pill)));
        Assert.All(pills, (pill) => Assert.True(Label(pill).IsEffectivelyVisible));
        window.Close();
    }

    [AvaloniaTheory]
    [InlineData(200)]
    [InlineData(260)]
    [InlineData(320)]
    public void Line_NarrowDock_ShrinksPillsToIconsLongestFirstAndNeverCutsOne(double width)
    {
        var (window, pills, playbook) = Open(width);
        var line = playbook.GetVisualAncestors().OfType<PillLine>().First();

        // Every pill lies wholly inside the line, so none is cut.
        foreach (var pill in pills)
        {
            var left = pill.TranslatePoint(default, line)!.Value.X;

            Assert.True(left + pill.Bounds.Width <= line.Bounds.Width + 0.5, $"{ToolTip.GetTip(pill)} ends at {left + pill.Bounds.Width} of {line.Bounds.Width}.");
        }

        // A compact pill shows its icon alone, keeps its link and has its text in its tooltip.
        foreach (var pill in pills.Where(Compact))
        {
            Assert.False(Label(pill).IsVisible);
            Assert.Contains(pill.GetVisualDescendants().OfType<Control>(), (icon) => (icon.Classes.Contains("pill-icon") || icon.Classes.Contains("pill-logo")) && icon.IsEffectivelyVisible);
            Assert.Contains(Label(pill).Text!, Assert.IsType<string>(ToolTip.GetTip(pill)));
        }

        // Returned shrinks only after every other pill.
        var returned = pills.Single((pill) => pill.Classes.Contains("returned"));

        if (Compact(returned))
        {
            Assert.All(pills, (pill) => Assert.True(Compact(pill)));
        }

        window.Close();
    }

    [AvaloniaTheory]
    [InlineData(200, true)]
    [InlineData(260, true)]
    public void Line_SelectedRowWithButtons_LeavesOutWholePillsRatherThanCut(double width, bool keepsReturned)
    {
        var model = new DockViewModel(new DockSettings { Width = width }, (_) => { });
        var window = new MainWindow(model, null, new FakeHub(), new FakeActions(), docked: false);
        var view = Fixtures.View;

        model.Show(view with { Groups = view.Groups.Select((group) => group with { Rows = group.Rows.Select((row) => row.Key == "item:7" ? row with { Main = "Approve", Pastes = [new("Customer reply", "a.md")] } : row).ToList() }).ToList() });
        model.Selected = "item:7";
        window.Show();
        Dispatcher.UIThread.RunJobs();

        var row = window.GetVisualDescendants().OfType<Border>().Single((border) => border.Classes.Contains("row") && border.DataContext is RowViewModel { Key: "item:7" });
        var line = row.GetVisualDescendants().OfType<PillLine>().Single();
        var shown = row.GetVisualDescendants().OfType<Border>().Where((border) => border.Classes.Contains("pill") && border.IsEffectivelyVisible).ToList();

        Assert.True(row.GetVisualDescendants().OfType<Button>().Single((button) => button.Classes.Contains("main")).IsEffectivelyVisible);
        Assert.Equal(keepsReturned, shown.Any((pill) => pill.Classes.Contains("returned")));

        // Returned is left out only after every other pill.
        if (!keepsReturned)
        {
            Assert.Empty(shown);
        }

        foreach (var pill in shown)
        {
            Assert.True(pill.TranslatePoint(default, line)!.Value.X + pill.Bounds.Width <= line.Bounds.Width + 0.5, $"{ToolTip.GetTip(pill)} is cut.");
        }

        window.Close();
    }

    [AvaloniaFact]
    public void Line_LaidOutAgainAtTheSameNarrowWidth_KeepsTheSamePills()
    {
        var (window, pills, playbook) = Open(200);
        var line = playbook.GetVisualAncestors().OfType<PillLine>().First();
        string State() => string.Join(",", line.GetVisualDescendants().OfType<Border>().Where((border) => border.Classes.Contains("pill")).Select((pill) => $"{pill.IsVisible}:{pill.Classes.Contains("compact")}:{pill.TranslatePoint(default, line)?.X}"));
        var before = State();

        line.InvalidateMeasure();
        line.Measure(new Size(line.Bounds.Width, line.Bounds.Height));
        line.Arrange(line.Bounds);
        Assert.Equal(before, State());

        line.InvalidateMeasure();
        line.Measure(new Size(line.Bounds.Width, line.Bounds.Height));
        line.Arrange(line.Bounds);
        Assert.Equal(before, State());
        window.Close();
    }

    [AvaloniaFact]
    public void Line_DockWidenedAgain_ShowsThePillsWholeAgain()
    {
        var (window, pills, _) = Open(200);

        Assert.Contains(pills, Compact);

        window.Width = 800;
        Dispatcher.UIThread.RunJobs();

        Assert.All(pills, (pill) => Assert.False(Compact(pill)));
        window.Close();
    }
}
