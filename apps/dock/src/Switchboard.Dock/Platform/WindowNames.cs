namespace Switchboard.Dock.Platform;

/// <summary>The item window name of each open window, by handle.</summary>
public sealed class WindowNames
{
    readonly Dictionary<nint, string> names = [];

    /// <summary>Keeps the window's name, or forgets the window when its title no longer names an item window.</summary>
    public void Set(nint window, string? name)
    {
        if (name is null)
        {
            names.Remove(window);
        }
        else
        {
            names[window] = name;
        }
    }

    /// <summary>Forgets a destroyed window and returns its name, or null when it was not an item window.</summary>
    public string? Destroyed(nint window) => names.Remove(window, out var name) ? name : null;
}
