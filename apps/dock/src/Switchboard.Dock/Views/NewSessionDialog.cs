using System.Collections.ObjectModel;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Layout;
using Avalonia.Media;
using Switchboard.Dock.Hub;

namespace Switchboard.Dock.Views;

/// <summary>What the New session dialog asks the hub to make: a folder, provider, model (null for Default), first message (null for none) and Run as.</summary>
internal sealed record NewSessionChoice(string Folder, string Provider, string? Model, string? Prompt, string Run);

/// <summary>What the New session dialog did: made a work item with &lt;paramref name="Choice"/&gt;, or ran the schedule &lt;paramref name="Schedule"/&gt; now.</summary>
internal sealed record NewSessionOutcome(NewSessionChoice? Choice, NewSessionReply? Reply, string? Schedule);

/// <summary>What the New session dialog offers: the hub's folders, schedules, providers and models, and the Run as this dock chose last.</summary>
internal sealed record NewSessionOptions(
    FolderPlaces Folders,
    IReadOnlyList<ScheduleEntry> Schedules,
    string DefaultProvider,
    IReadOnlyList<string>? Installed,
    IReadOnlyDictionary<string, string?> Models,
    IReadOnlyDictionary<string, IReadOnlyList<ModelChoice>> Choices,
    string Run,
    string? Note);

/// <summary>
/// The modal New session dialog (PRD R122), the dock's counterpart of the web page's form: Folder (the hub's recent folders, repo roots and
/// worktrees, then Choose a folder…, the native picker), Provider (hidden with one installed), Model (Default, the provider's models, Other…),
/// an optional First message, Run as once there is one, and More options' Run a schedule now (PRD R82). A refusal keeps it open with the hub's
/// reason.
/// </summary>
static class NewSessionDialog
{
    /// <summary>The Folder list's last entry, which asks for any folder.</summary>
    public const string ChooseFolder = "Choose a folder…";

    /// <summary>The Model list's last entry, which shows a box for any model name.</summary>
    public const string OtherModel = "Other…";

    /// <summary>The Run as choices, by the hub's names.</summary>
    public static readonly IReadOnlyList<(string Run, string Label)> RunAs = [("now", "Conversation, start now"), ("queue", "Task, start when a slot is free"), ("wait", "Task, wait for Start")];

    sealed record ModelOption(string? Id, string Label)
    {
        public override string ToString() => Label;
    }

    /// <param name="create">Asks the hub to make the work item; its reply, whose error keeps the dialog open.</param>
    /// <param name="run">Runs the named schedule now; the hub's refusal, or null.</param>
    /// <param name="pickFolder">Asks for any folder for Choose a folder…; without it the list has no such entry.</param>
    public static Task<NewSessionOutcome?> Ask(Window owner, NewSessionOptions options, Func<NewSessionChoice, Task<NewSessionReply>> create, Func<string, Task<string?>> run, Func<Window, Task<string?>>? pickFolder)
    {
        var shell = new DialogShell(owner, "New session", 500);
        var dialog = shell.Window;
        var places = options.Folders;
        var folders = new ObservableCollection<string>();

        foreach (var folder in places.Recent.Concat(places.RepoRoots).Concat(places.Worktrees))
        {
            if (!folders.Contains(folder, StringComparer.OrdinalIgnoreCase))
            {
                folders.Add(folder);
            }
        }

        if (pickFolder is not null)
        {
            folders.Add(ChooseFolder);
        }

        // A path can be typed or pasted as well as chosen; the hub checks it when the dialog sends it.
        var folderBox = new ComboBox { Name = "SessionFolder", IsEditable = true, ItemsSource = folders, SelectedItem = folders.FirstOrDefault((one) => one != ChooseFolder), HorizontalAlignment = HorizontalAlignment.Stretch, PlaceholderText = "Choose or type a folder" };
        var folderField = DialogShell.Field("Folder", folderBox, "SessionFolderField");
        var installed = new[] { ("claude", "Claude"), ("codex", "Codex") }.Where((one) => options.Installed is null || options.Installed.Contains(one.Item1)).ToList();
        var provider = installed.Any((one) => one.Item1 == options.DefaultProvider) ? options.DefaultProvider : installed.Select((one) => one.Item1).FirstOrDefault() ?? "claude";
        var providerSwitch = new StackPanel { Name = "SessionProvider", Orientation = Orientation.Horizontal, Spacing = 0 };
        var providerButtons = installed.Select((one) =>
        {
            var content = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };

            if (ProviderMarks.Mark(one.Item1) is { } mark)
            {
                content.Children.Add(mark);
            }

            content.Children.Add(new TextBlock { Text = one.Item2, VerticalAlignment = VerticalAlignment.Center });
            return new ToggleButton { Name = $"SessionProvider_{one.Item1}", Tag = one.Item1, Content = content, IsChecked = one.Item1 == provider, MinWidth = 90 };
        }).ToList();

