using Switchboard.Dock.Platform;

namespace Switchboard.Dock.Tests;

public sealed class WindowNamesTests
{
    [Fact]
    public void Destroyed_KeptWindow_ReturnsItsNameOnce()
    {
        var names = new WindowNames();

        names.Set(1, "gh-107-58c609");

        Assert.Equal("gh-107-58c609", names.Destroyed(1));
        Assert.Null(names.Destroyed(1));
    }

    [Fact]
    public void Destroyed_UnknownWindow_ReturnsNull()
    {
        var names = new WindowNames();

        names.Set(1, "gh-107-58c609");

        Assert.Null(names.Destroyed(2));
    }

    [Fact]
    public void Set_NewName_ReplacesTheOldName()
    {
        var names = new WindowNames();

        names.Set(1, "gh-107-58c609");
        names.Set(1, "gh-108-widgets-655280");

        Assert.Equal("gh-108-widgets-655280", names.Destroyed(1));
    }

    [Fact]
    public void Set_NoName_ForgetsTheWindow()
    {
        var names = new WindowNames();

        names.Set(1, "gh-107-58c609");
        names.Set(1, null);

        Assert.Null(names.Destroyed(1));
    }
}
