using Switchboard.Dock.Platform;

namespace Switchboard.Dock.Tests;

public sealed class FullScreenReportsTests
{
    readonly List<bool> reported = [];

    [Fact]
    public void Read_ServiceReturned_ReportsWhatItRead()
    {
        var reports = new FullScreenReports(reported.Add);

        reports.Lost();
        reports.Read(reports.Begin(), true);

        Assert.Equal([false, true], reported);
    }

    [Fact]
    public void Read_ServiceLeftWhileReading_KeepsTheLaterLoss()
    {
        var reports = new FullScreenReports(reported.Add);
        var started = reports.Begin();

        reports.Lost();
        reports.Read(started, true);

        Assert.Equal([false], reported);
    }

    [Fact]
    public void Read_SignalWhileReading_KeepsTheSignal()
    {
        var reports = new FullScreenReports(reported.Add);
        var started = reports.Begin();

        reports.Changed(false);
        reports.Read(started, true);

        Assert.Equal([false], reported);
    }

    [Fact]
    public void Read_NewerReadStarted_ReportsOnlyTheNewer()
    {
        var reports = new FullScreenReports(reported.Add);
        var first = reports.Begin();
        var second = reports.Begin();

        reports.Read(second, false);
        reports.Read(first, true);

        Assert.Equal([false], reported);
    }
}
