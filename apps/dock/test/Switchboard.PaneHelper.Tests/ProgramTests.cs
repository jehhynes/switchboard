using System.Diagnostics;

namespace Switchboard.PaneHelper.Tests;

/// <summary>The helper as the hub runs it: a process that talks over stdin and stdout. No order names a marker, so it touches no window.</summary>
public sealed class ProgramTests : IDisposable
{
    readonly string home = Directory.CreateTempSubdirectory("pane-helper-").FullName;

    public void Dispose() => Directory.Delete(home, recursive: true);

    static Process Start(params string[] args)
    {
        var start = new ProcessStartInfo(Path.Combine(AppContext.BaseDirectory, "Switchboard.PaneHelper.exe"))
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        foreach (var arg in args)
        {
            start.ArgumentList.Add(arg);
        }

        return Process.Start(start)!;
    }

    [Fact]
    public async Task Run_InputClosed_SaysReadyThenExitsAndLogs()
    {
        using var helper = Start("--home", home);

        Assert.Equal("""{"state":"ready"}""", await helper.StandardOutput.ReadLineAsync(TestContext.Current.CancellationToken));
        await helper.StandardInput.WriteLineAsync("""{"type":"pane","marker":null,"rect":null}""");
        await helper.StandardInput.WriteLineAsync("not json");
        helper.StandardInput.Close();

        Assert.True(helper.WaitForExit(10_000), "The helper did not exit when its input closed.");
        Assert.Equal(0, helper.ExitCode);
        Assert.Null(await helper.StandardOutput.ReadLineAsync(TestContext.Current.CancellationToken));

        var log = await File.ReadAllTextAsync(Path.Combine(home, "chrome-pane.log"), TestContext.Current.CancellationToken);

        Assert.Contains("pane helper started", log);
        Assert.Contains("pane helper stopped", log);
    }

    [Fact]
    public void Run_NoHome_RefusesToStart()
    {
        using var helper = Start();

        Assert.True(helper.WaitForExit(10_000));
        Assert.Equal(2, helper.ExitCode);
        Assert.Contains("--home", helper.StandardError.ReadToEnd());
    }
}
