using Switchboard.Dock.Hub;

namespace Switchboard.Dock.Tests;

static class Fixtures
{
    /// <summary>The dock message recorded from <c>dockView</c> by packages/hub/test/dock.test.ts.</summary>
    public static string DockJson => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "dock.json"));

    public static DockView View => DockView.Parse(DockJson);

    public static DockRow Row(string key) => View.Groups.SelectMany((group) => group.Rows).Single((row) => row.Key == key);

    /// <summary>A new empty folder under the test temp directory.</summary>
    public static string TempFolder()
    {
        var path = Path.Combine(Path.GetTempPath(), "switchboard-dock-tests", Guid.NewGuid().ToString("N"));

        Directory.CreateDirectory(path);

        return path;
    }
}
