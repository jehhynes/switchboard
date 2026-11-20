using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;

namespace Switchboard.Dock.Views;

/// <summary>Provider choice for a new conversation or ad-hoc prompt; it never changes the configured default.</summary>
static class ProviderDialog
{
    internal sealed record Option(string Id, string Label)
    {
        public override string ToString() => Label;
    }

    public static ComboBox Box(string preferred, string name) => new()
    {
        Name = name,
        ItemsSource = new Option[] { new("claude", "Claude"), new("codex", "Codex") },
        SelectedIndex = preferred == "codex" ? 1 : 0,
        HorizontalAlignment = HorizontalAlignment.Stretch,
    };

    public static Task<string?> Ask(Window owner, string preferred)
    {
        var dialog = new Window { Title = "New session", Width = 340, SizeToContent = SizeToContent.Height, CanResize = false, WindowStartupLocation = WindowStartupLocation.CenterOwner };
        var choice = Box(preferred, "SessionProvider");
        var create = new Button { Name = "SessionCreate", Content = "Create", IsDefault = true };
        var cancel = new Button { Name = "SessionCancel", Content = "Cancel", IsCancel = true };
        create.Classes.Add("accent");
        create.Click += (_, _) => dialog.Close((choice.SelectedItem as Option)?.Id);
        cancel.Click += (_, _) => dialog.Close(null);
        dialog.Bind(Window.BackgroundProperty, owner.GetResourceObservable("DockBackground"));
        dialog.Content = new StackPanel
        {
            Margin = new Thickness(16), Spacing = 12,
            Children = { new TextBlock { Text = "Provider" }, choice, new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, HorizontalAlignment = HorizontalAlignment.Right, Children = { cancel, create } } },
        };
        return dialog.ShowDialog<string?>(owner);
    }
}
