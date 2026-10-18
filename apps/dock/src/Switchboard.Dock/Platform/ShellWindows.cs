using System.Diagnostics;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Switching;

namespace Switchboard.Dock.Platform;

/// <summary>The Switchboard GNOME Shell extension's <c>switchboard.Shell</c> D-Bus service (architecture.md § Dock); each call throws <see cref="ShellException"/> when it fails.</summary>
public interface IShell
{
    /// <summary>VS Code's top-level windows, front first.</summary>
    IReadOnlyList<ShellWindow> Windows();

    /// <summary>Brings the window forward on its workspace, unminimized and maximized; false when no window has the ID.</summary>
    bool Activate(ulong id);

    /// <summary>Whether a full-screen window covers the primary monitor.</summary>
    bool FullScreen();

    /// <summary>Calls <paramref name="changed"/>, on another thread, each time a full-screen window starts or stops covering the primary monitor.</summary>
    void WatchFullScreen(Action<bool> changed);
}

/// <summary>A window as the shell names it: Mutter's window ID and its title.</summary>
public readonly record struct ShellWindow(ulong Id, string Title);

/// <summary>The shell's service is missing or failed, such as when the extension is disabled.</summary>
public sealed class ShellException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>
/// Item windows found and brought forward by GNOME Shell through the Switchboard extension, where the dock cannot see other apps' windows itself
/// (architecture.md § Dock). A window is named by its Mutter window ID. While a call fails, such as after the extension is turned off,
/// <paramref name="fallback"/> answers instead, and a window it found is shown by it.
/// </summary>
public sealed class ShellWindows(IShell shell, IWindows fallback) : IWindows
{
    // The fallback's handles under negative keys of their own, because they could equal a Mutter window ID, which is positive.
    readonly List<nint> fallbackFound = [];
    // Whether the last find fell back, so Run knows whether Show brings the window forward.
    bool fellBack;

    public bool Raises => !fellBack || fallback.Raises;

    public nint Find(string name) => Answer((windows) => windows.FirstOrDefault((window) => DockWindow.NameOf(window.Title) == name).Id, () => fallback.Find(name));

    public bool Show(nint window)
    {
        if (window < 0)
        {
            var index = (int)(-window - 1);

            return index < fallbackFound.Count && fallback.Show(fallbackFound[index]);
        }

        try
        {
            return shell.Activate((ulong)window);
        }
        catch (ShellException)
        {
            return false;
        }
    }

    public void OpenUrl(string url) => Process.Start(new ProcessStartInfo(url) { UseShellExecute = true })?.Dispose();

    public nint FindVsCode() => Answer((windows) => windows.FirstOrDefault().Id, fallback.FindVsCode);

    nint Answer(Func<IReadOnlyList<ShellWindow>, ulong> pick, Func<nint> fallBack)
    {
        try
        {
            var found = (nint)pick(shell.Windows());

            fellBack = false;
            return found;
        }
        catch (ShellException)
        {
            var found = fallBack();

            fellBack = true;

            if (found == 0)
            {
                return 0;
            }

            if (!fallbackFound.Contains(found))
            {
                fallbackFound.Add(found);
            }

            return -(fallbackFound.IndexOf(found) + 1);
        }
    }
}