        foreach (var button in providerButtons)
        {
            providerSwitch.Children.Add(button);
        }

        var providerField = DialogShell.Field("Provider", providerSwitch, "SessionProviderField");
        var modelBox = new ComboBox { Name = "SessionModel", HorizontalAlignment = HorizontalAlignment.Stretch };
        var otherModel = new TextBox { Name = "SessionOtherModel", PlaceholderText = "Model name", MaxLength = 200, IsVisible = false };
        var modelField = DialogShell.Field("Model", modelBox, "SessionModelField");
        var prompt = new TextBox { Name = "SessionPrompt", PlaceholderText = "Optional. Leave empty to open an empty session.", AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 90, MaxHeight = 400 };
        var promptField = DialogShell.Field("First message", prompt, "SessionPromptField");
        var runButtons = RunAs.Select((one) => new RadioButton { Name = $"SessionRun_{one.Run}", GroupName = "SessionRun", Content = one.Label, IsChecked = one.Run == options.Run, Tag = one.Run }).ToList();
        var runPanel = new StackPanel { Spacing = 4 };

        foreach (var button in runButtons)
        {
            runPanel.Children.Add(button);
        }

        var runField = DialogShell.Field("Run as", runPanel, "SessionRunField");
        var scheduleBox = new ComboBox
        {
            Name = "SessionSchedule",
            ItemsSource = (string[])["None", .. options.Schedules.Select((entry) => $"Run {entry.Name} now · {entry.Playbook}")],
            SelectedIndex = 0,
            HorizontalAlignment = HorizontalAlignment.Stretch,
        };
        var scheduleNote = shell.Note("The schedule's playbook and folder are used; the other fields are hidden.", "SessionScheduleNote");
        var scheduleField = DialogShell.Field("Run a schedule now", scheduleBox, "SessionScheduleField");
        scheduleField.Children.Add(scheduleNote);
        var more = new Expander { Name = "SessionMore", Header = "More options", Content = scheduleField, HorizontalAlignment = HorizontalAlignment.Stretch, IsVisible = options.Schedules.Count > 0 };
        var error = shell.Error("SessionError");
        var cancel = shell.Add("SessionCancel", "Cancel", DialogButton.Cancel);
        var go = shell.Add("SessionStart", "Start", DialogButton.Primary);
        var busy = false;
        var lastFolder = folderBox.SelectedItem as string;

        string Provider() => provider;

        ScheduleEntry? Schedule() => scheduleBox.SelectedIndex > 0 ? options.Schedules[scheduleBox.SelectedIndex - 1] : null;

        string? Folder() => folderBox.Text?.Trim() is { Length: > 0 } folder && folder != ChooseFolder ? folder : null;

        string Run() => string.IsNullOrWhiteSpace(prompt.Text) ? "now" : runButtons.FirstOrDefault((button) => button.IsChecked == true)?.Tag as string ?? "now";

        string? Model() => modelBox.SelectedItem is ModelOption { Label: OtherModel } ? otherModel.Text?.Trim() : (modelBox.SelectedItem as ModelOption)?.Id;

        // Default names what it resolves to; each provider has its own models, so a change of provider goes back to Default.
        void ShowModels()
        {
            var id = Provider();
            var configured = options.Models.TryGetValue(id, out var named) && !string.IsNullOrWhiteSpace(named) ? named : $"{(id == "codex" ? "Codex" : "Claude")}'s default";
            var choices = options.Choices.TryGetValue(id, out var listed) ? listed : [];

            modelBox.ItemsSource = (ModelOption[])[new(null, $"Default ({configured})"), .. choices.Select((one) => new ModelOption(one.Id, one.Label)), new(null, OtherModel)];
            modelBox.SelectedIndex = 0;
        }

