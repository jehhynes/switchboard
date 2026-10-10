using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;

namespace Switchboard.Dock.Views;

/// <summary>A small modal window that asks before a destructive action; <c>ConfirmAction</c> goes ahead and <c>ConfirmCancel</c> does not.</summary>
static class ConfirmDialog
{
    public static Task<bool> Ask(Window owner, string question, string detail, string action)
    {
        var dialog = new Window { Title = question, Width = 380, SizeToContent = SizeToContent.Height, CanResize = false, WindowStartupLocation = WindowStartupLocation.CenterOwner };
        var go = new Button { Name = "ConfirmAction", Content = action };
        var cancel = new Button { Name = "ConfirmCancel", Content = "Cancel", IsCancel = true };

        go.Classes.Add("accent");
        go.Click += (_, _) => dialog.Close(true);
        cancel.Click += (_, _) => dialog.Close(false);
        dialog.Bind(Window.BackgroundProperty, owner.GetResourceObservable("DockBackground"));
        dialog.Content = new StackPanel
        {
            Margin = new Thickness(16),
            Spacing = 12,
            Children =
            {
                new TextBlock { Text = question, FontWeight = FontWeight.SemiBold, TextWrapping = TextWrapping.Wrap },
                new TextBlock { Text = detail, TextWrapping = TextWrapping.Wrap },
                new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, HorizontalAlignment = HorizontalAlignment.Right, Children = { cancel, go } },
            },
        };

        return dialog.ShowDialog<bool>(owner);
    }
}
