using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using Avalonia.Threading;
using Avalonia.VisualTree;
using Switchboard.Dock.Views;

namespace Switchboard.Dock.Tests;

/// <summary>Every dock dialog shares one layout and its keys: focus on the first field, Enter for the main action, Escape to cancel.</summary>
public sealed class DialogTests
{
    static (Window Owner, Window Dialog) Show(Func<Window, Task> open)
    {
        var owner = new Window();

        owner.Show();
        _ = open(owner);
        Dispatcher.UIThread.RunJobs();

        return (owner, Assert.Single(owner.OwnedWindows));
    }

    static T Named<T>(Window dialog, string name) where T : Control => dialog.GetVisualDescendants().OfType<T>().Single((control) => control.Name == name);

    static void Press(Window window, Key key, RawInputModifiers modifiers = RawInputModifiers.None)
    {
        window.KeyPress(key, modifiers, PhysicalKey.None, null);
        Dispatcher.UIThread.RunJobs();
    }

    [AvaloniaTheory]
    [InlineData(Key.Enter)]
    [InlineData(Key.Escape)]
    public void Confirm_EnterOrEscape_CancelsTheDestructiveAction(Key key)
    {
        bool? answer = null;
        var (owner, dialog) = Show(async (owner) => answer = await ConfirmDialog.Ask(owner, "Delete gh 107?", "Switchboard deletes the work item.", "Delete"));
        var action = Named<Button>(dialog, "ConfirmAction");

        Assert.Contains("danger", action.Classes);
        Assert.False(action.IsDefault);
        Assert.Same(Named<Button>(dialog, "ConfirmCancel"), dialog.FocusManager!.GetFocusedElement());

        Press(dialog, key);

        Assert.False(answer);
        Assert.False(dialog.IsVisible);
        owner.Close();
    }

    [AvaloniaFact]
    public void Provider_Enter_CreatesWithTheSelectedProviderAndNamesTheFolder()
    {
        string? answer = "unset";
        var (owner, dialog) = Show(async (owner) => answer = await ProviderDialog.Ask(owner, "codex", "D:/git/widgets"));

        Assert.Equal("New conversation in a folder", Named<TextBlock>(dialog, "DialogTitle").Text);
        Assert.Equal("D:/git/widgets", Named<TextBlock>(dialog, "DialogSubtitle").Text);
        Assert.Same(Named<ComboBox>(dialog, "SessionProvider"), dialog.FocusManager!.GetFocusedElement());

        Press(dialog, Key.Enter);

        Assert.Equal("codex", answer);
        owner.Close();
    }

    [AvaloniaFact]
    public void Provider_Escape_ReturnsNothing()
    {
        string? answer = "unset";
        var (owner, dialog) = Show(async (owner) => answer = await ProviderDialog.Ask(owner, "claude"));

        Press(dialog, Key.Escape);

        Assert.Null(answer);
        owner.Close();
    }

    [AvaloniaFact]
    public void Input_EnterStartsALineAndCtrlEnterRunsTheAction()
    {
        InputAnswer? answer = null;
        var (owner, dialog) = Show(async (owner) => answer = await InputDialog.Ask(owner, "Add comment", "Comments show on the row.", "Add"));
        var text = Named<TextBox>(dialog, "InputText");

        Assert.Same(text, dialog.FocusManager!.GetFocusedElement());
        text.Text = "Waiting on Dana.";
        Press(dialog, Key.Enter);
        Assert.Null(answer);
        Assert.True(dialog.IsVisible);

        Press(dialog, Key.Enter, RawInputModifiers.Control);

        Assert.StartsWith("Waiting on Dana.", answer!.Text);
        owner.Close();
    }

    [AvaloniaFact]
    public void Dialogs_ShareOneLayout_TitleBodyAndFooterWithCancelBeforeTheMainAction()
    {
        var (owner, dialog) = Show((owner) => ProviderDialog.Ask(owner, "claude", "D:/git/widgets"));
        var buttons = dialog.GetVisualDescendants().OfType<Button>().Where((button) => button.Classes.Contains("dialog")).ToList();

        Assert.Equal(["SessionCancel", "SessionCreate"], buttons.Select((button) => button.Name));
        Assert.True(buttons[0].IsCancel);
        Assert.True(buttons[1].IsDefault);
        Assert.Contains("accent", buttons[1].Classes);
        Assert.Contains("dialog", dialog.Classes);
        owner.Close();
    }
}
