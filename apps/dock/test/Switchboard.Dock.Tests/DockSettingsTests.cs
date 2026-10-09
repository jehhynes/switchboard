namespace Switchboard.Dock.Tests;

public sealed class DockSettingsTests
{
    [Fact]
    public void Load_NoFile_GivesTheDefaults()
    {
        var settings = DockSettings.Load(Fixtures.TempFolder());

        Assert.Equal(320, settings.Width);
        Assert.Empty(settings.Groups);
    }

    [Fact]
    public void Save_ThenLoad_KeepsWidthAndGroups()
    {
        var home = Fixtures.TempFolder();
        var settings = new DockSettings { Width = 410, Groups = { ["done"] = true, ["needs"] = false } };

        settings.Save(home);

        var loaded = DockSettings.Load(home);

        Assert.Equal(410, loaded.Width);
        Assert.Equal(new Dictionary<string, bool> { ["done"] = true, ["needs"] = false }, loaded.Groups);
        Assert.Equal(["dock.json"], Directory.GetFiles(home).Select(Path.GetFileName));
    }

    [Theory]
    [InlineData("{\"width\": 50}", 200)]
    [InlineData("{\"width\": 5000}", 800)]
    [InlineData("{\"width\": \"wide\"}", 320)]
    [InlineData("not json", 320)]
    [InlineData("{\"groups\": null}", 320)]
    public void Load_BadOrOutOfRangeFile_KeepsTheWidthWithinItsLimits(string json, double width)
    {
        var home = Fixtures.TempFolder();

        File.WriteAllText(Path.Combine(home, "dock.json"), json);

        var settings = DockSettings.Load(home);

        Assert.Equal(width, settings.Width);
        Assert.NotNull(settings.Groups);
    }
}
