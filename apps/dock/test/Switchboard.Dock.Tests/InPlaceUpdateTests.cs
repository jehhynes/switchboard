using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Avalonia.VisualTree;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Settings;
using Switchboard.Dock.Views;

namespace Switchboard.Dock.Tests;

/// <summary>A hub view or settings change updates the dock's windows in place, so focus, selection and scroll position survive it.</summary>
public sealed class InPlaceUpdateTests
{
    readonly FakeHub hub = new();
    readonly FakeActions actions = new();

    (MainWindow Window, DockViewModel Model) Open()
    {
        var model = new DockViewModel(new DockSettings(), (_) => { });
        var window = new MainWindow(model, null, hub, actions, docked: false);

        model.Show(Fixtures.View);
        window.Show();
        Dispatcher.UIThread.RunJobs();

        return (window, model);
    }

    static Border RowOf(Window window, string key) =>
        window.GetVisualDescendants().OfType<Border>().Single((border) => border.Classes.Contains("row") && border.DataContext is RowViewModel row && row.Key == key);

    static DockView WithRow(DockView view, string key, Func<DockRow, DockRow> change) =>
        view with { Groups = view.Groups.Select((group) => group with { Rows = group.Rows.Select((row) => row.Key == key ? change(row) : row).ToList() }).ToList() };

    static DockView Without(DockView view, string key) =>
        view with { Groups = view.Groups.Select((group) => group with { Rows = group.Rows.Where((row) => row.Key != key).ToList() }).ToList() };

    [AvaloniaFact]
    public void Show_RowTextChanged_KeepsTheRowControlsAndShowsTheNewText()
    {
        var (window, model) = Open();
        var row = RowOf(window, "item:7");
        var other = RowOf(window, "item:10");

        model.Show(WithRow(Fixtures.View, "item:7", (row) => row with { Title = "Renamed title" }));
        Dispatcher.UIThread.RunJobs();

        Assert.Same(row, RowOf(window, "item:7"));
        Assert.Same(other, RowOf(window, "item:10"));
        Assert.Contains("Renamed title", row.GetVisualDescendants().OfType<TextBlock>().Select((text) => text.Text));
        Assert.Equal("Renamed title", model.Row("item:7")!.Row.Title);
    }

    [AvaloniaFact]
    public void Show_RowRemoved_RemovesOnlyItsControls()
    {
        var (window, model) = Open();
        var other = RowOf(window, "item:10");

        model.Show(Without(Fixtures.View, "item:7"));
        Dispatcher.UIThread.RunJobs();

        Assert.DoesNotContain(window.GetVisualDescendants().OfType<Border>(), (border) => border.DataContext is RowViewModel { Key: "item:7" });
        Assert.Same(other, RowOf(window, "item:10"));
        Assert.Null(model.Row("item:7"));
    }

    [AvaloniaFact]
    public void Show_SelectedRowChanged_StaysSelected()
    {
        var (window, model) = Open();

        model.Selected = "item:7";
        model.Show(WithRow(Fixtures.View, "item:7", (row) => row with { Title = "Renamed title" }));
        Dispatcher.UIThread.RunJobs();

        Assert.Contains("selected", RowOf(window, "item:7").Classes);
    }

    static HeldSessionsWindow Held(MainWindow window)
    {
        var more = window.FindControl<Button>("MoreButton")!;

        more.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        Dispatcher.UIThread.RunJobs();
        more.ContextMenu!.Items.OfType<MenuItem>().Single((item) => (string)item.Header! == "Held sessions").RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        return window.HeldWindow!;
    }

    [AvaloniaFact]
    public void HeldSessions_IdleTimeChanged_KeepsTheButtonsAndShowsTheNewTime()
    {
        var (window, model) = Open();
        var held = Held(window);
        var stop = held.GetVisualDescendants().OfType<Button>().Single((button) => (string?)button.Tag == "stop:o1");
        var changed = Fixtures.View.Held!.Select((one) => one.Session == "o1" ? one with { Idle = "9h 9m" } : one).ToList();

        model.Show(Fixtures.View with { Held = changed });
        Dispatcher.UIThread.RunJobs();

        Assert.Same(stop, held.GetVisualDescendants().OfType<Button>().Single((button) => (string?)button.Tag == "stop:o1"));
        Assert.Contains("9h 9m", held.GetVisualDescendants().OfType<TextBlock>().Select((text) => text.Text));
        held.Close();
    }

    [AvaloniaFact]
    public void Settings_FieldEdited_KeepsTheNavigationAndPageButtons()
    {
        var config = new FakeConfigHub();
        var editor = new SettingsEditor(config, (_) => Task.CompletedTask);
        var window = new SettingsWindow(editor, actions, new DockViewModel(new DockSettings(), (_) => { }));

        window.Show();
        editor.Load().GetAwaiter().GetResult();
        Settle();

        Button Tagged(string tag) => window.GetVisualDescendants().OfType<Button>().Single((button) => (string?)button.Tag == tag);
        var general = Tagged("general");
        var save = Tagged("save");

        window.GetVisualDescendants().OfType<TextBox>().Single((box) => box.Name == "field:sessions.concurrency").Text = "3";
        Settle();

        Assert.Same(general, Tagged("general"));
        Assert.Same(save, Tagged("save"));
        Assert.True(save.IsEnabled);
        Assert.Contains(general.GetVisualDescendants().OfType<TextBlock>(), (text) => text.Classes.Contains("dirty"));
        window.Close();
    }

    [AvaloniaFact]
    public void Settings_SourceAdded_KeepsTheFocusedNavigationButton()
    {
        var config = new FakeConfigHub();
        var editor = new SettingsEditor(config, (_) => Task.CompletedTask);
        var window = new SettingsWindow(editor, actions, new DockViewModel(new DockSettings(), (_) => { }));

        window.Show();
        editor.Load().GetAwaiter().GetResult();
        Settle();

        Button Tagged(string tag) => window.GetVisualDescendants().OfType<Button>().Single((button) => (string?)button.Tag == tag);
        var github = Tagged("source:github");

        Tagged("new-source").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        Settle();
        window.GetVisualDescendants().OfType<ComboBox>().Single((box) => box.Name == "NewKind").SelectedIndex = 0;
        window.GetVisualDescendants().OfType<TextBox>().Single((box) => box.Name == "NewName").Text = "widgets-dashboard";
        Settle();
        github.Focus();
        Tagged("create").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        Settle();

        Assert.Same(github, Tagged("source:github"));
        Assert.NotNull(Tagged("source:widgets-dashboard"));
        window.Close();
    }

    static void Settle()
    {
        for (var pass = 0; pass < 5; pass++)
        {
            Dispatcher.UIThread.RunJobs();
        }
    }
}
