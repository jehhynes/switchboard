using Switchboard.Dock.Hub;

namespace Switchboard.Dock.Switching;

/// <summary>Finding and showing windows: Win32 on Windows, the hub's view of VS Code's windows on Linux (PRD R71).</summary>
public interface IWindows
{
    /// <summary>Whether <see cref="Show"/> brings a window to the front itself; false where only VS Code can, and only for an item window.</summary>
    bool Raises => true;

    /// <summary>The visible top-level item window whose title names <paramref name="name"/> (<c>DockWindow.NameOf</c>), or 0.</summary>
    nint Find(string name);

    /// <summary>Restores the window if minimized, maximizes it and brings it to the front; true when it is then the foreground window.</summary>
    bool Show(nint window);

    void OpenUrl(string url);

    /// <summary>The VS Code window nearest the front, item windows included, or 0 when none is open.</summary>
    nint FindVsCode();

    /// <summary>Whether <see cref="FindTerminal"/> can find terminal windows; false without the GNOME Shell extension (PRD R71).</summary>
    bool FindsTerminals => false;

    /// <summary>The terminal window whose title names <paramref name="name"/> as <c>sb:&lt;name&gt;</c>, or 0.</summary>
    nint FindTerminal(string name) => 0;

    /// <summary>Whether <see cref="FindPage"/> can find the installed web page's window; false on Linux, whose shell lists only VS Code and terminals.</summary>
    bool FindsPages => false;

    /// <summary>The visible browser window whose title holds <c>[sb-show &lt;marker&gt;]</c>, the installed web page showing a dock click, or 0.</summary>
    nint FindPage(string marker) => 0;

    /// <summary>Restores the window if minimized and brings it to the front, leaving its size and place; true when it is then the foreground window.</summary>
    bool Raise(nint window) => false;
}

/// <summary>The terminal app sessions open in with <c>dock.openVSCode: review</c> (PRD R71): Ptyxis on Linux, Windows Terminal on Windows.</summary>
public interface ITerminal
{
    /// <summary>Opens a new window running the session's CLI; throws when the terminal cannot be started.</summary>
    void Open(DockTerminal terminal);
}

/// <summary>The VS Code installation that item windows open in.</summary>
public interface IVsCode
{
    /// <summary>
    /// Opens a workspace file or a folder, as <c>code &lt;path&gt;</c>, in the profile VS Code gives it, which focuses a window already on it; throws when VS
    /// Code cannot be started.
    /// </summary>
    void Open(string workspaceFile);
}
