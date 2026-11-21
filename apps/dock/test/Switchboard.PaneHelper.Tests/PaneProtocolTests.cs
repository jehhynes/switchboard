namespace Switchboard.PaneHelper.Tests;

public sealed class PaneProtocolTests
{
    [Fact]
    public void ParseOrder_PaneLine_ReadsTheMarkerAndColumnAndDropsAMalformedColumn()
    {
        Assert.Equal(new PaneOrder("0123456789ab", new PaneRect(1, 2, 600, 4, 1.5, 6, 7)), PaneProtocol.ParseOrder("""{"type":"pane","marker":"0123456789ab","rect":{"left":1,"top":2,"width":600,"height":4,"dpr":1.5,"innerWidth":6,"innerHeight":7}}"""));
        Assert.Equal(new PaneOrder("0123456789ab", null), PaneProtocol.ParseOrder("""{"type":"pane","marker":"0123456789ab","rect":{"left":1,"top":2,"width":"wide","height":4,"dpr":1.5,"innerWidth":6,"innerHeight":7}}"""));
        Assert.Equal(new PaneOrder("0123456789ab", null), PaneProtocol.ParseOrder("""{"type":"pane","marker":"0123456789ab","rect":{"left":1,"top":2,"width":600,"height":4,"dpr":0,"innerWidth":6,"innerHeight":7}}"""));
        Assert.Equal(new PaneOrder(null, null), PaneProtocol.ParseOrder("""{"type":"pane","marker":null,"rect":null}"""));
    }

    [Fact]
    public void ParseOrder_OtherLine_ReadsNothing()
    {
        Assert.Null(PaneProtocol.ParseOrder("not json"));
        Assert.Null(PaneProtocol.ParseOrder("[]"));
        Assert.Null(PaneProtocol.ParseOrder("""{"marker":"0123456789ab","rect":null}"""));
        Assert.Null(PaneProtocol.ParseOrder("""{"type":"tabs","marker":"0123456789ab"}"""));
    }

    [Fact]
    public void Line_Report_IsOneLineOfJson()
    {
        var line = PaneProtocol.Line(new System.Text.Json.Nodes.JsonObject { ["state"] = "failed", ["marker"] = "0123456789ab", ["reason"] = "One\nTwo" });

        Assert.Equal("""{"state":"failed","marker":"0123456789ab","reason":"One\nTwo"}""", line);
        Assert.Equal("""{"state":"ready"}""", PaneProtocol.Line(PaneProtocol.Ready));
    }
}
