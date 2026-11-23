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

    static NewSessionOptions Options(string provider = "codex") => new(
        new Hub.FolderPlaces(null, ["D:/git/widgets"], [], []),
        [],
        provider,
        ["claude", "codex"],
        new Dictionary<string, string?> { ["claude"] = "sonnet", ["codex"] = "gpt-6.2-sol" },
        new Dictionary<string, IReadOnlyList<Hub.ModelChoice>>(),
        "now",
        null);

    [AvaloniaFact]
    public void NewSession_Enter_StartsWithTheChosenFieldsAndEscapeCancels()
    {
        NewSessionChoice? sent = null;
        NewSessionOutcome? answer = null;
        var (owner, dialog) = Show(async (owner) => answer = await NewSessionDialog.Ask(owner, Options(), (choice) => { sent = choice; return Task.FromResult(new Hub.NewSessionReply(null, 3, choice.Folder)); }, (_) => Task.FromResult<string?>(null), null));

        Assert.Equal("Default (gpt-6.2-sol)", Named<ComboBox>(dialog, "SessionModel").SelectedItem?.ToString());
        Named<Avalonia.Controls.Primitives.ToggleButton>(dialog, "SessionProvider_claude").RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
        Dispatcher.UIThread.RunJobs();
        Assert.Equal("Default (sonnet)", Named<ComboBox>(dialog, "SessionModel").SelectedItem?.ToString());
        // The focus is in First message, where Enter starts a line, so Ctrl+Enter starts.
        Press(dialog, Key.Enter, RawInputModifiers.Control);

        Assert.Equal(new NewSessionChoice("D:/git/widgets", "claude", null, null, "now"), sent);
        Assert.Equal(3, answer?.Reply?.WorkItemId);

        NewSessionOutcome? cancelled = new(null, null, null);
        var (_, second) = Show(async (other) => cancelled = await NewSessionDialog.Ask(other, Options(), (_) => throw new InvalidOperationException(), (_) => Task.FromResult<string?>(null), null));

        Press(second, Key.Escape);
        Assert.Null(cancelled);
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
        var (owner, dialog) = Show((owner) => NewSessionDialog.Ask(owner, Options(), (_) => Task.FromResult(new Hub.NewSessionReply(null, null, null)), (_) => Task.FromResult<string?>(null), null));
        var buttons = dialog.GetVisualDescendants().OfType<Button>().Where((button) => button.Classes.Contains("dialog")).ToList();

        Assert.Equal(["SessionCancel", "SessionStart"], buttons.Select((button) => button.Name));
        Assert.True(buttons[0].IsCancel);
        Assert.True(buttons[1].IsDefault);
        Assert.Contains("accent", buttons[1].Classes);
        Assert.Contains("dialog", dialog.Classes);
        owner.Close();
    }
}
