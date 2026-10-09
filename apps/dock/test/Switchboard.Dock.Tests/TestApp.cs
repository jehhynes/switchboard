using Avalonia;
using Avalonia.Headless;
using Switchboard.Dock;
using Switchboard.Dock.Tests;

[assembly: AvaloniaTestApplication(typeof(TestApp))]

namespace Switchboard.Dock.Tests;

public static class TestApp
{
    public static AppBuilder BuildAvaloniaApp() => AppBuilder.Configure<App>().UseHeadless(new AvaloniaHeadlessPlatformOptions());
}
