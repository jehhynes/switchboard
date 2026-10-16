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

    /// <summary>Opens More Actions and clicks the item with the header.</summary>
    static void Choose(Window window, string header)
    {
        var more = window.FindControl<Button>("MoreButton")!;

        Click(more);
        more.ContextMenu!.Items.OfType<MenuItem>().Single((item) => (string)item.Header! == header).RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent));
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

        Assert.Equal(["github", "zoho"], toggles.Select((button) => ((SourceViewModel)button.DataContext!).Name));
        Assert.Equal([false, true], toggles.Select((toggle) => toggle.GetVisualDescendants().OfType<Avalonia.Controls.Shapes.Path>().Single((logo) => logo.IsVisible).Classes.Contains("off")));
        Click(toggles[0]);
        Click(toggles[1]);

        Assert.Equal(["source github False", "source zoho True"], hub.Calls);
    }

    [AvaloniaFact]
    public void Search_Text_ShowsOnlyMatchingRowsWithTheirGroupsOpen()
    {
        var (window, model) = Open();

        Click(window.FindControl<Button>("SearchButton")!);
        window.FindControl<TextBox>("SearchBox")!.Text = "branch 108";
        Dispatcher.UIThread.RunJobs();
        Assert.Empty(VisibleTitles(window));

        window.FindControl<TextBox>("SearchBox")!.Text = "gh 10";
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(["Issue <7>", "Issue <10>", "Issue <8>", "Issue <9>", "Issue <4>"], VisibleTitles(window));

        model.Filter = "107-fix";
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(["Issue <7>"], VisibleTitles(window));
        Assert.Equal(["review"], model.Groups.Where((group) => group.IsShown).Select((group) => group.Key));
        Assert.Equal("1", model.Groups[0].Count);

        window.FindControl<TextBox>("SearchBox")!.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Escape });
        Dispatcher.UIThread.RunJobs();
        Assert.Equal("", model.Filter);
        Assert.False(window.FindControl<TextBox>("SearchBox")!.IsVisible);
        Assert.Equal(7, VisibleTitles(window).Count);
    }

    [AvaloniaFact]
    public void SearchButton_ClickedTwice_ShowsTheBoxThenHidesItAndClearsTheSearch()
    {
        var (window, model) = Open();
        var box = window.FindControl<TextBox>("SearchBox")!;

        Assert.False(box.IsVisible);

        Click(window.FindControl<Button>("SearchButton")!);
        Assert.True(box.IsVisible);
        box.Text = "107-fix";
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(["Issue <7>"], VisibleTitles(window));

        Click(window.FindControl<Button>("SearchButton")!);
        Assert.False(box.IsVisible);
        Assert.Equal("", model.Filter);
        Assert.Equal(7, VisibleTitles(window).Count);
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

    static Window DialogOf(Window window) => Assert.Single(window.OwnedWindows);

    static T Named<T>(Window dialog, string name) where T : Control => dialog.GetVisualDescendants().OfType<T>().Single((control) => control.Name == name);

    [AvaloniaFact]
    public void Adhoc_PromptCreated_PostsItUnstartedAndClosesTheDialog()
    {
        var (window, model) = Open();

        Choose(window, "New Ad-hoc Session…");
        var dialog = DialogOf(window);

        Assert.True(Named<ComboBox>(dialog, "AdhocRepoBox").IsVisible);
        Assert.False(Named<CheckBox>(dialog, "AdhocStartAutomatically").IsChecked);
        Assert.False(Named<Button>(dialog, "AdhocCreate").IsEnabled);

        Named<ComboBox>(dialog, "AdhocRepoBox").SelectedItem = "D:/git/support";
        Named<TextBox>(dialog, "AdhocPromptBox").Text = "Check the log";
        hub.ActReplies.Enqueue(null);
        Click(Named<Button>(dialog, "AdhocCreate"));

        Assert.Equal(["act {\"type\":\"adhoc\",\"prompt\":\"Check the log\",\"repoRoot\":\"D:/git/support\",\"start\":false}"], hub.Calls);
        Assert.Empty(window.OwnedWindows);
        Assert.Equal("D:/git/support", model.AdhocRepo);
    }

    [AvaloniaFact]
    public void Adhoc_StartAutomaticallyChecked_PostsStart()
    {
        var (window, _) = Open();

        Choose(window, "New Ad-hoc Session…");
        var dialog = DialogOf(window);

        Named<TextBox>(dialog, "AdhocPromptBox").Text = "Check the log";
        Named<CheckBox>(dialog, "AdhocStartAutomatically").IsChecked = true;
        hub.ActReplies.Enqueue(null);
        Click(Named<Button>(dialog, "AdhocCreate"));

        Assert.Equal(["act {\"type\":\"adhoc\",\"prompt\":\"Check the log\",\"repoRoot\":\"D:/git/widgets\",\"start\":true}"], hub.Calls);
        Assert.Empty(window.OwnedWindows);
    }

    [AvaloniaFact]
    public void Adhoc_ScheduleChosen_RunsItNowWithoutAPrompt()
    {
        var (window, model) = Open();

        Choose(window, "New Ad-hoc Session…");
        var dialog = DialogOf(window);
        var run = Named<ComboBox>(dialog, "AdhocRunBox");

        Assert.True(run.IsVisible);
        Assert.Equal(["A prompt", "Run self-review now · ops:performance-review"], run.ItemsSource!.Cast<string>());

        run.SelectedIndex = 1;
        Dispatcher.UIThread.RunJobs();

        Assert.False(Named<TextBox>(dialog, "AdhocPromptBox").IsVisible);
        Assert.False(Named<ComboBox>(dialog, "AdhocRepoBox").IsVisible);
        Assert.False(Named<CheckBox>(dialog, "AdhocStartAutomatically").IsVisible);
        Assert.True(Named<Button>(dialog, "AdhocCreate").IsEnabled);
        Assert.Equal("Run", Named<Button>(dialog, "AdhocCreate").Content);

        hub.ActReplies.Enqueue("self-review already has an open work item.");
        Click(Named<Button>(dialog, "AdhocCreate"));

        Assert.Equal("self-review already has an open work item.", Named<TextBlock>(dialog, "AdhocError").Text);

        hub.ActReplies.Enqueue(null);
        Click(Named<Button>(dialog, "AdhocCreate"));

        Assert.Equal(["act {\"type\":\"run-schedule\",\"name\":\"self-review\"}", "act {\"type\":\"run-schedule\",\"name\":\"self-review\"}"], hub.Calls);
        Assert.Empty(window.OwnedWindows);
        Assert.Equal("D:/git/widgets", model.AdhocRepo);
    }

    [AvaloniaFact]
    public void Adhoc_NoRepoRoots_OpensOnAScheduleAndCreatesNoPrompt()
    {
        var (window, model) = Open(Fixtures.View with { RepoRoots = [] });

        Choose(window, "New Ad-hoc Session…");
        var dialog = DialogOf(window);

        Assert.Equal(1, Named<ComboBox>(dialog, "AdhocRunBox").SelectedIndex);
        Assert.True(Named<Button>(dialog, "AdhocCreate").IsEnabled);

        Named<ComboBox>(dialog, "AdhocRunBox").SelectedIndex = 0;
        Named<TextBox>(dialog, "AdhocPromptBox").Text = "Check the log";
        Dispatcher.UIThread.RunJobs();
        Assert.False(Named<Button>(dialog, "AdhocCreate").IsEnabled);

        Named<ComboBox>(dialog, "AdhocRunBox").SelectedIndex = 1;
        hub.ActReplies.Enqueue(null);
        Click(Named<Button>(dialog, "AdhocCreate"));

        Assert.Equal(["act {\"type\":\"run-schedule\",\"name\":\"self-review\"}"], hub.Calls);
        Assert.Empty(window.OwnedWindows);
        Assert.Null(model.AdhocRepo);
    }

    [AvaloniaFact]
    public void Adhoc_NoRepoRootsOrSchedules_SaysToSetARepoRoot()
    {
        var (window, model) = Open(Fixtures.View with { RepoRoots = [], Schedules = [] });

        Choose(window, "New Ad-hoc Session…");

        Assert.Empty(window.OwnedWindows);
        Assert.Equal("Set a repoRoot on a source to start an ad-hoc session.", model.Status);
    }

    [AvaloniaFact]
    public void Adhoc_Refused_KeepsTheDialogAndShowsTheReason()
    {
        var (window, model) = Open();

        Choose(window, "New Ad-hoc Session…");
        var dialog = DialogOf(window);

        Named<TextBox>(dialog, "AdhocPromptBox").Text = "Check the log";
        hub.ActReplies.Enqueue("D:/elsewhere is not a configured repo root.");
        Click(Named<Button>(dialog, "AdhocCreate"));

        Assert.Same(dialog, DialogOf(window));
        Assert.True(Named<TextBlock>(dialog, "AdhocError").IsVisible);
        Assert.Equal("D:/elsewhere is not a configured repo root.", Named<TextBlock>(dialog, "AdhocError").Text);
        Assert.Equal("Check the log", Named<TextBox>(dialog, "AdhocPromptBox").Text);
        Assert.True(Named<Button>(dialog, "AdhocCreate").IsEnabled);
        Assert.Equal("D:/git/widgets", model.AdhocRepo);
    }

    [AvaloniaFact]
    public void Adhoc_EmptyPromptOrCancel_PostsNothing()
    {
        var (window, _) = Open();

        Choose(window, "New Ad-hoc Session…");
        var dialog = DialogOf(window);

        Named<TextBox>(dialog, "AdhocPromptBox").Text = "   ";
        Assert.False(Named<Button>(dialog, "AdhocCreate").IsEnabled);
        Click(Named<Button>(dialog, "AdhocCreate"));
        Click(Named<Button>(dialog, "AdhocCancel"));

        Assert.Empty(window.OwnedWindows);
        Assert.Empty(hub.Calls);
    }

    [AvaloniaFact]
    public void Adhoc_OneRepoRoot_AsksOnlyForThePrompt()
    {
        var (window, _) = Open(Fixtures.View with { RepoRoots = ["D:/git/widgets"] });

        Choose(window, "New Ad-hoc Session…");
        var dialog = DialogOf(window);

        Assert.False(Named<ComboBox>(dialog, "AdhocRepoBox").IsVisible);
        Assert.Equal("D:/git/widgets", Named<ComboBox>(dialog, "AdhocRepoBox").SelectedItem);
    }

    [AvaloniaFact]
    public void MoreActions_Clicked_OpensTheMenuOfAdhocSettingsAndHubLog()
    {
        var (window, _) = Open();
        var more = window.FindControl<Button>("MoreButton")!;

        Click(more);

        Assert.True(more.ContextMenu!.IsOpen);
        Assert.Equal(["New Ad-hoc Session…", "Open Settings", "Show Hub Log"], more.ContextMenu.Items.OfType<MenuItem>().Select((item) => (string)item.Header!));
    }

    [AvaloniaFact]
    public void ShowHubLog_Chosen_RunsTheLogCommandInTheVsCodeWindowUsedLast()
    {
        var (window, _) = Open();

        Choose(window, "Show Hub Log");

        Assert.Equal(["none {\"type\":\"log\"}"], actions.Runs);
        Assert.Empty(hub.Calls);
    }

    [AvaloniaFact]
    public void Settings_ClickedTwice_OpensOneSettingsWindowWithTheFiles()
    {
        var (window, _) = Open();

        Choose(window, "Open Settings");
        var first = window.Settings;
        Choose(window, "Open Settings");

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

        Assert.Equal(["Open in Claude", "Stop", "Mark done", "Snooze", "Open in terminal", "History", "", "Delete", "", "Open ticket"], headers(Fixtures.Row("item:8")));
        Assert.Equal(["Approve", "Triage again", "Mark done", "Snooze", "Move to top", "Move up", "Copy Customer reply", "Open in terminal", "History", "Open report", "", "Delete", "", "Open ticket"], headers(Fixtures.Row("item:10")));

        var two = Fixtures.Row("item:10") with { Pastes = [new DockPaste("Customer reply", "a.md"), new DockPaste("Private note", "b.md")] };
        var copy = (MenuItem)window.MenuOf(two)[6];

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
    public void Adhoc_CreateClickedTwiceWhileTheHubAnswers_PostsOnce()
    {
        var (window, _) = Open();

        Choose(window, "New Ad-hoc Session…");
        var dialog = DialogOf(window);
        var create = Named<Button>(dialog, "AdhocCreate");

        Named<TextBox>(dialog, "AdhocPromptBox").Text = "Check the log";
        hub.ActReplies.Enqueue(null);
        hub.HoldAct = new TaskCompletionSource();
        Click(create);

        Assert.False(create.IsEnabled);
        Click(create);
        hub.HoldAct.SetResult();
        Dispatcher.UIThread.RunJobs();

        Assert.Single(hub.Calls);
        Assert.Empty(window.OwnedWindows);
    }

    [AvaloniaFact]
    public void Adhoc_ClosedWhileTheHubAnswers_StaysOpenToShowTheRefusal()
    {
        var (window, _) = Open();

        Choose(window, "New Ad-hoc Session…");
        var dialog = DialogOf(window);

        Named<TextBox>(dialog, "AdhocPromptBox").Text = "Check the log";
        hub.ActReplies.Enqueue("D:/elsewhere is not a configured repo root.");
        hub.HoldAct = new TaskCompletionSource();
        Click(Named<Button>(dialog, "AdhocCreate"));

        Assert.False(Named<Button>(dialog, "AdhocCancel").IsEnabled);
        dialog.Close();
        Dispatcher.UIThread.RunJobs();
        Assert.Same(dialog, DialogOf(window));

        hub.HoldAct.SetResult();
        Dispatcher.UIThread.RunJobs();

        Assert.Equal("D:/elsewhere is not a configured repo root.", Named<TextBlock>(dialog, "AdhocError").Text);
        Assert.True(Named<Button>(dialog, "AdhocCancel").IsEnabled);
        Click(Named<Button>(dialog, "AdhocCancel"));
        Assert.Empty(window.OwnedWindows);
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
