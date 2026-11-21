using Switchboard.Dock.Hub;

namespace Switchboard.Dock.Tests;

static class Fixtures
{
    /// <summary>The dock message recorded from <c>dockView</c> by packages/hub/test/dock.test.ts.</summary>
    public static string DockJson => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "dock.json"));

    /// <summary>The recorded view without its holder notice and result, which sit above the groups and would move every row the layout tests place.</summary>
    public static DockView View => HolderView with { HolderNotice = null, HolderResult = null };

    /// <summary>The recorded view whole, with the holder notice and result (architecture.md § Restarting the holder).</summary>
    public static DockView HolderView => DockView.Parse(DockJson);

    public static DockRow Row(string key) => View.Groups.SelectMany((group) => group.Rows).Single((row) => row.Key == key);

    /// <summary>A new empty folder under the test temp directory.</summary>
    public static string TempFolder()
    {
        var path = Path.Combine(Path.GetTempPath(), "switchboard-dock-tests", Guid.NewGuid().ToString("N"));

        Directory.CreateDirectory(path);

        return path;
    }
}
