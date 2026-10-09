using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Input.Platform;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Avalonia.VisualTree;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Platform;
using Switchboard.Dock.Switching;

namespace Switchboard.Dock.Views;

/// <summary>The dock (PRD R71): the list, docked to the left edge of the primary monitor as an app bar when <c>docked</c>.</summary>
public sealed partial class MainWindow : Window
{
    readonly DockViewModel model;
    readonly HubClient? stream;
    readonly IHub hub;
    readonly IDockActions actions;
    readonly bool docked;
    AppBar? appBar;
    // The strip the docked window last took, in physical pixels.
    Native.Rect? placed;
    bool resizing;
    // The width the pointer has dragged to, in device-independent pixels, before rounding to physical pixels.
    double? dragged;
    // The click that is running, which a click on another row replaces.
    (string Key, CancellationTokenSource Cancel)? running;

    /// <summary>For the XAML previewer only.</summary>
    public MainWindow()
        : this(new DockViewModel(new DockSettings(), (_) => { }), null, new NoHub(), new NoActions(), docked: false)
    {
    }

    public MainWindow(DockViewModel model, HubClient? stream, IHub hub, IDockActions actions, bool docked)
    {
        this.model = model;
        this.stream = stream;
        this.hub = hub;
        this.actions = actions;
        this.docked = docked;
        DataContext = model;
        Width = model.Settings.Width;
        InitializeComponent();

        if (stream is not null)
        {
            stream.Changed += () => Dispatcher.UIThread.Post(Refresh);
        }
    }

    void Refresh()
    {
        if (stream is { Connection: Connection.Connected, View: { } view })
        {
            model.Show(view);
        }
        else if (stream is not null)
        {
            model.Show(stream.Connection);
        }
    }

    protected override void OnOpened(EventArgs e)
    {
        base.OnOpened(e);

        if (docked && OperatingSystem.IsWindows() && TryGetPlatformHandle() is { } handle)
        {
            appBar = new AppBar(handle.Handle);
            appBar.Placed += Place;
            appBar.FullScreen += (full) => Topmost = !full;
            Dock();
        }
    }

    protected override void OnClosed(EventArgs e)
    {
        if (OperatingSystem.IsWindows())
        {
            appBar?.Dispose();
        }

        base.OnClosed(e);
    }

    void Dock()
    {
        if (OperatingSystem.IsWindows() && appBar is not null)
        {
            Place(appBar.Dock((int)Math.Round(model.Settings.Width * RenderScaling)));
        }
    }

    /// <summary>
    /// Places the docked window in its strip with Win32, because Avalonia moves a window it resizes into the monitor's work area, which starts
    /// at the dock's own right edge.
    /// </summary>
    void Place(Native.Rect bounds)
    {
        placed = bounds;

        if (OperatingSystem.IsWindows() && TryGetPlatformHandle() is { } handle)
        {
            if (appBar is not null)
            {
                appBar.Strip = bounds;
            }

            Native.SetWindowPos(handle.Handle, 0, bounds.Left, bounds.Top, bounds.Right - bounds.Left, bounds.Bottom - bounds.Top, Native.SwpNoZOrder | Native.SwpNoActivate);
        }
    }

    /// <summary>Selects and scrolls to the row of an item window that came to the front by any means; other windows change nothing (PRD R71).</summary>
    public void ShowForeground(string title)
    {
        if (DockWindow.NameOf(title) is not { } name || model.SelectWindow(name) is not { } key)
        {
            return;
        }

        Dispatcher.UIThread.Post(
            () => this.GetVisualDescendants().OfType<Border>().FirstOrDefault((border) => border.Classes.Contains("row") && border.DataContext is RowViewModel row && row.Key == key)?.BringIntoView(),
            DispatcherPriority.Loaded);
    }

    /// <summary>Closes the dock, which removes its strip, so other windows take the full screen again.</summary>
    void OnCloseClicked(object? sender, RoutedEventArgs e) => Close();

    void OnGroupTapped(object? sender, TappedEventArgs e)
    {
        if ((sender as Control)?.DataContext is GroupViewModel group)
        {
            group.Toggle();
        }
    }

    async void OnRowTapped(object? sender, TappedEventArgs e)
    {
        // A button on the row runs its own control, not the row's click.
        if ((sender as Control)?.DataContext is not RowViewModel row || (e.Source as Visual)?.FindAncestorOfType<Button>(includeSelf: true) is not null)
        {
            return;
        }

        await Open(row);
    }

