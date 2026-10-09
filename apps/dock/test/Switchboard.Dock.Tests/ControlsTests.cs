using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Avalonia.VisualTree;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Views;

namespace Switchboard.Dock.Tests;

public sealed class ControlsTests
{
    readonly FakeHub hub = new();
    readonly FakeActions actions = new();
    readonly FakeConfigHub config = new();

    (MainWindow Window, DockViewModel Model) Open(DockView? view = null)
    {
        var model = new DockViewModel(new DockSettings(), (_) => { });
        var window = new MainWindow(model, null, hub, actions, docked: false, config) { Height = 1200 };

        model.Show(view ?? Fixtures.View);
        window.Show();
        Dispatcher.UIThread.RunJobs();

        return (window, model);
    }

    static Border RowOf(Window window, string key) =>
        window.GetVisualDescendants().OfType<Border>().Single((border) => border.Classes.Contains("row") && border.DataContext is RowViewModel row && row.Key == key);

    static Button ButtonIn(Control scope, string className) => scope.GetVisualDescendants().OfType<Button>().Single((button) => button.Classes.Contains(className));

    static void Click(Button button)
    {
        button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        Dispatcher.UIThread.RunJobs();
    }

    static List<string> VisibleTitles(Window window) =>
        window.GetVisualDescendants().OfType<Border>().Where((border) => border.Classes.Contains("row") && border.IsEffectivelyVisible).Select((border) => ((RowViewModel)border.DataContext!).Title).ToList();

    [AvaloniaFact]
    public void MainButton_ApproveRow_PostsApproveWithoutTheRowClick()
    {
        var (window, _) = Open();

        hub.ActReplies.Enqueue(null);
        Click(ButtonIn(RowOf(window, "item:10"), "main"));

        Assert.Equal(["act {\"type\":\"approve\",\"workItemId\":10}"], hub.Calls);
        Assert.Empty(actions.Clicked);
    }

