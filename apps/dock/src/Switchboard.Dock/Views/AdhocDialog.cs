using System.Collections.ObjectModel;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Switchboard.Dock.Hub;

namespace Switchboard.Dock.Views;

/// <summary>
/// The modal New ad-hoc session window (PRD R6). &lt;c&gt;AdhocCreate&lt;/c&gt; sends the prompt, or runs the schedule chosen in &lt;c&gt;AdhocRunBox&lt;/c&gt; now (PRD R82);
/// a refusal keeps the window open with the hub's reason.
/// </summary>
static class AdhocDialog
{
    /// <summary>The Repository list's last entry, which asks for any folder.</summary>
    public const string ChooseFolder = "Choose a folder…";

    /// <summary>
    /// Returns the repo of the created work item, the given repo after a schedule's run, or null when the operator cancelled. With no repo, only a
    /// schedule can run, until a folder is chosen.
    /// </summary>
    /// <param name="create">Sends the prompt, repo and Start automatically; returns the hub's refusal, or null.</param>
    /// <param name="run">Runs the named schedule now; returns the hub's refusal, or null.</param>
    /// <param name="providerError">Why the hub could not list the providers: the dialog falls back to the default provider and shows it beside the box.</param>
    /// <param name="recent">Folders chosen before, offered after the repo roots.</param>
    /// <param name="pickFolder">Asks for any folder for Choose a folder…; without it the list has no such entry.</param>
    /// <param name="remember">Keeps a chosen folder that is not a repo root, so the list offers it again.</param>
    /// <param name="defaultKnown">Whether &lt;paramref name="defaultProvider"/&gt; is the configured default, as the hub named it, rather than a guess.</param>
    public static Task<string?> Ask(Window owner, IReadOnlyList<string> repos, string? repo, Func<string, string, bool, string, Task<string?>> create, IReadOnlyList<ScheduleEntry>? schedules = null,
        Func<string, Task<string?>>? run = null, string defaultProvider = "claude", string? providerError = null, IReadOnlyList<string>? recent = null,
        Func<Window, Task<string?>>? pickFolder = null, Action<string>? remember = null, bool defaultKnown = true)
    {
        var shell = new DialogShell(owner, "New ad-hoc session", 500);
        var dialog = shell.Window;
        var choices = schedules ?? [];
        var runBox = new ComboBox
        {
            Name = "AdhocRunBox",
            ItemsSource = (string[])["A prompt", .. choices.Select((entry) => $"Run {entry.Name} now · {entry.Playbook}")],
            SelectedIndex = repo is null && choices.Count > 0 ? 1 : 0,
            HorizontalAlignment = HorizontalAlignment.Stretch,
        };
        var runField = DialogShell.Field("Run", runBox, "AdhocRunField");
        runField.IsVisible = choices.Count > 0 && run is not null;

        // The repo roots, then folders chosen before, then Choose a folder… to pick any other.
        var folders = new ObservableCollection<string>(repos.Concat((recent ?? []).Where((folder) => !repos.Contains(folder, StringComparer.OrdinalIgnoreCase))));

        if (pickFolder is not null)
        {
            folders.Add(ChooseFolder);
        }

        var repoBox = new ComboBox { Name = "AdhocRepoBox", ItemsSource = folders, SelectedItem = repo, HorizontalAlignment = HorizontalAlignment.Stretch };
        var repoField = DialogShell.Field("Repository", repoBox, "AdhocRepoField");
        var provider = ProviderDialog.Box(defaultProvider, "AdhocProvider");
        var providerError_ = shell.Error("AdhocProviderError");
        var providerField = DialogShell.Field("Provider", provider, "AdhocProviderField");

        // The hub could not list the providers: the default stays selected and usable, and the reason shows beside the box.
        if (providerError is not null)
        {
            var name = defaultProvider == "codex" ? "Codex" : "Claude";

            providerError_.Text = defaultKnown ? $"{providerError} Using {name}, the default." : $"{providerError} Using {name}.";
            providerError_.IsVisible = true;
        }

        providerField.Children.Add(providerError_);

        var prompt = new TextBox { Name = "AdhocPromptBox", PlaceholderText = "What the session should do", AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 120, MaxHeight = 400 };
        var promptField = DialogShell.Field("Prompt", prompt, "AdhocPromptField");
        var start = new CheckBox { Name = "AdhocStartAutomatically", Content = "Start automatically", IsChecked = false };
        var error = shell.Error("AdhocError");
        var cancel = shell.Add("AdhocCancel", "Cancel", DialogButton.Cancel);
        var go = shell.Add("AdhocCreate", "Create", DialogButton.Primary);
        var busy = false;
        string? lastFolder = repo;

        ScheduleEntry? Chosen() => runBox.SelectedIndex > 0 ? choices[runBox.SelectedIndex - 1] : null;

        string? Folder() => repoBox.SelectedItem is string folder && folder != ChooseFolder ? folder : null;

        void Enable() => go.IsEnabled = !busy && (Chosen() is not null || (Folder() is not null && !string.IsNullOrWhiteSpace(prompt.Text)));

        // A schedule's run takes its playbook's prompt and the schedule's repo, and starts at once.
        void Show()
        {
            var typed = Chosen() is null;

            repoField.IsVisible = typed;
            promptField.IsVisible = typed;
            providerField.IsVisible = typed;
            start.IsVisible = typed;
            go.Content = typed ? "Create" : "Run";
            Enable();
        }

        runBox.SelectionChanged += (_, _) => Show();
        repoBox.SelectionChanged += async (_, _) =>
        {
            if (repoBox.SelectedItem as string != ChooseFolder)
            {
                lastFolder = Folder();
                Enable();
                return;
            }

            var picked = await pickFolder!(dialog);

            if (picked is null)
            {
                repoBox.SelectedItem = lastFolder;
                return;
            }

            var known = folders.FirstOrDefault((folder) => folder != ChooseFolder && string.Equals(folder, picked, StringComparison.OrdinalIgnoreCase));

            if (known is null)
            {
                folders.Insert(folders.Count - 1, picked);
            }

            if (!repos.Contains(picked, StringComparer.OrdinalIgnoreCase))
            {
                remember?.Invoke(known ?? picked);
            }

            repoBox.SelectedItem = known ?? picked;
        };
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
            var chosen = Folder();

            if (busy || !go.IsEnabled || (schedule is null && (string.IsNullOrWhiteSpace(prompt.Text) || chosen is null)))
            {
                return;
            }

            busy = true;
            cancel.IsEnabled = false;
            error.IsVisible = false;
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
        cancel.Click += (_, _) => dialog.Close(null);
        // A close while the hub answers would lose its refusal.
        dialog.Closing += (_, e) => e.Cancel = busy && e.CloseReason == WindowCloseReason.WindowClosing;
        shell.Body.Children.Add(runField);
        shell.Body.Children.Add(repoField);
        shell.Body.Children.Add(providerField);
        shell.Body.Children.Add(promptField);
        shell.Body.Children.Add(start);
        shell.Body.Children.Add(error);
        Show();

        return dialog.ShowDialog<string?>(owner);
    }
}
