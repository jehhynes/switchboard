using System.Diagnostics;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Switching;

namespace Switchboard.Dock.Platform;

/// <summary>The Switchboard GNOME Shell extension's <c>switchboard.Shell</c> D-Bus service (architecture.md § Dock); each call throws <see cref="ShellException"/> when it fails.</summary>
public interface IShell
{
    /// <summary>VS Code's top-level windows, front first.</summary>
    IReadOnlyList<ShellWindow> Windows();

    /// <summary>
    /// Brings the window forward on its workspace, unminimized and maximized, on the monitor named by <paramref name="monitor"/>, a connector, or
    /// where it is when that is empty or unknown; false when no window has the ID.
    /// </summary>
    bool Activate(ulong id, string monitor);

    /// <summary>The monitors a full-screen window covers, by connector, which is the monitor's RandR name under XWayland.</summary>
    IReadOnlyList<string> FullScreen();

    /// <summary>Calls <paramref name="changed"/>, on another thread, with the monitors a full-screen window covers each time they change.</summary>
    void WatchFullScreen(Action<IReadOnlyList<string>> changed);

    /// <summary>Ptyxis's top-level windows, front first; an extension older than terminals throws (PRD R71).</summary>
    IReadOnlyList<ShellWindow> Terminals() => throw new ShellException("The GNOME Shell extension lists no terminals.");

    /// <summary>
    /// Opens an http or https URL in the default browser, which the shell lets take the focus (mechanics M54); false for any other URL, and an
    /// extension older than this method throws.
    /// </summary>
    bool OpenUrl(string url) => throw new ShellException("The GNOME Shell extension opens no URLs.");

    /// <summary>Calls <paramref name="focused"/>, on another thread, with the title of each terminal window that gains the focus.</summary>
    void WatchTerminalFocused(Action<string> focused)
    {
    }

    /// <summary>
    /// Calls <paramref name="left"/>, on another thread, each time the focus moves from a terminal window to a window that is not one, or to none;
    /// an extension older than this signal never calls it.
    /// </summary>
    void WatchTerminalUnfocused(Action left)
    {
    }
}

/// <summary>A window as the shell names it: Mutter's window ID and its title.</summary>
public readonly record struct ShellWindow(ulong Id, string Title);

/// <summary>The shell's service is missing or failed, such as when the extension is disabled.</summary>
public class ShellException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>The shell did not answer in time; it may still carry out the call.</summary>
public sealed class ShellTimeoutException(string message) : ShellException(message);

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

    /// <summary>The connector of the monitor the dock is on, where an item window is maximized; empty leaves the window on its monitor.</summary>
    public string Monitor { get; set; } = "";

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
            return shell.Activate((ulong)window, Monitor);
        }
        catch (ShellException)
        {
            return false;
        }
    }

    /// <summary>
    /// Opens the URL through the shell, so the browser comes forward; when the shell does not open it, the fallback opens it, and GNOME only says
    /// the browser is ready. A shell that does not answer in time may still open it, so the fallback does not, and the call throws.
    /// </summary>
    public void OpenUrl(string url)
    {
        try
        {
            if (shell.OpenUrl(url))
            {
                return;
            }
        }
        catch (ShellTimeoutException error)
        {
            throw new InvalidOperationException(error.Message, error);
        }
        catch (ShellException)
        {
        }

        fallback.OpenUrl(url);
    }

    public nint FindVsCode() => Answer((windows) => windows.FirstOrDefault().Id, fallback.FindVsCode);

    /// <summary>Whether the extension lists terminals; an older one, or none, does not, so a click opens no terminal it could not find again.</summary>
    public bool FindsTerminals
    {
        get
        {
            try
            {
                shell.Terminals();
                return true;
            }
            catch (ShellException)
            {
                return false;
            }
        }
    }

    public nint FindTerminal(string name)
    {
        try
        {
            return (nint)shell.Terminals().FirstOrDefault((window) => DockWindow.NameOf(window.Title) == name).Id;
        }
        catch (ShellException)
        {
            return 0;
        }
    }

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
