using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Switchboard.Dock.Hub;

namespace Switchboard.Dock.Views;

/// <summary>
/// The modal New Ad-hoc Session window (PRD R6). <c>AdhocCreate</c> sends the prompt, or runs the schedule chosen in <c>AdhocRunBox</c> now (PRD R82);
/// a refusal keeps the window open with the hub's reason.
/// </summary>
static class AdhocDialog
{
    /// <summary>
    /// Returns the repo of the created work item, the given repo after a schedule's run, or null when the operator cancelled. With no repo, only a
    /// schedule can run.
    /// </summary>
    /// <param name="create">Sends the prompt, repo and Start automatically; returns the hub's refusal, or null.</param>
    /// <param name="run">Runs the named schedule now; returns the hub's refusal, or null.</param>
    public static Task<string?> Ask(Window owner, IReadOnlyList<string> repos, string? repo, Func<string, string, bool, string, Task<string?>> create, IReadOnlyList<ScheduleEntry>? schedules = null, Func<string, Task<string?>>? run = null, string defaultProvider = "claude", string? providerError = null)
    {
        var dialog = new Window { Title = "New Ad-hoc Session", Width = 480, SizeToContent = SizeToContent.Height, CanResize = false, WindowStartupLocation = WindowStartupLocation.CenterOwner };
        var choices = schedules ?? [];
        var runBox = new ComboBox
        {
            Name = "AdhocRunBox",
            ItemsSource = (string[])["A prompt", .. choices.Select((entry) => $"Run {entry.Name} now · {entry.Playbook}")],
            SelectedIndex = repo is null && choices.Count > 0 ? 1 : 0,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            IsVisible = choices.Count > 0 && run is not null,
        };
        var repoBox = new ComboBox { Name = "AdhocRepoBox", ItemsSource = repos, SelectedItem = repo, HorizontalAlignment = HorizontalAlignment.Stretch, IsVisible = repos.Count > 1 };
        var provider = ProviderDialog.Box(defaultProvider, "AdhocProvider");
        provider.IsEnabled = providerError is null;
        var providerField = new StackPanel { Spacing = 4, Children = { new TextBlock { Text = "Provider" }, provider } };
        var prompt = new TextBox { Name = "AdhocPromptBox", PlaceholderText = "Prompt for a new session", AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 120, MaxHeight = 400 };
        var start = new CheckBox { Name = "AdhocStartAutomatically", Content = "Start automatically", IsChecked = false };
        var error = new TextBlock { Name = "AdhocError", TextWrapping = TextWrapping.Wrap, IsVisible = false };
        var go = new Button { Name = "AdhocCreate", Content = "Create", IsEnabled = false };
        var cancel = new Button { Name = "AdhocCancel", Content = "Cancel", IsCancel = true };
        var busy = false;

        ScheduleEntry? Chosen() => runBox.SelectedIndex > 0 ? choices[runBox.SelectedIndex - 1] : null;

        void Enable() => go.IsEnabled = !busy && (Chosen() is not null || (providerError is null && repoBox.SelectedItem is string && !string.IsNullOrWhiteSpace(prompt.Text)));

        // A schedule's run takes its playbook's prompt and the schedule's repo, and starts at once.
        void Show()
        {
            var typed = Chosen() is null;

            repoBox.IsVisible = typed && repos.Count > 1;
            prompt.IsVisible = typed;
            providerField.IsVisible = typed;
            start.IsVisible = typed;
            go.Content = typed ? "Create" : "Run";
            error.Text = typed ? providerError : null;
            error.IsVisible = typed && providerError is not null;
            Enable();
        }

        runBox.SelectionChanged += (_, _) => Show();

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
            var schedule = Chosen();

            var chosen = repoBox.SelectedItem as string;

            if (busy || (schedule is null && (providerError is not null || string.IsNullOrWhiteSpace(prompt.Text) || chosen is null)))
            {
                return;
            }

            busy = true;
            cancel.IsEnabled = false;
            Enable();

            var refused = schedule is null ? await create(prompt.Text!, chosen!, start.IsChecked == true, ((ProviderDialog.Option)provider.SelectedItem!).Id) : await run!(schedule.Name);

            busy = false;
            cancel.IsEnabled = true;
            Enable();

            if (refused is null)
            {
                dialog.Close(schedule is null ? chosen : repo);
                return;
            }

            error.Text = refused;
            error.IsVisible = true;
        };
        Show();
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
                runBox,
                repoBox,
                providerField,
                prompt,
                start,
                error,
                new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, HorizontalAlignment = HorizontalAlignment.Right, Children = { cancel, go } },
            },
        };

        return dialog.ShowDialog<string?>(owner);
    }
}
