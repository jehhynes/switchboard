using Avalonia;

namespace Switchboard.Dock;

static class Program
{
    /// <summary><c>Switchboard.Dock.exe [--home &lt;dir&gt;]</c>: <c>--home</c> names the folder holding <c>.switchboard</c>, as the hub's does.</summary>
    [STAThread]
    public static int Main(string[] args)
    {
        var home = args.SkipWhile((arg) => arg != "--home").Skip(1).FirstOrDefault() ?? Environment.GetEnvironmentVariable("SWITCHBOARD_HOME") ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

        // One dock per desktop: a second would reserve a second strip.
        using var single = new Mutex(true, @"Local\Switchboard.Dock", out var first);

        if (!first)
        {
            return 1;
        }

        App.SwitchboardHome = Path.Combine(home, ".switchboard");

        return BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
    }

    public static AppBuilder BuildAvaloniaApp() => AppBuilder.Configure<App>().UsePlatformDetect().LogToTrace();
}
