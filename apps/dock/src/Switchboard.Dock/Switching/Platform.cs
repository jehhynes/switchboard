namespace Switchboard.Dock.Switching;

/// <summary>Finding and showing windows. Only Windows is implemented (PRD R71).</summary>
public interface IWindows
{
    /// <summary>The visible top-level item window whose title names <paramref name="name"/> (<c>DockWindow.NameOf</c>), or 0.</summary>
    nint Find(string name);

    /// <summary>Restores the window if minimized, maximizes it and brings it to the front; true when it is then the foreground window.</summary>
    bool Show(nint window);

    void OpenUrl(string url);

    /// <summary>The VS Code window nearest the front, item windows included, or 0 when none is open.</summary>
    nint FindVsCode();
}

/// <summary>The VS Code installation that item windows open in.</summary>
public interface IVsCode
{
    /// <summary>Opens a workspace file, as <c>code &lt;file&gt;</c>, in the profile VS Code gives it; throws when VS Code cannot be started.</summary>
    void Open(string workspaceFile);
}
