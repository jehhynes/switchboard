using System.Collections;
using System.Diagnostics;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Switching;

namespace Switchboard.Dock.Platform;

/// <summary>
/// The terminal windows sessions open in with <c>dock.openVSCode: review</c> (PRD R71): Ptyxis on Linux and Windows Terminal on Windows. Each runs
/// the session's CLI in a new window titled <see cref="DockTerminal.Title"/>, whose <c>sb:&lt;name&gt;</c> the dock finds it by.
/// </summary>
public static class Terminals
{
    /// <summary>The terminal of this platform.</summary>
    public static ITerminal ForPlatform() => OperatingSystem.IsWindows() ? new WindowsTerminal() : new PtyxisTerminal();

    /// <summary>
    /// What Ptyxis runs: a new window with the title, which the CLI's own title does not replace (mechanics M46), the session's directory and its
    /// CLI.
    /// </summary>
    public static ProcessStartInfo Ptyxis(DockTerminal terminal, IDictionary environment) =>
        Start("ptyxis", ["--new-window", "-T", terminal.Title, "-d", terminal.Cwd, "--"], terminal, environment);

    /// <summary>What Windows Terminal runs: a new window with the title, which the CLI may not change, the session's directory and its CLI.</summary>
    public static ProcessStartInfo WindowsTerminal(DockTerminal terminal, IDictionary environment) =>
        Start("wt.exe", ["-w", "new", "--title", terminal.Title, "--suppressApplicationTitle", "-d", terminal.Cwd, "--"], terminal, environment);

    static ProcessStartInfo Start(string app, IEnumerable<string> options, DockTerminal terminal, IDictionary environment)
    {
        var executable = terminal.Executable ?? terminal.Provider;
        var start = new ProcessStartInfo(app) { UseShellExecute = false, WorkingDirectory = terminal.Cwd };

        foreach (var argument in options.Append(executable).Concat(terminal.Args))
        {
            start.ArgumentList.Add(argument);
        }

        start.Environment.Clear();

        foreach (var (key, value) in CliEnvironment(environment, executable))
        {
            start.Environment[key] = value;
        }

        return start;
    }

    /// <summary>
    /// The dock's environment for the CLI: without VS Code's and a Claude Code session's variables, which would make Claude turn off transcripts or
    /// target a VS Code window (mechanics M46), and with an absolute executable's folder first on PATH, so an npm launcher finds its Node.js.
    /// </summary>
    public static Dictionary<string, string> CliEnvironment(IDictionary environment, string executable)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (DictionaryEntry entry in environment)
        {
            if (entry.Key is string key && entry.Value is string value && !Dropped(key))
            {
                result[key] = value;
            }
        }

        if (Path.IsPathRooted(executable) && Path.GetDirectoryName(executable) is { Length: > 0 } folder)
        {
            var path = result.Keys.FirstOrDefault((key) => key.Equals("PATH", StringComparison.OrdinalIgnoreCase)) ?? "PATH";

            result[path] = result.TryGetValue(path, out var current) && current != "" ? $"{folder}{Path.PathSeparator}{current}" : folder;
        }

        return result;
    }

    static bool Dropped(string key) =>
        key.Equals("CLAUDECODE", StringComparison.OrdinalIgnoreCase)
        || new[] { "CLAUDE_CODE_", "ELECTRON_", "VSCODE_" }.Any((prefix) => key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase));
}

/// <summary>Opens a session's terminal in a new Ptyxis window.</summary>
public sealed class PtyxisTerminal : ITerminal
{
    public void Open(DockTerminal terminal) => Process.Start(Terminals.Ptyxis(terminal, Environment.GetEnvironmentVariables()))?.Dispose();
}

/// <summary>Opens a session's terminal in a new Windows Terminal window; not verified on Windows yet (mechanics M46).</summary>
public sealed class WindowsTerminal : ITerminal
{
    public void Open(DockTerminal terminal) => Process.Start(Terminals.WindowsTerminal(terminal, Environment.GetEnvironmentVariables()))?.Dispose();
}
