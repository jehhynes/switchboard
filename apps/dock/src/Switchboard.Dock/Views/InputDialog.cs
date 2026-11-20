using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Switchboard.Dock.Hub;

namespace Switchboard.Dock.Views;

/// <summary>The trimmed text, and the chosen value when it differs from the one selected at first, else null.</summary>
sealed record InputAnswer(string Text, string? Choice);

/// <summary>
/// A small modal window that asks for a text, which starts as &lt;c&gt;initial&lt;/c&gt;, and with a choice, for a value from &lt;c&gt;InputChoice&lt;/c&gt;; &lt;c&gt;InputAction&lt;/c&gt; returns them and
/// &lt;c&gt;InputCancel&lt;/c&gt; returns null. The action needs a text, or with a choice, a text or a changed choice. The box takes several lines, so
/// Ctrl+Enter runs the action.
/// </summary>
static class InputDialog
{
    public static Task<InputAnswer?> Ask(Window owner, string question, string detail, string action, DockChoice? choice = null, string? initial = null)
    {
        var shell = new DialogShell(owner, question, 600, detail);
        var text = new TextBox { Name = "InputText", Text = initial, CaretIndex = initial?.Length ?? 0, AcceptsReturn = true, TextWrapping = TextWrapping.Wrap };
        // A prompt to edit, such as Start with prompt…'s, gets a taller box than new text.
        (text.MinHeight, text.MaxHeight) = initial is null ? (90, 300) : (150, 400);
        var values = new ComboBox { Name = "InputChoice", ItemsSource = choice?.Values, SelectedItem = choice?.Value, HorizontalAlignment = HorizontalAlignment.Stretch };
        string? Chosen() => choice is not null && values.SelectedItem is string value && value != choice.Value ? value : null;

        if (choice is not null)
        {
            shell.Body.Children.Add(DialogShell.Field(choice.Label, values));
        }

        shell.Body.Children.Add(text);
        shell.Body.Children.Add(shell.Note("Ctrl+Enter to " + action.ToLowerInvariant().TrimEnd('…') + "."));
        shell.Add("InputCancel", "Cancel", DialogButton.Cancel).Click += (_, _) => shell.Window.Close(null);

        var go = shell.Add("InputAction", action, DialogButton.Primary);

        void Update() => go.IsEnabled = !string.IsNullOrWhiteSpace(text.Text) || Chosen() is not null;

        Update();
        text.PropertyChanged += (_, e) =>
        {
            if (e.Property == TextBox.TextProperty)
            {
                Update();
            }
        };
        values.SelectionChanged += (_, _) => Update();
        go.Click += (_, _) =>
        {
            if (go.IsEnabled)
            {
                shell.Window.Close(new InputAnswer(text.Text?.Trim() ?? "", Chosen()));
            }
        };

        return shell.Window.ShowDialog<InputAnswer?>(owner);
    }
}
