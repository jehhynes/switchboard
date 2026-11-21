using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Avalonia.VisualTree;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Views;

namespace Switchboard.Dock.Tests;

/// <summary>The held sessions window and the orphan note (PRD R94).</summary>
public sealed class HeldSessionsTests
{
    readonly FakeHub hub = new();
    readonly FakeActions actions = new();

    (MainWindow Window, DockViewModel Model) Open(DockView? view = null)
    {
        var model = new DockViewModel(new DockSettings(), (_) => { });
        var window = new MainWindow(model, null, hub, actions, docked: false);

        model.Show(view ?? Fixtures.View);
        window.Show();
        Dispatcher.UIThread.RunJobs();

        return (window, model);
    }

    static HeldSessionsWindow Held(MainWindow window)
    {
        var more = window.FindControl<Button>("MoreButton")!;

        more.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        Dispatcher.UIThread.RunJobs();
        more.ContextMenu!.Items.OfType<MenuItem>().Single((item) => (string)item.Header! == "Held sessions").RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent));
        Dispatcher.UIThread.RunJobs();

        return window.HeldWindow!;
    }

    static Button Tagged(Window window, string tag) => window.GetVisualDescendants().OfType<Button>().Single((button) => (string?)button.Tag == tag);

    static List<string?> Texts(Window window) => window.GetVisualDescendants().OfType<TextBlock>().Select((text) => text.Text).ToList();

    static void Click(Button button)
    {
        button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        Dispatcher.UIThread.RunJobs();
    }

    [AvaloniaFact]
    public void HeldSessions_ChosenFromMoreActions_ListsEachSessionOrphansFirstWithItsColumns()
    {
        var (window, _) = Open();
        var held = Held(window);
        var texts = Texts(held);

        Assert.True(texts.IndexOf("No work item") < texts.IndexOf("gh 115"));
        Assert.Contains("eeee5555-native", texts);
        Assert.Contains("2h 5m", texts);
        Assert.Contains("300 MB", texts);
        Assert.False(Tagged(held, "open:o1").IsEnabled);
        Assert.True(Tagged(held, "open:cm15").IsEnabled);
        Assert.True(Tagged(held, "stop:o1").IsEnabled);
        Assert.Same(held, Held(window));
        held.Close();
    }

    [AvaloniaFact]
    public void HeldSessions_OpenInTerminal_OpensTheAttachTerminalInTheTerminalApp()
    {
        var (window, _) = Open();
        var held = Held(window);

        actions.TerminalReply = "The terminal did not start: wt.exe was not found.";
        Click(Tagged(held, "open:cm15"));

        var opened = Assert.Single(actions.Terminals);

        Assert.Equal(("cm15", true), (opened.SessionId, opened.CodeMode));
        Assert.Equal(["attach", "cm15"], opened.Args);
        Assert.Contains(actions.TerminalReply, Texts(held));
        held.Close();
    }

    [AvaloniaFact]
    public void HeldSessions_StopCancelled_AsksNamingTheSessionAndPostsNothing()
    {
        var (window, _) = Open();
        var held = Held(window);
        List<string> asked = [];

        held.Confirm = (_, question, detail, action) =>
        {
            asked.Add($"{question} | {detail} | {action}");
            return Task.FromResult(false);
        };
        Click(Tagged(held, "stop:o1"));
        Click(Tagged(held, "stop:cm15"));

        Assert.Empty(hub.Calls);
        Assert.Equal(2, asked.Count);
        Assert.StartsWith("Stop held session o1? | Session o1 in ", asked[0]);
        Assert.EndsWith(" | Stop", asked[0]);
        Assert.StartsWith("Stop the held session of gh 115? | Session cm15 in ", asked[1]);
        held.Close();
    }

    [AvaloniaFact]
    public void HeldSessions_Stop_PostsTheSwitchboardIdAndShowsTheResultOrRefusal()
    {
        var (window, _) = Open();
        var held = Held(window);

        held.Confirm = (_, _, _, _) => Task.FromResult(true);
        Click(Tagged(held, "stop:o1"));
        Assert.Equal(["stop held o1"], hub.Calls);
        Assert.Contains("Stopped held session o1.", Texts(held));

        hub.StopReply = "No held session o1.";
        Click(Tagged(held, "stop:o1"));
        Assert.Contains("No held session o1.", Texts(held));
        held.Close();
    }

    [AvaloniaFact]
    public void HeldSessions_HubViewChanges_FollowsItAndDisablesStopOnAnExitedProcessWhateverItsState()
    {
        var (window, model) = Open();
        var held = Held(window);
        var exited = Fixtures.View.Held![0] with { State = "idle", Exited = true };

        model.Show(Fixtures.View with { Held = [exited], HeldNote = null });
        Dispatcher.UIThread.RunJobs();
        Assert.False(Tagged(held, "stop:o1").IsEnabled);
        Assert.DoesNotContain(held.GetVisualDescendants().OfType<Button>(), (button) => (string?)button.Tag == "stop:cm15");

        model.Show(Fixtures.View with { Held = null, HeldNote = null });
        Dispatcher.UIThread.RunJobs();
        Assert.Contains("No held sessions. Code Mode sessions appear here while the terminal holder keeps them.", Texts(held));
        held.Close();
    }

    [AvaloniaFact]
    public void HeldNote_OrphanHeld_CountsItAboveTheGroupsAndOpensTheWindow()
    {
        var (window, _) = Open();
        var note = window.FindControl<Button>("HeldNoteButton")!;

        Assert.True(note.IsVisible);
        Assert.Contains("1 held session without a work item", note.GetVisualDescendants().OfType<TextBlock>().Select((text) => text.Text));
        Assert.Null(window.HeldWindow);

        Click(note);
        Assert.NotNull(window.HeldWindow);
        window.HeldWindow!.Close();
    }

    static Button DialogButton(Window window, string name) => Assert.Single(window.OwnedWindows).GetVisualDescendants().OfType<Button>().Single((button) => button.Name == name);

    [AvaloniaFact]
    public void HolderNotice_RestartClicked_AsksTheHubsQuestionAndPostsOnlyAfterRestart()
    {
        var (window, _) = Open(Fixtures.HolderView);
        var restart = window.FindControl<Button>("HolderRestartButton")!;

        Assert.True(window.FindControl<StackPanel>("HolderNotice")!.IsVisible);
        Assert.Equal("The terminal holder is from an older build. Restart it to update (1 session will be resumed).", window.FindControl<TextBlock>("HolderNoticeLine")!.Text);
        Assert.True(restart.IsVisible);

        Click(restart);
        var texts = Assert.Single(window.OwnedWindows).GetVisualDescendants().OfType<TextBlock>().Select((text) => text.Text).ToList();

        Assert.Contains("Restart the terminal holder?", texts);
        Assert.Contains(texts, (text) => text?.Contains("not idle, so the restart interrupts its turn: Issue <15> (gh 115).", StringComparison.Ordinal) == true);
        Click(DialogButton(window, "ConfirmCancel"));
        Assert.Empty(hub.Calls);

        hub.RestartReply = "The terminal holder is already restarting.";
        Click(restart);
        Click(DialogButton(window, "ConfirmAction"));
        Assert.Equal([$"restart holder {Fixtures.HolderView.HolderNotice!.Confirm!.Detail}"], hub.Calls);
        Assert.Equal("The terminal holder is already restarting.", window.FindControl<TextBlock>("StatusLine")!.Text);
    }

    [AvaloniaFact]
    public void HolderNotice_Restarting_HidesTheButtonAndShowsTheResultUntilDismissed()
    {
        var (window, model) = Open(Fixtures.View with { HolderNotice = new DockHolderNotice("Restarting the terminal holder and resuming its sessions…", null) });

        Assert.False(window.FindControl<Button>("HolderRestartButton")!.IsVisible);
        Assert.False(window.FindControl<Grid>("HolderResult")!.IsVisible);

        var result = Fixtures.HolderView.HolderResult!;

        model.Show(Fixtures.View with { HolderResult = result });
        Dispatcher.UIThread.RunJobs();
        Assert.False(window.FindControl<StackPanel>("HolderNotice")!.IsVisible);
        Assert.True(window.FindControl<Grid>("HolderResult")!.IsVisible);
        Assert.Equal("The terminal holder restarted and 1 session resumed. 1 session did not resume: gh 109: Claude Code did not start.", window.FindControl<TextBlock>("HolderResultLine")!.Text);
        Assert.Contains("warning", window.FindControl<TextBlock>("HolderResultLine")!.Classes);

        Click(window.FindControl<Button>("DismissHolderResultButton")!);
        Assert.False(window.FindControl<Grid>("HolderResult")!.IsVisible);

        // The same result stays dismissed; a later restart's shows.
        model.Show(Fixtures.View with { HolderResult = result });
        Dispatcher.UIThread.RunJobs();
        Assert.False(window.FindControl<Grid>("HolderResult")!.IsVisible);
        model.Show(Fixtures.View with { HolderResult = result with { At = result.At + 1, Text = "The terminal holder restarted.", Failed = false } });
        Dispatcher.UIThread.RunJobs();
        Assert.True(window.FindControl<Grid>("HolderResult")!.IsVisible);
        Assert.DoesNotContain("warning", window.FindControl<TextBlock>("HolderResultLine")!.Classes);
    }

    [AvaloniaFact]
    public void HolderNotice_HolderCurrent_IsHidden()
    {
        var (window, _) = Open(Fixtures.View);

        Assert.False(window.FindControl<StackPanel>("HolderNotice")!.IsVisible);
        Assert.False(window.FindControl<Grid>("HolderResult")!.IsVisible);
    }

    [AvaloniaFact]
    public void HeldNote_NoOrphan_IsHidden()
    {
        var (window, _) = Open(Fixtures.View with { HeldNote = null });

        Assert.False(window.FindControl<Button>("HeldNoteButton")!.IsVisible);
    }
}
