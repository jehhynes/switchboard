using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Switchboard.Dock.Hub;

namespace Switchboard.Dock.Views;

/// <summary>The trimmed text, and the chosen value when it differs from the one selected at first, else null.</summary>
sealed record InputAnswer(string Text, string? Choice);

/// <summary>
/// A small modal window that asks for a text, and with a choice, for a value from <c>InputChoice</c>; <c>InputAction</c> returns them and
/// <c>InputCancel</c> returns null. The action needs a text, or with a choice, a text or a changed choice.
/// </summary>
static class InputDialog
{
    public static Task<InputAnswer?> Ask(Window owner, string question, string detail, string action, DockChoice? choice = null)
    {
        var dialog = new Window { Title = question, Width = 420, SizeToContent = SizeToContent.Height, CanResize = false, WindowStartupLocation = WindowStartupLocation.CenterOwner };
        var text = new TextBox { Name = "InputText", AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 90, MaxHeight = 300 };
        var values = new ComboBox { Name = "InputChoice", ItemsSource = choice?.Values, SelectedItem = choice?.Value, HorizontalAlignment = HorizontalAlignment.Stretch };
        var go = new Button { Name = "InputAction", Content = action, IsEnabled = false };
        var cancel = new Button { Name = "InputCancel", Content = "Cancel", IsCancel = true };
        string? Chosen() => choice is not null && values.SelectedItem is string value && value != choice.Value ? value : null;
        void Update() => go.IsEnabled = !string.IsNullOrWhiteSpace(text.Text) || Chosen() is not null;

        go.Classes.Add("accent");
        text.PropertyChanged += (_, e) =>
        {
            if (e.Property == TextBox.TextProperty)
            {
                Update();
            }
        };
        values.SelectionChanged += (_, _) => Update();
        go.Click += (_, _) => dialog.Close(new InputAnswer(text.Text?.Trim() ?? "", Chosen()));
        cancel.Click += (_, _) => dialog.Close(null);
        dialog.Opened += (_, _) => text.Focus();
        dialog.Bind(Window.BackgroundProperty, owner.GetResourceObservable("DockBackground"));

        var content = new StackPanel { Margin = new Thickness(16), Spacing = 12 };

        content.Children.Add(new TextBlock { Text = question, FontWeight = FontWeight.SemiBold, TextWrapping = TextWrapping.Wrap });

        if (choice is not null)
        {
            content.Children.Add(new StackPanel { Spacing = 4, Children = { new TextBlock { Text = choice.Label }, values } });
        }

        content.Children.Add(new TextBlock { Text = detail, TextWrapping = TextWrapping.Wrap });
        content.Children.Add(text);
        content.Children.Add(new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, HorizontalAlignment = HorizontalAlignment.Right, Children = { cancel, go } });
        dialog.Content = content;

        return dialog.ShowDialog<InputAnswer?>(owner);
    }
}
