using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;

namespace Switchboard.Dock.Views;

/// <summary>A small modal window that asks for a text; <c>InputAction</c> returns it, trimmed, and <c>InputCancel</c> returns null.</summary>
static class InputDialog
{
    public static Task<string?> Ask(Window owner, string question, string detail, string action)
    {
        var dialog = new Window { Title = question, Width = 420, SizeToContent = SizeToContent.Height, CanResize = false, WindowStartupLocation = WindowStartupLocation.CenterOwner };
        var text = new TextBox { Name = "InputText", AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 90, MaxHeight = 300 };
        var go = new Button { Name = "InputAction", Content = action, IsEnabled = false };
        var cancel = new Button { Name = "InputCancel", Content = "Cancel", IsCancel = true };

        go.Classes.Add("accent");
        text.PropertyChanged += (_, e) =>
        {
            if (e.Property == TextBox.TextProperty)
            {
                go.IsEnabled = !string.IsNullOrWhiteSpace(text.Text);
            }
        };
        go.Click += (_, _) => dialog.Close(text.Text?.Trim());
        cancel.Click += (_, _) => dialog.Close(null);
        dialog.Opened += (_, _) => text.Focus();
        dialog.Bind(Window.BackgroundProperty, owner.GetResourceObservable("DockBackground"));
        dialog.Content = new StackPanel
        {
            Margin = new Thickness(16),
            Spacing = 12,
            Children =
            {
                new TextBlock { Text = question, FontWeight = FontWeight.SemiBold, TextWrapping = TextWrapping.Wrap },
                new TextBlock { Text = detail, TextWrapping = TextWrapping.Wrap },
                text,
                new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, HorizontalAlignment = HorizontalAlignment.Right, Children = { cancel, go } },
            },
        };

        return dialog.ShowDialog<string?>(owner);
    }
}
