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

    static void Tap(Window window, Control control)
    {
        var point = control.TranslatePoint(new Point(Math.Min(20, control.Bounds.Width / 2), Math.Min(8, control.Bounds.Height / 2)), window)!.Value;

        window.MouseDown(point, MouseButton.Left);
        window.MouseUp(point, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();
    }

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
    public void NewSessionInAFolder_FolderChosen_MakesTheConversationThenOpensTheHubsFolder()
    {
        var (window, model) = Open();
        var picked = new TaskCompletionSource<string?>();
        var asked = 0;

        window.PickFolder = (_) =>
        {
            asked++;
            return picked.Task;
        };
        hub.NewConversationReplies.Enqueue(new NewConversationReply(null, 3, "D:\\git\\support"));
        model.Status = "Earlier.";

        // A second click while the picker is open asks nothing more.
        Choose(window, "New Session in a Folder…");
        Choose(window, "New Session in a Folder…");
        picked.SetResult("d:/git/support");
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(1, asked);
        Assert.Matches("^new-conversation d:/git/support [0-9a-f-]{36}$", Assert.Single(hub.Calls));
        Assert.Equal(["D:\\git\\support"], actions.Folders);
        Assert.Null(model.Status);
    }

    [AvaloniaFact]
    public void NewSessionInAFolder_RowClickedWhileTheHubAnswers_LeavesThatClickAndOpensNoFolder()
    {
        var (window, model) = Open();
        var answer = new TaskCompletionSource<NewConversationReply>();

        window.PickFolder = (_) => Task.FromResult<string?>("D:/git/support");
        hub.HoldNewConversation = answer;
        Choose(window, "New Session in a Folder…");

        // A row clicked meanwhile replaces New session, which then opens nothing over that row's window and shows nothing.
        var pending = new TaskCompletionSource<string?>();

        actions.Pending = pending;
        Tap(window, RowOf(window, "item:10"));
        answer.SetResult(new NewConversationReply(null, 3, "D:/git/support"));
        Dispatcher.UIThread.RunJobs();

        Assert.Empty(actions.Folders);
        Assert.Single(actions.Clicked);
        Assert.False(actions.Cancels[0].IsCancellationRequested);
        Assert.Null(model.Status);
        pending.SetResult(null);
        Dispatcher.UIThread.RunJobs();
    }

    [AvaloniaFact]
    public void NewSessionInAFolder_EarlierAttemptEndsWhileANewerOneWaits_KeepsTheNewerOnesHold()
    {
        var (window, _) = Open();
        var opening = new TaskCompletionSource<string?>();
        var answer = new TaskCompletionSource<NewConversationReply>();

        window.PickFolder = (_) => Task.FromResult<string?>("D:/git/support");
        hub.NewConversationReplies.Enqueue(new NewConversationReply(null, 3, "D:/git/support"));
        actions.HoldFolder = opening;
        // The first attempt has its conversation and waits for the folder window.
        Choose(window, "New Session in a Folder…");
        Assert.Equal(["D:/git/support"], actions.Folders);

        // A second replaces it and waits for the hub; the first then ends, and a third, chosen meanwhile, makes nothing.
        hub.HoldNewConversation = answer;
        Choose(window, "New Session in a Folder…");
        opening.SetResult(null);
        Dispatcher.UIThread.RunJobs();
        Choose(window, "New Session in a Folder…");

        Assert.Equal(2, hub.Calls.Count((call) => call.StartsWith("new-conversation ", StringComparison.Ordinal)));
        answer.SetResult(new NewConversationReply("Refused.", null, null));
        Dispatcher.UIThread.RunJobs();
    }

    [AvaloniaFact]
    public void NewSessionInAFolder_PickerCancelledOrHubRefuses_OpensNoWindow()
    {
        var (window, model) = Open();
        string? folder = null;

        window.PickFolder = (_) => Task.FromResult(folder);
        Choose(window, "New Session in a Folder…");
        Assert.Empty(hub.Calls);

        folder = "D:/git/support";
        hub.NewConversationReplies.Enqueue(new NewConversationReply("New sessions need Code Mode (sessions.codeMode).", null, null));
        Choose(window, "New Session in a Folder…");

        Assert.Single(hub.Calls);
        Assert.Equal("New sessions need Code Mode (sessions.codeMode).", model.Status);
        Assert.Empty(actions.Folders);
    }

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
    public void GroupHeader_QuickClicks_TogglesOnEveryClick()
    {
        var (window, model) = Open();
        var group = model.Groups.First();
        var header = window.GetVisualDescendants().OfType<Border>().First((border) => border.Classes.Contains("group") && border.DataContext == group);
        var point = header.TranslatePoint(new Point(4, 4), window)!.Value;
        var open = group.IsOpen;
        var seen = new List<bool>();

        for (var click = 0; click < 4; click++)
        {
            window.MouseDown(point, MouseButton.Left);

            // A second press that moves past the tap distance and back raises DoubleTapped and then Tapped.
            if (click == 3)
            {
                window.MouseMove(point + new Vector(8, 0), RawInputModifiers.LeftMouseButton);
                window.MouseMove(point, RawInputModifiers.LeftMouseButton);
            }

            window.MouseUp(point, MouseButton.Left);
            Dispatcher.UIThread.RunJobs();
            seen.Add(group.IsOpen);
        }

        Assert.Equal([!open, open, !open, open], seen);
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

    static DockView TwoGithubSources(bool github, bool personal) => Fixtures.View with
    {
        Sources =
        [
            new SourceGroup("github", github || personal, $"github: {(github ? "polled" : "not polled")}\npersonal: {(personal ? "polled" : "not polled")}\nClick to choose which to poll.",
                [new SourceState("github", github), new SourceState("personal", personal)]),
            new SourceGroup("zoho", false, "zoho: not polled\nClick to poll it.", [new SourceState("zoho", false)]),
        ],
    };

    static Button SourceIcon(Window window, string kind) =>
        window.FindControl<ItemsControl>("SourceList")!.GetVisualDescendants().OfType<Button>().Single((button) => ((SourceViewModel)button.DataContext!).Kind == kind);

    static List<MenuItem> MenuItems(Button button) => button.ContextMenu!.Items.OfType<MenuItem>().ToList();

    [AvaloniaFact]
    public void SourceIcon_TwoSourcesOfKind_OpensMenuInsteadOfToggling()
    {
        var row = Fixtures.Row("item:7") with { Ticket = "personal 63", Source = "personal", SourceKind = "github" };
        var (window, _) = Open(TwoGithubSources(false, true) with { Groups = [new DockGroup("review", "Ready for review", null, [row])] });
        var icon = SourceIcon(window, "github");
        var logo = icon.GetVisualDescendants().OfType<Avalonia.Controls.Shapes.Path>().Single((path) => path.IsVisible);

        Assert.Contains("github", logo.Classes);
        Assert.DoesNotContain("off", logo.Classes);
        Assert.Equal("github: not polled\npersonal: polled\nClick to choose which to poll.", ToolTip.GetTip(icon));
        Assert.DoesNotContain(icon.GetVisualDescendants().OfType<TextBlock>(), (text) => text.IsEffectivelyVisible);

        Click(icon);

        Assert.Empty(hub.Calls);
        Assert.True(icon.ContextMenu!.IsOpen);
        Assert.NotEmpty(window.OpenMenus);
        Assert.Equal([("github", false), ("personal", true)], MenuItems(icon).Select((item) => ((string)item.Header!, item.IsChecked)));
        Assert.All(MenuItems(icon), (item) => Assert.True(item.StaysOpenOnClick));
        Assert.Contains("github", RowOf(window, "item:7").GetVisualDescendants().OfType<Border>().Single((pill) => pill.Classes.Contains("pill") && pill.Tag as string == row.Url).Classes);
    }

    [AvaloniaFact]
    public void SourceMenu_EntryClicked_TogglesOnlyItsSourceAndStaysOpenAcrossTheSnapshot()
    {
        var (window, model) = Open(TwoGithubSources(false, true));
        var icon = SourceIcon(window, "github");

        Click(icon);
        var menu = icon.ContextMenu!;
        var github = MenuItems(icon)[0];
        github.RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(["source github True"], hub.Calls);

        model.Show(TwoGithubSources(true, true));
        Dispatcher.UIThread.RunJobs();

        Assert.Same(icon, SourceIcon(window, "github"));
        Assert.Same(menu, icon.ContextMenu);
        Assert.True(menu.IsOpen);
        Assert.Equal([true, true], MenuItems(icon).Select((item) => item.IsChecked));
        Assert.DoesNotContain("off", icon.GetVisualDescendants().OfType<Avalonia.Controls.Shapes.Path>().Single((path) => path.IsVisible).Classes);
    }

    [AvaloniaFact]
    public void SourceMenu_ToggleRefused_ShowsTheReasonAndKeepsTheCheck()
    {
        var (window, model) = Open(TwoGithubSources(false, true));
        var icon = SourceIcon(window, "github");

        hub.SourceReply = "settings.json has no source named github.";
        Click(icon);
        var github = MenuItems(icon)[0];
        github.IsChecked = true;
        github.RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        Assert.Equal("settings.json has no source named github.", model.Status);
        Assert.False(github.IsChecked);
    }

    [AvaloniaFact]
    public void SourceMenu_SourceRemovedWhileOpen_ClosesTheMenu()
    {
        var (window, model) = Open(TwoGithubSources(true, true));
        var icon = SourceIcon(window, "github");

        Click(icon);
        Assert.True(icon.ContextMenu!.IsOpen);

        model.Show(Fixtures.View);
        Dispatcher.UIThread.RunJobs();

        Assert.False(icon.ContextMenu!.IsOpen);
        Assert.Single(((SourceViewModel)SourceIcon(window, "github").DataContext!).Entries);
    }

    [AvaloniaFact]
    public void SourceMenu_Keyboard_OpensMovesTogglesAndCloses()
    {
        var (window, _) = Open(TwoGithubSources(true, false));
        var icon = SourceIcon(window, "github");

        icon.Focus();
        window.KeyPressQwerty(PhysicalKey.Enter, RawInputModifiers.None);
        Dispatcher.UIThread.RunJobs();
        Assert.True(icon.ContextMenu!.IsOpen);

        window.KeyPressQwerty(PhysicalKey.ArrowDown, RawInputModifiers.None);
        window.KeyPressQwerty(PhysicalKey.ArrowDown, RawInputModifiers.None);
        window.KeyPressQwerty(PhysicalKey.Space, RawInputModifiers.None);
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(["source personal True"], hub.Calls);
        Assert.True(icon.ContextMenu.IsOpen);

        window.KeyPressQwerty(PhysicalKey.Enter, RawInputModifiers.None);
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(["source personal True", "source personal True"], hub.Calls);
        window.KeyPressQwerty(PhysicalKey.Escape, RawInputModifiers.None);
        Dispatcher.UIThread.RunJobs();
        Assert.False(icon.ContextMenu.IsOpen);
        Assert.True(icon.IsFocused);
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
        Assert.Equal(8, VisibleTitles(window).Count);
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
        Assert.Equal(8, VisibleTitles(window).Count);
    }

    [AvaloniaFact]
    public void ClearSearchButton_Clicked_ClearsSearchAndKeepsTheBoxFocused()
    {
        var (window, model) = Open();
        var box = window.FindControl<TextBox>("SearchBox")!;

        Click(window.FindControl<Button>("SearchButton")!);
        box.Text = "107-fix";
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(["Issue <7>"], VisibleTitles(window));

        Click(window.FindControl<Button>("ClearSearchButton")!);
        Assert.True(box.IsVisible);
        Assert.Equal("", model.Filter);
        Assert.Equal(8, VisibleTitles(window).Count);
        Assert.Equal("", box.Text);
        Assert.True(box.IsFocused);
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
    public void MoreActions_Clicked_OpensTheMenuOfAdhocRefreshSettingsAndHubLog()
    {
        var (window, _) = Open();
        var more = window.FindControl<Button>("MoreButton")!;

        Click(more);

        Assert.True(more.ContextMenu!.IsOpen);
        Assert.Equal(["New Ad-hoc Session…", "New Session in a Folder…", "Refresh Sources", "Open Settings", "Ticket Volume Report", "Held Sessions", "Show Hub Log"], more.ContextMenu.Items.OfType<MenuItem>().Select((item) => (string)item.Header!));
        Assert.All(more.ContextMenu.Items.OfType<MenuItem>(), (item) => Assert.NotNull(item.Icon));
    }

    [AvaloniaFact]
    public void MoreActions_NoZohoOrForumSource_OmitsTicketVolumeReport()
    {
        var (window, _) = Open(Fixtures.View with { Sources = [new SourceGroup("github", true, "github: polled", [new SourceState("github", true)])] });
        var more = window.FindControl<Button>("MoreButton")!;

        Click(more);

        Assert.Equal(["New Ad-hoc Session…", "New Session in a Folder…", "Refresh Sources", "Open Settings", "Held Sessions", "Show Hub Log"], more.ContextMenu!.Items.OfType<MenuItem>().Select((item) => (string)item.Header!));
    }

    [AvaloniaFact]
    public void RefreshSources_Chosen_PostsPoll()
    {
        var (window, model) = Open();

        Choose(window, "Refresh Sources");

        Assert.Equal(["poll"], hub.Calls);
        Assert.Null(model.Status);
    }

    [AvaloniaFact]
    public void RefreshSources_Refused_ShowsTheHubsReason()
    {
        var (window, model) = Open();
        hub.PollReply = "No source is polled. Turn one on in the header.";

        Choose(window, "Refresh Sources");

        Assert.Equal("No source is polled. Turn one on in the header.", model.Status);
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

        Assert.Equal(["Open in Claude", "Stop", "Mark done", "Snooze…", "Add comment…", "Open in terminal", "History", "", "Delete", "", "Open ticket"], headers(Fixtures.Row("item:8")));
        Assert.Equal(["Approve", "Mark done", "Snooze…", "Add comment…", "Move to top", "Move up", "Copy Customer reply", "Open in terminal", "History", "Open report", "", "Delete", "", "Open ticket"], headers(Fixtures.Row("item:10")));

        var two = Fixtures.Row("item:10") with { Pastes = [new DockPaste("Customer reply", "a.md"), new DockPaste("Private note", "b.md")] };
        var copy = (MenuItem)window.MenuOf(two)[6];

        Assert.Equal("Copy", copy.Header);
        Assert.Equal(["Customer reply", "Private note"], copy.ItemsSource!.Cast<MenuItem>().Select((item) => (string)item.Header!));
    }

    /// <summary>The recorded question row as the hub sends it with review: Answer in terminal attaches, and the menu's Open in terminal runs in the dock.</summary>
    static DockRow ReviewQuestion()
    {
        var row = Fixtures.Row("item:8");
        var menu = new DockTerminal("claude", "aaaa1111-native", "D:/git/widgets", ["attach", "aaaa1111"], "gh-108-widgets-655280-aaaa1111", "Issue <8> · sb:gh-108-widgets-655280-aaaa1111");

        return row with
        {
            Open = new DockOpen("terminal", null, menu.SessionId, menu.Cwd, null, "claude", menu.Args, menu.Name, menu.Title),
            Main = "Answer in terminal",
            Terminal = menu,
            Commands = row.Commands.Where((command) => command.Label != "Open in terminal").ToList(),
        };
    }

    [AvaloniaFact]
    public async Task TerminalRow_MainButtonAndMenuRunTheClickAndOpenInTerminalRunsInTheDock()
    {
        var review = ReviewQuestion();
        var (window, _) = Open(Fixtures.View with { Groups = [new DockGroup("blocked", "Blocked on you", null, [review])] });
        var items = window.MenuOf(review);

        Assert.Equal(["Answer in terminal", "Stop", "Mark done", "Snooze…", "Add comment…", "Open in terminal", "History", "", "Delete", "", "Open ticket"], items.Select((item) => item is MenuItem named ? (string)named.Header! : "").ToList());

        Click(ButtonIn(RowOf(window, "item:8"), "main"));
        ((MenuItem)items[0]).RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        ((MenuItem)items[5]).RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        await Task.Yield();
        Dispatcher.UIThread.RunJobs();

        Assert.Equal([review.Open, review.Open], actions.Clicked.Select((clicked) => clicked.Open));
        Assert.Equal([review], actions.InTerminal);
        Assert.Empty(actions.Runs);
        Assert.Empty(hub.Calls);
    }

    [AvaloniaFact]
    public async Task OpenInTerminal_RowOfferingBoth_ShowsOneItemThatLeavesTheChoiceToTheSwitcher()
    {
        var row = Fixtures.Row("item:8");
        var auto = row with { Terminal = new DockTerminal("claude", "aaaa1111-native", "D:/git/widgets", ["attach", "aaaa1111"], "gh-108-widgets-655280-aaaa1111", "Issue <8>") };
        var (window, _) = Open(Fixtures.View with { Groups = [new DockGroup("blocked", "Blocked on you", null, [auto])] });
        var items = window.MenuOf(auto);

        Assert.Equal(["Open in Claude", "Stop", "Mark done", "Snooze…", "Add comment…", "Open in terminal", "History", "", "Delete", "", "Open ticket"], items.Select((item) => item is MenuItem named ? (string)named.Header! : "").ToList());

        ((MenuItem)items[5]).RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        await Task.Yield();
        Dispatcher.UIThread.RunJobs();

        Assert.Equal([auto], actions.InTerminal);
        Assert.Empty(actions.Runs);
    }

    [AvaloniaFact]
    public async Task MainButton_PromptBeforeStartsOpenInTerminal_OpensTheTerminal()
    {
        var row = Fixtures.Row("item:8") with { Open = null, Main = "Open in terminal" };
        var (window, _) = Open(Fixtures.View with { Groups = [new DockGroup("blocked", "Blocked on you", null, [row])] });

        Click(ButtonIn(RowOf(window, "item:8"), "main"));
        await Task.Yield();
        Dispatcher.UIThread.RunJobs();

        Assert.Equal([row], actions.InTerminal);
        Assert.Empty(actions.Clicked);
        Assert.Empty(hub.Calls);
    }

    [AvaloniaFact]
    public async Task ClickForwarded_KnownRowRunsItsClickAndAnUnknownRowSaysSo()
    {
        var (window, model) = Open();

        window.ClickForwarded("item:8");
        await Task.Yield();
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(["item:8"], actions.Clicked.Select((clicked) => clicked.Key));
        Assert.Equal("item:8", model.Selected);

        window.ClickForwarded("item:404");
        Dispatcher.UIThread.RunJobs();
        Assert.Equal("Switchboard has no row for item:404.", model.Status);
        Assert.Single(actions.Clicked);
    }

    [AvaloniaFact]
    public async Task ShowNeedsYou_MessageClicked_RunsTheRowsClickOnce()
    {
        var (window, model) = Open();

        window.ShowNeedsYou("item:8", "Switchboard: Fix it — Answer a question");
        Assert.Equal("Switchboard: Fix it — Answer a question", model.Status);

        var line = Named<TextBlock>(window, "StatusLine");

        line.RaiseEvent(new TappedEventArgs(InputElement.TappedEvent, null!));
        await Task.Yield();
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(["item:8"], actions.Clicked.Select((clicked) => clicked.Key));

        // Another message in the toast opens nothing.
        model.Status = "The click failed.";
        line.RaiseEvent(new TappedEventArgs(InputElement.TappedEvent, null!));
        Dispatcher.UIThread.RunJobs();
        Assert.Single(actions.Clicked);
    }

    [AvaloniaFact]
    public async Task ClickForwarded_UnknownRow_ReplacesTheClickStillRunning()
    {
        var (window, model) = Open();

        actions.Pending = new TaskCompletionSource<string?>();
        window.ClickForwarded("item:8");
        Dispatcher.UIThread.RunJobs();
        window.ClickForwarded("item:404");
        Dispatcher.UIThread.RunJobs();

        Assert.True(actions.Cancels[0].IsCancellationRequested);

        actions.Pending.SetResult("Windows kept another window in front. Click the row again.");
        await Task.Yield();
        Dispatcher.UIThread.RunJobs();
        Assert.Equal("Switchboard has no row for item:404.", model.Status);
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
