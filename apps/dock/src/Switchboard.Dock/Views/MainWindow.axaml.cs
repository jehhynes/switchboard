using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Avalonia.VisualTree;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Platform;

namespace Switchboard.Dock.Views;

/// <summary>The dock (PRD R71): the list, docked to the left edge of the primary monitor as an app bar when <c>docked</c>.</summary>
public sealed partial class MainWindow : Window
{
    readonly DockViewModel model;
    readonly HubClient? stream;
    readonly IHub hub;
    readonly Func<DockRow, CancellationToken, Task<string?>> click;
    readonly Func<string, string?> openUrl;
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
        : this(new DockViewModel(new DockSettings(), (_) => { }), null, new NoHub(), (_, _) => Task.FromResult<string?>(null), (_) => null, docked: false)
    {
    }

    public MainWindow(DockViewModel model, HubClient? stream, IHub hub, Func<DockRow, CancellationToken, Task<string?>> click, Func<string, string?> openUrl, bool docked)
    {
        this.model = model;
        this.stream = stream;
        this.hub = hub;
        this.click = click;
        this.openUrl = openUrl;
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
        if ((sender as Control)?.DataContext is not RowViewModel row)
        {
            return;
        }

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
            status = await click(row.Row, cancel.Token);
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

        if (row.Url != "")
        {
            if (items.Count > 0)
            {
                items.Add(new Separator());
            }

            items.Add(Item("Open ticket", () =>
            {
                model.Status = openUrl(row.Url);
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

    sealed class NoHub : IHub
    {
        public Task<string?> Act(JsonObject action) => Task.FromResult<string?>(null);

        public Task<string?> Open(string sessionId, string cwd, string workspace) => Task.FromResult<string?>(null);

        public Task<DockView?> Until(Func<DockView, bool> test, TimeSpan within) => Task.FromResult<DockView?>(null);
    }
}
