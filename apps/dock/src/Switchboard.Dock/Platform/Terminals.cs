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
    /// What Ptyxis runs: a new window with the title, which the CLI's own title does not replace (mechanics M47), the session's directory and its
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
    /// The dock's environment for the CLI: without VS Code's variables and the markers of a Claude Code session the dock may have been started from,
    /// which would make Claude turn off transcripts or target a VS Code window (mechanics M47), keeping the operator's own Claude Code settings such
    /// as <c>CLAUDE_CODE_USE_BEDROCK</c>, as the hub's sessions do; and with an absolute executable's folder first on PATH, so an npm launcher finds
    /// its Node.js.
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
        SessionMarkers.Contains(key) || new[] { "ELECTRON_", "VSCODE_", "CLAUDE_CODE_MESSAGING_" }.Any((prefix) => key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase));

    /// <summary>What Claude Code sets in the processes a session runs, read from a session's environment (Claude Code 2.1.305).</summary>
    static readonly HashSet<string> SessionMarkers = new(
        ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_SESSION_ATTENDED"],
        StringComparer.OrdinalIgnoreCase);
}

/// <summary>Opens a session's terminal in a new Ptyxis window.</summary>
public sealed class PtyxisTerminal : ITerminal
{
    public void Open(DockTerminal terminal) => Process.Start(Terminals.Ptyxis(terminal, Environment.GetEnvironmentVariables()))?.Dispose();
}

/// <summary>Opens a session's terminal in a new Windows Terminal window (mechanics M47).</summary>
public sealed class WindowsTerminal : ITerminal
{
    public void Open(DockTerminal terminal) => Process.Start(Terminals.WindowsTerminal(terminal, Environment.GetEnvironmentVariables()))?.Dispose();
}
