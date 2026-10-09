using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
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
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop && OperatingSystem.IsWindows())
        {
            var hub = new HubClient(SwitchboardHome);
            var windows = new Win32Windows();
            var switcher = new Switcher(SwitchboardHome, hub, windows, new VsCodeInstall());
            var model = new DockViewModel(DockSettings.Load(SwitchboardHome), (settings) => settings.Save(SwitchboardHome));
            var window = new MainWindow(model, hub, hub, switcher.Click, (url) => Switcher.OpenUrl(windows, url), docked: true);

            desktop.MainWindow = window;
            windows.WatchForeground(window.ShowForeground);
            desktop.Exit += (_, _) =>
            {
                windows.Dispose();
                hub.Dispose();
            };
            hub.Start();
        }

        base.OnFrameworkInitializationCompleted();
    }
}