        void Show()
        {
            var scheduled = Schedule() is not null;
            var message = !string.IsNullOrWhiteSpace(prompt.Text);

            folderField.IsVisible = !scheduled;
            providerField.IsVisible = !scheduled && installed.Count > 1;
            modelField.IsVisible = !scheduled;
            promptField.IsVisible = !scheduled;
            runField.IsVisible = !scheduled && message;
            scheduleNote.IsVisible = scheduled;
            otherModel.IsVisible = modelBox.SelectedItem is ModelOption { Label: OtherModel };
            go.Content = scheduled ? "Run" : message && Run() == "wait" ? "Create" : "Start";
            go.IsEnabled = !busy && (scheduled || (Folder() is not null && (modelBox.SelectedItem is not ModelOption { Label: OtherModel } || !string.IsNullOrWhiteSpace(otherModel.Text))));
        }

        modelField.Children.Add(otherModel);

        if (options.Note is not null)
        {
            providerField.Children.Add(shell.Note(options.Note, "SessionProviderNote"));
        }

        foreach (var button in providerButtons)
        {
            // A switch: the button clicked is the provider, and pressing it again keeps it.
            button.Click += (_, _) =>
            {
                var changed = provider != (string)button.Tag!;

                provider = (string)button.Tag!;

                foreach (var other in providerButtons)
                {
                    other.IsChecked = (string)other.Tag! == provider;
                }

                if (changed)
                {
                    ShowModels();
                }

                Show();
            };
        }

        folderBox.PropertyChanged += (_, e) =>
        {
            if (e.Property == ComboBox.TextProperty)
            {
                Show();
            }
        };
        modelBox.SelectionChanged += (_, _) => Show();
        scheduleBox.SelectionChanged += (_, _) => Show();

        foreach (var button in runButtons)
        {
            button.IsCheckedChanged += (_, _) => Show();
        }

        foreach (var box in new[] { prompt, otherModel })
        {
            box.PropertyChanged += (_, e) =>
            {
                if (e.Property == TextBox.TextProperty)
                {
                    Show();
                }
            };
        }

        folderBox.SelectionChanged += async (_, _) =>
        {
            if (folderBox.SelectedItem as string != ChooseFolder)
            {
                lastFolder = Folder();
                Show();
                return;
            }

            var picked = await pickFolder!(dialog);

            if (picked is null)
            {
                folderBox.SelectedItem = lastFolder;
                return;
            }

            var known = folders.FirstOrDefault((folder) => folder != ChooseFolder && string.Equals(folder, picked, StringComparison.OrdinalIgnoreCase));

            if (known is null)
            {
                folders.Insert(folders.Count - 1, picked);
            }

            folderBox.SelectedItem = known ?? picked;
        };
        go.Click += async (_, _) =>
        {
            if (busy || !go.IsEnabled)
            {
                return;
            }

            var schedule = Schedule();
            var folder = Folder();

            if (schedule is null && folder is null)
            {
                return;
            }

            busy = true;
            cancel.IsEnabled = false;
            error.IsVisible = false;
            Show();

            NewSessionChoice? choice = null;
            NewSessionReply? reply = null;
            string? refused;

            if (schedule is not null)
            {
                refused = await run(schedule.Name);
            }
            else
            {
                var message = prompt.Text?.Trim();

                choice = new NewSessionChoice(folder!, Provider(), Model(), string.IsNullOrEmpty(message) ? null : message, Run());
                reply = await create(choice);
                refused = reply.Error;
            }

            busy = false;
            cancel.IsEnabled = true;
            Show();

            if (refused is null)
            {
                dialog.Close(new NewSessionOutcome(choice, reply, schedule?.Name));
                return;
            }

            error.Text = refused;
            error.IsVisible = true;
        };
        cancel.Click += (_, _) => dialog.Close(null);
        // A close while the hub answers would lose its refusal.
        dialog.Closing += (_, e) => e.Cancel = busy && e.CloseReason == WindowCloseReason.WindowClosing;
        shell.Body.Children.Add(folderField);
        shell.Body.Children.Add(providerField);
        shell.Body.Children.Add(modelField);
        shell.Body.Children.Add(promptField);
        shell.Body.Children.Add(runField);
        shell.Body.Children.Add(more);
        shell.Body.Children.Add(error);
        // The first message is what the operator most often types; the other fields have defaults.
        shell.FocusFirst(prompt);
        ShowModels();
        Show();

        return dialog.ShowDialog<NewSessionOutcome?>(owner);
    }
}
