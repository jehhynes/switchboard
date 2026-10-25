namespace Switchboard.Dock.Platform;

/// <summary>The X11 calls the dock makes as an X11 dock window (<see cref="X11Dock"/>); tests give a fake, as no X display is used.</summary>
internal interface IX11Edge : IDisposable
{
    /// <summary>Reserves <paramref name="strip"/>, in X screen pixels, at <paramref name="edge"/>.</summary>
    void Reserve(DockEdge edge, PixelRect strip);

    /// <summary>Reserves nothing; other windows may then cover the dock's strip.</summary>
    void Release();

    /// <summary>Whether the window can be clipped to its sliver; auto-hide needs it.</summary>
    bool CanShape { get; }

    /// <summary>Limits the window's drawing and input to the <paramref name="width"/> pixels at its <paramref name="edge"/>.</summary>
    void ClipToSliver(DockEdge edge, int width);

    /// <summary>Gives the window its whole rectangle again.</summary>
    void Unclip();

    /// <summary>Whether the pointer is over the dock or a window it owns, or one of them has the keyboard focus.</summary>
    bool KeptOpen();

    /// <summary>Each monitor's work area on the current workspace; empty when the window manager does not give them.</summary>
    IReadOnlyList<PixelRect> WorkAreas();

    /// <summary>The pointer on the X screen; null when it is on another X screen.</summary>
    Avalonia.PixelPoint? Pointer();

    /// <summary>Gives the window the keyboard focus.</summary>
    void Focus();

    /// <summary>Keeps the window below others, or above them again.</summary>
    void Below(bool below);
}
