using System.Diagnostics;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Switching;

namespace Switchboard.Dock.Platform;

/// <summary>
/// Item windows as the hub reports them, for a desktop where the dock cannot see other apps' windows, such as GNOME on Wayland (architecture.md
/// § Dock). A window is found while its VS Code window is connected to the hub, and shown by opening its workspace file again, which VS Code answers
/// by focusing that window. Whether it came to the front is not known.
/// </summary>
public sealed class HubWindows(IVsCode vsCode) : IWindows
{
    public bool Raises => false;

    /// <summary>The handle <see cref="FindVsCode"/> returns while any VS Code window is connected; it names no window.</summary>
    public const nint AnyWindow = -1;

    // Each workspace file ever found, so a handle names the same file for the dock's lifetime.
    readonly List<string> files = [];
    OpenWindows windows = new([], null, 0);
    Action<string>? foreground;
    Action<string>? closed;

    /// <summary>Takes the windows of a new view; reports the item window that came to the front and each item window that closed.</summary>
    public void Update(OpenWindows? next)
    {
        next ??= new OpenWindows([], null, 0);

        var before = windows;

        windows = next;

        foreach (var file in before.Open.Except(next.Open, StringComparer.Ordinal))
        {
            closed?.Invoke(NameOf(file));
        }

        if (next.Front is { } front && front != before.Front)
        {
            foreground?.Invoke(NameOf(front));
        }
    }

    /// <summary>Calls <paramref name="changed"/> with the name of each item window that comes to the front.</summary>
    public void WatchForeground(Action<string> changed) => foreground = changed;

    /// <summary>Calls <paramref name="closed"/> with the name of each item window that closes.</summary>
    public void WatchClosed(Action<string> closed) => this.closed = closed;

    public nint Find(string name)
    {
        if (windows.Open.FirstOrDefault((file) => NameOf(file) == name) is not { } file)
        {
            return 0;
        }

        if (!files.Contains(file))
        {
            files.Add(file);
        }

        return files.IndexOf(file) + 1;
    }

    /// <summary>Opens the window's workspace file, which focuses its window; for <see cref="AnyWindow"/>, does nothing, so the next VS Code window to gain focus runs the command.</summary>
    public bool Show(nint window)
    {
        if (window > 0 && window <= files.Count)
        {
            vsCode.Open(files[(int)window - 1]);
        }

        return true;
    }

    public void OpenUrl(string url) => Process.Start(new ProcessStartInfo(url) { UseShellExecute = true })?.Dispose();

    public nint FindVsCode() => windows.Count > 0 ? AnyWindow : 0;

    /// <summary>
    /// The window name in a workspace file's name, <c>&lt;Switchboard home&gt;/windows/&lt;name&gt;.code-workspace</c>. Either separator ends the folder,
    /// because a name has neither.
    /// </summary>
    static string NameOf(string file) => Path.GetFileNameWithoutExtension(file[(file.LastIndexOfAny(['\\', '/']) + 1)..]);
}
