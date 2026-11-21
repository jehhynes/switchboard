namespace Switchboard.PaneHelper.Tests;

public sealed class PaneTitlesTests
{
    const string Marker = "0123456789ab";
    const uint Chrome = 100;
    const uint OtherProfile = 200;

    static ChromeWindow Window(nint handle, string title, uint process = Chrome, bool visible = true, bool owned = false, string? appId = null) => new(handle, process, title, visible, owned, appId);

    [Fact]
    public void PaneMarked_TitleWithTheMarker_MatchesOnlyThatMarker()
    {
        Assert.True(PaneTitles.PaneMarked("Switchboard pane 0123456789ab - Google Chrome", Marker));
        Assert.False(PaneTitles.PaneMarked("Switchboard pane 1b17b20dd815 - Google Chrome", Marker));
        Assert.False(PaneTitles.PaneMarked("Switchboard pane - Google Chrome", Marker));
    }

    [Fact]
    public void PaneAny_PaneTitleWithAnyMarkerOrNone_MatchesOnlyThat()
    {
        Assert.True(PaneTitles.PaneAny("Switchboard pane - Google Chrome"));
        Assert.True(PaneTitles.PaneAny("Switchboard pane 1b17b20dd815 - Google Chrome"));
        Assert.False(PaneTitles.PaneAny("Switchboard"));
        Assert.False(PaneTitles.PaneAny("Switchboard pane notes - Google Chrome"));
        Assert.False(PaneTitles.PaneAny("Re: Switchboard pane - Google Chrome"));
    }

    [Fact]
    public void PageNamed_PageAndAppTitles_MatchAndOthersDoNot()
    {
        Assert.True(PaneTitles.PageNamed("Switchboard"));
        Assert.True(PaneTitles.PageNamed("(2) Switchboard"));
        Assert.True(PaneTitles.PageNamed("Switchboard - (2) Switchboard [sb-pane ef4652596974]"));
        Assert.True(PaneTitles.PageNamed("Switchboard [sb-pane ef4652596974] [sb-show 0123456789ab]"));
        Assert.True(PaneTitles.PageNamed("127.0.0.1_/page/"));
        Assert.False(PaneTitles.PageNamed("Switchboard - Google Chrome"));
        Assert.False(PaneTitles.PageNamed("Switchboard Notes"));
        Assert.False(PaneTitles.PageNamed("Switchboard - Switchboard Notes"));
        Assert.False(PaneTitles.PageNamed("127.0.0.1_/other/"));
    }

    [Fact]
    public void PickPane_MarkedWindow_IsTakenEvenHiddenAndBeforeOthers()
    {
        var windows = new[] { Window(1, "Switchboard pane - Google Chrome"), Window(2, "Switchboard pane 0123456789ab - Google Chrome", visible: false), Window(3, "Switchboard") };

        Assert.Equal((windows[1], false), PaneTitles.PickPane(windows, Marker));
    }

    [Fact]
    public void PickPane_OneUnmarkedPaneInThePagesBrowser_IsTakenByTitle()
    {
        // The operator's 2026-11-21 15:55 windows: the pane without its marker and the installed page titled with the app's name.
        var windows = new[] { Window(1, "Switchboard", appId: "Chrome._crx_icffloodgfejmdc.UserData.Profile1"), Window(2, "Switchboard pane - Google Chrome"), Window(3, "Issue #1 - Google Chrome"), Window(4, "Switchboard pane - Google Chrome for Testing", process: OtherProfile) };

        Assert.Equal((windows[1], true), PaneTitles.PickPane(windows, Marker));
    }

    [Fact]
    public void PickPane_UnmarkedPanesTwiceOrNoPageInTheirBrowser_TakesNothing()
    {
        // Two windows titled as the pane in the page's browser, such as the real one and a normal tab of that title: neither can be told apart.
        var twice = new[] { Window(1, "Switchboard"), Window(2, "Switchboard pane - Google Chrome"), Window(3, "Switchboard pane - Google Chrome", visible: false) };
        // A pane window of another profile or browser, whose process shows no page window.
        var elsewhere = new[] { Window(1, "Switchboard"), Window(4, "Switchboard pane - Google Chrome", process: OtherProfile) };

        Assert.Equal((null, false), PaneTitles.PickPane(twice, Marker));
        Assert.Equal((null, false), PaneTitles.PickPane(elsewhere, Marker));
    }

    [Fact]
    public void PickPage_MarkedFirstThenTheFrontNamedOneInThePanesBrowser()
    {
        var pane = Window(9, "Switchboard pane - Google Chrome");
        var marked = new[] { Window(1, "Switchboard"), Window(2, "Switchboard - Switchboard [sb-pane 0123456789ab]"), pane };
        var named = new[] { Window(3, "Switchboard Notes"), Window(4, "Switchboard", process: OtherProfile), Window(5, "Switchboard", owned: true), Window(6, "(2) Switchboard"), Window(7, "Switchboard"), pane };

        Assert.Equal(marked[1], PaneTitles.PickPage(marked, Marker, pane));
        Assert.Equal(named[3], PaneTitles.PickPage(named, Marker, pane));
        Assert.Equal(2, PaneTitles.PageCandidates(named, pane));
        Assert.Null(PaneTitles.PickPage(named, Marker, null));
    }
}
