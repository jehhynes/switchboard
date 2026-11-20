using System.Collections;
using System.Diagnostics;
using System.Text.Json;

namespace Switchboard.Dock.Hub;

/// <summary>
/// Starts the hub when none runs, so the dock works with no VS Code window open (PRD R71). It runs the hub bundle a VS Code window copied to the
/// Switchboard home, with the runtime and config folder of the last hub the dock connected to, which it keeps in <c>dock-hub.json</c>; a VS Code
/// window still replaces a hub whose build or config folder differs (architecture.md § Hub lifecycle).
/// </summary>
public sealed class HubStarter(string switchboardHome, Func<DateTime>? now = null, Func<ProcessStartInfo, Process?>? start = null, IReadOnlyList<string>? extraArgs = null, IDictionary? environment = null)
{
    /// <summary>The shortest time between two starts, so a hub that cannot start is not started on every retry.</summary>
    public static readonly TimeSpan Every = TimeSpan.FromSeconds(30);

    /// <summary>How long no hub answers before the dock starts one, so a VS Code window replacing the hub, such as for a new config folder, wins.</summary>
    public static readonly TimeSpan Grace = TimeSpan.FromSeconds(5);

    public const string Never = "Switchboard is not running. Open VS Code once to start it; after that the dock starts it.";

    readonly Func<DateTime> clock = now ?? (() => DateTime.UtcNow);
    readonly Func<ProcessStartInfo, Process?> run = start ?? Process.Start;
    DateTime? started;
    DateTime? missingSince;
    string? problem;
    // The hub process last started, so a hub that exits at once is reported rather than shown as starting.
    Process? launched;

    /// <summary>The hub process last started, or null.</summary>
    public Process? Launched => launched;

    /// <summary>The runtime and config folder a hub was started with.</summary>
    public sealed record Launch(string ExecPath, string ConfigDir);

    string LaunchFile => Path.Combine(switchboardHome, "dock-hub.json");

    /// <summary>Keeps the runtime and config folder of a hub the dock connected to; a record from an older hub, without them, changes nothing.</summary>
    public void Remember(HubRecord record)
    {
        missingSince = null;

        if (string.IsNullOrEmpty(record.ExecPath) || string.IsNullOrEmpty(record.ConfigDir))
        {
            return;
        }

        var launch = new Launch(record.ExecPath, record.ConfigDir);

        if (Saved() == launch)
        {
            return;
        }

        try
        {
            File.WriteAllText(LaunchFile, JsonSerializer.Serialize(launch, Options));
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // The next connection tries again; until then the dock starts the hub it remembered before.
        }
    }

    /// <summary>
    /// Starts a hub once none has answered for <see cref="Grace"/>, unless one was started less than <see cref="Every"/> ago; returns what the
    /// dock says while no hub runs: why it could not start one, or null while one is starting or about to be.
    /// </summary>
    public string? Start()
    {
        lock (gate)
        {
            return StartAfterGrace();
        }
    }

    /// <summary>
    /// Starts a hub at once, for the dock's Start hub button: unless the hub last started is still running, it skips the grace and the time
    /// between starts; returns why it could not start one, or null.
    /// </summary>
    public string? StartNow()
    {
        lock (gate)
        {
            if (launched is { HasExited: false })
            {
                return null;
            }

            missingSince ??= clock();
            started = clock();
            problem = Try();

            return problem;
        }
    }

    readonly Lock gate = new();

    string? StartAfterGrace()
    {
        missingSince ??= clock();

        if (clock() - missingSince < Grace)
        {
            return problem;
        }

        if (launched is { HasExited: true } ended)
        {
            problem = $"Switchboard's hub stopped as it started (exit code {ended.ExitCode}); see {Path.Combine(switchboardHome, "hub.log")}.";
            ended.Dispose();
            launched = null;
        }

        if (started is { } at && clock() - at < Every)
        {
            return problem;
        }

        started = clock();
        problem = Try();

        return problem;
    }

    string? Try()
    {
        if (Saved() is not { } launch)
        {
            return Never;
        }

        var bundle = Path.Combine(switchboardHome, "hub.js");

        foreach (var path in new[] { launch.ExecPath, bundle })
        {
            if (!File.Exists(path))
            {
                return $"Switchboard could not start the hub: {path} is missing. Open VS Code once to start it.";
            }
        }

        try
        {
            // Cleared before the start, so a start that throws leaves no disposed process for the next check to read.
            var previous = launched;

            launched = null;
            previous?.Dispose();
            launched = run(StartInfo(launch, bundle, switchboardHome, environment ?? Environment.GetEnvironmentVariables(), OperatingSystem.IsWindows(), extraArgs ?? []));
            return null;
        }
        catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception or IOException)
        {
            return $"Switchboard could not start the hub: {error.Message}";
        }
    }

    Launch? Saved()
    {
        try
        {
            return JsonSerializer.Deserialize<Launch>(File.ReadAllText(LaunchFile), Options) is { ExecPath.Length: > 0, ConfigDir.Length: > 0 } launch ? launch : null;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

    /// <summary>
    /// The hub as a VS Code window starts it (<c>hubProcess.ts</c>): the runtime with <c>ELECTRON_RUN_AS_NODE=1</c>, which makes VS Code's executable
    /// run as Node, on the bundle with <c>--home</c> and <c>--config</c>, without VS Code's variables or <c>NODE_OPTIONS</c>. Elsewhere than Windows
    /// its output is appended to <c>hub.log</c> through the shell, which <c>exec</c>s it, so the hub keeps writing it after the dock exits. On
    /// Windows it starts directly, unlogged, because <c>cmd.exe</c> would expand a <c>%NAME%</c> in a path.
    /// </summary>
    public static ProcessStartInfo StartInfo(Launch launch, string bundle, string switchboardHome, IDictionary environment, bool windows, IReadOnlyList<string> extraArgs)
    {
        var home = Path.GetDirectoryName(Path.TrimEndingDirectorySeparator(switchboardHome)) ?? switchboardHome;
        var log = Path.Combine(switchboardHome, "hub.log");
        string[] hub = [launch.ExecPath, bundle, $"--home={home}", $"--config={launch.ConfigDir}", .. extraArgs];

        var info = windows ? new ProcessStartInfo(hub[0]) { CreateNoWindow = true } : new ProcessStartInfo("/bin/sh");

        foreach (var argument in windows ? hub.Skip(1) : new[] { "-c", "log=$1; shift; exec \"$@\" >>\"$log\" 2>&1", "sh", log }.Concat(hub))
        {
            info.ArgumentList.Add(argument);
        }

        info.UseShellExecute = false;
        info.Environment.Clear();

        foreach (DictionaryEntry entry in environment)
        {
            if (entry.Key is string key && entry.Value is string value && !key.StartsWith("ELECTRON_", StringComparison.OrdinalIgnoreCase) && !key.StartsWith("VSCODE_", StringComparison.OrdinalIgnoreCase) && !key.Equals("NODE_OPTIONS", StringComparison.OrdinalIgnoreCase))
            {
                info.Environment[key] = value;
            }
        }

        info.Environment["ELECTRON_RUN_AS_NODE"] = "1";

        return info;
    }
}
