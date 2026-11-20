using System.Collections;
using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text.Json;
using Switchboard.Dock.Hub;

namespace Switchboard.Dock.Tests;

/// <summary>The dock starts the hub when none runs (PRD R71).</summary>
public sealed class HubStarterTests
{
    readonly string home = Fixtures.TempFolder();
    readonly List<ProcessStartInfo> started = [];
    DateTime now = new(2026, 10, 21, 12, 0, 0, DateTimeKind.Utc);

    string Switchboard => Path.Combine(home, ".switchboard");

    HubStarter Starter() => new(Switchboard, () => now, (info) =>
    {
        started.Add(info);
        return null;
    });

    /// <summary>Starts after the grace a missing hub gets, as the dock's retries reach it.</summary>
    string? StartAfterGrace(HubStarter starter)
    {
        starter.Start();
        now += HubStarter.Grace;

        return starter.Start();
    }

    /// <summary>A runtime and bundle that exist, as a hub a VS Code window started would leave them.</summary>
    HubRecord Installed()
    {
        Directory.CreateDirectory(Switchboard);

        var runtime = Path.Combine(home, "code");

        File.WriteAllText(runtime, "");
        File.WriteAllText(Path.Combine(Switchboard, "hub.js"), "");

        return new HubRecord(51234, "t0k", 42, "/home/me/.claude/switchboard", runtime);
    }

    [Fact]
    public void Start_NoHubSeenYet_SaysToOpenVsCodeOnceAndStartsNothing()
    {
        Assert.Equal(HubStarter.Never, StartAfterGrace(Starter()));
        Assert.Empty(started);
    }

    [Fact]
    public void Remember_RecordFromAnOlderHub_KeepsNothing()
    {
        var starter = Starter();

        Installed();
        starter.Remember(new HubRecord(51234, "t0k", 42));
        starter.Remember(new HubRecord(51234, "t0k", 42, "C:/cfg"));

        Assert.Equal(HubStarter.Never, StartAfterGrace(starter));
        Assert.Empty(started);
    }

    [Fact]
    public void Start_AfterAHubWasSeen_StartsItsRuntimeOnTheBundleWithItsConfigFolder()
    {
        var starter = Starter();
        var record = Installed();

        starter.Remember(record);

        Assert.Null(StartAfterGrace(starter));

        var info = Assert.Single(started);
        var hub = OperatingSystem.IsWindows() ? [info.FileName, .. info.ArgumentList] : info.ArgumentList.TakeLast(4).ToList();

        Assert.Equal([record.ExecPath!, Path.Combine(Switchboard, "hub.js"), $"--home={home}", "--config=/home/me/.claude/switchboard"], hub);
        Assert.Equal("1", info.Environment["ELECTRON_RUN_AS_NODE"]);
    }

    [Fact]
    public void StartNow_HubMissing_StartsAtOnceWithoutTheGraceOrTheWaitBetweenStarts()
    {
        var starter = Starter();

        Assert.Equal(HubStarter.Never, starter.StartNow());
        Assert.Empty(started);

        starter.Remember(Installed());
        Assert.Null(starter.StartNow());
        Assert.Single(started);

        // The fake start returns no process, so none is running and another press starts again.
        Assert.Null(starter.StartNow());
        Assert.Equal(2, started.Count);
    }

    [Fact]
    public void Start_AgainWithin30Seconds_StartsNothingAndKeepsItsAnswer()
    {
        var starter = Starter();

        starter.Remember(Installed());
        StartAfterGrace(starter);
        now += TimeSpan.FromSeconds(29);

        Assert.Null(starter.Start());
        Assert.Single(started);

        now += TimeSpan.FromSeconds(2);
        starter.Start();
        Assert.Equal(2, started.Count);
    }

    [Fact]
    public void Start_HubMissingForLessThanTheGrace_StartsNothingAndAHubAnsweringRestartsTheGrace()
    {
        var starter = Starter();
        var record = Installed();

        starter.Remember(record);
        Assert.Null(starter.Start());
        now += HubStarter.Grace - TimeSpan.FromSeconds(1);
        Assert.Null(starter.Start());
        Assert.Empty(started);

        // A window's new hub answered, then went away again: the grace counts from the next missed attempt.
        starter.Remember(record);
        now += TimeSpan.FromSeconds(2);
        Assert.Null(starter.Start());
        Assert.Empty(started);

        now += HubStarter.Grace;
        starter.Start();
        Assert.Single(started);
    }

