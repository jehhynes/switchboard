using Avalonia;
using Avalonia.Headless;
using Switchboard.Dock;
using Switchboard.Dock.Tests;

[assembly: AvaloniaTestApplication(typeof(TestApp))]

namespace Switchboard.Dock.Tests;

public static class TestApp
{
    /// <summary>The headless platform's options; a test that needs popups as windows of their own, as on Windows and X11, turns OverlayPopups off.</summary>
    internal static readonly AvaloniaHeadlessPlatformOptions Options = new();

    public static AppBuilder BuildAvaloniaApp() => AppBuilder.Configure<App>().UseHeadless(Options);
}
