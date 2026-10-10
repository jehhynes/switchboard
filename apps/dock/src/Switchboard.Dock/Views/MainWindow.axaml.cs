using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Controls.Primitives.PopupPositioning;
using Avalonia.Input;
using Avalonia.Input.Platform;
using Avalonia.Interactivity;
using Avalonia.Media;
using Avalonia.Threading;
using Avalonia.VisualTree;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Platform;
using Switchboard.Dock.Settings;
using Switchboard.Dock.Switching;

namespace Switchboard.Dock.Views;

/// <summary>The dock (PRD R71): the list, docked to the left or right edge of a monitor as an app bar when <c>docked</c>.</summary>
public sealed partial class MainWindow : Window
{
    readonly DockViewModel model;
    readonly HubClient? stream;
    readonly IHub hub;
    readonly IDockActions actions;
    readonly bool docked;
    readonly IConfigHub? config;
    SettingsWindow? settingsWindow;
    AppBar? appBar;
    // The strip the docked window last took, in physical pixels.
    Native.Rect? placed;
    bool resizing;
    /// <summary>Where the pointer last moved or pressed, in window coordinates; a row's menu opens there.</summary>
    Point pointer;
    // The width the pointer has dragged to, in device-independent pixels, before rounding to physical pixels.
    double? dragged;
    // The click that is running, which a click on another row replaces.
    (string Key, CancellationTokenSource Cancel)? running;
    bool moving;
    // A press on a movable row, which becomes a drag of that row once the pointer moves more than DragStart vertically (PRD R73).
    (string Key, Point Start, IPointer Pointer)? press;
    // The key of the row being dragged; rows are rebuilt on each hub update, so the row is found again by its key.
    string? dragging;
    // Where the pointer last was during the drag, in window coordinates, which stay put while the list scrolls or moves under a still pointer.
    Point dragAt;
    // A drag ended on this press, so the row's tap does not run its click.
    bool rowDragged;
    const double DragStart = 4;

    /// <summary>Raised with the monitor the dock docked on, where item windows are placed.</summary>
    public event Action<nint>? DockedOn;

    /// <summary>For the XAML previewer only.</summary>
    public MainWindow()
        : this(new DockViewModel(new DockSettings(), (_) => { }), null, new NoHub(), new NoActions(), docked: false)
    {
    }

