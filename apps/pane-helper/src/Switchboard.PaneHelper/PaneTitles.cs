using System.Text.RegularExpressions;

namespace Switchboard.PaneHelper;

/// <summary>A top-level Chrome window as the search sees it, front first.</summary>
public sealed record ChromeWindow(nint Handle, uint Process, string Title, bool Visible, bool Owned, string? AppId);

/// <summary>
/// How the helper tells the extension's pane window and the installed page's window (architecture.md § Pane helper), as pure tests and choices:
/// the marker when a title has it, else the title the window always has, since Chrome may leave the marker out (mechanics M103), and never a
/// window it cannot tell apart from another.
/// </summary>
public static partial class PaneTitles
{
    /// <summary>The installed page's app name, its manifest's <c>name</c> (packages/web), which Chrome may show as an app window's title.</summary>
    public const string PageAppName = "Switchboard";

    /// <summary>The pane window's title while its marker tab is in front with this marker: <c>Switchboard pane &lt;marker&gt; - &lt;browser&gt;</c>.</summary>
    public static bool PaneMarked(string title, string marker) => title.Contains($"Switchboard pane {marker}", StringComparison.Ordinal);

    /// <summary>
    /// The pane window's title with any marker or none: an extension that loaded the marker page in a form its script does not read, or an earlier
    /// marker's, still titles its window <c>Switchboard pane</c>.
    /// </summary>
    public static bool PaneAny(string title) => AnyPane().IsMatch(title);

    /// <summary>The page's title with this marker, which Chrome shows in some versions' app window titles.</summary>
    public static bool PageMarked(string title, string marker) => title.Contains($"[sb-pane {marker}]", StringComparison.Ordinal);

    /// <summary>
    /// The page's window by its title alone: the app's name (<c>Switchboard</c>), the page's own title (<c>Switchboard</c> or <c>(2) Switchboard</c>,
    /// with its markers), either after <c>Switchboard - </c> as Chrome titles some app windows, or <c>127.0.0.1_/page/</c> for an <c>--app</c>
    /// window. A normal browser window's title ends in the browser's name, and another app's is its own.
    /// </summary>
    public static bool PageNamed(string title) => PageTitle().IsMatch(title) || AppTitle().IsMatch(title);

    /// <summary>
    /// The page's window: the front one whose title holds the marker, else, in the pane window's browser process, the front one named as the page
    /// (several are logged by the caller); unowned and not the pane.
    /// </summary>
    public static ChromeWindow? PickPage(IReadOnlyList<ChromeWindow> windows, string marker, ChromeWindow? pane)
    {
        bool Candidate(ChromeWindow window) => window.Visible && !window.Owned && window.Handle != pane?.Handle;

        return windows.FirstOrDefault((window) => Candidate(window) && PageMarked(window.Title, marker))
            ?? (pane is null ? null : windows.FirstOrDefault((window) => Candidate(window) && window.Process == pane.Process && PageNamed(window.Title)));
    }

    /// <summary>How many windows in the pane's process could be the page's by name, so the caller logs a choice among several.</summary>
    public static int PageCandidates(IReadOnlyList<ChromeWindow> windows, ChromeWindow pane) =>
        windows.Count((window) => window.Visible && !window.Owned && window.Handle != pane.Handle && window.Process == pane.Process && PageNamed(window.Title));

    /// <summary>
    /// The pane window: the one whose title holds the marker, visible or not; else the one window titled <c>Switchboard pane</c> with another
    /// marker or none in a browser process that also shows the page's window, since the extension keeps one pane window per browser. Several such
    /// windows in that process, or none, choose nothing, and the search goes on.
    /// </summary>
    public static (ChromeWindow? Pane, bool ByTitleAlone) PickPane(IReadOnlyList<ChromeWindow> windows, string marker)
    {
        var marked = windows.FirstOrDefault((window) => PaneMarked(window.Title, marker));

        if (marked is not null)
        {
            return (marked, false);
        }

        var pageProcesses = windows.Where((window) => window.Visible && !window.Owned && (PageMarked(window.Title, marker) || PageNamed(window.Title))).Select((window) => window.Process).ToHashSet();
        var unmarked = windows.Where((window) => PaneAny(window.Title) && pageProcesses.Contains(window.Process)).ToList();

        return unmarked.Count == 1 ? (unmarked[0], true) : (null, false);
    }

    [GeneratedRegex(@"^Switchboard pane( [0-9a-f]{12})?( - .+)?$")]
    private static partial Regex AnyPane();

    [GeneratedRegex(@"^(Switchboard - )?(\(\d+\) )?Switchboard( \[sb-[a-z]+ [0-9a-f]{12}\])*$")]
    private static partial Regex PageTitle();

    [GeneratedRegex(@"^(127\.0\.0\.1|localhost)_/page/$")]
    private static partial Regex AppTitle();
}
