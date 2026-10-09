using Switchboard.Dock.Hub;
using Switchboard.Dock.Switching;

namespace Switchboard.Dock.Tests;

public sealed class WorkspaceFileTests
{
    static readonly DockWindow Window = new("gh-107-widgets", "sb:gh-107-widgets · Fix ${x} badge", ["D:/git/widgets", "D:/git/widgets/.worktrees/107-fix"]);

    [Fact]
    public void Content_Window_ListsFoldersAndStartsTheTitleWithThePrefix()
    {
        var expected = """
            {
              "folders": [
                {
                  "path": "D:/git/widgets"
                },
                {
                  "path": "D:/git/widgets/.worktrees/107-fix"
                }
              ],
              "settings": {
                "window.title": "sb:gh-107-widgets \u00B7 Fix $ {x} badge \u00B7 ${activeEditorShort}"
              }
            }
            """;

        Assert.Equal(expected.ReplaceLineEndings() + Environment.NewLine, WorkspaceFile.Content(Window).ReplaceLineEndings());
    }

    [Fact]
    public void Write_SameWindowTwice_LeavesTheFileUnchanged()
    {
        var home = Fixtures.TempFolder();
        var path = WorkspaceFile.Write(home, Window);
        var written = File.GetLastWriteTimeUtc(path);

        File.SetLastWriteTimeUtc(path, written.AddHours(-1));
        WorkspaceFile.Write(home, Window);

        Assert.Equal(Path.Combine(home, "windows", "gh-107-widgets.code-workspace"), path);
        Assert.Equal(written.AddHours(-1), File.GetLastWriteTimeUtc(path));
    }

    [Fact]
    public void Write_ChangedTitle_RewritesTheFile()
    {
        var home = Fixtures.TempFolder();
        var path = WorkspaceFile.Write(home, Window);

        WorkspaceFile.Write(home, Window with { Title = "sb:gh-107-widgets · Renamed" });

        Assert.Contains("Renamed", File.ReadAllText(path));
    }
}
