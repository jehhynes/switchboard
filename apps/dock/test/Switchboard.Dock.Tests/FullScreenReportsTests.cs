using Switchboard.Dock.Platform;

namespace Switchboard.Dock.Tests;

public sealed class FullScreenReportsTests
{
    readonly List<string> reported = [];

    FullScreenReports Reports() => new((monitors) => reported.Add(string.Join(",", monitors)));

    [Fact]
    public void Read_ServiceReturned_ReportsWhatItRead()
    {
        var reports = Reports();

        reports.Lost();
        reports.Read(reports.Begin(), ["HDMI-1", "HDMI-2"]);

        Assert.Equal(["", "HDMI-1,HDMI-2"], reported);
    }

    [Fact]
    public void Read_ServiceLeftWhileReading_KeepsTheLaterLoss()
    {
        var reports = Reports();
        var started = reports.Begin();

        reports.Lost();
        reports.Read(started, ["HDMI-1", "HDMI-2"]);

        Assert.Equal([""], reported);
    }

    [Fact]
    public void Read_SignalWhileReading_KeepsTheSignal()
    {
        var reports = Reports();
        var started = reports.Begin();

        reports.Changed([]);
        reports.Read(started, ["HDMI-1", "HDMI-2"]);

        Assert.Equal([""], reported);
    }

    [Fact]
    public void Read_NewerReadStarted_ReportsOnlyTheNewer()
    {
        var reports = Reports();
        var first = reports.Begin();
        var second = reports.Begin();

        reports.Read(second, []);
        reports.Read(first, ["HDMI-1", "HDMI-2"]);

        Assert.Equal([""], reported);
    }
}
