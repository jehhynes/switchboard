namespace Switchboard.Dock.Switching;

/// <summary>Copy (PRD R60): the drafted text as the operator pastes it.</summary>
public static class Paste
{
    /// <summary>The file's text as it is on disk now, without a byte order mark or trailing whitespace, as the panel's Copy reads it.</summary>
    public static string Read(string file) => File.ReadAllText(file).TrimStart('\uFEFF').TrimEnd();
}
