using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Presenters;
using Avalonia.Controls.Primitives;
using Avalonia.Controls.Primitives.PopupPositioning;
using Avalonia.Input;
using Avalonia.Input.Platform;
using Avalonia.Interactivity;
using Avalonia.Media;
using Avalonia.Platform.Storage;
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
    readonly TerminalFocus terminalFocus;
    readonly IDockActions actions;
    readonly bool docked;
    readonly IConfigHub? config;
    SettingsWindow? settingsWindow;
    HeldSessionsWindow? heldWindow;
    AppBar? appBar;
    // The strip the docked window last took, in physical pixels.
    Native.Rect? placed;
    bool resizing;
    // Auto-hide (PRD R71): whether the dock shows only its sliver, and the check that hides it while it shows.
    bool hidden;
    // X11 keeps the explicit shape after auto-hide is turned off; Mutter needs it refreshed on resize.
    bool shaped;
    readonly HideDelay hideDelay = new();
    readonly System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
    DispatcherTimer? hideTimer;
    DispatcherTimer? showTimer;
    TimeSpan? hoverSince;
    DispatcherTimer? topmostTimer;
    // The dock's open menus, including the search box's flyout; while one is open the dock does not hide, and hiding closes them.
    readonly HashSet<Popup> openPopups = [];
    readonly IDisposable popupWatch;
    // On X11, whether the dock or its menu has had the focus since a menu opened, and the check that closes the menus once it moves elsewhere.
    bool popupFocused;
    DispatcherTimer? popupTimer;
    // The status toast's countdown: it hides once it has shown for StatusShown while the dock showed and the pointer was off it.
    static readonly TimeSpan StatusShown = TimeSpan.FromSeconds(10);
    DispatcherTimer? statusTimer;
    TimeSpan statusSince;

    /// <summary>The monotonic time the status countdown reads; tests replace it, as the headless platform runs no timers.</summary>
    internal Func<TimeSpan> StatusClock { get; set; }
    /// <summary>Where the pointer last moved or pressed, in window coordinates; a row's menu and a tooltip open there.</summary>
    Point pointer;
    // The width the pointer has dragged to, in device-independent pixels, before rounding to physical pixels.
    double? dragged;
    // The click that is running, which a click on another row replaces.
    (string Key, CancellationTokenSource Cancel)? running;
    bool moving;
    // An ordinary window, where the dock cannot reserve a screen edge (Float).
    bool floating;
    // Docked at a monitor's edge as an X11 dock window (DockOnX11), and its X11 calls, when an X display opened.
    bool edgeDocked;
    IX11Edge? x11;
    // As an X11 dock window, the scale of the monitor it docked on, at which an auto-hidden dock cuts its sliver.
    double edgeScale = 1;
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
        terminalFocus = new TerminalFocus(hub);
        this.actions = actions;
        this.docked = docked;
        DataContext = model;
        model.SearchHub ??= hub.Search;
        InitializeComponent();
        ApplyTheme();
        model.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName is nameof(DockViewModel.VsCodeTheme) or nameof(DockViewModel.Theme))
            {
                ApplyTheme();
            }
            else if (e.PropertyName is nameof(DockViewModel.Status))
            {
                WatchStatus();
            }
            // A menu opened on a row before the hub went away would still act on it.
            else if (e.PropertyName is nameof(DockViewModel.IsLive) && !model.IsLive)
            {
                ClosePopups();
            }
        };
        StatusClock = () => clock.Elapsed;
        MenuScreenAt = ScreenForMenu;
        // The 1-second check could miss a short hover, so leaving the toast restarts its time too.
        StatusToast.PointerExited += (_, _) => statusSince = StatusClock();
        // After the XAML, whose width is the default.
        Width = model.Settings.Width;
        AddHandler(PointerMovedEvent, (_, e) =>
        {
            pointer = e.GetPosition(this);
            WatchShow(clock.Elapsed);
        }, RoutingStrategies.Tunnel, handledEventsToo: true);
        PointerExited += (_, _) => CancelShow();
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
        // A class handler, because Avalonia opens a control's own context menu or flyout without the dock's code. A submenu's popup is placed on
        // its menu, not the dock, and its root menu stays open while it is. ContextMenu alone would name the window's property.
        popupWatch = Popup.IsOpenProperty.Changed.AddClassHandler<Popup>((popup, e) =>
        {
            if (e.GetNewValue<bool>() && popup.Child is Avalonia.Controls.ContextMenu or MenuFlyoutPresenter && popup.PlacementTarget is { } target && TopLevel.GetTopLevel(target) == this)
            {
                if (openPopups.Add(popup) && openPopups.Count == 1)
                {
                    WatchPopups();
                }
            }
            else
            {
                openPopups.Remove(popup);
            }
        });
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
            PinGroupHeads();

            // A hub update or a selection while hidden moves the rows, so the sliver follows them.
            if (hidden)
            {
                Sliver.Bars = SliverBars();
            }
        };
        RowScroller.ScrollChanged += (_, _) =>
        {
            RedrawDrop();
            PinGroupHeads();
        };
        // As an X11 dock window, the sliver at the right edge is cut from the window's width, which the X server sets after the dock asks for it.
        Resized += (_, _) =>
        {
            if (x11 is not null && shaped)
            {
                if (hidden)
                {
                    Collapse();
                }
                else
                {
                    x11.Unclip();
                }
            }
        };

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
            // Open in Switchboard, or a VS Code click on a row that opens a terminal (PRD R65, R69, R71).
            stream.ClickRequested += (key) => Dispatcher.UIThread.Post(() => ClickForwarded(key));
            // A hub that started since the last report does not know which terminal is in front.
            stream.Connected += () => Dispatcher.UIThread.Post(() => _ = terminalFocus.Resend());
            // A work item that starts needing the operator, which the VS Code windows no longer toast (PRD R65).
            stream.NeedsYou += (key, message) => Dispatcher.UIThread.Post(() => ShowNeedsYou(key, message));
        }

        // Hidden until it is in its strip, so it does not show at Avalonia's first size and position and then jump (the window exists before it is shown).
        if (docked && OperatingSystem.IsWindows() && TryGetPlatformHandle() is { } handle)
        {
            Native.NoTransitions(handle.Handle);
            Native.Cloak(handle.Handle, true);
        }
    }

    // The row whose needs-you message the status toast shows, which a click on the message opens.
    (string Key, string Message)? needsRow;

    /// <summary>Shows that a work item started needing the operator in the status toast; a click on the message runs its row's click.</summary>
    internal void ShowNeedsYou(string key, string message)
    {
        model.ShowInfo(message);
        needsRow = (key, message);
    }

    void OnStatusTapped(object? sender, TappedEventArgs e)
    {
        if (needsRow is { } needs && model.Status == needs.Message)
        {
            needsRow = null;
            model.Status = null;

            ClickForwarded(needs.Key, inWeb: null);
        }
    }

    /// <summary>
    /// Puts the keyboard focus back on the row with <paramref name="key"/> when a view moved it to another group or band, whose new controls do
    /// not have the focus; a row the view kept keeps it on its own.
    /// </summary>
    /// <summary>The key of the row that holds the keyboard focus, on the row itself or on one of its buttons or pills, or null.</summary>
    internal string? FocusedRow() =>
        (FocusManager?.GetFocusedElement() as Visual)?.GetSelfAndVisualAncestors().OfType<Border>().FirstOrDefault((border) => border.Classes.Contains("row"))?.DataContext is RowViewModel row ? row.Key : null;

    internal void RestoreFocus(string? key)
    {
        if (key is null)
        {
            return;
        }

        Dispatcher.UIThread.Post(() =>
        {
            if (FocusManager?.GetFocusedElement() is Visual focused && TopLevel.GetTopLevel(focused) == this)
            {
                return;
            }

            var stops = ListStops();

            // A row moved into a closed group or band, or out of the search's matches, leaves the focus on its group's heading.
            var target = stops.FirstOrDefault((border) => border.DataContext is RowViewModel row && row.Key == key)
                ?? stops.FirstOrDefault((border) => border.Classes.Contains("group") && border.DataContext is GroupViewModel group && group.AllRows.Any((row) => row.Key == key));

            target?.Focus(NavigationMethod.Directional);
        }, DispatcherPriority.Loaded);
    }

    /// <summary>
    /// Runs a click on a row the dock does not show under the pointer, as the operator's click on the row would: one VS Code forwarded in VS Code,
    /// whatever <c>dock.openIn</c> says, and the needs-you message's, with <paramref name="inWeb"/> null, where <c>dock.openIn</c> says.
    /// </summary>
    internal async void ClickForwarded(string key, bool? inWeb = false)
    {
        if (model.Row(key) is { } row)
        {
            await Open(row, inWeb);
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
            var focused = FocusedRow();

            model.Show(view);
            RestoreFocus(focused);
        }
        else if (stream is not null)
        {
            model.Show(stream.Connection, stream.NotRunningText);
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
        CancelShow();
        topmostTimer?.Stop();
        popupTimer?.Stop();
        statusTimer?.Stop();
        popupWatch.Dispose();

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
            ApplyAutoHide();
        }
        else
        {
            Width = model.Settings.Width;

            if (edgeDocked)
            {
                PlaceOnEdge();

                if (x11 is { CanShape: true })
                {
                    ApplyAutoHide();
                }
            }
        }
    }

    void ApplyAutoHide()
    {
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

    /// <summary>
    /// Places the window in the strip at the kept edge of the kept monitor, or the primary monitor when that is missing, as tall as its work area,
    /// and reserves the strip unless auto-hide is on or the monitor has a neighbour beyond that edge (<see cref="DockPlacement.CanReserve"/>). Only the work area's
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
        var work = (x11 is { } monitors ? DockPlacement.WorkAreaOn(bounds, monitors.WorkAreas()) : null) ?? PixelRectOf(screen.WorkingArea);
        var area = bounds with { Top = work.Top, Bottom = work.Bottom };
        var strip = DockPlacement.Strip(model.Settings.DockEdge, area, DockPlacement.Pixels(model.Settings.Width, screen.Scaling));

        Position = new PixelPoint(strip.Left, strip.Top);
        Height = strip.Height / screen.Scaling;
        edgeScale = screen.Scaling;
        edgeMonitor = screen.DisplayName;
        DockedOnX11?.Invoke(edgeMonitor ?? "");

        if (x11 is { } dock)
        {
            if (!(model.Settings.AutoHide && dock.CanShape) && DockPlacement.CanReserve(model.Settings.DockEdge, strip, bounds, Screens.All.Select((each) => PixelRectOf(each.Bounds))))
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
            hideTimer.Tick += (_, _) => CheckHide(clock.Elapsed);
        }

        hideTimer.Start();
    }

    /// <summary>The hide timer's check at <paramref name="now"/>, a monotonic time; tests call it, as the headless platform runs no timers.</summary>
    internal void CheckHide(TimeSpan now)
    {
        if (hideTimer?.IsEnabled == true && hideDelay.Hides(KeptOpen(), now))
        {
            Collapse();
        }
    }

    /// <summary>Starts the countdown of a new status message, or stops it when the status is cleared.</summary>
    void WatchStatus()
    {
        statusSince = StatusClock();

        if (model.Status is null)
        {
            statusTimer?.Stop();
            return;
        }

        if (statusTimer is null)
        {
            statusTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
            statusTimer.Tick += (_, _) => CheckStatus(StatusClock());
        }

        statusTimer.Start();
    }

    /// <summary>The status timer's check at <paramref name="now"/>, a <see cref="StatusClock"/> time; tests call it.</summary>
    internal void CheckStatus(TimeSpan now)
    {
        // A hidden dock or a pointer on the toast keeps the message for its whole time once the operator can read it.
        if (hidden || StatusToast.IsPointerOver)
        {
            statusSince = now;
        }
        else if (now - statusSince >= StatusShown)
        {
            model.Status = null;
        }
    }

    internal void WatchShow(TimeSpan now)
    {
        if (!hidden || showTimer?.IsEnabled == true)
        {
            return;
        }

        if (showTimer is null)
        {
            showTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(100) };
            showTimer.Tick += (_, _) => CheckShow(clock.Elapsed);
        }

        hoverSince = now;
        showTimer.Start();
    }

    // Tests supply monotonic time because the headless platform runs no timers.
    internal void CheckShow(TimeSpan now)
    {
        if (showTimer?.IsEnabled != true)
        {
            return;
        }

        if (!hidden || !IsPointerOver)
        {
            CancelShow();
            return;
        }

        if (now - hoverSince >= TimeSpan.FromMilliseconds(500))
        {
            Expand();
        }
    }

    void CancelShow()
    {
        showTimer?.Stop();
        hoverSince = null;
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
        if (resizing || moving || dragging is not null || openPopups.Count > 0)
        {
            return true;
        }

        if (x11 is { } dock)
        {
            return dock.KeptOpen();
        }

        if (!OperatingSystem.IsWindows() || TryGetPlatformHandle() is not { } handle)
        {
            return true;
        }

        bool Ours(nint window) => window != 0 && HideDelay.OwnedBy(Native.GetAncestor(window, Native.GaRoot), handle.Handle, (at) => Native.GetWindow(at, Native.GwOwner));

        return (Native.GetCursorPos(out var at) && Ours(Native.WindowFromPoint(at))) || Ours(Native.GetForegroundWindow());
    }

    /// <summary>Shows only the sliver at the outer edge; the window keeps its strip and its layout, so it shows again at once.</summary>
    void Collapse()
    {
        CancelShow();
        hideTimer?.Stop();
        ClosePopups();

        if (x11 is { } dock)
        {
            ShowSliver();
            shaped = true;
            dock.ClipToSliver(model.Settings.DockEdge, DockPlacement.Pixels(DockPlacement.SliverWidth, edgeScale));
        }
        else if (OperatingSystem.IsWindows() && placed is { } bounds && TryGetPlatformHandle() is { } handle)
        {
            var sliver = DockPlacement.Sliver(model.Settings.DockEdge, bounds.Right - bounds.Left, bounds.Bottom - bounds.Top, RenderScaling);

            ShowSliver();
            Native.SetWindowRgn(handle.Handle, Native.CreateRectRgn(sliver.Left, sliver.Top, sliver.Right, sliver.Bottom), true);
        }
    }

    void ClosePopups()
    {
        foreach (var popup in openPopups.ToList())
        {
            popup.IsOpen = false;
        }
    }

    /// <summary>
    /// On X11, takes the focus as a menu opens and checks every 100 ms whether it is still the dock's or the menu's. Avalonia closes a menu when
    /// the dock window loses the focus; while the focus was elsewhere, a click on another app left the menu open.
    /// </summary>
    void WatchPopups()
    {
        if (x11 is not { } dock)
        {
            return;
        }

        TakeFocus();
        // The X server applies the request before it answers the query on the same connection, so a focus lost before the first check counts.
        popupFocused = dock.HasFocus();

        if (popupTimer is null)
        {
            popupTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(100) };
            popupTimer.Tick += (_, _) => CheckPopups();
        }

        popupTimer.Start();
    }

    /// <summary>The menu timer's check; tests call it, as the headless platform runs no timers.</summary>
    internal void CheckPopups()
    {
        if (x11 is not { } dock || openPopups.Count == 0)
        {
            popupTimer?.Stop();
        }
        else if (dock.HasFocus())
        {
            popupFocused = true;
        }
        else if (popupFocused)
        {
            ClosePopups();
        }
    }

    void ShowSliver()
    {
        Sliver.HorizontalAlignment = model.Settings.DockEdge == DockEdge.Left ? Avalonia.Layout.HorizontalAlignment.Left : Avalonia.Layout.HorizontalAlignment.Right;
        Sliver.Bars = SliverBars();
        Sliver.IsVisible = true;
        hidden = true;
    }

    /// <summary>The coloured stripe of each row in the list's view, cut to the view, at its height in the window.</summary>
    internal List<SliverBar> SliverBars()
    {
        // A pinned heading covers the rows that scroll under it, so their stripes are out of view.
        var covered = GroupHeads().Where((group) => group.Pin.RenderTransform is TranslateTransform { Y: > 0 } && group.Pin.IsEffectivelyVisible)
            .Select((group) => (group.Pin.TranslatePoint(default, RowScroller)?.Y ?? 0) + group.Pin.Bounds.Height).DefaultIfEmpty(0).Max();
        var view = new Rect(0, Math.Max(0, covered), RowScroller.Bounds.Width, Math.Max(0, RowScroller.Bounds.Height - covered));
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
        CancelShow();
        if (!hidden)
        {
            return;
        }

        if (x11 is { } dock)
        {
            dock.Unclip();
        }
        else if (OperatingSystem.IsWindows() && TryGetPlatformHandle() is { } handle)
        {
            Native.SetWindowRgn(handle.Handle, 0, true);
        }
        else
        {
            return;
        }

        Sliver.IsVisible = false;
        // The composition surface keeps the clipped frame until Avalonia draws again.
        InvalidateVisual();
        hidden = false;
        statusSince = StatusClock();
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
            if (x11?.Pointer() is { } pointer)
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
    /// tall as the primary monitor's work area at the kept edge, its title moves it, and it has no auto-hide, which clips an X11 window to
    /// its sliver (architecture.md § Dock).
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
    /// a drag of the title docks it at the nearer edge of the monitor under the pointer, and the grip sets its width. With an X display whose server
    /// has the Shape extension it can auto-hide (PRD R71). Call before the window shows, so the window manager maps it as a dock window.
    /// </summary>
    public void DockOnX11() => DockOnX11(OperatingSystem.IsLinux() && TryGetPlatformHandle() is { HandleDescriptor: "XID" } handle ? X11Dock.Create(handle.Handle) : null);

    /// <summary>Docks as an X11 dock window through <paramref name="edge"/>, its X11 calls; null when no X display opened.</summary>
    internal void DockOnX11(IX11Edge? edge)
    {
        edgeDocked = true;
        ShowInTaskbar = false;
        x11 = edge;
        AutoHideButton.IsVisible = x11 is { CanShape: true };

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

        x11?.Below(below);
    }

    /// <summary>How many times the dock asked for the keyboard focus; for tests, where no X display is used.</summary>
    internal int FocusRequests { get; private set; }

    /// <summary>The dock's open menus; for tests, as a row's menu is not reachable from the window.</summary>
    internal IReadOnlyCollection<Popup> OpenMenus => openPopups;

    /// <summary>
    /// As an X11 dock window, takes the keyboard focus, which the window manager does not give a dock window on a click. It does not check
    /// <c>IsActive</c>, which can stay true after another app's window took the focus.
    /// </summary>
    void TakeFocus()
    {
        FocusRequests++;

        x11?.Focus();
    }

    /// <summary>
    /// Selects and scrolls to the row of an item window or session terminal that came to the front by any means; other windows change nothing
    /// (PRD R71). The hub hears whether it is a Code Mode session's terminal window, which the voice follows (architecture.md § Voice).
    /// </summary>
    public void ShowForeground(string title)
    {
        var name = DockWindow.NameOf(title);

        _ = terminalFocus.Report(name is null ? null : model.TerminalSession(name));

        if (name is not null)
        {
            ShowItemWindow(name);
        }
    }

    /// <summary>A session's terminal window lost the focus to a window that is no terminal, as GNOME Shell reports it (PRD R71).</summary>
    public void TerminalLeft() => _ = terminalFocus.Report(null);

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
            () =>
            {
                if (RowBorder(key) is { } shown)
                {
                    Reveal(shown);
                }
                // Done draws only its rows in view, so a row out of view has no border yet; once drawn, it is moved out from under the pinned heading.
                else if (this.GetVisualDescendants().OfType<ItemsControl>().FirstOrDefault((list) => list.DataContext is BandViewModel band && band.Shown.Any((row) => row.Key == key)) is { DataContext: BandViewModel band } list)
                {
                    list.ScrollIntoView(band.Shown.First((row) => row.Key == key));
                    Dispatcher.UIThread.Post(
                        () =>
                        {
                            if (RowBorder(key) is { } drawn)
                            {
                                Reveal(drawn);
                            }
                        },
                        DispatcherPriority.Loaded);
                }
            },
            DispatcherPriority.Loaded);

    Border? RowBorder(string key) =>
        this.GetVisualDescendants().OfType<Border>().FirstOrDefault((border) => border.Classes.Contains("row") && border.DataContext is RowViewModel row && row.Key == key);

    async void OnKey(object? sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape && dragging is not null)
        {
            e.Handled = true;
            CancelDrag();
        }
        else if (FocusManager?.GetFocusedElement() is Border { IsEffectivelyEnabled: true } focused && ListKey(focused, e) is { } run)
        {
            e.Handled = true;
            await run();
        }
        else if (e.Key == Key.F8 && (e.KeyModifiers & ~KeyModifiers.Shift) == KeyModifiers.None && model.IsLive)
        {
            e.Handled = true;
            await NextTurn(backwards: e.KeyModifiers == KeyModifiers.Shift);
        }
        else if (e.KeyModifiers == KeyModifiers.Alt && e.Key is Key.Up or Key.Down && model.IsLive && model.Selected is { } key && model.Row(key) is { Row.Movable: true } row
            && row.Row.Controls.FirstOrDefault((control) => control.Label == (e.Key == Key.Up ? "Move up" : "Move down")) is { } move)
        {
            e.Handled = true;
            await Act(move.Action);
        }
    }

    /// <summary>
    /// The list's keys (PRD R71) on the focused row, group or band heading, or link pill: Up and Down move the focus to the previous or next row
    /// or heading, which selects a row; Enter runs a row's click, or Enter and Space open or close a heading or open a pill's link; the Menu key
    /// and Shift+F10 open a row's menu at its corner. Null for any other key, which the focused control handles.
    /// </summary>
    Func<Task>? ListKey(Border focused, KeyEventArgs e)
    {
        var plain = e.KeyModifiers == KeyModifiers.None;

        if (focused.Classes.Contains("pill"))
        {
            return plain && e.Key is Key.Enter or Key.Space && focused.Tag is string { Length: > 0 } url ? () =>
            {
                model.Status = actions.OpenUrl(url);
                return Task.CompletedTask;
            } : null;
        }

        if (!focused.Classes.Contains("row") && !focused.Classes.Contains("group") && !focused.Classes.Contains("band"))
        {
            return null;
        }

        if (plain && e.Key is Key.Up or Key.Down)
        {
            return () =>
            {
                MoveFocus(focused, e.Key == Key.Down);
                return Task.CompletedTask;
            };
        }

        if (focused.DataContext is RowViewModel row)
        {
            if (plain && e.Key == Key.Enter)
            {
                return () => Open(row);
            }

            if ((plain && e.Key == Key.Apps) || (e.KeyModifiers == KeyModifiers.Shift && e.Key == Key.F10))
            {
                return () =>
                {
                    model.Selected = row.Key;
                    RowMenu(MenuOf(row.Row), model.GripOnLeft, focused.TranslatePoint(default, this) ?? default, MenuScreenAt).Open(this);
                    return Task.CompletedTask;
                };
            }

            return null;
        }

        if (plain && e.Key is Key.Enter or Key.Space)
        {
            return () =>
            {
                (focused.DataContext as GroupViewModel)?.Toggle();
                (focused.DataContext as BandViewModel)?.Toggle();
                return Task.CompletedTask;
            };
        }

        return null;
    }

    /// <summary>The group headings, each in its wrapper that pins it, with the group's section that holds it and its rows.</summary>
    IEnumerable<(StackPanel Section, Border Pin)> GroupHeads() =>
        GroupList.GetRealizedContainers().OfType<ContentPresenter>().Select((container) => container.Child)
            .OfType<StackPanel>().Where((section) => section.Children.Count > 0 && section.Children[0] is Border pin && pin.Classes.Contains("group-pin"))
            .Select((section) => (section, (Border)section.Children[0]));

    /// <summary>
    /// Pins the heading of the group at the top of the list there while the group's rows scroll under it, and lets the next group's heading push it
    /// up, as a sticky heading does: a heading whose section starts above the list's top moves down by as much, but no further than its section's
    /// end, the gap after it included. A render offset, so the layout and the rows' places stay as they are.
    /// </summary>
    void PinGroupHeads()
    {
        foreach (var (section, pin) in GroupHeads())
        {
            var top = section.IsEffectivelyVisible ? section.TranslatePoint(default, RowScroller)?.Y ?? 0 : 0;
            var shift = Math.Clamp(-top, 0, Math.Max(0, section.Bounds.Height + section.Margin.Bottom - pin.Bounds.Height));

            if (pin.RenderTransform is TranslateTransform offset)
            {
                if (offset.Y != shift)
                {
                    offset.Y = shift;
                }
            }
            else if (shift > 0)
            {
                pin.RenderTransform = new TranslateTransform(0, shift);
            }
        }
    }

    /// <summary>Scrolls a row into view below the pinned group heading, which would cover a row scrolled to the list's top.</summary>
    void Reveal(Control row)
    {
        var head = GroupHeads().Select((group) => group.Pin.Bounds.Height).FirstOrDefault((height) => height > 0);

        row.BringIntoView(new Rect(0, -head, row.Bounds.Width, row.Bounds.Height + head));
    }

    /// <summary>The list's rows and group and band headings that show, in list order.</summary>
    List<Border> ListStops() =>
        GroupList.GetVisualDescendants().OfType<Border>().Where((border) => (border.Classes.Contains("row") || border.Classes.Contains("group") || border.Classes.Contains("band")) && border.IsEffectivelyVisible).ToList();

    /// <summary>Moves the keyboard focus to the row or heading after or before <paramref name="from"/>, staying put at either end.</summary>
    void MoveFocus(Border from, bool down)
    {
        var stops = ListStops();
        var at = stops.IndexOf(from) + (down ? 1 : -1);

        if (at >= 0 && at < stops.Count)
        {
            stops[at].Focus(NavigationMethod.Directional);
        }
    }

    /// <summary>A row the keyboard reaches is selected, so its buttons show and Tab reaches them, and is scrolled into view.</summary>
    void OnRowGotFocus(object? sender, FocusChangedEventArgs e)
    {
        if (e.NavigationMethod != NavigationMethod.Pointer && sender is Border { DataContext: RowViewModel row } border && e.Source == border)
        {
            model.Selected = row.Key;
            Reveal(border);
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

        // Alt-click opens the work item where dock.openIn does not (PRD R71).
        await Open(row, inWeb: model.OpensInWeb != e.KeyModifiers.HasFlag(KeyModifiers.Alt));
    }

    /// <summary>
    /// The row's click (PRD R71): its session and its item window, or with <paramref name="inWeb"/>, <c>dock.openIn</c> when null, the web page;
    /// a click on another row replaces a click still running.
    /// </summary>
    async Task Open(RowViewModel row, bool? inWeb = null)
    {
        if (!model.IsLive)
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
            status = inWeb ?? model.OpensInWeb ? await actions.OpenInPage(row.Row, cancel.Token) : await actions.Click(row.Row, cancel.Token);
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

        RowMenu(MenuOf(row.Row), model.GripOnLeft, at, MenuScreenAt).Open(this);
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
    /// A row's menu at the pointer, or a header button's below it, opening away from the screen edge the dock is on and kept on the monitor with
    /// its submenus (<see cref="MenuPlacement"/>), on the monitor <paramref name="screenAt"/> finds, Avalonia's when null.
    /// </summary>
    internal static ContextMenu RowMenu(List<Control> items, bool dockOnRight, Point at, MenuScreenAt? screenAt = null) => MenuPlacement.Menu(items, dockOnRight, at, screenAt);

    /// <summary>The monitor a menu opens on; tests replace it.</summary>
    internal MenuScreenAt MenuScreenAt { get; set; }

    /// <summary>Avalonia's monitor at the point, with Mutter's work area for it as an X11 dock window, as <see cref="PlaceOnEdge"/> takes.</summary>
    MenuScreen? ScreenForMenu(Visual visual, Avalonia.PixelPoint point)
    {
        if (MenuPlacement.ScreenOf(visual, point) is not { } screen)
        {
            return null;
        }

        return x11 is { } monitors && DockPlacement.WorkAreaOn(PixelRectOf(screen.Bounds), monitors.WorkAreas()) is { } work
            ? screen with { WorkArea = new Avalonia.PixelRect(work.Left, work.Top, work.Width, work.Height) }
            : screen;
    }

    /// <summary>The state controls, which change what the work item waits for rather than run its work (PRD R71).</summary>
    static readonly HashSet<string> StateActions = ["mark-done", "reopen", "snooze", "restore"];

    /// <summary>The order controls of a Ready for review row (PRD R73).</summary>
    static readonly HashSet<string> OrderActions = ["move", "reset-position"];

    /// <summary>
    /// The row's menu (PRD R71), in groups with a separator between them: the row's main action; its work (Start, Approve, Retry, Stop session and the
    /// other hub controls); its state (Mark done or Reopen, Snooze… or Unsnooze); its notes (Add comment…, Persona); its order in Ready for review;
    /// what it opens (Copy, Open in terminal, the window commands, Open ticket and its links); and Delete, or any control that asks first, last.
    /// </summary>
    internal List<Control> MenuOf(DockRow row)
    {
        List<Control> main = [];
        List<Control> work = [];
        List<Control> state = [];
        List<Control> notes = [];
        List<Control> order = [];
        List<Control> opens = [];
        List<Control> asking = [];
        DockControl? mainControl = null;
        var terminalIsMain = false;

        // Open in Claude or Codex, or Answer in terminal, is the click itself on a row whose session waits on a question (PRD R70, R71).
        if (MainIsClick(row) && model.Row(row.Key) is { } shown)
        {
            main.Add(Item(row.Main ?? "Open", () => Open(shown), row.MainGlyph));
            // Answer in terminal opens the terminal Open in terminal would, so the menu lists it once.
            terminalIsMain = row.Open?.Terminal is { } clicked && row.Terminal is { } own && clicked.Name == own.Name;
        }
        else if (row.Controls.FirstOrDefault((control) => control.Label == row.Main && control.Confirm is null && control.Group is null) is { } control)
        {
            mainControl = control;
            main.Add(ControlItem(row, control));
        }
        // A prompt before start's Open in terminal (PRD R41).
        else if (row.Main == "Open in terminal" && (row.Terminal is not null || row.Commands.Any(Switcher.IsTerminal)))
        {
            terminalIsMain = true;
            main.Add(Item("Open in terminal", () => OpenInTerminal(row), TerminalGlyph));
        }

        foreach (var control in row.Controls.Where((control) => control.Confirm is null && control.Group is null && control != mainControl))
        {
            var type = control.Action["type"]?.GetValue<string>() ?? "";

            (StateActions.Contains(type) ? state : OrderActions.Contains(type) ? order : type == "comment" ? notes : work).Add(ControlItem(row, control));
        }

        // Controls that share a group, such as Persona, are its submenu, the checked ones marked (architecture.md § Personas).
        foreach (var group in row.Controls.Where((control) => control.Confirm is null && control.Group is not null).GroupBy((control) => control.Group!))
        {
            notes.Add(new MenuItem { Header = group.Key, ItemsSource = group.Select((control) => Checked(control.Label, control.Checked, () => Act(control))).ToList() });
        }

        if (row.Pastes.Count == 1)
        {
            opens.Add(Item($"Copy {row.Pastes[0].Label}", () => Copy(row.Pastes[0]), CopyGlyph));
        }
        else if (row.Pastes.Count > 1)
        {
            opens.Add(new MenuItem { Header = "Copy", Icon = Glyph(CopyGlyph), ItemsSource = row.Pastes.Select((paste) => Item(paste.Label, () => Copy(paste))).ToList() });
        }

        // One Open in terminal, which picks the item window or the terminal app when the row offers both (PRD R28).
        if (row.Terminal is not null && !terminalIsMain && !row.Commands.Any(Switcher.IsTerminal))
        {
            opens.Add(Item("Open in terminal", () => OpenInTerminal(row), TerminalGlyph));
        }

        foreach (var command in row.Commands.Where((command) => !(terminalIsMain && Switcher.IsTerminal(command))))
        {
            opens.Add(Switcher.IsTerminal(command) ? Item(command.Label, () => OpenInTerminal(row), command.Glyph) : Item(command.Label, () => Run(row, command.Command), command.Glyph));
        }

        // The ticket, then its links, such as its pull request (PRD R52), open in the browser. A link's label can be free text a session
        // reported, so a long one is cut, whole in its tooltip, and more than two links go in an Open link submenu.
        if (row.Url != "")
        {
            opens.Add(LinkItem("Open ticket", row.Url, LinkGlyph));
        }

        if (row.Links.Count > MenuLinks)
        {
            opens.Add(new MenuItem { Header = "Open link", Icon = Glyph(LinkGlyph), ItemsSource = row.Links.Select((link) => LinkItem(link.Label, link.Url)).ToList() });
        }
        else
        {
            opens.AddRange(row.Links.Select((link) => LinkItem($"Open {link.Label}", link.Url, LinkGlyph)));
        }

        // Controls that ask first, such as Delete, come last, apart from the rest.
        foreach (var control in row.Controls.Where((control) => control.Confirm is not null))
        {
            asking.Add(Item(control.Label, () => Act(control), control.Glyph));
        }

        List<Control> items = [];

        foreach (var group in new[] { main, work, state, notes, order, opens, asking }.Where((group) => group.Count > 0))
        {
            if (items.Count > 0)
            {
                items.Add(new Separator());
            }

            items.AddRange(group);
        }

        return items;
    }

    /// <summary>The most links the row menu lists by themselves; more go in its Open link submenu.</summary>
    const int MenuLinks = 2;

    /// <summary>The longest menu item label for a link; a longer one is cut with an ellipsis and shown whole in its tooltip.</summary>
    internal const int LinkLabelMax = 48;

    /// <summary>A menu item that opens a URL in the browser.</summary>
    MenuItem LinkItem(string label, string url, string? glyph = null)
    {
        var item = Item(label.Length > LinkLabelMax ? label[..(LinkLabelMax - 1)].TrimEnd() + "…" : label, () =>
        {
            model.Status = actions.OpenUrl(url);
            return Task.CompletedTask;
        }, glyph);

        if (label.Length > LinkLabelMax)
        {
            ToolTip.SetTip(item, label);
        }

        return item;
    }

    /// <summary>A hub control's item: Snooze… opens its dialog; any other posts its action, asking for its text first when it has an input.</summary>
    MenuItem ControlItem(DockRow row, DockControl control) =>
        Item(control.Label, control.Action["type"]?.GetValue<string>() == "snooze" ? () => Snooze(row, control) : () => Act(control), control.Glyph);

    // Codicons the dock draws itself: copy, link-external, add, settings-gear and output.
    const string CopyGlyph = "\uEBCC";
    const string LinkGlyph = "\uEB14";
    const string SettingsGlyph = "\uEB51";
    const string OutputGlyph = "\uEB9D";
    const string RefreshGlyph = "\uEB37";

    /// <summary>A submenu's choice, checked when it is the current one.</summary>
    static MenuItem Checked(string header, bool isChecked, Func<Task> run)
    {
        var item = new MenuItem { Header = header, ToggleType = MenuItemToggleType.CheckBox, IsChecked = isChecked };

        item.Click += async (_, _) => await run();

        return item;
    }

    static MenuItem Item(string header, Func<Task> run, string? glyph = null)
    {
        var item = new MenuItem { Header = header, Icon = Glyph(glyph) };

        item.Click += async (_, _) => await run();

        return item;
    }

    /// <summary>A menu item's codicon, or null for none.</summary>
    static TextBlock? Glyph(string? glyph) =>
        string.IsNullOrEmpty(glyph) ? null : new TextBlock { Text = glyph, FontFamily = (FontFamily)Application.Current!.FindResource("Codicons")!, FontSize = 14, VerticalAlignment = Avalonia.Layout.VerticalAlignment.Center };

    /// <summary>
    /// The dock as the owner of a dialog it opens, shown first: a modal dialog blocks the dock's input, so a pointer at the sliver could not show a
    /// hidden dock until the dialog closed, as when a row's menu stayed open after the dock hid (mechanics M49).
    /// </summary>
    internal MainWindow ShownForDialog()
    {
        Expand();
        return this;
    }

    /// <summary>Posts Snooze… with the wake time and comment its dialog returns, or nothing on Cancel (PRD R49).</summary>
    async Task Snooze(DockRow row, DockControl control)
    {
        if (await SnoozeDialog.Ask(ShownForDialog(), row.Title, model.Snooze) is not { } answer)
        {
            return;
        }

        var action = control.Action.DeepClone().AsObject();

        action["until"] = answer.Until;

        if (answer.Comment is { } comment)
        {
            action["comment"] = comment;
        }

        await Act(action);
    }

    /// <summary>Posts the control's action, after the operator confirms it when the hub sent a question, or with the text the hub asked for.</summary>
    async Task Act(DockControl control)
    {
        if (control.Confirm is { } confirm && !await ConfirmDialog.Ask(ShownForDialog(), confirm.Question, confirm.Detail, confirm.Action))
        {
            return;
        }

        if (control.Input is { } input)
        {
            if (await InputDialog.Ask(ShownForDialog(), input.Question, input.Detail, input.Action, input.Choice, input.Text) is not { } answer)
            {
                return;
            }

            var action = WithField(control.Action, input.Field, answer.Text);

            await Act(input.Choice is { } choice && answer.Choice is { } chosen ? WithField(action, choice.Field, chosen) : action);
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
        // A row's control acts only on the hub's current view.
        if (!model.IsLive)
        {
            model.Status = "Switchboard is not running, so the dock cannot act on the row.";
            return;
        }

        model.Status = null;
        model.Status = await hub.Act(action.DeepClone().AsObject());
    }

    /// <summary>A control that runs in VS Code; like a click, it replaces a click or control still switching windows.</summary>
    Task Run(DockRow? row, JsonObject command) => Running((cancel) => actions.Run(row, command, cancel), "The command failed");

    /// <summary>Open in terminal, in the item window or the terminal app (PRD R28, R71).</summary>
    Task OpenInTerminal(DockRow row) => Running((cancel) => actions.OpenInTerminal(row, cancel), "The terminal did not open");

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
            model.ShowInfo($"Copied {paste.Label}.");
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
            await Open(row, inWeb: false);
        }
        else if (row.Row.Controls.FirstOrDefault((control) => control.Label == row.Main) is { } control)
        {
            await Act(control);
        }
        // A prompt before start's Open in terminal (PRD R41).
        else if (row.Main == "Open in terminal")
        {
            await OpenInTerminal(row.Row);
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
            RowMenu(row.Row.Pastes.Select((paste) => (Control)Item(paste.Label, () => Copy(paste))).ToList(), model.GripOnLeft, new Point(model.GripOnLeft ? button.Bounds.Width : 0, button.Bounds.Height), MenuScreenAt).Open(button);
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
        if (sender is not Button button || button.DataContext is not SourceViewModel group)
        {
            return;
        }

        if (!group.IsMenu)
        {
            model.Status = await hub.SetSource(group.Name, !group.Enabled);
            return;
        }

        var menu = SourceMenu(group, new Point(model.GripOnLeft ? button.Bounds.Width : 0, button.Bounds.Height));

        OpenBelow(button, menu, () =>
        {
            if (button.DataContext is SourceViewModel { IsMenu: true })
            {
                OnSourceClicked(button, new RoutedEventArgs());
            }
        });

        // A snapshot that adds or removes a source replaces the icons, so the menu's entries would be stale.
        void Replaced(object? _, System.Collections.Specialized.NotifyCollectionChangedEventArgs __) => menu.Close();

        model.Sources.CollectionChanged += Replaced;
        menu.Closed += (_, _) => model.Sources.CollectionChanged -= Replaced;
    }

    /// <summary>
    /// A kind's menu of its sources, each with a check box that turns only that source on or off (PRD R71). It stays open on a click, so several
    /// can be changed, and each check box follows the hub's snapshots, so a refused toggle shows unchanged.
    /// </summary>
    internal ContextMenu SourceMenu(SourceViewModel group, Point at)
    {
        var items = group.Entries.Select((entry) =>
        {
            var item = new MenuItem { Header = entry.Name, ToggleType = MenuItemToggleType.CheckBox, StaysOpenOnClick = true, DataContext = entry };

            item.Bind(MenuItem.IsCheckedProperty, new Avalonia.Data.Binding(nameof(SourceEntryViewModel.Enabled)) { Mode = Avalonia.Data.BindingMode.OneWay });
            item.Click += async (_, _) =>
            {
                var status = await hub.SetSource(entry.Name, !entry.Enabled);

                model.Status = status;
                if (status is not null)
                {
                    item.SetCurrentValue(MenuItem.IsCheckedProperty, entry.Enabled);
                }
            };

            return (Control)item;
        }).ToList();
        var menu = RowMenu(items, model.GripOnLeft, at, MenuScreenAt);

        // Space toggles a check box as Enter does; Avalonia's menus take only Enter.
        menu.AddHandler(KeyDownEvent, (_, e) =>
        {
            if (e.Key == Key.Space && items.OfType<MenuItem>().FirstOrDefault((item) => item.IsSelected) is { } selected)
            {
                selected.RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent));
                e.Handled = true;
            }
        });

        return menu;
    }

    // The header buttons whose context request opens their menu again through OpenBelow.
    readonly HashSet<Control> menuButtons = [];

    /// <summary>
    /// Opens a header button's menu, its ContextMenu while open. A menu kept on the button after it closed would open again on a right-click or the
    /// context-menu key with Avalonia's own placement and the size limits of its first opening, so it is removed on close and a context request
    /// runs <paramref name="reopen"/>, which builds and places it afresh.
    /// </summary>
    void OpenBelow(Control button, ContextMenu menu, Action reopen)
    {
        if (menuButtons.Add(button))
        {
            button.ContextRequested += (_, e) =>
            {
                if (button.ContextMenu is null)
                {
                    e.Handled = true;
                    reopen();
                }
            };
        }

        button.ContextMenu = menu;
        menu.Closed += (_, _) =>
        {
            if (button.ContextMenu == menu)
            {
                button.ContextMenu = null;
            }
        };
        menu.Open(button);
    }

    /// <summary>The header's More Actions menu, below the button and opening away from the screen edge the dock is on.</summary>
    void OnMoreClicked(object? sender, RoutedEventArgs e)
    {
        var dockOnRight = model.GripOnLeft;
        var menu = RowMenu(HeaderMenu(), dockOnRight, new Point(dockOnRight ? MoreButton.Bounds.Width : 0, MoreButton.Bounds.Height), MenuScreenAt);

        OpenBelow(MoreButton, menu, () => OnMoreClicked(MoreButton, new RoutedEventArgs()));
    }

    /// <summary>
    /// The header's More Actions menu in groups with a separator between each: Held sessions (PRD R94); Refresh sources, which polls each source that is on now, and Show hub log, which shows the hub log in the VS Code window used
    /// last; then Open Settings, last.
    /// </summary>
    internal List<Control> HeaderMenu() =>
    [
        Item("Held sessions", OpenHeld, TerminalGlyph),
        new Separator(),
        Item("Refresh sources", async () => model.Status = await hub.Poll(), RefreshGlyph),
        Item("Show hub log", () => Run(null, new JsonObject { ["type"] = "log" }), OutputGlyph),
        new Separator(),
        Item("Open Settings", OpenSettings, SettingsGlyph),
    ];

    /// <summary>Opens the held sessions window (PRD R94), or brings the open one forward.</summary>
    Task OpenHeld()
    {
        if (heldWindow is not null)
        {
            heldWindow.Activate();
            return Task.CompletedTask;
        }

        heldWindow = new HeldSessionsWindow(model, hub, actions);
        heldWindow.Closed += (_, _) => heldWindow = null;
        heldWindow.Show();

        return Task.CompletedTask;
    }

    /// <summary>The open held sessions window, or null.</summary>
    internal HeldSessionsWindow? HeldWindow => heldWindow;

    void OnHeldNoteClicked(object? sender, RoutedEventArgs e) => _ = OpenHeld();

    /// <summary>
    /// Restart and resume (architecture.md § Restarting the holder): asks with the hub's question, which names the sessions the restart interrupts, then
    /// posts the restart; its progress and result come back in the hub's view.
    /// </summary>
    async void OnHolderRestartClicked(object? sender, RoutedEventArgs e)
    {
        if (model.HolderNotice?.Confirm is not { } confirm || !await ConfirmDialog.Ask(ShownForDialog(), confirm.Question, confirm.Detail, confirm.Action))
        {
            return;
        }

        if (!model.IsLive)
        {
            model.Status = "Switchboard is not running, so the terminal holder cannot restart.";
            return;
        }

        model.Status = null;
        model.Status = await hub.RestartHolder(confirm.Detail);
    }

    void OnDismissHolderResultClicked(object? sender, RoutedEventArgs e) => model.DismissHolderResult();

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

    async void OnNewStandaloneClicked(object? sender, RoutedEventArgs e) => await NewSession();

    /// <summary>
    /// The header's + button (PRD R122): the New session dialog, with the hub's folders, providers and models. A conversation's row opens once it
    /// shows; a task's row is selected, since a task that waits or queues has nothing to show yet; Run a schedule now opens nothing. A second
    /// click while the dialog is open does nothing.
    /// </summary>
    internal async Task NewSession()
    {
        if (creating is not null) return;
        var mine = new object();
        creating = mine;

        try
        {
            model.Status = null;
            var settings = await hub.SessionProvider();

            if (settings.Installed is { Count: 0 })
            {
                ShowFailure("Neither Claude nor Codex is installed.");
                return;
            }

            // A failed lookup falls back to the default the hub named last, or Claude when it never named one.
            if (settings.DefaultProvider is { } named)
            {
                knownProvider = named;
            }

            var folders = await hub.Folders();
            var places = folders.Error is null ? folders : folders with { RepoRoots = [.. model.RepoRoots] };
            var options = new NewSessionOptions(
                places,
                model.Schedules,
                settings.DefaultProvider ?? knownProvider ?? "claude",
                settings.Installed,
                new Dictionary<string, string?> { ["claude"] = settings.ClaudeModel, ["codex"] = settings.CodexModel },
                settings.ModelChoices ?? new Dictionary<string, IReadOnlyList<ModelChoice>>(),
                model.Settings.NewSessionRun,
                settings.Error is null ? null : $"{settings.Error} Using {((settings.DefaultProvider ?? knownProvider) == "codex" ? "Codex" : "Claude")} and its default model.");
            // One operation for the dialog, so a retry after a lost answer or a refusal makes one work item.
            var opId = Guid.NewGuid().ToString();
            var outcome = await PickNewSession(
                ShownForDialog(),
                options,
                (choice) => hub.NewSession(choice.Folder, opId, choice.Provider, choice.Model, choice.Prompt, choice.Run),
                (name) => hub.Act(new JsonObject { ["type"] = "run-schedule", ["name"] = name }),
                PickFolder);

            if (outcome?.Choice is not { } chosen || outcome.Reply is not { } reply)
            {
                return;
            }

            if (chosen.Prompt is not null)
            {
                model.RememberRun(chosen.Run);
            }

            if (reply.WorkItemId is not { } id)
            {
                ShowFailure("Switchboard did not return a work item.");
                return;
            }

            var key = $"item:{id}";
            var ready = await hub.Until(view => view.Groups.Any(group => group.Rows.Any(row => row.WorkItemId == id)), TimeSpan.FromSeconds(10));
            if (ready is null) { ShowFailure("The new work item did not appear."); return; }
            var row = model.Groups.SelectMany(group => group.AllRows).FirstOrDefault(row => row.Row.WorkItemId == id);
            if (row is null)
            {
                model.Show(ready);
                row = model.Groups.SelectMany(group => group.AllRows).FirstOrDefault(row => row.Row.WorkItemId == id);
            }
            if (row is null) { ShowFailure("The new work item did not appear in the dock."); return; }

            if (chosen.Run == "now")
            {
                await Open(row);
            }
            else
            {
                model.Selected = key;
                ScrollTo(key);
            }
        }
        catch (Exception error)
        {
            ShowFailure($"The session did not start: {error.Message}");
        }
        finally
        {
            if (creating == mine) creating = null;
        }
    }

    /// <summary>The New session attempt whose dialog is open or waits for the hub, or null.</summary>
    object? creating;

    /// <summary>Asks for a folder to start a session in, or null when the operator cancels; tests replace it, as the headless platform has no picker.</summary>
    internal Func<Window, Task<string?>> PickFolder { get; set; } = AskFolder;

    /// <summary>Shows the New session dialog; tests may replace it.</summary>
    internal Func<Window, NewSessionOptions, Func<NewSessionChoice, Task<NewSessionReply>>, Func<string, Task<string?>>, Func<Window, Task<string?>>?, Task<NewSessionOutcome?>> PickNewSession { get; set; } = NewSessionDialog.Ask;

    static async Task<string?> AskFolder(Window owner)
    {
        var picked = await owner.StorageProvider.OpenFolderPickerAsync(new FolderPickerOpenOptions { Title = "Choose a folder", AllowMultiple = false });

        return picked.Count == 0 ? null : picked[0].TryGetLocalPath();
    }

    /// <summary>The default provider the hub named last, which New session falls back to when the hub cannot list the providers.</summary>
    string? knownProvider;

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
            model.Status = "Switchboard is not running, so Settings cannot open.";
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

    /// <summary>The open Settings window, or null.</summary>
    internal SettingsWindow? Settings => settingsWindow;

    void OnSearchKey(object? sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape)
        {
            model.SearchOpen = false;
        }
    }

    void OnDismissStatusClicked(object? sender, RoutedEventArgs e) => model.Status = null;

    /// <summary>Starts the hub now, without waiting for the dock's own start; tests replace it, as they run no hub.</summary>
    internal Func<string?>? StartHub { get; set; }

    /// <summary>Start hub, shown while no hub runs: starts one at once and shows why it could not, if it could not.</summary>
    void OnStartHubClicked(object? sender, RoutedEventArgs e)
    {
        if (StartHub is { } start)
        {
            model.Status = start();
        }
        else
        {
            model.Status = stream is null ? "Open VS Code to start Switchboard." : stream.StartHub();
        }
    }

    void OnClearSearchClicked(object? sender, RoutedEventArgs e)
    {
        model.Filter = "";
        SearchBox.Focus();
    }

    void OnSearchFurtherClicked(object? sender, RoutedEventArgs e) => model.SearchFurther();

    void OnSearchAllTimeClicked(object? sender, RoutedEventArgs e) => model.Range = DockViewModel.Ranges.Count - 1;

    /// <summary>The searched time range's menu, below its button (PRD R63).</summary>
    void OnSearchRangeClicked(object? sender, RoutedEventArgs e)
    {
        var items = DockViewModel.Ranges.Select((label, index) => (Control)Checked(label, model.Range == index, () =>
        {
            model.Range = index;
            return Task.CompletedTask;
        })).ToList();
        var menu = RowMenu(items, model.GripOnLeft, new Point(0, SearchRangeButton.Bounds.Height), MenuScreenAt);

        OpenBelow(SearchRangeButton, menu, () => OnSearchRangeClicked(SearchRangeButton, new RoutedEventArgs()));
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
        public Task<string?> OpenInTerminal(DockRow row, CancellationToken cancel) => Task.FromResult<string?>(null);

        public Task<string?> Terminal(DockRow? row, DockTerminal terminal, CancellationToken cancel) => Task.FromResult<string?>(null);

        public Task<string?> Click(DockRow row, CancellationToken cancel) => Task.FromResult<string?>(null);

        public Task<string?> OpenInPage(DockRow row, CancellationToken cancel) => Task.FromResult<string?>(null);

        public Task<string?> Run(DockRow? row, JsonObject command, CancellationToken cancel) => Task.FromResult<string?>(null);

        public string? OpenUrl(string url) => null;

    }

    sealed class NoHub : IHub
    {
        public Task<string?> Act(JsonObject action) => Task.FromResult<string?>(null);

        public Task<SearchReply> Search(string text, long since) => Task.FromResult(new SearchReply(null, []));

        public Task<WindowReply> Window(JsonObject command, string? workspace) => Task.FromResult(new WindowReply(null, null));

        public Task<string?> Withdraw(int id) => Task.FromResult<string?>(null);

        public Task<string?> SetSource(string name, bool enabled) => Task.FromResult<string?>(null);

        public Task<string?> Poll() => Task.FromResult<string?>(null);

        public Task<WindowReply> Open(string sessionId, string cwd, string workspace) => Task.FromResult(new WindowReply(null, null));

        public Task<string?> WithdrawOpen(int id) => Task.FromResult<string?>(null);

        public Task<string?> Select(string rowKey) => Task.FromResult<string?>(null);

        public Task<PageReply> Page(string rowKey) => Task.FromResult(new PageReply(null, null, null));

        public Task<string?> StopHeld(string session) => Task.FromResult<string?>(null);

        public Task<string?> RestartHolder(string detail) => Task.FromResult<string?>(null);

        public Task<string?> Focus(string? sessionId, long at) => Task.FromResult<string?>(null);

        public Task<NewSessionReply> NewSession(string folder, string opId, string provider, string? model, string? prompt, string run) => Task.FromResult(new NewSessionReply(null, null, folder));

        public Task<FolderPlaces> Folders() => Task.FromResult(new FolderPlaces(null, [], [], []));
        public Task<SessionProviderReply> SessionProvider() => Task.FromResult(new SessionProviderReply(null, "claude"));

        public Task<DockView?> Until(Func<DockView, bool> test, TimeSpan within) => Task.FromResult<DockView?>(null);
    }
}