    [AvaloniaFact]
    public void MainButton_TappedOnSelectedRow_RunsTheButtonNotTheRowClick()
    {
        var (window, model) = Open();
        var row = RowOf(window, "item:10");

        hub.ActReplies.Enqueue(null);
        model.Selected = "item:10";
        Dispatcher.UIThread.RunJobs();

        var button = ButtonIn(row, "main");
        var point = button.TranslatePoint(new Point(4, 4), window)!.Value;

        window.MouseDown(point, MouseButton.Left);
        window.MouseUp(point, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();

        Assert.True(button.IsEffectivelyVisible);
        Assert.Equal(["act {\"type\":\"approve\",\"workItemId\":10}"], hub.Calls);
        Assert.Empty(actions.Clicked);
    }

    [AvaloniaFact]
    public void MainButton_QuestionRow_RunsOpenInClaudeAsTheClick()
    {
        var (window, _) = Open();

        Click(ButtonIn(RowOf(window, "item:8"), "main"));

        Assert.Equal(["item:8"], actions.Clicked.Select((row) => row.Key));
        Assert.Empty(hub.Calls);
    }

    [AvaloniaFact]
    public void AnswerButton_OneAnswer_PostsItsAnswerAction()
    {
        var (window, _) = Open();

        hub.ActReplies.Enqueue(null);
        Click(RowOf(window, "item:8").GetVisualDescendants().OfType<Button>().Single((button) => button.Classes.Contains("option")));

        Assert.Equal(["act {\"type\":\"answer\",\"workItemId\":8,\"nativeSessionId\":\"aaaa1111-native\",\"question\":\"Which branch?\",\"answer\":\"main\"}"], hub.Calls);
    }

    [AvaloniaFact]
    public void ReportButton_ApprovalRow_RunsOpenReportInVsCode()
    {
        var (window, model) = Open();
        var report = RowOf(window, "item:10").GetVisualDescendants().OfType<Button>().Single((button) => ToolTip.GetTip(button) as string == "reply.md");

        actions.RunReply = "Open a VS Code window first; this runs in VS Code.";
        Click(report);

        Assert.Equal(["item:10 {\"type\":\"openUrl\",\"url\":\"D:/drafts/reply.md\"}"], actions.Runs);
        Assert.Equal(actions.RunReply, model.Status);
    }

    [AvaloniaFact]
    public void CopyButton_UnreadableDraft_SaysWhy()
    {
        var (window, model) = Open();
        var copy = RowOf(window, "item:10").GetVisualDescendants().OfType<Button>().Single((button) => ToolTip.GetTip(button) as string == "Copy Customer reply");

        Click(copy);

        Assert.StartsWith("Customer reply could not be read: ", model.Status);
    }

    [AvaloniaFact]
    public void Rows_WithoutApproval_ShowNoCopyOrReport()
    {
        var (window, _) = Open();
        var tips = RowOf(window, "item:7").GetVisualDescendants().OfType<Button>().Where((button) => button.IsVisible).Select((button) => ToolTip.GetTip(button) as string);

        Assert.DoesNotContain("reply.md", tips);
        Assert.DoesNotContain(tips, (tip) => tip?.StartsWith("Copy") == true);
    }

    [AvaloniaFact]
    public void SourceToggle_EnabledSource_TurnsItOff()
    {
        var (window, _) = Open();
        var toggles = window.FindControl<ItemsControl>("SourceList")!.GetVisualDescendants().OfType<Button>().ToList();

        Assert.Equal(["gh", "zoho"], toggles.Select((button) => ((SourceViewModel)button.DataContext!).Label));
        Assert.Contains("off", toggles[1].Classes);
        Click(toggles[0]);
        Click(toggles[1]);

        Assert.Equal(["source github False", "source zoho True"], hub.Calls);
    }

    [AvaloniaFact]
    public void Search_Text_ShowsOnlyMatchingRowsWithTheirGroupsOpen()
    {
        var (window, model) = Open();

        window.FindControl<TextBox>("SearchBox")!.Text = "branch 108";
        Dispatcher.UIThread.RunJobs();
        Assert.Empty(VisibleTitles(window));

        window.FindControl<TextBox>("SearchBox")!.Text = "gh 10";
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(["Issue <7>", "Issue <8>", "Issue <10>", "Issue <9>", "Issue <4>"], VisibleTitles(window));

        model.Filter = "107-fix";
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(["Issue <7>"], VisibleTitles(window));
        Assert.Equal(["needs"], model.Groups.Where((group) => group.IsShown).Select((group) => group.Key));
        Assert.Equal("1", model.Groups[0].Count);

        window.FindControl<TextBox>("SearchBox")!.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Escape });
        Dispatcher.UIThread.RunJobs();
        Assert.Equal("", model.Filter);
        Assert.Equal(5, VisibleTitles(window).Count);
    }

    [AvaloniaFact]
    public void Search_ClosedGroup_OpensWhileFilteringOnly()
    {
        var (window, model) = Open();
        var done = Fixtures.View with { Groups = [.. Fixtures.View.Groups.Take(3), new DockGroup("done", "Done", null, [Fixtures.Row("item:9") with { Key = "item:50", Title = "Finished thing", Search = "Finished thing · gh 150" }])] };

        model.Show(done);
        model.Filter = "finished";
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(["Finished thing"], VisibleTitles(window));

        model.Filter = "";
        Dispatcher.UIThread.RunJobs();
        Assert.DoesNotContain("Finished thing", VisibleTitles(window));
        Assert.False(model.Groups.Single((group) => group.Key == "done").IsOpen);
    }

    [AvaloniaFact]
    public void Adhoc_PromptStarted_PostsItAndClosesTheForm()
    {
        var (window, model) = Open();

        Click(window.FindControl<Button>("AdhocButton")!);
        Assert.True(window.FindControl<StackPanel>("AdhocForm")!.IsVisible);
        Assert.True(window.FindControl<ComboBox>("AdhocRepoBox")!.IsVisible);

        model.AdhocRepo = "D:/git/support";
        model.AdhocPrompt = "Check the log";
        hub.ActReplies.Enqueue(null);
        Click(window.FindControl<Button>("AdhocStart")!);

        Assert.Equal(["act {\"type\":\"adhoc\",\"prompt\":\"Check the log\",\"repoRoot\":\"D:/git/support\"}"], hub.Calls);
        Assert.False(model.AdhocOpen);
        Assert.Equal("", model.AdhocPrompt);
    }

    [AvaloniaFact]
    public void Adhoc_Refused_KeepsTheFormAndPrompt()
    {
        var (window, model) = Open();

        model.AdhocOpen = true;
        model.AdhocPrompt = "Check the log";
        hub.ActReplies.Enqueue("D:/elsewhere is not a configured repo root.");
        Click(window.FindControl<Button>("AdhocStart")!);

        Assert.Equal("D:/elsewhere is not a configured repo root.", model.Status);
        Assert.True(model.AdhocOpen);
        Assert.Equal("Check the log", model.AdhocPrompt);
        Assert.Equal("D:/git/widgets", model.AdhocRepo);
    }

    [AvaloniaFact]
    public void Adhoc_EmptyPrompt_PostsNothing()
    {
        var (window, model) = Open();

        model.AdhocOpen = true;
        model.AdhocPrompt = "   ";
        Click(window.FindControl<Button>("AdhocStart")!);

        Assert.Empty(hub.Calls);
    }

    [AvaloniaFact]
    public void Adhoc_NoRepoRoots_SaysWhatIsMissing()
    {
        var (window, model) = Open(Fixtures.View with { RepoRoots = [] });

        Click(window.FindControl<Button>("AdhocButton")!);

        Assert.False(model.AdhocOpen);
        Assert.Equal("Set a repoRoot on a source to start an ad-hoc session.", model.Status);
    }

    [AvaloniaFact]
    public void Adhoc_OneRepoRoot_AsksOnlyForThePrompt()
    {
        var (window, model) = Open(Fixtures.View with { RepoRoots = ["D:/git/widgets"] });

        Click(window.FindControl<Button>("AdhocButton")!);

        Assert.False(window.FindControl<ComboBox>("AdhocRepoBox")!.IsVisible);
        Assert.Equal("D:/git/widgets", model.AdhocRepo);
    }

    [AvaloniaFact]
    public void Settings_ClickedTwice_OpensOneSettingsWindowWithTheFiles()
    {
        var (window, _) = Open();

        Click(window.FindControl<Button>("SettingsButton")!);
        var first = window.Settings;
        Click(window.FindControl<Button>("SettingsButton")!);

        Assert.NotNull(first);
        Assert.Same(first, window.Settings);
        Assert.True(first.IsVisible);
        Assert.Equal(["read"], config.Calls.Where((call) => call == "read"));
        Assert.Empty(actions.Runs);

        first.Close();
        Dispatcher.UIThread.RunJobs();
        Assert.Null(window.Settings);
    }

    [AvaloniaFact]
    public void MenuOf_QuestionAndApprovalRows_OfferOpenInClaudeCopyAndOpenReport()
    {
        var (window, _) = Open();
        var headers = (DockRow row) => window.MenuOf(row).Select((item) => item is MenuItem named ? (string)named.Header! : "").ToList();

        Assert.Equal(["Open in Claude", "Stop", "Mark done", "Snooze", "History", "", "Open ticket"], headers(Fixtures.Row("item:8")));
        Assert.Equal(["Approve", "Triage again", "Mark done", "Snooze", "Copy Customer reply", "History", "Open report", "", "Open ticket"], headers(Fixtures.Row("item:10")));

        var two = Fixtures.Row("item:10") with { Pastes = [new DockPaste("Customer reply", "a.md"), new DockPaste("Private note", "b.md")] };
        var copy = (MenuItem)window.MenuOf(two)[4];

        Assert.Equal("Copy", copy.Header);
        Assert.Equal(["Customer reply", "Private note"], copy.ItemsSource!.Cast<MenuItem>().Select((item) => (string)item.Header!));
    }

    [AvaloniaFact]
    public void MainButton_ApproveRow_NamesThePromptInItsTooltip()
    {
        var (window, _) = Open();

        Assert.Equal("Approve: runs /support-release #4521", ToolTip.GetTip(ButtonIn(RowOf(window, "item:10"), "main")));
    }

    [AvaloniaFact]
    public void Adhoc_StartClickedTwiceWhileTheHubAnswers_PostsOnce()
    {
        var (window, model) = Open();
        var start = window.FindControl<Button>("AdhocStart")!;

        model.AdhocOpen = true;
        model.AdhocPrompt = "Check the log";
        hub.ActReplies.Enqueue(null);
        hub.HoldAct = new TaskCompletionSource();
        Click(start);

        Assert.False(start.IsEnabled);
        Click(start);
        hub.HoldAct.SetResult();
        Dispatcher.UIThread.RunJobs();

        Assert.Single(hub.Calls);
        Assert.True(start.IsEnabled);
        Assert.False(model.AdhocOpen);
    }

    [AvaloniaFact]
    public void VsCodeControl_WhileARowClickSwitches_CancelsThatClick()
    {
        var (window, _) = Open();

        actions.Pending = new TaskCompletionSource<string?>();
        var point = RowOf(window, "item:7").TranslatePoint(new Point(20, 8), window)!.Value;

        window.MouseDown(point, MouseButton.Left);
        window.MouseUp(point, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();
        // Open report runs in VS Code.
        Click(RowOf(window, "item:10").GetVisualDescendants().OfType<Button>().Single((button) => ToolTip.GetTip(button) as string == "reply.md"));

        Assert.Equal(["item:7"], actions.Clicked.Select((row) => row.Key));
        Assert.True(actions.Cancels[0].IsCancellationRequested);
        Assert.False(actions.RunCancels[0].IsCancellationRequested);
    }

    [AvaloniaFact]
    public void SelectWindow_RowHiddenBySearch_ClearsTheSearchToShowIt()
    {
        var (window, model) = Open();

        model.Filter = "109";
        Dispatcher.UIThread.RunJobs();
        window.ShowForeground("Issue <7> · sb:gh-107-58c609");
        Dispatcher.UIThread.RunJobs();

        Assert.Equal("", model.Filter);
        Assert.Equal("item:7", model.Selected);
        Assert.Contains("Issue <7>", VisibleTitles(window));
    }
}
