using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Avalonia.VisualTree;
using Switchboard.Dock.Settings;
using Switchboard.Dock.Views;

namespace Switchboard.Dock.Tests;

public sealed class SettingsWindowTests
{
    readonly FakeConfigHub hub = new();
    readonly FakeActions actions = new();

    (SettingsWindow Window, SettingsEditor Editor) Open()
    {
        var editor = new SettingsEditor(hub, (_) => Task.CompletedTask);
        var window = new SettingsWindow(editor, actions);

        window.Show();
        editor.Load().GetAwaiter().GetResult();
        Settle();

        return (window, editor);
    }

    static void Settle()
    {
        for (var pass = 0; pass < 5; pass++)
        {
            Dispatcher.UIThread.RunJobs();
        }
    }

    static void Click(Button button)
    {
        button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        Settle();
    }

    static List<string> Texts(Control root) => root.GetVisualDescendants().OfType<TextBlock>().Where((text) => text.IsEffectivelyVisible && !string.IsNullOrEmpty(text.Text)).Select((text) => text.Text!).ToList();

    static Button NavButton(Window window, string page) => window.GetVisualDescendants().OfType<Button>().Single((button) => button.Classes.Contains("nav") && (string?)button.Tag == page);

    static Button PageButton(Window window, string command) => window.GetVisualDescendants().OfType<Button>().Single((button) => (string?)button.Tag == command);

    static T Field<T>(Window window, string path)
        where T : Control => window.GetVisualDescendants().OfType<T>().Single((control) => control.Name == $"field:{path}");

    [AvaloniaFact]
    public void Reload_WhileTyping_KeepsFocusAndCaretInTheField()
    {
        var (window, editor) = Open();
        var box = Field<TextBox>(window, "sessions.model");

        box.Focus();
        box.Text = "opus";
        box.SelectionStart = 2;
        box.SelectionEnd = 2;
        Settle();

        editor.Load().GetAwaiter().GetResult();
        Settle();

        var again = Field<TextBox>(window, "sessions.model");

        Assert.NotSame(box, again);
        Assert.True(again.IsFocused);
        Assert.Equal("opus", again.Text);
        Assert.Equal(2, again.SelectionStart);
    }

    [AvaloniaFact]
    public void Open_Files_ShowsTheGeneralPageWithItsValues()
    {
        var (window, _) = Open();
        var texts = Texts(window);

        Assert.Contains("Sessions and triage", texts);
        Assert.Contains("Concurrency", texts);
        Assert.Equal("2", Field<TextBox>(window, "sessions.concurrency").Text);
        Assert.Contains("+ Add Forum", texts);
        Assert.Contains("develop", texts);
        Assert.False(PageButton(window, "save").IsEnabled);
    }

    [AvaloniaFact]
    public void Edit_FieldTyped_EnablesSaveAndShowsTheCheckErrorUnderIt()
    {
        var (window, _) = Open();

        hub.CheckReplies.Enqueue(["sessions.concurrency must be 1 to 10."]);
        Field<TextBox>(window, "sessions.concurrency").Text = "11";
        Settle();

        var panel = window.GetVisualDescendants().OfType<StackPanel>().Single((stack) => (string?)stack.Tag == "sessions.concurrency");

        Assert.Contains("sessions.concurrency must be 1 to 10.", Texts(panel));
        Assert.True(PageButton(window, "save").IsEnabled);
        Assert.Contains(hub.Calls, (call) => call.Contains("\"concurrency\":11", StringComparison.Ordinal));
    }

    [AvaloniaFact]
    public void Save_HubRefuses_ShowsTheRefusalOnThePage()
    {
        var (window, _) = Open();

        Field<TextBox>(window, "sessions.concurrency").Text = "3";
        Settle();
        hub.SaveReplies.Enqueue(["settings.json changed on disk after the editor read it. Reload to see the change."]);
        Click(PageButton(window, "save"));

        Assert.Contains("settings.json changed on disk after the editor read it. Reload to see the change.", Texts(window));
        Assert.Contains(hub.Calls, (call) => call.StartsWith("save {\"target\":\"settings\"", StringComparison.Ordinal) && call.EndsWith("\"version\":\"v1\",\"configDir\":\"C:/cfg\"}", StringComparison.Ordinal));
    }

