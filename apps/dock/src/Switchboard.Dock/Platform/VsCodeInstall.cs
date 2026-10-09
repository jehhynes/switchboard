using System.Diagnostics;
using Switchboard.Dock.Switching;

namespace Switchboard.Dock.Platform;

/// <summary>The VS Code that <c>code</c> on PATH runs.</summary>
public sealed class VsCodeInstall : IVsCode
{
    public void Open(string workspaceFile)
    {
        var start = new ProcessStartInfo(Executable()) { UseShellExecute = false };

        start.ArgumentList.Add(workspaceFile);

        // A dock started from a VS Code terminal would pass these on and make Code.exe run as Node.
        foreach (var name in start.Environment.Keys.Where((name) => name.StartsWith("ELECTRON_", StringComparison.OrdinalIgnoreCase) || name.StartsWith("VSCODE_", StringComparison.OrdinalIgnoreCase)).ToList())
        {
            start.Environment.Remove(name);
        }

        Process.Start(start)?.Dispose();
    }

    /// <summary><c>Code.exe</c> beside the <c>bin\code.cmd</c> found on PATH, else in the per-user install folder.</summary>
    static string Executable()
    {
        var onPath = (Environment.GetEnvironmentVariable("PATH") ?? "")
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Select((folder) => Path.Combine(folder, "code.cmd"))
            .FirstOrDefault(File.Exists);
        var candidates = new[]
        {
            onPath is null ? null : Path.GetFullPath(Path.Combine(Path.GetDirectoryName(onPath)!, "..", "Code.exe")),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Microsoft VS Code", "Code.exe"),
        };

        return candidates.FirstOrDefault((path) => path is not null && File.Exists(path)) ?? throw new FileNotFoundException("Code.exe was not found beside code on PATH.");
    }
}
