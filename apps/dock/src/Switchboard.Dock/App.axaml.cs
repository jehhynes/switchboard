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
            var hub = new HubClient(SwitchboardHome);
            var model = new DockViewModel(DockSettings.Load(SwitchboardHome), (settings) => settings.Save(SwitchboardHome));
            MainWindow window;

            if (OperatingSystem.IsWindows())
            {
                var windows = new Win32Windows();

                window = new MainWindow(model, hub, hub, new Switcher(hub, windows, new VsCodeInstall()), docked: true, config: hub);
                window.DockedOn += (monitor) => windows.DockMonitor = monitor;
                windows.WatchForeground(window.ShowForeground);
                windows.WatchClosed(model.WindowClosed);
                desktop.Exit += (_, _) => windows.Dispose();
            }
            else
            {
                // The dock cannot see other apps' windows or reserve a screen edge here, so it is an ordinary window that follows VS Code through the hub.
                var windows = new HubWindows(new VsCodeInstall());

                window = new MainWindow(model, hub, hub, new Switcher(hub, windows, new VsCodeInstall()), docked: false, config: hub) { Title = "Switchboard" };
                window.Float();
                hub.Changed += () => Dispatcher.UIThread.Post(() => windows.Update(hub.View?.Windows));
                windows.WatchForeground(window.ShowItemWindow);
                windows.WatchClosed(model.WindowClosed);
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
