namespace Switchboard.Dock.Tests;

public sealed class DockSettingsTests
{
    [Fact]
    public void Load_NoFile_GivesTheDefaults()
    {
        var settings = DockSettings.Load(Fixtures.TempFolder());

        Assert.Equal(320, settings.Width);
        Assert.Empty(settings.Groups);
        Assert.Equal(Platform.DockEdge.Left, settings.DockEdge);
        Assert.Null(settings.Monitor);
        Assert.False(settings.AutoHide);
    }

    [Fact]
    public void Save_ThenLoad_KeepsAutoHide()
    {
        var home = Fixtures.TempFolder();

        new DockSettings { AutoHide = true }.Save(home);

        Assert.True(DockSettings.Load(home).AutoHide);
        Assert.Contains("\"autoHide\": true", File.ReadAllText(Path.Combine(home, "dock.json")));
    }

    [Fact]
    public void Save_ThenLoad_KeepsEdgeAndMonitor()
    {
        var home = Fixtures.TempFolder();

        new DockSettings { Edge = "right", Monitor = @"\\.\DISPLAY2" }.Save(home);

        var loaded = DockSettings.Load(home);

        Assert.Equal(Platform.DockEdge.Right, loaded.DockEdge);
        Assert.Equal(@"\\.\DISPLAY2", loaded.Monitor);
        Assert.DoesNotContain("dockEdge", File.ReadAllText(Path.Combine(home, "dock.json")));
    }

    [Theory]
    [InlineData("{\"newSessionRun\": \"wait\", \"recentFolders\": [\"D:/kept\"]}", "wait")]
    [InlineData("{\"newSessionRun\": \"later\"}", "now")]
    [InlineData("{}", "now")]
    public void Load_NewSessionRun_KeepsAKnownChoiceAndTheRecentFoldersForTheHubsImport(string json, string run)
    {
        var home = Fixtures.TempFolder();

        File.WriteAllText(Path.Combine(home, "dock.json"), json);

        var settings = DockSettings.Load(home);

        Assert.Equal(run, settings.NewSessionRun);
        settings.Save(home);
        Assert.Equal(json.Contains("D:/kept", StringComparison.Ordinal), File.ReadAllText(Path.Combine(home, "dock.json")).Contains("D:/kept", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("{\"edge\": \"top\"}")]
    [InlineData("{\"edge\": null}")]
    public void Load_EdgeTheDockDoesNotOffer_DocksOnTheLeft(string json)
    {
        var home = Fixtures.TempFolder();

        File.WriteAllText(Path.Combine(home, "dock.json"), json);

        var settings = DockSettings.Load(home);

        Assert.Equal("left", settings.Edge);
        Assert.Equal(Platform.DockEdge.Left, settings.DockEdge);
    }

    [Fact]
    public void Save_ThenLoad_KeepsWidthAndGroups()
    {
        var home = Fixtures.TempFolder();
        var settings = new DockSettings { Width = 410, Groups = { ["done"] = true, ["blocked"] = false } };

        settings.Save(home);

        var loaded = DockSettings.Load(home);

        Assert.Equal(410, loaded.Width);
        Assert.Equal(new Dictionary<string, bool> { ["done"] = true, ["blocked"] = false }, loaded.Groups);
        Assert.Equal(["dock.json"], Directory.GetFiles(home).Select(Path.GetFileName));
    }

    [Fact]
    public void Load_FileWithDoneBands_DropsTheBandsAndKeepsTheGroups()
    {
        var home = Fixtures.TempFolder();

        File.WriteAllText(Path.Combine(home, "dock.json"), "{\"groups\": {\"done\": true, \"done:Today\": false, \"done:Two weeks ago\": true}}");

        Assert.Equal(new Dictionary<string, bool> { ["done"] = true }, DockSettings.Load(home).Groups);
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

public sealed class PlacementTests
{
    [Fact]
    public void SetPlacement_RightEdge_KeepsItAndMovesTheGripToTheLeft()
    {
        var saved = new List<(string Edge, string? Monitor)>();
        var model = new Views.DockViewModel(new DockSettings(), (kept) => saved.Add((kept.Edge, kept.Monitor)));

        Assert.True(model.GripOnRight);
        Assert.False(model.GripOnLeft);

        model.SetPlacement(Platform.DockEdge.Right, @"\\.\DISPLAY2");

        Assert.True(model.GripOnLeft);
        Assert.False(model.GripOnRight);
        Assert.Equal([("right", @"\\.\DISPLAY2")], saved);
    }
}
