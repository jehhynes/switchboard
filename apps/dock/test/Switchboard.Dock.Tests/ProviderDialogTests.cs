using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Avalonia.VisualTree;
using Switchboard.Dock.Views;

namespace Switchboard.Dock.Tests;

public sealed class ProviderDialogTests
{
    static void Click(Button button) { button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); Dispatcher.UIThread.RunJobs(); }

    [AvaloniaFact]
    public async Task Ask_ProviderChanged_ReturnsTheChoice()
    {
        var owner = new Window(); owner.Show();
        var answer = ProviderDialog.Ask(owner, "codex");
        var dialog = Assert.Single(owner.OwnedWindows);
        var choice = dialog.GetVisualDescendants().OfType<ComboBox>().Single();
        Assert.Equal("codex", ((ProviderDialog.Option)choice.SelectedItem!).Id);
        choice.SelectedIndex = 0;
        Click(dialog.GetVisualDescendants().OfType<Button>().Single(button => button.Name == "SessionCreate"));
        Assert.Equal("claude", await answer);
        owner.Close();
    }

    [AvaloniaFact]
    public async Task Ask_Cancelled_ReturnsNoChoice()
    {
        var owner = new Window(); owner.Show();
        var answer = ProviderDialog.Ask(owner, "claude");
        var dialog = Assert.Single(owner.OwnedWindows);
        Click(dialog.GetVisualDescendants().OfType<Button>().Single(button => button.Name == "SessionCancel"));
        Assert.Null(await answer);
        owner.Close();
    }
}
