using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Avalonia.Threading;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Platform;
using Switchboard.Dock.Switching;
using Switchboard.Dock.Views;

namespace Switchboard.Dock;

public sealed class App : Application
{
    /// <summary>The Switchboard home, <c>&lt;home&gt;/.switchboard</c>, set by <see cref="Program"/>.</summary>
    public static string SwitchboardHome { get; set; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".switchboard");

    public override void Initialize() => AvaloniaXamlLoader.Load(this);

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            var hub = new HubClient(SwitchboardHome, new HubStarter(SwitchboardHome));
            var model = new DockViewModel(DockSettings.Load(SwitchboardHome), (settings) => settings.Save(SwitchboardHome));
            MainWindow window;

            if (OperatingSystem.IsWindows())
            {
                var windows = new Win32Windows();

                window = new MainWindow(model, hub, hub, new Switcher(hub, windows, new VsCodeInstall(), terminal: Terminals.ForPlatform()), docked: true, config: hub);
                window.DockedOn += (monitor) => windows.DockMonitor = monitor;
                windows.WatchForeground(window.ShowForeground);
                windows.WatchClosed(model.WindowClosed);
                desktop.Exit += (_, _) => windows.Dispose();
            }
            else
            {
                // Under GNOME on Wayland the dock cannot see other apps' windows: it follows VS Code's windows through the hub, and finds and brings
                // them forward through the GNOME Shell extension when it is enabled. It runs under XWayland, so it docks as an X11 dock window.
                var followed = new HubWindows(new VsCodeInstall());
                var shell = GnomeShell.Connect();
                var shellWindows = shell is null ? null : new ShellWindows(shell, followed);
                IWindows windows = shellWindows ?? (IWindows)followed;

                window = new MainWindow(model, hub, hub, new Switcher(hub, windows, new VsCodeInstall(), terminal: Terminals.ForPlatform()), docked: false, config: hub) { Title = "Switchboard" };

                if (window.TryGetPlatformHandle() is { HandleDescriptor: "XID" })
                {
                    window.DockOnX11();

                    if (shellWindows is not null)
                    {
                        window.DockedOnX11 += (monitor) => shellWindows.Monitor = monitor;
                    }
                }
                else
                {
                    window.Float();
                }

                if (shell is not null)
                {
                    // Only the extension sees full-screen windows; without it the dock stays above them.
                    window.Opened += (_, _) =>
                    {
                        try
                        {
                            shell.WatchFullScreen((monitors) => Dispatcher.UIThread.Post(() => window.ShowFullScreen(monitors)));
                            window.ShowFullScreen(shell.FullScreen());
                            // VS Code windows report their focus through the hub; a terminal's comes from the shell (PRD R71).
                            shell.WatchTerminalFocused((title) => Dispatcher.UIThread.Post(() => window.ShowForeground(title)));
                        }
                        catch (ShellException)
                        {
                            // The extension was turned off since the dock started; the dock stays above full-screen windows.
                        }
                    };
                    desktop.Exit += (_, _) => shell.Dispose();
                }

                hub.Changed += () => Dispatcher.UIThread.Post(() => followed.Update(hub.View?.Windows));
                followed.WatchForeground(window.ShowItemWindow);
                followed.WatchClosed(model.WindowClosed);
            }

            desktop.MainWindow = window;
            // Closing the dock ends it, even with the Settings window open.
            desktop.ShutdownMode = ShutdownMode.OnMainWindowClose;
            desktop.Exit += (_, _) => hub.Dispose();
            hub.Start();
        }

        base.OnFrameworkInitializationCompleted();
    }
}
