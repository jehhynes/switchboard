using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;

namespace Switchboard.Dock.Views;

/// <summary>The modal New Ad-hoc Session window (PRD R6). <c>AdhocCreate</c> sends the prompt; a refusal keeps the window open with the hub's reason.</summary>
static class AdhocDialog
{
    /// <summary>Returns the repo of the created work item, or null when the operator cancelled.</summary>
    /// <param name="create">Sends the prompt, repo and Start automatically; returns the hub's refusal, or null.</param>
    public static Task<string?> Ask(Window owner, IReadOnlyList<string> repos, string repo, Func<string, string, bool, Task<string?>> create)
    {
        var dialog = new Window { Title = "New Ad-hoc Session", Width = 480, SizeToContent = SizeToContent.Height, CanResize = false, WindowStartupLocation = WindowStartupLocation.CenterOwner };
        var repoBox = new ComboBox { Name = "AdhocRepoBox", ItemsSource = repos, SelectedItem = repo, HorizontalAlignment = HorizontalAlignment.Stretch, IsVisible = repos.Count > 1 };
        var prompt = new TextBox { Name = "AdhocPromptBox", PlaceholderText = "Prompt for a new session", AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 120, MaxHeight = 400 };
        var start = new CheckBox { Name = "AdhocStartAutomatically", Content = "Start automatically", IsChecked = false };
        var error = new TextBlock { Name = "AdhocError", TextWrapping = TextWrapping.Wrap, IsVisible = false };
        var go = new Button { Name = "AdhocCreate", Content = "Create", IsEnabled = false };
        var cancel = new Button { Name = "AdhocCancel", Content = "Cancel", IsCancel = true };
        var busy = false;

        void Enable() => go.IsEnabled = !busy && !string.IsNullOrWhiteSpace(prompt.Text);

        go.Classes.Add("accent");
        prompt.PropertyChanged += (_, e) =>
        {
            if (e.Property == TextBox.TextProperty)
            {
                Enable();
            }
        };
        go.Click += async (_, _) =>
        {
            if (busy || string.IsNullOrWhiteSpace(prompt.Text) || repoBox.SelectedItem is not string chosen)
            {
                return;
            }

            busy = true;
            cancel.IsEnabled = false;
            Enable();

            var refused = await create(prompt.Text, chosen, start.IsChecked == true);

            busy = false;
            cancel.IsEnabled = true;
            Enable();

            if (refused is null)
            {
                dialog.Close(chosen);
                return;
            }

            error.Text = refused;
            error.IsVisible = true;
        };
        cancel.Click += (_, _) => dialog.Close(null);
        // A close while the hub answers would lose its refusal.
        dialog.Closing += (_, e) => e.Cancel = busy && e.CloseReason == WindowCloseReason.WindowClosing;
        dialog.Opened += (_, _) => prompt.Focus();
        dialog.Bind(Window.BackgroundProperty, owner.GetResourceObservable("DockBackground"));
        error.Bind(TextBlock.ForegroundProperty, owner.GetResourceObservable("DockWarning"));
        dialog.Content = new StackPanel
        {
            Margin = new Thickness(16),
            Spacing = 12,
            Children =
            {
                new TextBlock { Text = "New Ad-hoc Session", FontWeight = FontWeight.SemiBold },
                repoBox,
                prompt,
                start,
                error,
                new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, HorizontalAlignment = HorizontalAlignment.Right, Children = { cancel, go } },
            },
        };

        return dialog.ShowDialog<string?>(owner);
    }
}
