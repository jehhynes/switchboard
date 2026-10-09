using Switchboard.Dock.Hub;

namespace Switchboard.Dock.Tests;

public sealed class EventStreamTests
{
    static List<ServerEvent> ReadAll(params string[] lines)
    {
        var stream = new EventStream();

        return lines.Select(stream.Read).OfType<ServerEvent>().ToList();
    }

    [Fact]
    public void Read_HubStream_ReturnsEachEventWhenItsBlankLineArrives()
    {
        var events = ReadAll("event: hello", "data: {\"hub\":\"switchboard\"}", "", ": ping", "", "event: dock", "data: {\"a\":1}", "");

        Assert.Equal([new ServerEvent("hello", "{\"hub\":\"switchboard\"}"), new ServerEvent("dock", "{\"a\":1}")], events);
    }

    [Fact]
    public void Read_SeveralDataLines_JoinsThemWithNewlines()
    {
        Assert.Equal([new ServerEvent("message", "one\ntwo")], ReadAll("data: one", "data:two", ""));
    }

    [Fact]
    public void Read_BlankLineWithoutData_ReturnsNothingAndResetsTheName()
    {
        Assert.Equal([new ServerEvent("message", "x")], ReadAll("event: dock", "", "data: x", ""));
    }
}
