using System.Text.Json;
using System.Text.Json.Nodes;
using Switchboard.Dock.Hub;

namespace Switchboard.Dock.Switching;

/// <summary>The <c>.code-workspace</c> file of an item window, under <c>&lt;Switchboard home&gt;/windows</c> (PRD R71).</summary>
public static class WorkspaceFile
{
    public static string PathOf(string switchboardHome, DockWindow window) => Path.Combine(switchboardHome, "windows", $"{window.Name}.code-workspace");

    /// <summary>
    /// The file's text: the folders, and a <c>window.title</c> that starts with the window's title prefix and the ticket title. It leaves out
    /// <c>${dirty}</c>, which would put a mark before the prefix, and breaks a <c>${</c> in the ticket title, which VS Code would read as a variable.
    /// </summary>
    public static string Content(DockWindow window)
    {
        var folders = new JsonArray(window.Folders.Select((folder) => (JsonNode)new JsonObject { ["path"] = folder }).ToArray());
        var title = $"{window.Title.Replace("${", "$ {")} · ${{activeEditorShort}}";
        var workspace = new JsonObject { ["folders"] = folders, ["settings"] = new JsonObject { ["window.title"] = title } };

        return workspace.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine;
    }

    /// <summary>Writes the file when its text differs, because VS Code applies any change to an open window, and returns its path.</summary>
    public static string Write(string switchboardHome, DockWindow window)
    {
        var path = PathOf(switchboardHome, window);
        var content = Content(window);

        Directory.CreateDirectory(Path.GetDirectoryName(path)!);

        if (!File.Exists(path) || File.ReadAllText(path) != content)
        {
            File.WriteAllText(path, content);
        }

        return path;
    }
}