    [AvaloniaFact]
    public void Navigate_SourceAndPlaybook_ShowsTheirFields()
    {
        var (window, _) = Open();

        Click(NavButton(window, "source:github"));
        Assert.Equal("acme/widgets", Field<TextBox>(window, "sources.github.repo").Text);
        Assert.True(Field<CheckBox>(window, "sources.github.enabled").IsChecked);

        Click(NavButton(window, "playbook:dev:develop"));
        Assert.True(Field<CheckBox>(window, "reports.done").IsChecked);
        Assert.Equal("Do {{ticket.title}}.", Field<TextBox>(window, "template").Text);
        Assert.Contains("C:/cfg/playbooks/dev/develop.md", window.GetVisualDescendants().OfType<Button>().Select((button) => button.Content as string));
    }

    [AvaloniaFact]
    public void Edit_ApprovalReportChecked_DrawsApproveSends()
    {
        var (window, _) = Open();

        Click(NavButton(window, "playbook:dev:review"));
        Assert.DoesNotContain(window.GetVisualDescendants().OfType<CheckBox>(), (box) => box.Name == "field:approvalSends");

        Field<CheckBox>(window, "reports.approval").IsChecked = true;
        Settle();

        Assert.Single(window.GetVisualDescendants().OfType<CheckBox>(), (box) => box.Name == "field:approvalSends");
    }

    [AvaloniaFact]
    public void OpenFile_Clicked_OpensTheFileInVsCode()
    {
        var (window, _) = Open();

        actions.RunReply = "Open a VS Code window first; this runs in VS Code.";
        Click(window.GetVisualDescendants().OfType<Button>().Single((button) => button.Name == "OpenFile"));

        Assert.Equal(["none {\"type\":\"openUrl\",\"url\":\"C:/cfg/settings.json\"}"], actions.Runs);
        Assert.Equal("Open a VS Code window first; this runs in VS Code.", window.Status);
    }

    [AvaloniaFact]
    public void Delete_Clicked_AsksInADialogAndDeletesOnlyAfterDelete()
    {
        var (window, _) = Open();

        Click(NavButton(window, "playbook:dev:develop"));
        Click(PageButton(window, "delete"));

        var dialog = Assert.Single(window.OwnedWindows);

        Assert.Contains("2 open work items use it. Its file is deleted.", Texts(dialog));
        Assert.DoesNotContain(hub.Calls, (call) => call.StartsWith("delete", StringComparison.Ordinal));

        Click(dialog.GetVisualDescendants().OfType<Button>().Single((button) => button.Name == "ConfirmDelete"));

        Assert.Contains("delete dev:develop p1", hub.Calls);
    }

    [AvaloniaFact]
    public void Delete_DialogCancelled_DeletesNothing()
    {
        var (window, _) = Open();

        Click(NavButton(window, "playbook:dev:review"));
        Click(PageButton(window, "delete"));
        Click(Assert.Single(window.OwnedWindows).GetVisualDescendants().OfType<Button>().Single((button) => button.Name == "ConfirmCancel"));

        Assert.Empty(window.OwnedWindows);
        Assert.DoesNotContain(hub.Calls, (call) => call.StartsWith("delete", StringComparison.Ordinal));
    }

    [AvaloniaFact]
    public void Create_NameTyped_CreatesThePlaybookAndShowsIt()
    {
        var (window, _) = Open();

        Click(window.GetVisualDescendants().OfType<Button>().Single((button) => (string?)button.Tag == "new-playbook"));
        window.GetVisualDescendants().OfType<AutoCompleteBox>().Single().Text = "dev";
        window.GetVisualDescendants().OfType<TextBox>().Single((box) => box.Name == "NewName").Text = "fix-tests";
        Settle();
        hub.Config["playbooks"]!.AsArray().Add(new System.Text.Json.Nodes.JsonObject { ["name"] = "dev:fix-tests", ["path"] = "C:/cfg/playbooks/dev/fix-tests.md", ["version"] = "p9", ["playbook"] = SettingsConfigs.Playbook(), ["error"] = null });
        Click(PageButton(window, "create"));

        Assert.Contains(hub.Calls, (call) => call.StartsWith("save {\"target\":\"playbook\",\"name\":\"dev:fix-tests\"", StringComparison.Ordinal));
        Assert.Contains("C:/cfg/playbooks/dev/fix-tests.md", window.GetVisualDescendants().OfType<Button>().Select((button) => button.Content as string));
    }
}