    public MainWindow(DockViewModel model, HubClient? stream, IHub hub, IDockActions actions, bool docked, IConfigHub? config = null)
    {
        this.config = config;
        this.model = model;
        this.stream = stream;
        this.hub = hub;
        this.actions = actions;
        this.docked = docked;
        DataContext = model;
        InitializeComponent();
        // After the XAML, whose width is the default.
        Width = model.Settings.Width;
        AddHandler(PointerMovedEvent, (_, e) => pointer = e.GetPosition(this), RoutingStrategies.Tunnel, handledEventsToo: true);
        AddHandler(PointerPressedEvent, (_, e) => pointer = e.GetPosition(this), RoutingStrategies.Tunnel, handledEventsToo: true);
        AddHandler(KeyDownEvent, OnKey, RoutingStrategies.Tunnel);
        // A pressed button handles the press, so it starts no drag.
        GroupList.AddHandler(PointerPressedEvent, OnListPressed);
        GroupList.AddHandler(PointerMovedEvent, OnListMoved, handledEventsToo: true);
        GroupList.AddHandler(PointerReleasedEvent, OnListReleased, handledEventsToo: true);
        GroupList.AddHandler(PointerCaptureLostEvent, OnListCaptureLost);
        // A hub update, a note above the list or a scroll moves the rows under a still pointer, so the drop line is placed again after each layout.
        LayoutUpdated += (_, _) => RedrawDrop();
        RowScroller.ScrollChanged += (_, _) => RedrawDrop();

        if (stream is not null)
        {
            stream.Changed += () => Dispatcher.UIThread.Post(Refresh);
            // A VS Code window's status bar item asks for the dock (PRD R71).
            stream.ShowRequested += () => Dispatcher.UIThread.Post(Activate);
        }

        // Hidden until it is in its strip, so it does not show at Avalonia's first size and position and then jump (the window exists before it is shown).
        if (docked && OperatingSystem.IsWindows() && TryGetPlatformHandle() is { } handle)
        {
            Native.NoTransitions(handle.Handle);
            Native.Cloak(handle.Handle, true);
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
            // Dispatched, because the bar raises it from inside its window procedure.
            appBar.Moved += () => Dispatcher.UIThread.Post(Dock);
            appBar.FullScreen += (full) => Topmost = !full;
            Dock();
            // Shown after it has drawn a frame at the strip's size.
            RequestAnimationFrame((_) => RequestAnimationFrame((_) => Native.Cloak(handle.Handle, false)));
            // Shown regardless after a second, in case no frame is drawn, so the dock never stays hidden.
            DispatcherTimer.RunOnce(() => Native.Cloak(handle.Handle, false), TimeSpan.FromSeconds(1));
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

    /// <summary>Reserves the strip at the kept edge and monitor, at the kept width (PRD R71).</summary>
    void Dock()
    {
        if (OperatingSystem.IsWindows() && appBar is not null)
        {
            var monitor = Native.MonitorNamed(model.Settings.Monitor);
            Place(appBar.Dock(model.Settings.DockEdge, monitor, DockPlacement.Pixels(model.Settings.Width, Native.Scale(monitor))));
            DockedOn?.Invoke(appBar.Monitor);
        }
        else
        {
            Width = model.Settings.Width;
        }
    }

    /// <summary>Places the docked window in its reserved strip.</summary>
    void Place(Native.Rect bounds)
    {
        placed = bounds;
        Hold(bounds);
    }

    /// <summary>
    /// Moves and sizes the docked window with Win32, and holds it there, because Avalonia moves a window it resizes into the monitor's work area,
    /// which starts at the dock's own inner edge.
    /// </summary>
    void Hold(Native.Rect bounds)
    {
        if (OperatingSystem.IsWindows() && TryGetPlatformHandle() is { } handle)
        {
            if (appBar is not null)
            {
                appBar.Strip = bounds;
            }

            Native.SetWindowPos(handle.Handle, 0, bounds.Left, bounds.Top, bounds.Right - bounds.Left, bounds.Bottom - bounds.Top, Native.SwpNoZOrder | Native.SwpNoActivate);
        }
    }

    void OnMovePressed(object? sender, PointerPressedEventArgs e)
    {
        if (e.GetCurrentPoint(this).Properties.IsLeftButtonPressed)
        {
            moving = true;
            e.Pointer.Capture(sender as IInputElement);
            e.Handled = true;
        }
    }

    /// <summary>Another window took the pointer during a drag of the title, so no release comes: the drag ends where it is.</summary>
    void OnMoveCaptureLost(object? sender, PointerCaptureLostEventArgs e)
    {
        moving = false;
    }

    /// <summary>Docks at the nearer left or right edge of the monitor the title is dropped on, and keeps it (PRD R71).</summary>
    void OnMoveReleased(object? sender, PointerReleasedEventArgs e)
    {
        if (!moving)
        {
            return;
        }

        moving = false;
        e.Pointer.Capture(null);

        if (OperatingSystem.IsWindows() && appBar is not null)
        {
            var drop = this.PointToScreen(e.GetPosition(this));
            var monitor = Native.MonitorFromPoint(new System.Drawing.Point(drop.X, drop.Y), Native.MonitorDefaultToNearest);
            var edge = DockPlacement.EdgeAt(drop.X, Native.Bounds(monitor));
            var name = monitor == Native.PrimaryMonitor() ? null : Native.MonitorName(monitor);

            if (edge != model.Settings.DockEdge || name != model.Settings.Monitor)
            {
                model.SetPlacement(edge, name);
                Dock();
            }
        }
    }

    /// <summary>Selects and scrolls to the row of an item window that came to the front by any means; other windows change nothing (PRD R71).</summary>
    public void ShowForeground(string title)
    {
        if (DockWindow.NameOf(title) is not { } name || model.SelectWindow(name) is not { } key)
        {
            return;
        }

        ScrollTo(key);
    }

    /// <summary>Scrolls the row into view once a group or band it opened has drawn its rows.</summary>
    void ScrollTo(string key) =>
        Dispatcher.UIThread.Post(
            () => this.GetVisualDescendants().OfType<Border>().FirstOrDefault((border) => border.Classes.Contains("row") && border.DataContext is RowViewModel row && row.Key == key)?.BringIntoView(),
            DispatcherPriority.Loaded);

    async void OnKey(object? sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape && dragging is not null)
        {
            e.Handled = true;
            CancelDrag();
        }
        else if (e.Key == Key.F8 && (e.KeyModifiers & ~KeyModifiers.Shift) == KeyModifiers.None)
        {
            e.Handled = true;
            await NextTurn(backwards: e.KeyModifiers == KeyModifiers.Shift);
        }
        else if (e.KeyModifiers == KeyModifiers.Alt && e.Key is Key.Up or Key.Down && model.Selected is { } key && model.Row(key) is { Row.Movable: true } row
            && row.Row.Controls.FirstOrDefault((control) => control.Label == (e.Key == Key.Up ? "Move up" : "Move down")) is { } move)
        {
            e.Handled = true;
            await Act(move.Action);
        }
    }

    /// <summary>F8: the next row on the operator's turn, selected, shown and clicked as a tap would (PRD R73); Shift+F8 the previous.</summary>
    async Task NextTurn(bool backwards)
    {
        if (model.SelectNextTurn(backwards) is not { } row)
        {
            return;
        }

        ScrollTo(row.Key);
        await Open(row);
    }

    void OnListPressed(object? sender, PointerPressedEventArgs e)
    {
        rowDragged = false;
        press = null;

        if (e.GetCurrentPoint(this).Properties.IsLeftButtonPressed
            && (e.Source as Visual)?.GetSelfAndVisualAncestors().OfType<Border>().FirstOrDefault((border) => border.Classes.Contains("row")) is { DataContext: RowViewModel { Row.Movable: true } row })
        {
            press = (row.Key, e.GetPosition(GroupList), e.Pointer);
        }
    }

    void OnListMoved(object? sender, PointerEventArgs e)
    {
        if (press is not { } pressed)
        {
            return;
        }

        var at = e.GetPosition(GroupList);

        if (dragging is null)
        {
            if (Math.Abs(at.Y - pressed.Start.Y) <= DragStart)
            {
                return;
            }

            if (!e.GetCurrentPoint(this).Properties.IsLeftButtonPressed)
            {
                press = null;
                return;
            }

            dragging = pressed.Key;
            rowDragged = true;
            e.Pointer.Capture(GroupList);
        }

        dragAt = e.GetPosition(this);
        ShowDrop(DropAt(at));
    }

    async void OnListReleased(object? sender, PointerReleasedEventArgs e)
    {
        if (dragging is null)
        {
            press = null;
            return;
        }

        var drop = DropAt(e.GetPosition(GroupList));

        CancelDrag();

        if (drop is { } move)
        {
            await Act(new JsonObject { ["type"] = "move", ["workItemId"] = move.WorkItemId, ["after"] = move.After });
        }
    }

    /// <summary>Another window took the pointer, so no release comes: the drag ends without a move.</summary>
    void OnListCaptureLost(object? sender, PointerCaptureLostEventArgs e)
    {
        if (dragging is not null)
        {
            CancelDrag();
        }
    }

    void RedrawDrop()
    {
        if (dragging is not null && this.TranslatePoint(dragAt, GroupList) is { } at)
        {
            ShowDrop(DropAt(at));
        }
    }

    void CancelDrag()
    {
        var held = press?.Pointer;

        dragging = null;
        press = null;
        ShowDrop(null);
        held?.Capture(null);
    }

    /// <summary>
    /// The move a drop at <paramref name="at"/>, in the group list's coordinates, makes: the dragged row's ID, the ID of the Ready for review row
    /// above the drop point or null for the top, and the row edge the drop line marks. Null outside Ready for review's rows or the list's visible
    /// part, at the row's own place, or when the dragged row is no longer a movable Ready for review row.
    /// </summary>
    (int WorkItemId, int? After, Border Edge, bool Below)? DropAt(Point at)
    {
        if (dragging is not { } key || model.Groups.FirstOrDefault((group) => group.Key == "review") is not { ShowsRows: true } review)
        {
            return null;
        }

        var borders = GroupList.GetVisualDescendants().OfType<Border>().Where((border) => border.Classes.Contains("row") && border.IsEffectivelyVisible).ToList();
        var rows = review.Rows.Select((row) => (Row: row.Row, Border: borders.FirstOrDefault((border) => ReferenceEquals(border.DataContext, row)))).Where((entry) => entry.Border is not null).ToList();
        var from = rows.FindIndex((entry) => entry.Row.Key == key);

        if (from < 0 || !rows[from].Row.Movable || rows[from].Row.WorkItemId is not { } id)
        {
            return null;
        }

        double Top(int index) => rows[index].Border!.TranslatePoint(default, GroupList)!.Value.Y;

        var left = rows[0].Border!.TranslatePoint(default, GroupList)!.Value.X;

        if (at.Y < Top(0) || at.Y > Top(rows.Count - 1) + rows[^1].Border!.Bounds.Height || at.X < left || at.X > left + rows[0].Border!.Bounds.Width)
        {
            return null;
        }

        // Under capture the pointer can be past the scrolled-out part of the list or outside the window.
        if (GroupList.TranslatePoint(at, RowScroller) is not { } seen || !new Rect(RowScroller.Bounds.Size).Contains(seen))
        {
            return null;
        }

        var to = Enumerable.Range(0, rows.Count).Count((index) => Top(index) + (rows[index].Border!.Bounds.Height / 2) < at.Y);

        if (to == from || to == from + 1)
        {
            return null;
        }

        return to == rows.Count ? (id, rows[^1].Row.WorkItemId, rows[^1].Border!, true) : (id, to == 0 ? null : rows[to - 1].Row.WorkItemId, rows[to].Border!, false);
    }

    /// <summary>Draws the drop line on the top edge of the row below the drop point, or the bottom edge of the last row; null hides it.</summary>
    void ShowDrop((int WorkItemId, int? After, Border Edge, bool Below)? drop)
    {
        if (drop is not { } shown || shown.Edge.TranslatePoint(new Point(0, shown.Below ? shown.Edge.Bounds.Height : 0), DropLayer) is not { } corner)
        {
            DropLine.IsVisible = false;
            return;
        }

        Canvas.SetLeft(DropLine, corner.X);
        Canvas.SetTop(DropLine, corner.Y - 1);
        DropLine.Width = shown.Edge.Bounds.Width;
        DropLine.IsVisible = true;
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

    void OnBandTapped(object? sender, TappedEventArgs e)
    {
        if ((sender as Control)?.DataContext is BandViewModel band)
        {
            band.Toggle();
        }
    }

    /// <summary>A pill with a link, the ticket's key or a link badge, opens it in the browser instead of running the row's click (PRD R52).</summary>
    void OnPillTapped(object? sender, TappedEventArgs e)
    {
        if ((sender as Control)?.Tag is string { Length: > 0 } url)
        {
            e.Handled = true;
            model.Status = actions.OpenUrl(url);
        }
    }

    async void OnRowTapped(object? sender, TappedEventArgs e)
    {
        // A button on the row runs its own control, not the row's click, and a drag of the row only moves it.
        if ((sender as Control)?.DataContext is not RowViewModel row || (e.Source as Visual)?.FindAncestorOfType<Button>(includeSelf: true) is not null || rowDragged)
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

        // The event's own position can be wrong for a right-click, so the menu opens where the pointer last was; one opened from the keyboard,
        // which has no position, opens at the row's corner.
        var at = e.TryGetPosition(this, out _) ? pointer : target.TranslatePoint(default, this) ?? default;

        RowMenu(MenuOf(row.Row), model.GripOnLeft, at).Open(this);
    }

    /// <summary>
    /// A row's menu at the pointer, opening away from the screen edge the dock is on. Popups are kept inside the monitor's working area, which
    /// leaves out the dock's app bar strip, so a horizontal adjustment would move the menu beside the dock; only vertical ones are allowed.
    /// Submenus follow the same rule.
    /// </summary>
    internal static ContextMenu RowMenu(List<Control> items, bool dockOnRight, Point at)
    {
        foreach (var item in items.OfType<MenuItem>().Where((item) => item.ItemsSource is not null))
        {
            item.TemplateApplied += (_, e) =>
            {
                if (e.NameScope.Find<Popup>("PART_Popup") is { } popup)
                {
                    popup.Placement = dockOnRight ? PlacementMode.LeftEdgeAlignedTop : PlacementMode.RightEdgeAlignedTop;
                    popup.PlacementConstraintAdjustment = PopupPositionerConstraintAdjustment.FlipY | PopupPositionerConstraintAdjustment.SlideY;

                    // The theme's offset overlaps the submenu with its item on the right; mirror it so a left submenu overlaps too.
                    if (dockOnRight)
                    {
                        popup.HorizontalOffset = -popup.HorizontalOffset;
                    }
                }
            };
        }

        return new()
        {
            ItemsSource = items,
            Placement = PlacementMode.AnchorAndGravity,
            PlacementRect = new Rect(at, new Size(1, 1)),
            PlacementAnchor = PopupAnchor.TopLeft,
            PlacementGravity = dockOnRight ? PopupGravity.BottomLeft : PopupGravity.BottomRight,
            PlacementConstraintAdjustment = PopupPositionerConstraintAdjustment.FlipY | PopupPositionerConstraintAdjustment.SlideY,
        };
    }

    /// <summary>The row's hub controls, Snooze with its choices, then Open ticket (PRD R71).</summary>
    internal List<Control> MenuOf(DockRow row)
    {
        List<Control> items = [];

        // Open in Claude is the click itself on a row whose session waits on a question (PRD R70).
        if (row.Open is { Type: "question" } && model.Row(row.Key) is { } shown)
        {
            items.Add(Item("Open in Claude", () => Open(shown), row.MainGlyph));
        }

        foreach (var control in row.Controls.Where((control) => control.Confirm is null))
        {
            if (control.Label == "Snooze")
            {
                items.Add(new MenuItem { Header = "Snooze", Icon = Glyph(control.Glyph), ItemsSource = model.Snooze.Select((choice) => Item(choice.Description == "" ? choice.Label : $"{choice.Label} · {choice.Description}", () => Act(Snoozed(control.Action, choice.Until)))).ToList() });
            }
            else
            {
                items.Add(Item(control.Label, () => Act(control), control.Glyph));
            }
        }

        if (row.Pastes.Count == 1)
        {
            items.Add(Item($"Copy {row.Pastes[0].Label}", () => Copy(row.Pastes[0]), CopyGlyph));
        }
        else if (row.Pastes.Count > 1)
        {
            items.Add(new MenuItem { Header = "Copy", Icon = Glyph(CopyGlyph), ItemsSource = row.Pastes.Select((paste) => Item(paste.Label, () => Copy(paste))).ToList() });
        }

        foreach (var command in row.Commands)
        {
            items.Add(Item(command.Label, () => Run(row, command.Command), command.Glyph));
        }

        // Controls that ask first, such as Delete, come last, apart from the rest.
        var asking = row.Controls.Where((control) => control.Confirm is not null).ToList();

        if (asking.Count > 0 && items.Count > 0)
        {
            items.Add(new Separator());
        }

        foreach (var control in asking)
        {
            items.Add(Item(control.Label, () => Act(control), control.Glyph));
        }

        // The ticket, then its links, such as its pull request (PRD R52), open in the browser.
        var opens = (row.Url == "" ? [] : new[] { ("Open ticket", row.Url) }).Concat(row.Links.Select((link) => ($"Open {link.Label}", link.Url))).ToList();

        if (opens.Count > 0 && items.Count > 0)
        {
            items.Add(new Separator());
        }

        foreach (var (label, url) in opens)
        {
            items.Add(Item(label, () =>
            {
                model.Status = actions.OpenUrl(url);
                return Task.CompletedTask;
            }, LinkGlyph));
        }

        return items;
    }

    // Codicons the dock draws itself: copy and link-external.
    const string CopyGlyph = "\uEBCC";
    const string LinkGlyph = "\uEB14";

    static MenuItem Item(string header, Func<Task> run, string? glyph = null)
    {
        var item = new MenuItem { Header = header, Icon = Glyph(glyph) };

        item.Click += async (_, _) => await run();

        return item;
    }

    /// <summary>A menu item's codicon, or null for none.</summary>
    static TextBlock? Glyph(string? glyph) =>
        string.IsNullOrEmpty(glyph) ? null : new TextBlock { Text = glyph, FontFamily = (FontFamily)Application.Current!.FindResource("Codicons")!, FontSize = 14, VerticalAlignment = Avalonia.Layout.VerticalAlignment.Center };

    static JsonObject Snoozed(JsonObject action, long? until)
    {
        var copy = action.DeepClone().AsObject();

        copy["until"] = until;

        return copy;
    }

    /// <summary>Posts the control's action, after the operator confirms it when the hub sent a question.</summary>
    async Task Act(DockControl control)
    {
        if (control.Confirm is { } confirm && !await ConfirmDialog.Ask(this, confirm.Question, confirm.Detail, confirm.Action))
        {
            return;
        }

        await Act(control.Action);
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
            await Act(control);
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

    /// <summary>Opens the Settings window (PRD R54), or brings the open one forward.</summary>
    async void OnSettingsClicked(object? sender, RoutedEventArgs e)
    {
        if (settingsWindow is not null)
        {
            settingsWindow.Activate();
            return;
        }

        if (config is null)
        {
            model.Status = "Settings need the hub.";
            return;
        }

        var editor = new SettingsEditor(config);
        var window = new SettingsWindow(editor, actions);
        // The hub says when the files change on disk, so the window reads them again.
        Action reload = () => Dispatcher.UIThread.Post(() => _ = editor.Load());

        settingsWindow = window;

        if (stream is not null)
        {
            stream.ConfigChanged += reload;
            // A hub started on another config folder connects as a new stream.
            stream.Connected += reload;
        }

        window.Closed += (_, _) =>
        {
            settingsWindow = null;

            if (stream is not null)
            {
                stream.ConfigChanged -= reload;
                stream.Connected -= reload;
            }
        };
        window.Show();
        await editor.Load();
    }

    /// <summary>The open Settings window, or null.</summary>
    internal SettingsWindow? Settings => settingsWindow;

    void OnSearchKey(object? sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape)
        {
            model.SearchOpen = false;
        }
    }

    void OnSearchClicked(object? sender, RoutedEventArgs e)
    {
        model.SearchOpen = !model.SearchOpen;

        if (model.SearchOpen)
        {
            Dispatcher.UIThread.Post(() => SearchBox.Focus());
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

        // The outer edge stays where it is; only the strip's width follows the pointer.
        if (OperatingSystem.IsWindows() && appBar is not null && placed is { } bounds)
        {
            var strip = Native.Pixels(bounds);
            var scale = Native.Scale(appBar.Monitor);
            var width = Math.Clamp(DockPlacement.WidthAt(model.Settings.DockEdge, strip, this.PointToScreen(e.GetPosition(this)).X) / scale, DockSettings.MinWidth, DockSettings.MaxWidth);

            dragged = width;
            Hold(Native.RectOf(DockPlacement.Strip(model.Settings.DockEdge, strip, DockPlacement.Pixels(width, scale))));
        }
        else
        {
            dragged = Math.Clamp(e.GetPosition(this).X, DockSettings.MinWidth, DockSettings.MaxWidth);
            Width = dragged.Value;
        }
    }

    void OnGripReleased(object? sender, PointerReleasedEventArgs e)
    {
        if (resizing)
        {
            e.Pointer.Capture(null);
            EndResize();
        }
    }

    /// <summary>Another window took the pointer during a drag of the inner edge, so no release comes: the width it reached is kept.</summary>
    void OnGripCaptureLost(object? sender, PointerCaptureLostEventArgs e)
    {
        if (resizing)
        {
            EndResize();
        }
    }

    void EndResize()
    {
        resizing = false;
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
