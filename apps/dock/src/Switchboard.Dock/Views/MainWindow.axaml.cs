using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Controls.Primitives.PopupPositioning;
using Avalonia.Input;
using Avalonia.Input.Platform;
using Avalonia.Interactivity;
using Avalonia.Media;
using Avalonia.Styling;
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
    VolumeWindow? volumeWindow;
    AppBar? appBar;
    // The strip the docked window last took, in physical pixels.
    Native.Rect? placed;
    bool resizing;
    // Auto-hide (PRD R71): whether the dock shows only its sliver, and the check that hides it while it shows.
    bool hidden;
    readonly HideDelay hideDelay = new();
    readonly System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
    DispatcherTimer? hideTimer;
    DispatcherTimer? topmostTimer;
    /// <summary>Where the pointer last moved or pressed, in window coordinates; a row's menu and a tooltip open there.</summary>
    Point pointer;
    // The width the pointer has dragged to, in device-independent pixels, before rounding to physical pixels.
    double? dragged;
    // The click that is running, which a click on another row replaces.
    (string Key, CancellationTokenSource Cancel)? running;
    bool moving;
    // An ordinary window, where the dock cannot reserve a screen edge (Float).
    bool floating;
    // Docked at a monitor's edge as an X11 dock window (DockOnX11), and the X11 properties that reserve its strip, when an X display opened.
    bool edgeDocked;
    IDisposable? x11;
    // As an X11 dock window, the RandR name of the monitor the dock is on, and the monitors a full-screen window covers.
    string? edgeMonitor;
    IReadOnlyList<string> fullScreen = [];
    // A floating resize's start: the pointer on the screen, the width and the window's position.
    (int X, double Width, PixelPoint Position) resizeFrom;
    // A press on a movable row, which becomes a drag of that row once the pointer moves more than DragStart vertically (PRD R73).
    (string Key, Point Start, IPointer Pointer)? press;
    // The key of the row being dragged; rows are rebuilt on each hub update, so the row is found again by its key.
    string? dragging;
    // Where the pointer last was during the drag, in window coordinates, which stay put while the list scrolls or moves under a still pointer.
    Point dragAt;
    // A drag ended on this press, so the row's tap does not run its click.
    bool rowDragged;
    // The last press was on a row, whose click and controls switch to VS Code or act on its work item, so the dock does not take the focus after it.
    bool pressOnRow;
    const double DragStart = 4;

    /// <summary>Raised with the monitor the dock docked on, where item windows are placed.</summary>
    public event Action<nint>? DockedOn;

    /// <summary>As an X11 dock window, raised with the RandR name of the monitor the dock docked on, where item windows are placed.</summary>
    public event Action<string>? DockedOnX11;

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
        ApplyTheme();
        model.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName is nameof(DockViewModel.VsCodeTheme) or nameof(DockViewModel.Theme))
            {
                ApplyTheme();
            }
        };
        // After the XAML, whose width is the default.
        Width = model.Settings.Width;
        AddHandler(PointerMovedEvent, (_, e) =>
        {
            pointer = e.GetPosition(this);
            Expand();
        }, RoutingStrategies.Tunnel, handledEventsToo: true);
        // Alt+Tab or a VS Code status bar item (ShowRequested) shows a hidden dock.
        Activated += (_, _) => Expand();
        AddHandler(PointerPressedEvent, (_, e) =>
        {
            model.HoldView();
            pointer = e.GetPosition(this);
            pressOnRow = (e.Source as Visual)?.GetSelfAndVisualAncestors().OfType<Border>().Any((border) => border.Classes.Contains("row")) == true;

            // The keys go where the row's click switches to, so the search box shows no caret. As an X11 dock window the dock is not told when
            // another app's window takes the focus, and would keep showing it.
            if (pressOnRow && FocusManager?.GetFocusedElement() is TextBox)
            {
                FocusManager.Focus(null);
            }
        }, RoutingStrategies.Tunnel, handledEventsToo: true);
        // After the release, because taking the focus between the press and the release lost the click on the operator's desktop (mechanics M39).
        // Posted, so the release's tap runs first.
        AddHandler(PointerReleasedEvent, (_, _) =>
        {
            Dispatcher.UIThread.Post(model.ReleaseView);
            if (!pressOnRow)
            {
                Dispatcher.UIThread.Post(TakeFocus);
            }
        }, RoutingStrategies.Tunnel, handledEventsToo: true);
        AddHandler(PointerCaptureLostEvent, (_, e) =>
        {
            if (e.Pointer.Captured is null)
            {
                Dispatcher.UIThread.Post(model.ReleaseView);
            }
        }, RoutingStrategies.Tunnel, handledEventsToo: true);
        Deactivated += (_, _) => Dispatcher.UIThread.Post(model.ReleaseView);
        Styles.Add(new Style((x) => x.Is<Control>())
        {
            Setters =
            {
                new Setter(ToolTip.PlacementProperty, PlacementMode.Custom),
                new Setter(ToolTip.CustomPopupPlacementCallbackProperty, (CustomPopupPlacementCallback)((placement) => PlaceTip(placement, model.GripOnLeft, pointer))),
            },
        });
        AddHandler(KeyDownEvent, OnKey, RoutingStrategies.Tunnel);
        // A pressed button handles the press, so it starts no drag.
        GroupList.AddHandler(PointerPressedEvent, OnListPressed);
        GroupList.AddHandler(PointerMovedEvent, OnListMoved, handledEventsToo: true);
        GroupList.AddHandler(PointerReleasedEvent, OnListReleased, handledEventsToo: true);
        GroupList.AddHandler(PointerCaptureLostEvent, OnListCaptureLost);
        // A hub update, a note above the list or a scroll moves the rows under a still pointer, so the drop line is placed again after each layout.
        LayoutUpdated += (_, _) =>
        {
            RedrawDrop();

            // A hub update or a selection while hidden moves the rows, so the sliver follows them.
            if (hidden)
            {
                Sliver.Bars = SliverBars();
            }
        };
        RowScroller.ScrollChanged += (_, _) => RedrawDrop();

        if (stream is not null)
        {
            stream.Changed += () => Dispatcher.UIThread.Post(Refresh);
            // A VS Code window's status bar item asks for the dock (PRD R71).
            // Shown first, because Windows can refuse the activation to a dock that does not have the latest input.
            stream.ShowRequested += () => Dispatcher.UIThread.Post(() =>
            {
                Expand();
                Activate();
                TakeFocus();
            });
            // A notification's Open or Open in Switchboard on a row that opens a terminal (PRD R65, R69, R71).
            stream.ClickRequested += (key) => Dispatcher.UIThread.Post(() => ClickForwarded(key));
        }

        // Hidden until it is in its strip, so it does not show at Avalonia's first size and position and then jump (the window exists before it is shown).
        if (docked && OperatingSystem.IsWindows() && TryGetPlatformHandle() is { } handle)
        {
            Native.NoTransitions(handle.Handle);
            Native.Cloak(handle.Handle, true);
        }
    }

    /// <summary>Runs the click VS Code forwarded, as the operator's click on the row would.</summary>
    internal async void ClickForwarded(string key)
    {
        if (model.Row(key) is { } row)
        {
            await Open(row);
        }
        else
        {
            // As a click on another row would, it replaces a click still running.
            running?.Cancel.Cancel();
            running = null;
            model.Status = $"Switchboard has no row for {key}.";
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
            appBar.FullScreen += (_) => Dispatcher.UIThread.Post(UpdateTopmost);
            Dock();
            topmostTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(100) };
            topmostTimer.Tick += (_, _) => UpdateTopmost();
            topmostTimer.Start();
            // Shown after it has drawn a frame at the strip's size.
            RequestAnimationFrame((_) => RequestAnimationFrame((_) => Native.Cloak(handle.Handle, false)));
            // Shown regardless after a second, in case no frame is drawn, so the dock never stays hidden.
            DispatcherTimer.RunOnce(() => Native.Cloak(handle.Handle, false), TimeSpan.FromSeconds(1));
        }
    }

    protected override void OnClosed(EventArgs e)
    {
        hideTimer?.Stop();
        topmostTimer?.Stop();

        if (OperatingSystem.IsWindows())
        {
            appBar?.Dispose();
        }

        x11?.Dispose();

        base.OnClosed(e);
    }

    /// <summary>Reserves the strip at the kept edge and monitor, at the kept width, or with auto-hide takes it without reserving it (PRD R71).</summary>
    void Dock()
    {
        if (OperatingSystem.IsWindows() && appBar is not null)
        {
            var monitor = Native.MonitorNamed(model.Settings.Monitor);
            Place(appBar.Dock(model.Settings.DockEdge, monitor, DockPlacement.Pixels(model.Settings.Width, Native.Scale(monitor)), model.Settings.AutoHide));
            DockedOn?.Invoke(appBar.Monitor);

            if (!model.Settings.AutoHide)
            {
                Expand();
                hideTimer?.Stop();
            }
            else if (hidden)
            {
                // The strip may have changed size or edge, so the sliver is cut again.
                Collapse();
            }
            else
            {
                WatchHide();
            }
        }
        else
        {
            Width = model.Settings.Width;

            if (edgeDocked)
            {
                PlaceOnEdge();
            }
        }
    }

    /// <summary>
    /// Places the window in the strip at the kept edge of the kept monitor, or the primary monitor when that is missing, as tall as its work area,
    /// and reserves the strip unless the monitor has a neighbour beyond that edge (<see cref="DockPlacement.CanReserve"/>). Only the work area's
    /// top and bottom are used, because its left and right leave out the dock's own strip. It is Mutter's work area for that monitor: Avalonia's
    /// comes from <c>_NET_WORKAREA</c>, one work area for all monitors, which can leave out a panel on one monitor or a top bar's rows on another.
    /// </summary>
    void PlaceOnEdge()
    {
        if ((Screens.All.FirstOrDefault((each) => model.Settings.Monitor is { } name && each.DisplayName == name) ?? Screens.Primary) is not { } screen)
        {
            return;
        }

        var bounds = PixelRectOf(screen.Bounds);
        var work = (OperatingSystem.IsLinux() && x11 is X11Dock monitors ? DockPlacement.WorkAreaOn(bounds, monitors.WorkAreas()) : null) ?? PixelRectOf(screen.WorkingArea);
        var area = bounds with { Top = work.Top, Bottom = work.Bottom };
        var strip = DockPlacement.Strip(model.Settings.DockEdge, area, DockPlacement.Pixels(model.Settings.Width, screen.Scaling));

        Position = new PixelPoint(strip.Left, strip.Top);
        Height = strip.Height / screen.Scaling;
        edgeMonitor = screen.DisplayName;
        DockedOnX11?.Invoke(edgeMonitor ?? "");

        if (OperatingSystem.IsLinux() && x11 is X11Dock dock)
        {
            if (DockPlacement.CanReserve(model.Settings.DockEdge, strip, bounds, Screens.All.Select((each) => PixelRectOf(each.Bounds))))
            {
                dock.Reserve(model.Settings.DockEdge, strip);
            }
            else
            {
                dock.Release();
            }
        }

        GoBelow();
    }

    static Platform.PixelRect PixelRectOf(Avalonia.PixelRect bounds) => new(bounds.X, bounds.Y, bounds.Right, bounds.Bottom);

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

    /// <summary>Checks every 100 ms whether the shown dock is still kept open, and hides it once it has not been for <see cref="HideDelay.Delay"/>.</summary>
    void WatchHide()
    {
        if (hideTimer?.IsEnabled == true)
        {
            return;
        }

        hideDelay.Reset();

        if (hideTimer is null)
        {
            hideTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(100) };
            hideTimer.Tick += (_, _) =>
            {
                if (hideDelay.Hides(KeptOpen(), clock.Elapsed))
                {
                    Collapse();
                }
            };
        }

        hideTimer.Start();
    }

    void UpdateTopmost()
    {
        if (!OperatingSystem.IsWindows() || appBar is null || TryGetPlatformHandle() is not { } handle)
        {
            return;
        }

        var fullScreen = Native.FullScreenOnMonitor(handle.Handle, appBar.Monitor);

        Topmost = !fullScreen;
        // Avalonia caches Topmost; the shell can change the native style without changing that property.
        Native.SetTopmost(handle.Handle, !fullScreen);
    }

    /// <summary>The pointer is over the dock or a window it owns, such as a menu or dialog, one of them has the focus, or a drag is under way.</summary>
    bool KeptOpen()
    {
        if (resizing || moving || dragging is not null || !OperatingSystem.IsWindows() || TryGetPlatformHandle() is not { } handle)
        {
            return true;
        }

        bool Ours(nint window) => window != 0 && HideDelay.OwnedBy(Native.GetAncestor(window, Native.GaRoot), handle.Handle, (at) => Native.GetWindow(at, Native.GwOwner));

        return (Native.GetCursorPos(out var at) && Ours(Native.WindowFromPoint(at))) || Ours(Native.GetForegroundWindow());
    }

    /// <summary>Shows only the sliver at the outer edge; the window keeps its strip and its layout, so it shows again at once.</summary>
    void Collapse()
    {
        hideTimer?.Stop();

        if (OperatingSystem.IsWindows() && placed is { } bounds && TryGetPlatformHandle() is { } handle)
        {
            var sliver = DockPlacement.Sliver(model.Settings.DockEdge, bounds.Right - bounds.Left, bounds.Bottom - bounds.Top, RenderScaling);

            Sliver.HorizontalAlignment = model.Settings.DockEdge == DockEdge.Left ? Avalonia.Layout.HorizontalAlignment.Left : Avalonia.Layout.HorizontalAlignment.Right;
            Sliver.Bars = SliverBars();
            Sliver.IsVisible = true;
            Native.SetWindowRgn(handle.Handle, Native.CreateRectRgn(sliver.Left, sliver.Top, sliver.Right, sliver.Bottom), true);
            hidden = true;
        }
    }

    /// <summary>The coloured stripe of each row in the list's view, cut to the view, at its height in the window.</summary>
    internal List<SliverBar> SliverBars()
    {
        var view = new Rect(RowScroller.Bounds.Size);
        List<SliverBar> bars = [];

        foreach (var stripe in GroupList.GetVisualDescendants().OfType<Border>().Where((border) => border.Classes.Contains("stripe") && border.Background is not null && border.IsEffectivelyVisible))
        {
            if (stripe.TranslatePoint(default, RowScroller) is not { } corner || new Rect(corner, stripe.Bounds.Size).Intersect(view) is not { Height: > 0 } seen
                || RowScroller.TranslatePoint(seen.TopLeft, this) is not { } top)
            {
                continue;
            }

            bars.Add(new SliverBar(top.Y, seen.Height, stripe.Background!));
        }

        return bars;
    }

    void Expand()
    {
        if (!hidden || !OperatingSystem.IsWindows() || TryGetPlatformHandle() is not { } handle)
        {
            return;
        }

        Sliver.IsVisible = false;
        Native.SetWindowRgn(handle.Handle, 0, true);
        // The composition surface keeps the clipped frame until Avalonia draws again.
        InvalidateVisual();
        hidden = false;
        WatchHide();
    }

    /// <summary>The header's pin turns auto-hide on or off (PRD R71); turning it off reserves the strip again.</summary>
    void OnAutoHideClicked(object? sender, RoutedEventArgs e)
    {
        model.AutoHide = !model.AutoHide;
        Dock();
    }

    void OnMovePressed(object? sender, PointerPressedEventArgs e)
    {
        if (floating && e.GetCurrentPoint(this).Properties.IsLeftButtonPressed)
        {
            BeginMoveDrag(e);
            e.Handled = true;
        }
        else if (e.GetCurrentPoint(this).Properties.IsLeftButtonPressed)
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

    /// <summary>Docks at the nearer left or right edge of the monitor under the pointer while the title is dragged, and keeps it (PRD R71).</summary>
    void OnMoveMoved(object? sender, PointerEventArgs e)
    {
        if (moving)
        {
            DockAtPointer(this.PointToScreen(e.GetPosition(this)));
        }
    }

    void OnMoveReleased(object? sender, PointerReleasedEventArgs e)
    {
        if (!moving)
        {
            return;
        }

        moving = false;
        e.Pointer.Capture(null);
        DockAtPointer(this.PointToScreen(e.GetPosition(this)));
    }

    /// <summary>
    /// Docks at the nearer edge of the monitor under the pointer when that differs from where the dock is. The pointer is read from the system,
    /// because the window moves under it during the drag: from Windows, or as an X11 dock window from the X server. <paramref name="at"/>, the
    /// pointer on the screen as the window places it, is used only when there is no X display, as in tests.
    /// </summary>
    void DockAtPointer(PixelPoint at)
    {
        if (edgeDocked)
        {
            if (OperatingSystem.IsLinux() && x11 is X11Dock dock && dock.Pointer() is { } pointer)
            {
                at = pointer;
            }

            // Null in a gap between monitors.
            if (Screens.ScreenFromPoint(at) is not { } screen)
            {
                return;
            }

            var edge = DockPlacement.EdgeAt(at.X, PixelRectOf(screen.Bounds));
            var name = screen.IsPrimary ? null : screen.DisplayName;

            if (edge != model.Settings.DockEdge || name != model.Settings.Monitor)
            {
                model.SetPlacement(edge, name);
                Dock();
            }

            return;
        }

        if (OperatingSystem.IsWindows() && appBar is not null && Native.GetCursorPos(out var cursor))
        {
            var monitor = Native.MonitorFromPoint(cursor, Native.MonitorDefaultToNearest);
            var edge = DockPlacement.EdgeAt(cursor.X, Native.Bounds(monitor));
            var name = monitor == Native.PrimaryMonitor() ? null : Native.MonitorName(monitor);

            if (edge != model.Settings.DockEdge || name != model.Settings.Monitor)
            {
                model.SetPlacement(edge, name);
                Dock();
            }
        }
    }

    /// <summary>
    /// Makes the dock an ordinary window, for a Linux desktop where its window is not an X11 window, so it cannot reserve a screen edge: it opens as
    /// tall as the primary monitor's work area at the kept edge, its title moves it, and it has no auto-hide, which needs a reserved edge
    /// (architecture.md § Dock).
    /// </summary>
    public void Float()
    {
        floating = true;
        ShowInTaskbar = true;
        Topmost = false;
        AutoHideButton.IsVisible = false;
        ToolTip.SetTip(MoveHandle, "Drag to move");
        Opened += (_, _) =>
        {
            if (Screens.Primary is { } screen)
            {
                var area = screen.WorkingArea;

                Height = area.Height / screen.Scaling;
                Position = new PixelPoint(model.Settings.DockEdge == DockEdge.Right ? area.Right - (int)(Width * screen.Scaling) : area.X, area.Y);
            }
        };
    }

    /// <summary>
    /// Docks at the kept edge and monitor as an X11 dock window, where the dock runs under XWayland (architecture.md § Dock): it reserves the strip,
    /// a drag of the title docks it at the nearer edge of the monitor under the pointer, and the grip sets its width. There is no auto-hide. Call before the window shows,
    /// so the window manager maps it as a dock window.
    /// </summary>
    public void DockOnX11()
    {
        edgeDocked = true;
        ShowInTaskbar = false;
        AutoHideButton.IsVisible = false;

        if (OperatingSystem.IsLinux() && TryGetPlatformHandle() is { HandleDescriptor: "XID" } handle)
        {
            x11 = X11Dock.Create(handle.Handle);
        }

        Opened += (_, _) => Dock();
        // A monitor added, removed or rearranged moves the kept monitor's edge, or the kept monitor is gone.
        Screens.Changed += (_, _) => Dock();
    }

    /// <summary>
    /// The monitors, by RandR name, that a full-screen window covers: as an X11 dock window, the dock goes below a full-screen window on its own
    /// monitor, as on Windows.
    /// </summary>
    public void ShowFullScreen(IReadOnlyList<string> monitors)
    {
        fullScreen = monitors;
        GoBelow();
    }

    /// <summary>Whether the dock is below other windows, because a full-screen window covers its monitor; for tests, where no X display is used.</summary>
    internal bool Below { get; private set; }

    void GoBelow()
    {
        var below = DockPlacement.Below(edgeMonitor, fullScreen);

        if (below == Below)
        {
            return;
        }

        Below = below;

        if (OperatingSystem.IsLinux() && x11 is X11Dock dock)
        {
            dock.Below(below);
        }
    }

    /// <summary>How many times the dock asked for the keyboard focus; for tests, where no X display is used.</summary>
    internal int FocusRequests { get; private set; }

    /// <summary>
    /// As an X11 dock window, takes the keyboard focus, which the window manager does not give a dock window on a click. It does not check
    /// <c>IsActive</c>, which can stay true after another app's window took the focus.
    /// </summary>
    void TakeFocus()
    {
        FocusRequests++;

        if (OperatingSystem.IsLinux() && x11 is X11Dock dock)
        {
            dock.Focus();
        }
    }

    /// <summary>Selects and scrolls to the row of an item window that came to the front by any means; other windows change nothing (PRD R71).</summary>
    public void ShowForeground(string title)
    {
        if (DockWindow.NameOf(title) is { } name)
        {
            ShowItemWindow(name);
        }
    }

    /// <summary>Selects and scrolls to the row of the named item window, which came to the front.</summary>
    public void ShowItemWindow(string name)
    {
        if (model.SelectWindow(name) is { } key)
        {
            ScrollTo(key);
        }
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
            model.ReleaseView();
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

    /// <summary>
    /// A quick second click raises DoubleTapped, not Tapped, so headers toggle on both; a press that moves before release raises both, so each
    /// press toggles once.
    /// </summary>
    bool pressToggled;

    void OnHeaderPressed(object? sender, PointerPressedEventArgs e) => pressToggled = false;

    void OnGroupTapped(object? sender, TappedEventArgs e)
    {
        if (!pressToggled && (sender as Control)?.DataContext is GroupViewModel group)
        {
            pressToggled = true;
            group.Toggle();
        }
    }

    void OnBandTapped(object? sender, TappedEventArgs e)
    {
        if (!pressToggled && (sender as Control)?.DataContext is BandViewModel band)
        {
            pressToggled = true;
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
            ShowFailure(status);
        }

        if (running == mine)
        {
            running = null;
        }
    }

    /// <summary>Shows why a click or control did not finish, or nothing; the dock takes the focus to show a reason, as it did not switch to VS Code.</summary>
    void ShowFailure(string? status)
    {
        model.Status = status;

        if (status is not null)
        {
            TakeFocus();
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

    /// <summary>A tooltip at the pointer, placed as a row's menu is, because the default horizontal slide moved it beside the dock.</summary>
    internal static void PlaceTip(CustomPopupPlacement placement, bool dockOnRight, Point at)
    {
        placement.AnchorRectangle = new Rect(at, new Size(1, 1));
        placement.Anchor = PopupAnchor.TopLeft;
        placement.Gravity = dockOnRight ? PopupGravity.BottomLeft : PopupGravity.BottomRight;
        placement.ConstraintAdjustment = PopupPositionerConstraintAdjustment.FlipY | PopupPositionerConstraintAdjustment.SlideY;
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

        // Open in Claude or Codex, or Answer in terminal, is the click itself on a row whose session waits on a question (PRD R70, R71).
        if (MainIsClick(row) && model.Row(row.Key) is { } shown)
        {
            items.Add(Item(row.Main ?? "Open", () => Open(shown), row.MainGlyph));
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

        if (row.Terminal is { } terminal)
        {
            items.Add(Item("Open in terminal", () => OpenTerminal(row, terminal), TerminalGlyph));
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

    // Codicons the dock draws itself: copy, link-external, add, settings-gear and output.
    const string CopyGlyph = "\uEBCC";
    const string LinkGlyph = "\uEB14";
    const string AddGlyph = "\uEA60";
    const string SettingsGlyph = "\uEB51";
    const string OutputGlyph = "\uEB9D";
    const string RefreshGlyph = "\uEB37";
    const string GraphGlyph = "\uEB03";

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

    /// <summary>Posts the control's action, after the operator confirms it when the hub sent a question, or with the text the hub asked for.</summary>
    async Task Act(DockControl control)
    {
        if (control.Confirm is { } confirm && !await ConfirmDialog.Ask(this, confirm.Question, confirm.Detail, confirm.Action))
        {
            return;
        }

        if (control.Input is { } input)
        {
            if (await InputDialog.Ask(this, input.Question, input.Detail, input.Action) is not { } text)
            {
                return;
            }

            await Act(WithField(control.Action, input.Field, text));
            return;
        }

        await Act(control.Action);
    }

    static JsonObject WithField(JsonObject action, string field, string text)
    {
        var copy = action.DeepClone().AsObject();

        copy[field] = text;

        return copy;
    }

    async Task Act(JsonObject action)
    {
        model.Status = null;
        model.Status = await hub.Act(action.DeepClone().AsObject());
    }

    /// <summary>A control that runs in VS Code; like a click, it replaces a click or control still switching windows.</summary>
    Task Run(DockRow? row, JsonObject command) => Running((cancel) => actions.Run(row, command, cancel), "The command failed");

    /// <summary>The menu's Open in terminal with <c>dock.openVSCode: review</c>, which runs in the dock (PRD R28, R71).</summary>
    Task OpenTerminal(DockRow row, DockTerminal terminal) => Running((cancel) => actions.Terminal(row, terminal, cancel), "The terminal did not open");

    /// <summary>Runs a menu action that a click on another row replaces, and shows what it could not do.</summary>
    async Task Running(Func<CancellationToken, Task<string?>> act, string failure)
    {
        running?.Cancel.Cancel();

        using var cancel = new CancellationTokenSource();
        var mine = ("", cancel);

        running = mine;
        model.Status = null;

        string? status;

        try
        {
            status = await act(cancel.Token);
        }
        catch (Exception error)
        {
            status = $"{failure}: {error.Message}";
        }

        if (!cancel.IsCancellationRequested)
        {
            ShowFailure(status);
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

        // The main control of a row whose session waits on a question is Open in Claude or Codex, or Answer in terminal, which is the row's
        // click (PRD R70, R71).
        if (MainIsClick(row.Row))
        {
            await Open(row);
        }
        else if (row.Row.Controls.FirstOrDefault((control) => control.Label == row.Main) is { } control)
        {
            await Act(control);
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

    /// <summary>The header's More Actions menu, below the button and opening away from the screen edge the dock is on.</summary>
    void OnMoreClicked(object? sender, RoutedEventArgs e)
    {
        var dockOnRight = model.GripOnLeft;
        var menu = RowMenu(HeaderMenu(), dockOnRight, new Point(dockOnRight ? MoreButton.Bounds.Width : 0, MoreButton.Bounds.Height));

        MoreButton.ContextMenu = menu;
        menu.Open(MoreButton);
    }

    /// <summary>
    /// New Ad-hoc Session, Refresh Sources, which polls each source that is on now, Open Settings, Ticket Volume Report when a Zoho or Forum source is configured,
    /// and Show Hub Log, which shows the hub log in the VS Code window used last.
    /// </summary>
    internal List<Control> HeaderMenu() =>
    [
        Item("New Ad-hoc Session…", NewAdhoc, AddGlyph),
        Item("Refresh Sources", async () => model.Status = await hub.Poll(), RefreshGlyph),
        Item("Open Settings", OpenSettings, SettingsGlyph),
        .. model.Sources.Any((source) => source.IsZoho || source.IsForum) ? [Item("Ticket Volume Report", OpenVolume, GraphGlyph)] : Array.Empty<Control>(),
        Item("Show Hub Log", () => Run(null, new JsonObject { ["type"] = "log" }), OutputGlyph),
    ];

    void ApplyTheme()
    {
        var theme = model.Settings.Theme == "vscode" ? model.VsCodeTheme : model.Settings.Theme;
        Application.Current!.RequestedThemeVariant = theme switch
        {
            "light" => ThemeVariant.Light,
            "dark" => ThemeVariant.Dark,
            _ => ThemeVariant.Default,
        };
    }

    /// <summary>Opens the New Ad-hoc Session window (PRD R6); the work item starts only when Start automatically is checked.</summary>
    async Task NewAdhoc()
    {
        // A schedule names its own repo root, so Run now needs no source's.
        if ((model.RepoRoots.Count == 0 || model.AdhocRepo is null) && model.Schedules.Count == 0)
        {
            model.Status = "Set a repoRoot on a source to start an ad-hoc session.";
            return;
        }

        var repo = model.AdhocRepo;

        model.Status = null;

        var created = await AdhocDialog.Ask(this, [.. model.RepoRoots], repo, (prompt, repoRoot, start) =>
            hub.Act(new JsonObject { ["type"] = "adhoc", ["prompt"] = prompt, ["repoRoot"] = repoRoot, ["start"] = start }),
            model.Schedules, (name) => hub.Act(new JsonObject { ["type"] = "run-schedule", ["name"] = name }));

        if (created is not null)
        {
            model.AdhocRepo = created;
        }
    }

    /// <summary>Opens the Settings window (PRD R54), or brings the open one forward.</summary>
    async Task OpenSettings()
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
        var window = new SettingsWindow(editor, actions, model);
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

    async Task OpenVolume()
    {
        if (volumeWindow is not null)
        {
            volumeWindow.Activate();
            return;
        }
        if (hub is not IVolumeHub volume)
        {
            model.Status = "Ticket volume needs the hub.";
            return;
        }
        var window = new VolumeWindow(volume, actions);
        volumeWindow = window;
        window.Closed += (_, _) => volumeWindow = null;
        window.Show();
        await window.Load();
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
        resizeFrom = (this.PointToScreen(e.GetPosition(this)).X, Width, Position);
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
        else if (floating || edgeDocked)
        {
            // The pointer is read on the screen, because the window moves under it when the grip is on its left.
            var scale = RenderScaling;
            var moved = (this.PointToScreen(e.GetPosition(this)).X - resizeFrom.X) / scale;
            var width = Math.Clamp(model.GripOnLeft ? resizeFrom.Width - moved : resizeFrom.Width + moved, DockSettings.MinWidth, DockSettings.MaxWidth);

            dragged = width;
            Width = width;

            if (model.GripOnLeft)
            {
                Position = resizeFrom.Position.WithX(resizeFrom.Position.X + (int)Math.Round((resizeFrom.Width - width) * scale));
            }
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

    /// <summary>Whether the row's main control is its click: Open in Claude or Codex, or Answer in terminal, which are not hub actions (PRD R70, R71).</summary>
    static bool MainIsClick(DockRow row) => row.Open is { Type: "question" } || (row.Open is { Type: "terminal" } && row.Main is { } main && row.Controls.All((control) => control.Label != main));

    /// <summary>The codicon of Open in terminal.</summary>
    const string TerminalGlyph = "\uea85";

    sealed class NoActions : IDockActions
    {
        public Task<string?> Terminal(DockRow row, DockTerminal terminal, CancellationToken cancel) => Task.FromResult<string?>(null);

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

        public Task<string?> Poll() => Task.FromResult<string?>(null);

        public Task<string?> Open(string sessionId, string cwd, string workspace) => Task.FromResult<string?>(null);

        public Task<DockView?> Until(Func<DockView, bool> test, TimeSpan within) => Task.FromResult<DockView?>(null);
    }
}