    [Fact]
    public void Start_RuntimeOrBundleGone_SaysWhichAndStartsNothing()
    {
        var starter = Starter();
        var record = Installed();

        starter.Remember(record);
        File.Delete(record.ExecPath!);

        Assert.Equal($"Switchboard could not start the hub: {record.ExecPath} is missing. Open VS Code once to start it.", StartAfterGrace(starter));

        File.WriteAllText(record.ExecPath!, "");
        File.Delete(Path.Combine(Switchboard, "hub.js"));
        now += HubStarter.Every;

        Assert.Equal($"Switchboard could not start the hub: {Path.Combine(Switchboard, "hub.js")} is missing. Open VS Code once to start it.", starter.Start());
        Assert.Empty(started);
    }

    [Fact]
    public void Start_ProcessFails_SaysWhy()
    {
        var starter = new HubStarter(Switchboard, () => now, (_) => throw new System.ComponentModel.Win32Exception("Permission denied"));


        starter.Remember(Installed());

        Assert.Equal("Switchboard could not start the hub: Permission denied", StartAfterGrace(starter));
    }

    [Fact]
    public async Task StartNow_RestartAfterTheLastHubExitedFails_SaysWhyAndCanBePressedAgain()
    {
        var starts = 0;
        var starter = new HubStarter(Switchboard, () => now, (_) =>
        {
            if (starts++ > 0)
            {
                throw new System.ComponentModel.Win32Exception("Permission denied");
            }

            return Process.Start(OperatingSystem.IsWindows() ? new ProcessStartInfo("cmd.exe", "/c exit 0") : new ProcessStartInfo("/bin/sh", "-c true"));
        });

        starter.Remember(Installed());
        Assert.Null(starter.StartNow());
        await starter.Launched!.WaitForExitAsync(TestContext.Current.CancellationToken);

        Assert.Equal("Switchboard could not start the hub: Permission denied", starter.StartNow());
        Assert.Equal("Switchboard could not start the hub: Permission denied", starter.StartNow());
        Assert.Null(starter.Launched);
    }