    /// <summary>The row's click (PRD R71): its session and its item window; a click on another row replaces a click still running.</summary>
    async Task Open(RowViewModel row)
    {
        model.Selected = row.Key;

        // A second click on the row being switched to would stop its session twice; a click on another row replaces the first click.
        if (running?.Key == row.Key)
        {
            return;
        }

        running?.Cancel.Cancel();

        using var cancel = new CancellationTokenSource();
        var mine = (row.Key, cancel);

        running = mine;
        model.Status = null;

        string? status;

        try
        {
            status = await actions.Click(row.Row, cancel.Token);
        }
        catch (Exception error)
        {
            // An async void handler must not throw, or the dock exits.
            status = $"The click failed: {error.Message}";
        }

        if (!cancel.IsCancellationRequested)
        {
            model.Status = status;
        }

        if (running == mine)
        {
            running = null;
        }
    }

    void OnRowContext(object? sender, ContextRequestedEventArgs e)
    {
        if (sender is not Control target || target.DataContext is not RowViewModel row)
        {
            return;
        }

        model.Selected = row.Key;
        e.Handled = true;

        var menu = new ContextMenu { ItemsSource = MenuOf(row.Row) };

        menu.Open(target);
    }

    /// <summary>The row's hub controls, Snooze with its choices, then Open ticket (PRD R71).</summary>
    internal List<Control> MenuOf(DockRow row)
    {
        List<Control> items = [];

        // Open in Claude is the click itself on a row whose session waits on a question (PRD R70).
        if (row.Open is { Type: "question" } && model.Row(row.Key) is { } shown)
        {
            items.Add(Item("Open in Claude", () => Open(shown)));
        }

        foreach (var control in row.Controls)
        {
            if (control.Label == "Snooze")
            {
                items.Add(new MenuItem { Header = "Snooze", ItemsSource = model.Snooze.Select((choice) => Item(choice.Description == "" ? choice.Label : $"{choice.Label} · {choice.Description}", () => Act(Snoozed(control.Action, choice.Until)))).ToList() });
            }
            else
            {
                items.Add(Item(control.Label, () => Act(control.Action)));
            }
        }

        if (row.Pastes.Count == 1)
        {
            items.Add(Item($"Copy {row.Pastes[0].Label}", () => Copy(row.Pastes[0])));
        }
        else if (row.Pastes.Count > 1)
        {
            items.Add(new MenuItem { Header = "Copy", ItemsSource = row.Pastes.Select((paste) => Item(paste.Label, () => Copy(paste))).ToList() });
        }

        foreach (var command in row.Commands)
        {
            items.Add(Item(command.Label, () => Run(row, command.Command)));
        }

        if (row.Url != "")
        {
            if (items.Count > 0)
            {
                items.Add(new Separator());
            }

            items.Add(Item("Open ticket", () =>
            {
                model.Status = actions.OpenUrl(row.Url);
                return Task.CompletedTask;
            }));
        }

        return items;
    }

    static MenuItem Item(string header, Func<Task> run)
    {
        var item = new MenuItem { Header = header };

        item.Click += async (_, _) => await run();

        return item;
    }

    static JsonObject Snoozed(JsonObject action, long? until)
    {
        var copy = action.DeepClone().AsObject();

        copy["until"] = until;

        return copy;
    }

    async Task Act(JsonObject action)
    {
        model.Status = null;
        model.Status = await hub.Act(action.DeepClone().AsObject());
    }

    /// <summary>A control that runs in VS Code; like a click, it replaces a click or control still switching windows.</summary>
    async Task Run(DockRow? row, JsonObject command)
    {
        running?.Cancel.Cancel();

        using var cancel = new CancellationTokenSource();
        var mine = ("", cancel);

        running = mine;
        model.Status = null;

        string? status;

        try
        {
            status = await actions.Run(row, command, cancel.Token);
        }
        catch (Exception error)
        {
            status = $"The command failed: {error.Message}";
        }

        if (!cancel.IsCancellationRequested)
        {
            model.Status = status;
        }

        if (running == mine)
        {
            running = null;
        }
    }

    /// <summary>Copy (PRD R60): the draft as it is on disk now, on the clipboard.</summary>
    async Task Copy(DockPaste paste)
    {
        try
        {
            var text = Paste.Read(paste.File);

            if (Clipboard is null)
            {
                model.Status = "The clipboard is not available.";
                return;
            }

            await Clipboard.SetTextAsync(text);
            model.Status = $"Copied {paste.Label}.";
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            model.Status = $"{paste.Label} could not be read: {error.Message}";
        }
    }

    async void OnMainClicked(object? sender, RoutedEventArgs e)
    {
        if ((sender as Control)?.DataContext is not RowViewModel row)
        {
            return;
        }

        model.Selected = row.Key;

        if (row.Main == "Open in Claude")
        {
            await Open(row);
        }
        else if (row.Row.Controls.FirstOrDefault((control) => control.Label == row.Main) is { } control)
        {
            await Act(control.Action);
        }
    }

