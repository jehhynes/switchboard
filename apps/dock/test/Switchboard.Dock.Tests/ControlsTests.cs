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
    readonly FakeTime time = new();

    (MainWindow Window, DockViewModel Model) Open(DockView? view = null)
    {
        var model = new DockViewModel(new DockSettings(), (_) => { }, time);
        var window = new MainWindow(model, null, hub, actions, docked: false, config) { Height = 1200 };
        window.PickProvider = (_, preferred, _) => Task.FromResult<string?>(preferred);

        model.Show(view ?? Fixtures.View);
        window.Show();
        Dispatcher.UIThread.RunJobs();

        return (window, model);
    }

    static Border RowOf(Window window, string key) =>
        window.GetVisualDescendants().OfType<Border>().Single((border) => border.Classes.Contains("row") && border.DataContext is RowViewModel row && row.Key == key);

    static Button ButtonIn(Control scope, string className) => scope.GetVisualDescendants().OfType<Button>().Single((button) => button.Classes.Contains(className));

    static void Tap(Window window, Control control, RawInputModifiers modifiers = RawInputModifiers.None)
    {
        var point = control.TranslatePoint(new Point(Math.Min(20, control.Bounds.Width / 2), Math.Min(8, control.Bounds.Height / 2)), window)!.Value;

        window.MouseDown(point, MouseButton.Left, modifiers);
        window.MouseUp(point, MouseButton.Left, modifiers);
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
        // A real click closes the menu, which opens below the button over the rows.
        more.ContextMenu.Close();
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
        Choose(window, "New conversation in a folder…");
        Choose(window, "New conversation in a folder…");
        picked.SetResult("d:/git/support");
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(1, asked);
        Assert.Matches("^new-conversation d:/git/support [0-9a-f-]{36} claude$", Assert.Single(hub.Calls));
        Assert.Equal(["D:\\git\\support"], actions.Folders);
        Assert.Null(model.Status);
    }

    [AvaloniaFact]
    public void NewSessionInAFolder_ProviderChosenOrCancelled_PostsOnlyTheExplicitChoice()
    {
        hub.DefaultProvider = "codex";
        var (window, _) = Open();
        window.PickFolder = (_) => Task.FromResult<string?>("D:/git/support");
        window.PickProvider = (_, preferred, _) => { Assert.Equal("codex", preferred); return Task.FromResult<string?>(null); };
        Choose(window, "New conversation in a folder…");
        Assert.Empty(hub.Calls);
        window.PickProvider = (_, _, _) => Task.FromResult<string?>("claude");
        hub.NewConversationReplies.Enqueue(new NewConversationReply(null, 3, "D:/git/support"));
        Choose(window, "New conversation in a folder…");
        Assert.Matches("^new-conversation D:/git/support [0-9a-f-]{36} claude$", Assert.Single(hub.Calls));
        Assert.Equal("codex", hub.DefaultProvider);
    }

    [AvaloniaFact]
    public void NewSessionInAFolder_OneProviderInstalled_StartsInItWithoutAsking()
    {
        hub.DefaultProvider = "claude";
        hub.Installed = ["codex"];
        var (window, _) = Open();
        var asked = 0;
        window.PickFolder = (_) => Task.FromResult<string?>("D:/git/support");
        window.PickProvider = (_, preferred, _) => { asked++; return Task.FromResult<string?>(preferred); };
        hub.NewConversationReplies.Enqueue(new NewConversationReply(null, 3, "D:/git/support"));
        Choose(window, "New conversation in a folder…");
        Assert.Equal(0, asked);
        Assert.Matches("^new-conversation D:/git/support [0-9a-f-]{36} codex$", Assert.Single(hub.Calls));

        // With both installed it asks.
        hub.Installed = ["claude", "codex"];
        hub.NewConversationReplies.Enqueue(new NewConversationReply(null, 4, "D:/git/support"));
        Choose(window, "New conversation in a folder…");
        Assert.Equal(1, asked);
    }

    [AvaloniaFact]
    public void NewSessionInAFolder_RowClickedWhileTheHubAnswers_LeavesThatClickAndOpensNoFolder()
    {
        var (window, model) = Open();
        var answer = new TaskCompletionSource<NewConversationReply>();

        window.PickFolder = (_) => Task.FromResult<string?>("D:/git/support");
        hub.HoldNewConversation = answer;
        Choose(window, "New conversation in a folder…");

        // A row clicked meanwhile replaces New conversation in a folder, which then opens nothing over that row's window and shows nothing.
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
        Choose(window, "New conversation in a folder…");
        Assert.Equal(["D:/git/support"], actions.Folders);

        // A second replaces it and waits for the hub; the first then ends, and a third, chosen meanwhile, makes nothing.
        hub.HoldNewConversation = answer;
        Choose(window, "New conversation in a folder…");
        opening.SetResult(null);
        Dispatcher.UIThread.RunJobs();
        Choose(window, "New conversation in a folder…");

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
        Choose(window, "New conversation in a folder…");
        Assert.Empty(hub.Calls);

        folder = "D:/git/support";
        hub.NewConversationReplies.Enqueue(new NewConversationReply("New sessions need Code Mode (sessions.codeMode).", null, null));
        Choose(window, "New conversation in a folder…");

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
        var report = RowOf(window, "item:10").GetVisualDescendants().OfType<Button>().Single((button) => ToolTip.GetTip(button) as string == "Open report (reply.md)");

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

        var menu = icon.ContextMenu!;
        model.Show(Fixtures.View);
        Dispatcher.UIThread.RunJobs();

        Assert.False(menu.IsOpen);
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
        var menu = icon.ContextMenu;
        Assert.True(menu.IsOpen);

        window.KeyPressQwerty(PhysicalKey.Enter, RawInputModifiers.None);
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(["source personal True", "source personal True"], hub.Calls);
        window.KeyPressQwerty(PhysicalKey.Escape, RawInputModifiers.None);
        Dispatcher.UIThread.RunJobs();
        Assert.False(menu.IsOpen);
        Assert.True(icon.IsFocused);
    }

    [AvaloniaFact]
    public void Search_Text_ShowsOnlyMatchingRowsWithTheirGroupsOpen()
    {
        var (window, model) = Open();

        Click(window.FindControl<Button>("SearchButton")!);
        Search(window, "branch 108");
        Assert.Empty(VisibleTitles(window));

        Search(window, "gh 10");
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
        Search(window, "107-fix");
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
        Search(window, "107-fix");
        Assert.Equal(["Issue <7>"], VisibleTitles(window));

        Click(window.FindControl<Button>("ClearSearchButton")!);
        Assert.True(box.IsVisible);
        Assert.Equal("", model.Filter);
        Assert.Equal(8, VisibleTitles(window).Count);
        Assert.Equal("", box.Text);
        Assert.True(box.IsFocused);
    }

    [AvaloniaFact]
    public void Search_UnderThreeCharacters_ShowsEveryRow()
    {
        var (window, _) = Open();

        Click(window.FindControl<Button>("SearchButton")!);
        Search(window, "Is");

        Assert.Equal(8, VisibleTitles(window).Count);
        Assert.False(window.FindControl<StackPanel>("SearchEnd")!.IsVisible);
    }

    [AvaloniaFact]
    public void Search_ThreeCharacters_WaitsForTheLastKeyBeforeSearching()
    {
        var (window, model) = Open();
        var box = window.FindControl<TextBox>("SearchBox")!;

        Click(window.FindControl<Button>("SearchButton")!);
        box.Text = "107-f";
        time.Advance(DockViewModel.SearchDelay - TimeSpan.FromMilliseconds(1));
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(8, VisibleTitles(window).Count);

        // Another key restarts the wait, so the earlier text is never searched.
        box.Text = "107-fix";
        time.Advance(TimeSpan.FromMilliseconds(1));
        Dispatcher.UIThread.RunJobs();
        Assert.Equal("", model.Filter);
        Assert.Equal(8, VisibleTitles(window).Count);

        time.Advance(DockViewModel.SearchDelay);
        Dispatcher.UIThread.RunJobs();
        Assert.Equal("107-fix", model.Filter);
        Assert.Equal(["Issue <7>"], VisibleTitles(window));
    }

    [AvaloniaTheory]
    [InlineData("107")]
    [InlineData("gh 107")]
    [InlineData("#107")]
    [InlineData("PR #19002")]
    [InlineData("19002")]
    public void Search_TicketOrLinkKey_SearchesAtOnce(string key)
    {
        var (window, _) = Open();

        Click(window.FindControl<Button>("SearchButton")!);
        window.FindControl<TextBox>("SearchBox")!.Text = key;
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(["Issue <7>"], VisibleTitles(window));
    }

    static DockRow Older(string key, string title, string band) => Fixtures.Row("item:12") with { Key = key, Title = title, Search = $"{title} · Done", Band = band, Window = null };

    [AvaloniaFact]
    public void SearchRange_LastMonth_AsksTheHubAndShowsItsRowsUnderTheirMonth()
    {
        var (window, model) = Open();
        var range = window.FindControl<Button>("SearchRangeButton")!;

        Click(window.FindControl<Button>("SearchButton")!);
        Assert.True(range.IsVisible);
        Assert.Equal("Last 2 weeks", model.RangeText);
        Search(window, "rotate key");
        Assert.Empty(hub.Searches);
        Assert.True(window.FindControl<Button>("SearchFurtherButton")!.IsVisible);

        Click(range);
        range.ContextMenu!.Items.OfType<MenuItem>().Single((item) => (string)item.Header! == "Last month").RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        Assert.Equal([("rotate key", time.Now.AddMonths(-1).ToUnixTimeMilliseconds())], hub.Searches);
        Assert.Equal("Searching…", model.SearchNote);
        Assert.False(model.NoMatches);
        hub.AnswerSearch(new SearchReply(null, [Older("item:70", "Rotate the signing key", "October 2026")]));
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(["Rotate the signing key"], VisibleTitles(window));
        Assert.Equal(["October 2026"], model.Groups.Single((group) => group.Key == "done").Bands.Select((band) => band.Title));
        Assert.Null(model.SearchNote);
        // Not yet all time, so the end of the results still offers more.
        Assert.True(window.FindControl<Button>("SearchFurtherButton")!.IsVisible);

        // A new view keeps the rows while their search lasts; ending the search drops them and the range.
        model.Show(Fixtures.View with { Notes = ["changed"] });
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(["Rotate the signing key"], VisibleTitles(window));
        model.SearchOpen = false;
        Dispatcher.UIThread.RunJobs();
        Assert.Equal("Last 2 weeks", model.RangeText);
        Assert.DoesNotContain("Rotate the signing key", model.Groups.SelectMany((group) => group.AllRows).Select((row) => row.Title));
    }

    [AvaloniaFact]
    public void SearchRange_AnswerAfterANewerSearch_IsDropped()
    {
        var (window, model) = Open();

        Click(window.FindControl<Button>("SearchButton")!);
        model.Range = 3;
        Search(window, "rotate");
        Search(window, "rotate key");

        Assert.Equal([("rotate", 0L), ("rotate key", 0L)], hub.Searches);
        hub.AnswerSearch(new SearchReply(null, [Older("item:70", "Rotate stale", "October 2026")]));
        Dispatcher.UIThread.RunJobs();
        Assert.Empty(VisibleTitles(window));
        Assert.Equal("Searching…", model.SearchNote);

        hub.AnswerSearch(new SearchReply(null, [Older("item:71", "Rotate the signing key", "October 2026")], More: true));
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(["Rotate the signing key"], VisibleTitles(window));
        Assert.Equal("Showing the newest 1 matches from before the last 2 weeks. Add words to narrow the search.", model.SearchNote);
        Assert.False(window.FindControl<Button>("SearchFurtherButton")!.IsVisible);
    }

    [AvaloniaFact]
    public void Search_NothingFound_SaysWhereAndOffersFurtherBackAndAllTime()
    {
        var (window, model) = Open();
        var noMatch = window.FindControl<TextBlock>("NoMatchLine")!;

        Click(window.FindControl<Button>("SearchButton")!);
        Search(window, "zzznothing");

        Assert.True(noMatch.IsVisible);
        Assert.Equal("No matches for “zzznothing” in the last 2 weeks.", noMatch.Text);
        Assert.True(window.FindControl<Button>("SearchFurtherButton")!.IsVisible);
        Click(window.FindControl<Button>("SearchAllTimeButton")!);

        Assert.Equal("All time", model.RangeText);
        Assert.Equal([("zzznothing", 0L)], hub.Searches);
        Assert.False(noMatch.IsVisible);
        hub.AnswerSearch(new SearchReply(null, []));
        Dispatcher.UIThread.RunJobs();
        Assert.Equal("No matches for “zzznothing”.", noMatch.Text);
        Assert.True(noMatch.IsVisible);
        Assert.False(window.FindControl<Button>("SearchFurtherButton")!.IsVisible);
        Assert.False(window.FindControl<Button>("SearchAllTimeButton")!.IsVisible);
    }

    [AvaloniaFact]
    public void Search_HubRefuses_SaysSoAndKeepsTheListedMatches()
    {
        var (window, model) = Open();

        Click(window.FindControl<Button>("SearchButton")!);
        Search(window, "107-fix");
        Click(window.FindControl<Button>("SearchFurtherButton")!);
        hub.AnswerSearch(new SearchReply("Switchboard is not running.", []));
        Dispatcher.UIThread.RunJobs();

        Assert.Equal("Last month", model.RangeText);
        Assert.Equal(["Issue <7>"], VisibleTitles(window));
        Assert.Equal("The hub could not search further back: Switchboard is not running.", window.FindControl<TextBlock>("SearchNoteLine")!.Text);
    }

    [AvaloniaFact]
    public void Search_KeyRetypedWhileAnEarlierWaitFired_WaitsItsOwnDelay()
    {
        var (window, model) = Open();
        var box = window.FindControl<TextBox>("SearchBox")!;

        Click(window.FindControl<Button>("SearchButton")!);
        box.Text = "107-fix";
        // The wait ends and queues its search, but other keys come before the dock runs it.
        time.Advance(DockViewModel.SearchDelay);
        box.Text = "107-fi";
        box.Text = "107-fix";
        Dispatcher.UIThread.RunJobs();

        Assert.Equal("", model.Filter);
        time.Advance(DockViewModel.SearchDelay);
        Dispatcher.UIThread.RunJobs();
        Assert.Equal("107-fix", model.Filter);
    }

    [AvaloniaFact]
    public void Search_NumberOfNoListedRow_SearchesTheHubAtOnce()
    {
        var (window, model) = Open();

        Click(window.FindControl<Button>("SearchButton")!);
        model.Range = 3;
        window.FindControl<TextBox>("SearchBox")!.Text = "#42";
        Dispatcher.UIThread.RunJobs();

        Assert.Equal("42", model.Filter);
        Assert.Equal([("42", 0L)], hub.Searches);
    }

    [Fact]
    public void Sync_NarrowWidenOrReorder_ListsTheItemsInOrderKeepingThoseItCan()
    {
        var items = Enumerable.Range(0, 300).Select((index) => new object()).ToList();
        var target = new System.Collections.ObjectModel.ObservableCollection<object>(items);
        var first = items[0];
        var events = 0;

        target.CollectionChanged += (_, _) => events++;
        Lists.Sync(target, [items[0], items[2], items[3]]);
        Assert.Equal([items[0], items[2], items[3]], target);
        Assert.Same(first, target[0]);

        events = 0;
        Lists.Sync(target, [items[0], items[1], items[2], items[3]]);
        Assert.Equal(1, events);
        Assert.Equal(items.Take(4), target);

        Lists.Sync(target, items);
        Assert.Equal(items, target);

        Lists.Sync(target, [items[3], items[1]]);
        Assert.Equal([items[3], items[1]], target);
    }

    [AvaloniaFact]
    public void Search_Narrowed_KeepsTheRowsItStillShows()
    {
        var (window, model) = Open();

        model.Filter = "gh 10";
        Dispatcher.UIThread.RunJobs();
        var shown = RowOf(window, "item:7");

        model.Filter = "gh 107";
        Dispatcher.UIThread.RunJobs();

        Assert.Equal(["Issue <7>"], VisibleTitles(window));
        Assert.Same(shown, RowOf(window, "item:7"));
    }

    /// <summary>A Done group of &lt;paramref name="count"/&gt; finished rows in one band, the last being item 7's with its window.</summary>
    static DockView ManyDone(int count) =>
        Fixtures.View with
        {
            Groups =
            [
                .. Fixtures.View.Groups.Take(3),
                new DockGroup("done", "Done", null, [
                    .. Enumerable.Range(100, count - 1).Select((id) => Fixtures.Row("item:9") with { Key = $"item:{id}", Title = $"Finished {id}", Search = $"Finished {id}", Band = "Today", Window = null }),
                    Fixtures.Row("item:7") with { Key = "item:999", Title = "Finished last", Search = "Finished last", Band = "Today", Window = Fixtures.Row("item:7").Window! with { Name = "gh-999-000999" } },
                ]),
            ],
        };

    [AvaloniaFact]
    public void Search_HundredsOfDoneRows_DrawsOnlyTheRowsInView()
    {
        var (window, model) = Open(ManyDone(300));

        window.Height = 600;
        model.Filter = "finished";
        Dispatcher.UIThread.RunJobs();

        var done = model.Groups.Single((group) => group.Key == "done");
        var drawn = window.GetVisualDescendants().OfType<Border>().Count((border) => border.Classes.Contains("row") && border.DataContext is RowViewModel row && row.Title.StartsWith("Finished"));

        Assert.Equal(300, done.Rows.Count);
        Assert.InRange(drawn, 1, 60);
    }

    [AvaloniaFact]
    public void SelectWindow_DoneRowOutOfView_ScrollsItIntoView()
    {
        var (window, model) = Open(ManyDone(300));

        window.Height = 600;
        model.Filter = "finished";
        Dispatcher.UIThread.RunJobs();
        window.ShowForeground("Finished last · sb:gh-999-000999");
        Dispatcher.UIThread.RunJobs();

        var scroller = window.FindControl<ScrollViewer>("RowScroller")!;
        var row = RowOf(window, "item:999");
        var top = row.TranslatePoint(new Point(0, 0), scroller)!.Value.Y;

        Assert.Equal("item:999", model.Selected);
        Assert.InRange(top, 0, scroller.Viewport.Height - row.Bounds.Height);
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

    /// <summary>Types into the search box and waits out the search delay.</summary>
    void Search(Window window, string text)
    {
        window.FindControl<TextBox>("SearchBox")!.Text = text;
        time.Advance(DockViewModel.SearchDelay);
        Dispatcher.UIThread.RunJobs();
    }

    static Window DialogOf(Window window) => Assert.Single(window.OwnedWindows);

    static T Named<T>(Window dialog, string name) where T : Control => dialog.GetVisualDescendants().OfType<T>().Single((control) => control.Name == name);

    [AvaloniaFact]
    public void Adhoc_PromptCreated_PostsItUnstartedAndClosesTheDialog()
    {
        var (window, model) = Open();

        Choose(window, "New ad-hoc session…");
        var dialog = DialogOf(window);

        Assert.True(Named<ComboBox>(dialog, "AdhocRepoBox").IsVisible);
        Assert.False(Named<CheckBox>(dialog, "AdhocStartAutomatically").IsChecked);
        Assert.False(Named<Button>(dialog, "AdhocCreate").IsEnabled);

        Named<ComboBox>(dialog, "AdhocRepoBox").SelectedItem = "D:/git/support";
        Named<TextBox>(dialog, "AdhocPromptBox").Text = "Check the log";
        hub.ActReplies.Enqueue(null);
        Click(Named<Button>(dialog, "AdhocCreate"));

        Assert.Equal(["act {\"type\":\"adhoc\",\"prompt\":\"Check the log\",\"repoRoot\":\"D:/git/support\",\"start\":false,\"provider\":\"claude\"}"], hub.Calls);
        Assert.Empty(window.OwnedWindows);
        Assert.Equal("D:/git/support", model.AdhocRepo);
    }

    [AvaloniaFact]
    public void Adhoc_StartAutomaticallyChecked_PostsStart()
    {
        var (window, _) = Open();

        Choose(window, "New ad-hoc session…");
        var dialog = DialogOf(window);

        Named<TextBox>(dialog, "AdhocPromptBox").Text = "Check the log";
        Named<CheckBox>(dialog, "AdhocStartAutomatically").IsChecked = true;
        hub.ActReplies.Enqueue(null);
        Click(Named<Button>(dialog, "AdhocCreate"));

        Assert.Equal(["act {\"type\":\"adhoc\",\"prompt\":\"Check the log\",\"repoRoot\":\"D:/git/widgets\",\"start\":true,\"provider\":\"claude\"}"], hub.Calls);
        Assert.Empty(window.OwnedWindows);
    }

    [AvaloniaFact]
    public void Adhoc_ProviderChanged_PostsTheChoiceWithoutChangingTheDefault()
    {
        hub.DefaultProvider = "codex";
        var (window, _) = Open();
        Choose(window, "New ad-hoc session…");
        var dialog = DialogOf(window);
        var provider = Named<ComboBox>(dialog, "AdhocProvider");
        Assert.Equal("codex", ((ProviderDialog.Option)provider.SelectedItem!).Id);
        provider.SelectedIndex = 0;
        Named<TextBox>(dialog, "AdhocPromptBox").Text = "Check";
        hub.ActReplies.Enqueue(null);
        Click(Named<Button>(dialog, "AdhocCreate"));
        Assert.Contains("\"provider\":\"claude\"", Assert.Single(hub.Calls));
        Assert.Equal("codex", hub.DefaultProvider);
    }

    [AvaloniaFact]
    public void Adhoc_ProviderLookupFails_FallsBackToTheDefaultWithTheReasonBesideTheProvider()
    {
        hub.ProviderError = "Provider lookup failed.";
        var (window, _) = Open();
        Choose(window, "New ad-hoc session…");
        var dialog = DialogOf(window);
        var reason = Named<TextBlock>(dialog, "AdhocProviderError");

        Assert.True(Named<ComboBox>(dialog, "AdhocProvider").IsEnabled);
        Assert.True(reason.IsVisible);
        Assert.Equal("Provider lookup failed. Using Claude.", reason.Text);
        Assert.Contains(reason, Named<StackPanel>(dialog, "AdhocProviderField").Children);
        Assert.False(Named<TextBlock>(dialog, "AdhocError").IsVisible);

        Named<TextBox>(dialog, "AdhocPromptBox").Text = "Work";
        Assert.True(Named<Button>(dialog, "AdhocCreate").IsEnabled);
        hub.ActReplies.Enqueue(null);
        Click(Named<Button>(dialog, "AdhocCreate"));
        Assert.Equal(["act {\"type\":\"adhoc\",\"prompt\":\"Work\",\"repoRoot\":\"D:/git/widgets\",\"start\":false,\"provider\":\"claude\"}"], hub.Calls);
    }

    [AvaloniaFact]
    public void Adhoc_ProviderLookupFailsAfterItNamedCodex_FallsBackToCodexAsTheDefault()
    {
        hub.DefaultProvider = "codex";
        var (window, _) = Open();
        Choose(window, "New ad-hoc session…");
        Click(Named<Button>(DialogOf(window), "AdhocCancel"));

        hub.ProviderError = "Provider lookup failed.";
        Choose(window, "New ad-hoc session…");
        var dialog = DialogOf(window);

        Assert.Equal("codex", ((ProviderDialog.Option)Named<ComboBox>(dialog, "AdhocProvider").SelectedItem!).Id);
        Assert.Equal("Provider lookup failed. Using Codex, the default.", Named<TextBlock>(dialog, "AdhocProviderError").Text);
        Click(Named<Button>(dialog, "AdhocCancel"));
    }

    [AvaloniaFact]
    public void Adhoc_ProviderLookupFailsAfterNewSessionNamedCodex_FallsBackToCodex()
    {
        hub.DefaultProvider = "codex";
        var (window, _) = Open();
        window.PickFolder = (_) => Task.FromResult<string?>("D:/scratch");
        window.PickProvider = (_, _, _) => Task.FromResult<string?>(null);
        window.NewSession().GetAwaiter().GetResult();

        hub.ProviderError = "Provider lookup failed.";
        Choose(window, "New ad-hoc session…");
        var dialog = DialogOf(window);

        Assert.Equal("Provider lookup failed. Using Codex, the default.", Named<TextBlock>(dialog, "AdhocProviderError").Text);
        Click(Named<Button>(dialog, "AdhocCancel"));
    }

    [AvaloniaFact]
    public void Adhoc_Opened_FocusesTheFirstFieldThatShows()
    {
        var (window, _) = Open();
        Choose(window, "New ad-hoc session…");
        var dialog = DialogOf(window);

        Assert.Same(Named<ComboBox>(dialog, "AdhocRunBox"), dialog.FocusManager!.GetFocusedElement());
        Click(Named<Button>(dialog, "AdhocCancel"));

        var (other, _) = Open(Fixtures.View with { Schedules = [] });
        Choose(other, "New ad-hoc session…");
        var plain = DialogOf(other);

        Assert.Same(Named<ComboBox>(plain, "AdhocRepoBox"), plain.FocusManager!.GetFocusedElement());
        Click(Named<Button>(plain, "AdhocCancel"));
    }

    [AvaloniaFact]
    public void Adhoc_Fields_AreLabelledRunRepositoryProviderAndPrompt()
    {
        var (window, _) = Open();
        Choose(window, "New ad-hoc session…");
        var dialog = DialogOf(window);
        string? LabelOf(string field) => Named<StackPanel>(dialog, field).Children.OfType<TextBlock>().First().Text;

        Assert.Equal(["Run", "Repository", "Provider", "Prompt"], new[] { "AdhocRunField", "AdhocRepoField", "AdhocProviderField", "AdhocPromptField" }.Select(LabelOf));
        Click(Named<Button>(dialog, "AdhocCancel"));
    }

    [AvaloniaFact]
    public void Adhoc_ChooseAFolder_PicksAnyFolderPostsItAndOffersItAgain()
    {
        var (window, model) = Open();
        string? picked = "D:/scratch/tool";
        window.PickFolder = (_) => Task.FromResult<string?>(picked);

        Choose(window, "New ad-hoc session…");
        var dialog = DialogOf(window);
        var repos = Named<ComboBox>(dialog, "AdhocRepoBox");

        Assert.Equal(["D:/git/widgets", "D:/git/support", AdhocDialog.ChooseFolder], repos.ItemsSource!.Cast<string>());

        // A cancelled picker keeps the folder that was selected.
        picked = null;
        repos.SelectedItem = AdhocDialog.ChooseFolder;
        Dispatcher.UIThread.RunJobs();
        Assert.Equal("D:/git/widgets", repos.SelectedItem);

        picked = "D:/scratch/tool";
        repos.SelectedItem = AdhocDialog.ChooseFolder;
        Dispatcher.UIThread.RunJobs();
        Assert.Equal("D:/scratch/tool", repos.SelectedItem);
        Assert.Equal(["D:/scratch/tool"], model.Settings.RecentFolders);

        Named<TextBox>(dialog, "AdhocPromptBox").Text = "Check the tool";
        hub.ActReplies.Enqueue(null);
        Click(Named<Button>(dialog, "AdhocCreate"));
        Assert.Contains("\"repoRoot\":\"D:/scratch/tool\"", Assert.Single(hub.Calls));

        Choose(window, "New ad-hoc session…");
        var again = DialogOf(window);

        Assert.Equal(["D:/git/widgets", "D:/git/support", "D:/scratch/tool", AdhocDialog.ChooseFolder], Named<ComboBox>(again, "AdhocRepoBox").ItemsSource!.Cast<string>());
        Assert.Equal("D:/scratch/tool", Named<ComboBox>(again, "AdhocRepoBox").SelectedItem);
        Click(Named<Button>(again, "AdhocCancel"));
    }

    [AvaloniaFact]
    public void Adhoc_ScheduleChosen_RunsItNowWithoutAPrompt()
    {
        var (window, model) = Open();

        Choose(window, "New ad-hoc session…");
        var dialog = DialogOf(window);
        var run = Named<ComboBox>(dialog, "AdhocRunBox");

        Assert.True(run.IsVisible);
        Assert.Equal(["A prompt", "Run self-review now · ops:performance-review"], run.ItemsSource!.Cast<string>());

        run.SelectedIndex = 1;
        Dispatcher.UIThread.RunJobs();

        Assert.False(Named<StackPanel>(dialog, "AdhocPromptField").IsVisible);
        Assert.False(Named<StackPanel>(dialog, "AdhocRepoField").IsVisible);
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

        Choose(window, "New ad-hoc session…");
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
    public void Adhoc_NoRepoRootsOrSchedules_OffersOnlyChooseAFolder()
    {
        var (window, _) = Open(Fixtures.View with { RepoRoots = [], Schedules = [] });

        Choose(window, "New ad-hoc session…");
        var dialog = DialogOf(window);

        Assert.Equal([AdhocDialog.ChooseFolder], Named<ComboBox>(dialog, "AdhocRepoBox").ItemsSource!.Cast<string>());
        Named<TextBox>(dialog, "AdhocPromptBox").Text = "Check the log";
        Assert.False(Named<Button>(dialog, "AdhocCreate").IsEnabled);
        Click(Named<Button>(dialog, "AdhocCancel"));
    }

    [AvaloniaFact]
    public void Adhoc_Refused_KeepsTheDialogAndShowsTheReason()
    {
        var (window, model) = Open();

        Choose(window, "New ad-hoc session…");
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

        Choose(window, "New ad-hoc session…");
        var dialog = DialogOf(window);

        Named<TextBox>(dialog, "AdhocPromptBox").Text = "   ";
        Assert.False(Named<Button>(dialog, "AdhocCreate").IsEnabled);
        Click(Named<Button>(dialog, "AdhocCreate"));
        Click(Named<Button>(dialog, "AdhocCancel"));

        Assert.Empty(window.OwnedWindows);
        Assert.Empty(hub.Calls);
    }

    [AvaloniaFact]
    public void Adhoc_OneRepoRoot_SelectsItAndStillOffersChooseAFolder()
    {
        var (window, _) = Open(Fixtures.View with { RepoRoots = ["D:/git/widgets"] });

        Choose(window, "New ad-hoc session…");
        var dialog = DialogOf(window);

        Assert.True(Named<ComboBox>(dialog, "AdhocRepoBox").IsEffectivelyVisible);
        Assert.Equal("D:/git/widgets", Named<ComboBox>(dialog, "AdhocRepoBox").SelectedItem);
        Assert.Equal(["D:/git/widgets", AdhocDialog.ChooseFolder], Named<ComboBox>(dialog, "AdhocRepoBox").ItemsSource!.Cast<string>());
        Click(Named<Button>(dialog, "AdhocCancel"));
    }

    [AvaloniaFact]
    public void MoreActions_Clicked_OpensTheMenuGroupedWithSettingsLast()
    {
        var (window, _) = Open();
        var more = window.FindControl<Button>("MoreButton")!;

        Click(more);

        Assert.True(more.ContextMenu!.IsOpen);
        Assert.Equal(["New ad-hoc session…", "New conversation in a folder…", "", "Held sessions", "Ticket volume report", "", "Refresh sources", "Show hub log", "", "Open Settings"], more.ContextMenu.Items.OfType<Control>().Select((item) => item is MenuItem named ? (string)named.Header! : Assert.IsType<Separator>(item) is not null ? "" : "?"));
        Assert.All(more.ContextMenu.Items.OfType<MenuItem>(), (item) => Assert.NotNull(item.Icon));
    }

    [AvaloniaFact]
    public void MoreActions_NoZohoOrForumSource_OmitsTicketVolumeReport()
    {
        var (window, _) = Open(Fixtures.View with { Sources = [new SourceGroup("github", true, "github: polled", [new SourceState("github", true)])] });
        var more = window.FindControl<Button>("MoreButton")!;

        Click(more);

        Assert.Equal(["New ad-hoc session…", "New conversation in a folder…", "Held sessions", "Refresh sources", "Show hub log", "Open Settings"], more.ContextMenu!.Items.OfType<MenuItem>().Select((item) => (string)item.Header!));
    }

    [AvaloniaFact]
    public void RefreshSources_Chosen_PostsPoll()
    {
        var (window, model) = Open();

        Choose(window, "Refresh sources");

        Assert.Equal(["poll"], hub.Calls);
        Assert.Null(model.Status);
    }

    [AvaloniaFact]
    public void RefreshSources_Refused_ShowsTheHubsReason()
    {
        var (window, model) = Open();
        hub.PollReply = "No source is polled. Turn one on in the header.";

        Choose(window, "Refresh sources");

        Assert.Equal("No source is polled. Turn one on in the header.", model.Status);
    }

    [AvaloniaFact]
    public void ShowHubLog_Chosen_RunsTheLogCommandInTheVsCodeWindowUsedLast()
    {
        var (window, _) = Open();

        Choose(window, "Show hub log");

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
    public void LineThree_TwoDetails_SeparatesThemWithAMutedDot()
    {
        var snoozed = Fixtures.Row("item:8") with { Details = [new DockText("Wakes Oct 26", null, null), new DockText("Customer said they will reply", null, null)] };
        var (window, _) = Open(Fixtures.View with { Groups = [new DockGroup("blocked", "Blocked on you", null, [snoozed, Fixtures.Row("item:7")])] });
        var line = (string key) => RowOf(window, key).GetVisualDescendants().OfType<TextBlock>()
            .Where((text) => (text.Classes.Contains("detail") || text.Classes.Contains("detail-separator")) && text.IsEffectivelyVisible).Select((text) => text.Text).ToList();

        Assert.Equal(["Wakes Oct 26", "·", "Customer said they will reply"], line("item:8"));
        Assert.Equal(["Review the finished turn"], line("item:7"));
    }

    [AvaloniaFact]
    public void MenuOf_QuestionAndApprovalRows_OfferOpenInClaudeCopyAndOpenReport()
    {
        var (window, _) = Open();
        var headers = (DockRow row) => window.MenuOf(row).Select((item) => item is MenuItem named ? (string)named.Header! : "").ToList();

        Assert.Equal(["Open in Claude", "", "Stop", "", "Mark done", "Snooze…", "", "Add comment…", "", "Open in terminal", "History", "Open ticket", "", "Delete"], headers(Fixtures.Row("item:8")));
        Assert.Equal(["Approve", "", "Mark done", "Snooze…", "", "Add comment…", "", "Move to top", "Move up", "", "Copy Customer reply", "Open in terminal", "History", "Open report", "Open ticket", "", "Delete"], headers(Fixtures.Row("item:10")));

        var two = Fixtures.Row("item:10") with { Pastes = [new DockPaste("Customer reply", "a.md"), new DockPaste("Private note", "b.md")] };
        var copy = window.MenuOf(two).OfType<MenuItem>().Single((item) => (string?)item.Header == "Copy");

        Assert.Equal("Copy", copy.Header);
        Assert.Equal(["Customer reply", "Private note"], copy.ItemsSource!.Cast<MenuItem>().Select((item) => (string)item.Header!));
    }

    [AvaloniaFact]
    public void CopyButton_SeveralDrafts_SaysCopyADraft()
    {
        var view = Fixtures.View with
        {
            Groups = Fixtures.View.Groups.Select((group) => group with { Rows = group.Rows.Select((row) => row.Key == "item:10" ? row with { Pastes = [new DockPaste("Customer reply", "a.md"), new DockPaste("Private note", "b.md")] } : row).ToList() }).ToList(),
        };
        var (window, _) = Open(view);

        Assert.Single(RowOf(window, "item:10").GetVisualDescendants().OfType<Button>(), (button) => ToolTip.GetTip(button) as string == "Copy a draft…");
    }

    [AvaloniaFact]
    public void OpenSettings_NoConfigHub_SaysSwitchboardIsNotRunning()
    {
        var model = new DockViewModel(new DockSettings(), (_) => { });
        var window = new MainWindow(model, null, hub, actions, docked: false);

        model.Show(Fixtures.View);
        window.Show();
        Dispatcher.UIThread.RunJobs();
        Choose(window, "Open Settings");

        Assert.Equal("Switchboard is not running, so Settings cannot open.", model.Status);
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

        // Answer in terminal opens the same terminal, so there is no Open in terminal beside it.
        Assert.Equal(["Answer in terminal", "", "Stop", "", "Mark done", "Snooze…", "", "Add comment…", "", "History", "Open ticket", "", "Delete"], items.Select((item) => item is MenuItem named ? (string)named.Header! : "").ToList());

        Click(ButtonIn(RowOf(window, "item:8"), "main"));
        ((MenuItem)items[0]).RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));

        // Without the question, the menu's Open in terminal runs in the dock.
        var answered = review with { Main = null };
        window.MenuOf(answered).OfType<MenuItem>().Single((item) => (string?)item.Header == "Open in terminal").RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        await Task.Yield();
        Dispatcher.UIThread.RunJobs();

        Assert.Equal([review.Open, review.Open], actions.Clicked.Select((clicked) => clicked.Open));
        Assert.Equal([answered], actions.InTerminal);
        Assert.Empty(actions.Runs);
        Assert.Empty(hub.Calls);
    }

    [AvaloniaFact]
    public void MenuOf_LongLinkAndMoreThanTwoLinks_CutsTheLabelAndGroupsTheLinks()
    {
        var (window, _) = Open();
        var text = "the customer's reply drafted in the shared folder for review before sending";
        var draft = new DockLink(text, "https://example.test/draft");
        var one = window.MenuOf(Fixtures.Row("item:8") with { Links = [draft] }).OfType<MenuItem>().Single((item) => ((string)item.Header!).StartsWith("Open the", StringComparison.Ordinal));

        Assert.Equal(MainWindow.LinkLabelMax, ((string)one.Header!).Length);
        Assert.EndsWith("…", (string)one.Header!);
        Assert.Equal($"Open {text}", ToolTip.GetTip(one));

        var two = window.MenuOf(Fixtures.Row("item:8") with { Links = [new DockLink("PR #1", "https://example.test/1"), new DockLink("gh 2", "https://example.test/2")] });
        Assert.Equal(["Open ticket", "Open PR #1", "Open gh 2"], two.Select((item) => item is MenuItem named ? (string)named.Header! : "").SkipWhile((header) => header != "Open ticket").TakeWhile((header) => header != ""));

        var three = window.MenuOf(Fixtures.Row("item:8") with { Links = [new DockLink("PR #1", "https://example.test/1"), new DockLink("gh 2", "https://example.test/2"), draft] });
        var submenu = three.OfType<MenuItem>().Single((item) => (string?)item.Header == "Open link");
        var items = submenu.ItemsSource!.Cast<MenuItem>().ToList();

        Assert.Equal(["Open ticket", "Open link"], three.Select((item) => item is MenuItem named ? (string)named.Header! : "").SkipWhile((header) => header != "Open ticket").TakeWhile((header) => header != ""));
        Assert.Equal(["PR #1", "gh 2"], items.Take(2).Select((item) => (string)item.Header!));
        Assert.Equal(text, ToolTip.GetTip(items[2]));

        items[1].RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(["https://example.test/2"], actions.Urls);
    }

    [AvaloniaFact]
    public void MenuOf_AnswerInTerminalOpeningAnotherTerminal_KeepsOpenInTerminal()
    {
        var review = ReviewQuestion();
        var other = review with { Open = review.Open! with { Name = "gh-108-widgets-655280-bbbb2222" } };
        var (window, _) = Open(Fixtures.View with { Groups = [new DockGroup("blocked", "Blocked on you", null, [other])] });

        Assert.Contains(window.MenuOf(other).OfType<MenuItem>(), (item) => (string?)item.Header == "Open in terminal");
    }

    [AvaloniaFact]
    public async Task OpenInTerminal_RowOfferingBoth_ShowsOneItemThatLeavesTheChoiceToTheSwitcher()
    {
        var row = Fixtures.Row("item:8");
        var auto = row with { Terminal = new DockTerminal("claude", "aaaa1111-native", "D:/git/widgets", ["attach", "aaaa1111"], "gh-108-widgets-655280-aaaa1111", "Issue <8>") };
        var (window, _) = Open(Fixtures.View with { Groups = [new DockGroup("blocked", "Blocked on you", null, [auto])] });
        var items = window.MenuOf(auto);

        Assert.Equal(["Open in Claude", "", "Stop", "", "Mark done", "Snooze…", "", "Add comment…", "", "Open in terminal", "History", "Open ticket", "", "Delete"], items.Select((item) => item is MenuItem named ? (string)named.Header! : "").ToList());

        items.OfType<MenuItem>().Single((item) => (string?)item.Header == "Open in terminal").RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
        await Task.Yield();
        Dispatcher.UIThread.RunJobs();

        Assert.Equal([auto], actions.InTerminal);
        Assert.Empty(actions.Runs);
    }

    [AvaloniaFact]
    public void MenuOf_MainControlAndPromptBeforeStart_PutsTheMainActionFirstOnce()
    {
        var (window, _) = Open();
        string[] Headers(DockRow row) => window.MenuOf(row).Select((item) => item is MenuItem named ? (string)named.Header! : "").ToArray();
        var approve = Headers(Fixtures.Row("item:10"));
        var prompt = Headers(Fixtures.Row("item:8") with { Open = null, Main = "Open in terminal" });

        Assert.Equal(["Approve", ""], approve.Take(2));
        Assert.Single(approve, "Approve");
        Assert.Equal(["Open in terminal", ""], prompt.Take(2));
        Assert.Single(prompt, "Open in terminal");
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
    public async Task RowTap_OpenInWeb_OpensTheWorkItemInThePageAndAltTapInVsCode()
    {
        var (window, _) = Open(Fixtures.View with { OpenIn = "web" });

        Tap(window, RowOf(window, "item:10"));
        await Task.Yield();
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(["item:10"], actions.InPage.Select((row) => row.Key));
        Assert.Empty(actions.Clicked);

        Tap(window, RowOf(window, "item:8"), RawInputModifiers.Alt);
        await Task.Yield();
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(["item:8"], actions.Clicked.Select((row) => row.Key));
        Assert.Single(actions.InPage);
    }

    [AvaloniaFact]
    public async Task RowTap_OpenInVsCode_AltTapOpensTheWorkItemInThePage()
    {
        var (window, _) = Open();

        Tap(window, RowOf(window, "item:10"), RawInputModifiers.Alt);
        await Task.Yield();
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(["item:10"], actions.InPage.Select((row) => row.Key));
        Assert.Empty(actions.Clicked);
    }

    [AvaloniaFact]
    public async Task OpenInWeb_NeedsYouMessageAndForwardedClick_OpenThePageAndVsCode()
    {
        var (window, _) = Open(Fixtures.View with { OpenIn = "web" });

        window.ShowNeedsYou("item:8", "Switchboard: Fix it — Answer a question");
        Named<TextBlock>(window, "StatusLine").RaiseEvent(new TappedEventArgs(InputElement.TappedEvent, null!));
        await Task.Yield();
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(["item:8"], actions.InPage.Select((row) => row.Key));

        // VS Code forwards a click to the work in VS Code (PRD R69).
        window.ClickForwarded("item:10");
        await Task.Yield();
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(["item:10"], actions.Clicked.Select((row) => row.Key));
        Assert.Single(actions.InPage);
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

        Choose(window, "New ad-hoc session…");
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

        Choose(window, "New ad-hoc session…");
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
        Click(RowOf(window, "item:10").GetVisualDescendants().OfType<Button>().Single((button) => ToolTip.GetTip(button) as string == "Open report (reply.md)"));

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