    [Fact]
    public void StartInfo_Linux_AppendsOutputToTheHubLogWithoutVsCodeVariables()
    {
        var launch = new HubStarter.Launch("/usr/share/code/code", "/home/me/.claude/switchboard");
        var environment = new Hashtable { ["HOME"] = "/home/me", ["ELECTRON_NO_ATTACH_CONSOLE"] = "1", ["VSCODE_PID"] = "7", ["NODE_OPTIONS"] = "--inspect" };

        var info = HubStarter.StartInfo(launch, "/home/me/.switchboard/hub.js", "/home/me/.switchboard", environment, windows: false, ["--idle-ms=5"]);

        Assert.Equal("/bin/sh", info.FileName);
        Assert.Equal(["-c", "log=$1; shift; exec \"$@\" >>\"$log\" 2>&1", "sh", Path.Combine("/home/me/.switchboard", "hub.log"), "/usr/share/code/code", "/home/me/.switchboard/hub.js", $"--home={Path.GetDirectoryName("/home/me/.switchboard")}", "--config=/home/me/.claude/switchboard", "--idle-ms=5"], info.ArgumentList);
        Assert.Equal(["ELECTRON_RUN_AS_NODE", "HOME"], info.Environment.Keys.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void StartInfo_Windows_StartsTheRuntimeDirectlyWithLiteralArguments()
    {
        var launch = new HubStarter.Launch(@"C:\Program Files\Microsoft VS Code\Code.exe", @"C:\Users\%USERNAME%\.claude\switchboard");

        var info = HubStarter.StartInfo(launch, @"C:\Users\me\.switchboard\hub.js", @"C:\Users\me\.switchboard", new Hashtable(), windows: true, []);

        Assert.Equal(@"C:\Program Files\Microsoft VS Code\Code.exe", info.FileName);
        Assert.Equal([@"C:\Users\me\.switchboard\hub.js", $"--home={Path.GetDirectoryName(@"C:\Users\me\.switchboard")}", @"--config=C:\Users\%USERNAME%\.claude\switchboard"], info.ArgumentList);
        Assert.True(info.CreateNoWindow);
    }

    [Fact]
    public async Task Start_HubExitsAtOnce_SaysSoWithTheLogInsteadOfStarting()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Runs /bin/false through /bin/sh.");

        var record = Installed() with { ExecPath = "/bin/false" };
        var starter = new HubStarter(Switchboard, () => now);

        starter.Remember(record);
        Assert.Null(StartAfterGrace(starter));
        await starter.Launched!.WaitForExitAsync(TestContext.Current.CancellationToken);

        Assert.Equal($"Switchboard's hub stopped as it started (exit code 1); see {Path.Combine(Switchboard, "hub.log")}.", starter.Start());
    }

    [Fact]
    public async Task Start_BuiltHubAndNode_StartsAHubThatAnswersWithItsRecordedToken()
    {
        var bundle = Repo() is { } repo ? Path.Combine(repo, "extensions", "switchboard", "dist", "hub.js") : null;
        var node = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator).Select((folder) => Path.Combine(folder, OperatingSystem.IsWindows() ? "node.exe" : "node")).FirstOrDefault(File.Exists);

        Assert.SkipWhen(bundle is null || !File.Exists(bundle) || node is null, "Needs the built hub bundle and Node.js on PATH.");

        Directory.CreateDirectory(Switchboard);
        File.Copy(bundle!, Path.Combine(Switchboard, "hub.js"));

        var config = Path.Combine(home, "config");

        // A hub installs its hooks into the operator's own Claude and Codex settings unless told not to (architecture.md § Hub lifecycle).
        Directory.CreateDirectory(config);
        File.WriteAllText(Path.Combine(config, "settings.json"), "{\"sessions\":{\"installHooks\":false}}");
        // No browser endpoint, so the test hub never takes the operator's fixed port, and Claude's, Codex's and the user profile's folders of its own.
        var environment = Environment.GetEnvironmentVariables();

        foreach (var name in new[] { "HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME" })
        {
            environment[name] = Path.Combine(home, "profile", name);
        }

        var starter = new HubStarter(Switchboard, () => now, extraArgs: ["--browser-port=0", "--idle-ms=60000"], environment: environment);

        starter.Remember(new HubRecord(1, "x", 1, config, node));
        Assert.Null(StartAfterGrace(starter));

        // The shell execs the runtime, so the process started is the hub; it is ended whatever the test finds.
        using var hub = starter.Launched!;

        try
        {
            HubRecord? record = null;

            for (var tries = 0; tries < 100 && record is null; tries++)
            {
                await Task.Delay(100, TestContext.Current.CancellationToken);
                record = HubRecord.Read(Switchboard);
            }

            Assert.NotNull(record);
            Assert.Equal(hub.Id, record.Pid);

            using var http = new HttpClient();
            using var request = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{record.Port}/status");

            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", record.Token);

            using var response = await http.SendAsync(request, TestContext.Current.CancellationToken);
            var identity = JsonDocument.Parse(await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken)).RootElement;

            Assert.True(response.IsSuccessStatusCode);
            Assert.Equal(record.Pid, identity.GetProperty("pid").GetInt32());
            Assert.Equal(config, record.ConfigDir);

            // On Windows the dock starts the hub unlogged (HubStarter.StartInfo).
            if (!OperatingSystem.IsWindows())
            {
                Assert.Contains("listening", File.ReadAllText(Path.Combine(Switchboard, "hub.log")), StringComparison.OrdinalIgnoreCase);
            }
        }
        finally
        {
            hub.Kill();
            await hub.WaitForExitAsync(CancellationToken.None);
        }
    }

    /// <summary>The repository root, above the test's output folder.</summary>
    static string? Repo()
    {
        for (var folder = new DirectoryInfo(AppContext.BaseDirectory); folder is not null; folder = folder.Parent)
        {
            if (Directory.Exists(Path.Combine(folder.FullName, "extensions", "switchboard")))
            {
                return folder.FullName;
            }
        }

        return null;
    }
}