    async void OnAnswerClicked(object? sender, RoutedEventArgs e)
    {
        if ((sender as Control)?.DataContext is DockAnswer answer)
        {
            await Act(answer.Action);
        }
    }

    async void OnCopyClicked(object? sender, RoutedEventArgs e)
    {
        if (sender is not Control button || button.DataContext is not RowViewModel row)
        {
            return;
        }

        if (row.Row.Pastes.Count == 1)
        {
            await Copy(row.Row.Pastes[0]);
        }
        else
        {
            new ContextMenu { ItemsSource = row.Row.Pastes.Select((paste) => Item(paste.Label, () => Copy(paste))).ToList() }.Open(button);
        }
    }

    async void OnReportClicked(object? sender, RoutedEventArgs e)
    {
        if ((sender as Control)?.DataContext is RowViewModel { Report: { } report } row)
        {
            await Run(row.Row, report.Command);
        }
    }

    async void OnSourceClicked(object? sender, RoutedEventArgs e)
    {
        if ((sender as Control)?.DataContext is SourceViewModel source)
        {
            model.Status = await hub.SetSource(source.Name, !source.Enabled);
        }
    }

    void OnAdhocClicked(object? sender, RoutedEventArgs e)
    {
        if (model.RepoRoots.Count == 0)
        {
            model.Status = "Set a repoRoot on a source to start an ad-hoc session.";
            return;
        }

        model.AdhocOpen = !model.AdhocOpen;
    }

    /// <summary>Starts the ad-hoc session (PRD R6); a refusal keeps the form and its prompt.</summary>
    async void OnAdhocStart(object? sender, RoutedEventArgs e)
    {
        var prompt = model.AdhocPrompt.Trim();

        if (prompt == "" || model.AdhocRepo is not { } repo || model.AdhocBusy)
        {
            return;
        }

        model.AdhocBusy = true;

        try
        {
            model.Status = await hub.Act(new JsonObject { ["type"] = "adhoc", ["prompt"] = model.AdhocPrompt, ["repoRoot"] = repo });
        }
        finally
        {
            model.AdhocBusy = false;
        }

        if (model.Status is null)
        {
            model.AdhocPrompt = "";
            model.AdhocOpen = false;
        }
    }

    void OnAdhocCancel(object? sender, RoutedEventArgs e) => model.AdhocOpen = false;

    async void OnSettingsClicked(object? sender, RoutedEventArgs e) => await Run(null, new JsonObject { ["type"] = "settings" });

    void OnSearchKey(object? sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape)
        {
            model.Filter = "";
        }
    }

    void OnGripPressed(object? sender, PointerPressedEventArgs e)
    {
        resizing = true;
        e.Pointer.Capture(sender as IInputElement);
    }

    void OnGripMoved(object? sender, PointerEventArgs e)
    {
        if (!resizing)
        {
            return;
        }

        var width = Math.Clamp(e.GetPosition(this).X, DockSettings.MinWidth, DockSettings.MaxWidth);

        dragged = width;

        // The left edge stays where it is; only the strip's width follows the pointer.
        if (placed is { } bounds)
        {
            Place(bounds with { Right = bounds.Left + (int)Math.Round(width * RenderScaling) });
        }
        else
        {
            Width = width;
        }
    }

    void OnGripReleased(object? sender, PointerReleasedEventArgs e)
    {
        if (!resizing)
        {
            return;
        }

        resizing = false;
        e.Pointer.Capture(null);
        model.Settings.Width = dragged ?? model.Settings.Width;
        dragged = null;
        model.SaveSettings();
        // The work area changes only now, so windows beside the dock move once, not on every step of the drag.
        Dock();
    }

    sealed class NoActions : IDockActions
    {
        public Task<string?> Click(DockRow row, CancellationToken cancel) => Task.FromResult<string?>(null);

        public Task<string?> Run(DockRow? row, JsonObject command, CancellationToken cancel) => Task.FromResult<string?>(null);

        public string? OpenUrl(string url) => null;
    }

    sealed class NoHub : IHub
    {
        public Task<string?> Act(JsonObject action) => Task.FromResult<string?>(null);

        public Task<WindowReply> Window(JsonObject command, string? workspace) => Task.FromResult(new WindowReply(null, null));

        public Task<string?> Withdraw(int id) => Task.FromResult<string?>(null);

        public Task<string?> SetSource(string name, bool enabled) => Task.FromResult<string?>(null);

        public Task<string?> Open(string sessionId, string cwd, string workspace) => Task.FromResult<string?>(null);

        public Task<DockView?> Until(Func<DockView, bool> test, TimeSpan within) => Task.FromResult<DockView?>(null);
    }
}
