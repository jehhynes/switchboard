using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
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

    (SettingsWindow Window, SettingsEditor Editor) Open(Func<CancellationToken, Task>? delay = null, DockViewModel? dock = null)
    {
        var editor = new SettingsEditor(hub, delay ?? ((_) => Task.CompletedTask));
        var window = new SettingsWindow(editor, actions, dock ?? new DockViewModel(new DockSettings(), _ => { }));

        window.Show();
        editor.Load().GetAwaiter().GetResult();
        Settle();

        return (window, editor);
    }

    static ComboBox ThemeBox(Window window) => window.GetVisualDescendants().OfType<ComboBox>().Single(box => box.Name == "DockTheme");

    static void Settle()
    {
        for (var pass = 0; pass < 5; pass++)
        {
            Dispatcher.UIThread.RunJobs();
        }
    }

    [AvaloniaFact]
    public void Theme_EditAndSave_DraftsThenPersistsWithoutWritingHubSettings()
    {
        var saved = new List<string>();
        var dock = new DockViewModel(new DockSettings { Theme = "vscode" }, settings => saved.Add(settings.Theme));
        var (window, _) = Open(dock: dock);
        var closed = false;
        window.Closed += (_, _) => closed = true;
        var theme = ThemeBox(window);

        Assert.Equal(1, theme.SelectedIndex);
        Assert.Equal(["Follow the system theme", "Follow the VS Code theme", "Always light", "Always dark"], theme.Items.Cast<string>());
        theme.SelectedIndex = 2;
        Settle();
        Assert.Equal("vscode", dock.Theme);
        Assert.Contains("Unsaved changes", Texts(window));
        Assert.Contains(NavButton(window, "general").GetVisualDescendants().OfType<TextBlock>(), text => text.Classes.Contains("dirty"));
        Click(PageButton(window, "save"));

        Assert.Equal(["light"], saved);
        Assert.Equal("light", dock.Theme);
        Assert.Empty(hub.Saves);
        Assert.True(closed);
    }

    [AvaloniaFact]
    public void Theme_Discard_RestoresSavedChoice()
    {
        var dock = new DockViewModel(new DockSettings { Theme = "dark" }, _ => throw new InvalidOperationException("Unexpected save"));
        var (window, _) = Open(dock: dock);
        var closed = false;
        window.Closed += (_, _) => closed = true;
        ThemeBox(window).SelectedIndex = 2;
        Settle();
        Click(PageButton(window, "discard"));
        Assert.True(closed);
        Assert.Empty(window.OwnedWindows);
        Assert.Equal("dark", dock.Theme);
    }

    [AvaloniaFact]
    public void Theme_SaveFails_KeepsDraftAndPreviousTheme()
    {
        var dock = new DockViewModel(new DockSettings(), _ => throw new IOException("disk full"));
        var (window, _) = Open(dock: dock);
        var closed = false;
        window.Closed += (_, _) => closed = true;
        ThemeBox(window).SelectedIndex = 2;
        Click(PageButton(window, "save"));
        Assert.False(closed);
        Assert.Equal("system", dock.Theme);
        Assert.Equal(2, ThemeBox(window).SelectedIndex);
        Assert.Contains("The dock could not save its settings: disk full", Texts(window));
        Assert.True(PageButton(window, "save").IsEnabled);
    }

    [AvaloniaTheory]
    [InlineData("CloseSave", "light")]
    [InlineData("CloseDiscard", "system")]
    public void Theme_CloseWithChanges_AsksAndHonoursChoice(string choice, string expected)
    {
        var dock = new DockViewModel(new DockSettings(), _ => { });
        var (window, _) = Open(dock: dock);
        var closed = false;
        window.Closed += (_, _) => closed = true;
        ThemeBox(window).SelectedIndex = 2;
        window.Close();
        Settle();
        Assert.False(closed);
        Click(DialogButton(window, choice));
        Assert.True(closed);
        Assert.Equal(expected, dock.Theme);
    }

    [AvaloniaFact]
    public void Theme_ConfigSaveRefused_DoesNotSaveTheme()
    {
        var dock = new DockViewModel(new DockSettings(), _ => throw new InvalidOperationException("Unexpected save"));
        var (window, _) = Open(dock: dock);
        ThemeBox(window).SelectedIndex = 2;
        Field<TextBox>(window, "sessions.concurrency").Text = "3";
        Settle();
        hub.SaveReplies.Enqueue(["Settings changed on disk."]);
        Click(PageButton(window, "save"));
        Assert.Equal("system", dock.Theme);
        Assert.Contains("Settings changed on disk.", Texts(window));
    }

    [AvaloniaFact]
    public void Theme_EditedDuringSave_KeepsLaterChoiceUnsaved()
    {
        var saved = new List<string>();
        var dock = new DockViewModel(new DockSettings(), settings => saved.Add(settings.Theme));
        var (window, _) = Open(dock: dock);
        var closed = false;
        window.Closed += (_, _) => closed = true;
        ThemeBox(window).SelectedIndex = 2;
        Field<TextBox>(window, "sessions.concurrency").Text = "3";
        Settle();
        var release = new TaskCompletionSource();
        hub.HoldSave = () => release.Task;
        Click(PageButton(window, "save"));
        ThemeBox(window).SelectedIndex = 3;
        release.SetResult();
        Settle();
        Assert.Equal(["light"], saved);
        Assert.Equal("light", dock.Theme);
        Assert.False(closed);
        Assert.Equal(3, ThemeBox(window).SelectedIndex);
        Assert.True(PageButton(window, "save").IsEnabled);
        Assert.Contains("Unsaved changes", Texts(window));
        Click(PageButton(window, "save"));
        Assert.Equal(["light", "dark"], saved);
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
    public void Reload_FileChangedOnDisk_KeepsFocusAndCaretInTheField()
    {
        var (window, editor) = Open();
        var box = Field<TextBox>(window, "sessions.concurrency");

        SettingsConfigs.Value(hub.Config)["sessions"]!["model"] = "opus";
        Settle();
        box.Focus();
        box.SelectionStart = 1;
        box.SelectionEnd = 1;
        Settle();

        // Another field changed on disk, so the read redraws the page.
        hub.Config["settings"]!["version"] = "v2";
        editor.Load().GetAwaiter().GetResult();
        Settle();

        var again = Field<TextBox>(window, "sessions.concurrency");

        Assert.NotSame(box, again);
        Assert.True(again.IsFocused);
        Assert.Equal("opus", Field<TextBox>(window, "sessions.model").Text);
        Assert.Equal(1, again.SelectionStart);
    }

    [AvaloniaFact]
    public void Open_Files_ShowsTheGeneralPageWithItsValues()
    {
        var (window, _) = Open();
        var texts = Texts(window);

        Assert.Contains("General", texts);
        Assert.Contains("Concurrency", texts);
        Assert.Equal("2", Field<TextBox>(window, "sessions.concurrency").Text);
        Assert.Contains("+ New Forum source", texts);
        Assert.Contains("develop", texts);
        Assert.Contains("VOICE", texts);
        Assert.DoesNotContain("Appearance", texts);
        Assert.False(Field<TextBox>(window, "sessions.nodePath").IsEffectivelyVisible);
        Click(window.GetVisualDescendants().OfType<Button>().Single((button) => button.Name == "section:Advanced"));
        Assert.True(Field<TextBox>(window, "sessions.nodePath").IsEffectivelyVisible);

        // The dock theme, kept in dock.json, is the first row of the Dock section.
        var themeRow = (Control)ThemeBox(window).Parent!;
        var dockRows = (StackPanel)themeRow.Parent!;
        Assert.Same(themeRow, dockRows.Children[0]);
        Assert.Same(dockRows, Field<ComboBox>(window, "dock.openVSCode").Parent!.Parent!.Parent);
        Assert.False(PageButton(window, "save").IsEnabled);
        Assert.False(PageButton(window, "discard").IsEnabled);
        Assert.Equal("Saved", FileStatus(window));
    }

    [AvaloniaFact]
    public void Edit_FieldTyped_EnablesSaveAndShowsTheCheckErrorUnderItWithoutSaving()
    {
        var (window, _) = Open();

        hub.CheckReplies.Enqueue(["sessions.concurrency must be 1 to 10."]);
        Field<TextBox>(window, "sessions.concurrency").Text = "11";
        Settle();

        var panel = window.GetVisualDescendants().OfType<StackPanel>().Single((stack) => (string?)stack.Tag == "sessions.concurrency");

        Assert.Contains("sessions.concurrency must be 1 to 10.", Texts(panel));
        Assert.True(PageButton(window, "save").IsEnabled);
        Assert.True(PageButton(window, "discard").IsEnabled);
        Assert.Equal("Unsaved changes · 1 error", FileStatus(window));
        Assert.Contains(window.GetVisualDescendants().OfType<Button>(), (button) => (string?)button.Tag == "general" && Texts(button).Contains("●"));
        Assert.Contains(hub.Calls, (call) => call.Contains("\"concurrency\":11", StringComparison.Ordinal));
        Assert.DoesNotContain(hub.Calls, (call) => call.StartsWith("save", StringComparison.Ordinal));
    }

    [AvaloniaFact]
    public void Save_Clicked_SavesTheFile()
    {
        var (window, editor) = Open();

        Field<TextBox>(window, "sessions.concurrency").Text = "3";
        Settle();
        Assert.Empty(hub.Saves);

        Click(PageButton(window, "save"));

        Assert.StartsWith("save {\"value\":{\"sessions\":{\"concurrency\":3}", Assert.Single(hub.Saves));
        Assert.False(editor.State!.Dirty);
        Assert.Equal("Saved", FileStatus(window));
        Assert.False(PageButton(window, "save").IsEnabled);
    }

    [AvaloniaFact]
    public void CodeMode_CheckedAndSaved_WritesSessionsCodeModeTrue()
    {
        var (window, _) = Open();
        var box = Field<CheckBox>(window, "sessions.codeMode");

        Assert.False(box.IsChecked);
        box.IsChecked = true;
        Settle();
        Click(PageButton(window, "save"));

        Assert.StartsWith("save {\"value\":{\"sessions\":{\"concurrency\":2,\"codeMode\":true}", Assert.Single(hub.Saves));
    }

    [AvaloniaFact]
    public void CtrlS_InATextBox_SavesTheFile()
    {
        var (window, _) = Open();
        var closed = false;
        var box = Field<TextBox>(window, "sessions.concurrency");

        window.Closed += (_, _) => closed = true;
        box.Text = "3";
        box.Focus();
        Settle();
        box.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.S, KeyModifiers = KeyModifiers.Control });
        Settle();

        Assert.Single(hub.Saves);
        Assert.Equal("Saved", FileStatus(window));
        Assert.False(closed);
    }

    [AvaloniaFact]
    public void Save_HubRefuses_ShowsTheRefusalInTheBarUntilTheNextEdit()
    {
        var (window, _) = Open();

        hub.SaveReplies.Enqueue(["Switchboard is not running."]);
        Field<TextBox>(window, "sessions.concurrency").Text = "3";
        Settle();
        Click(PageButton(window, "save"));

        var bar = window.GetVisualDescendants().OfType<StackPanel>().Single((panel) => panel.Name == "BarErrors");

        Assert.Equal(["Switchboard is not running."], Texts(bar));
        Assert.Equal("Unsaved changes", FileStatus(window));

        Field<TextBox>(window, "sessions.concurrency").Text = "4";
        Settle();

        Assert.Empty(Texts(bar));
    }

    [AvaloniaFact]
    public void Discard_Clicked_ClosesWithoutAskingOrSaving()
    {
        var (window, closed) = Changed(close: false);

        Click(PageButton(window, "discard"));

        Assert.True(closed());
        Assert.Empty(window.OwnedWindows);
        Assert.Empty(hub.Saves);
    }

    [AvaloniaFact]
    public void Save_Clicked_SavesAndCloses()
    {
        var (window, closed) = Changed(close: false);

        Click(PageButton(window, "save"));

        Assert.True(closed());
        Assert.Contains("\"concurrency\":3", Assert.Single(hub.Saves));
    }

    [AvaloniaFact]
    public void Save_FinishesAfterCloseKeepEditing_StaysOpen()
    {
        var (window, closed) = Changed(close: false);
        var release = new TaskCompletionSource();

        hub.HoldSave = () => release.Task;
        Click(PageButton(window, "save"));
        window.Close();
        Settle();
        Click(DialogButton(window, "CloseKeep"));
        release.SetResult();
        Settle();

        Assert.False(closed());
        Assert.Single(hub.Saves);
        Assert.Equal("Saved", FileStatus(window));
    }

    [AvaloniaFact]
    public void Save_FinishesWhileCloseAsks_LeavesTheQuestionOpen()
    {
        var (window, closed) = Changed(close: false);
        var release = new TaskCompletionSource();

        hub.HoldSave = () => release.Task;
        Click(PageButton(window, "save"));
        window.Close();
        Settle();
        release.SetResult();
        Settle();

        Assert.False(closed());
        Assert.Single(window.OwnedWindows);
    }

    [AvaloniaFact]
    public void Save_ClickedAndRefused_StaysOpenAndShowsWhy()
    {
        var (window, closed) = Changed(close: false);

        hub.SaveReplies.Enqueue(["Switchboard is not running."]);
        Click(PageButton(window, "save"));

        Assert.False(closed());
        Assert.Contains("Switchboard is not running.", Texts(window));
    }

    [AvaloniaFact]
    public void Navigate_SourceAndPlaybook_ShowsTheirFields()
    {
        var (window, _) = Open();

        Click(NavButton(window, "source:github"));
        Assert.Equal("acme/widgets", Field<TextBox>(window, "sources.github.repo").Text);
        Assert.DoesNotContain(window.GetVisualDescendants().OfType<Control>(), (control) => control.Name == "field:sources.github.enabled");

        Click(NavButton(window, "playbook:dev:develop"));
        Assert.True(Field<CheckBox>(window, "reports.done").IsChecked);
        Assert.Equal("Do {{ticket.title}}.", Field<TextBox>(window, "template").Text);
        Assert.Contains("C:/cfg/settings.json", window.GetVisualDescendants().OfType<Button>().Select((button) => button.Content as string));
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
    public void Fields_WithAndWithoutHelp_ShowTheHelpOnlyInAnInfoTooltip()
    {
        var (window, _) = Open();
        var rows = window.GetVisualDescendants().OfType<Grid>().Where((grid) => grid.Children.OfType<StackPanel>().Any((panel) => panel.Tag is string)).ToDictionary((grid) => (string)grid.Children.OfType<StackPanel>().First((panel) => panel.Tag is string).Tag!);
        var info = rows["sessions.concurrency"].GetVisualDescendants().OfType<TextBlock>().Single((text) => text.Classes.Contains("info"));

        Assert.Equal("Sessions that run at once, 1 to 10. A start with no free slot waits as queued.", ((TextBlock)ToolTip.GetTip(info)!).Text);
        Assert.DoesNotContain("Sessions that run at once, 1 to 10. A start with no free slot waits as queued.", Texts(window));
        Assert.DoesNotContain(rows["triage.timeoutSeconds"].GetVisualDescendants().OfType<TextBlock>(), (text) => text.Classes.Contains("info"));
    }

    [AvaloniaFact]
    public void Advanced_FieldGetsAnError_OpensTheCollapsedSection()
    {
        var (window, _) = Open();

        Click(NavButton(window, "source:github"));

        var gh = Field<TextBox>(window, "sources.github.ghPath");

        Assert.False(gh.IsEffectivelyVisible);

        Click(window.GetVisualDescendants().OfType<Button>().Single((button) => button.Name == "section:Advanced"));
        Assert.True(gh.IsEffectivelyVisible);
        Click(window.GetVisualDescendants().OfType<Button>().Single((button) => button.Name == "section:Advanced"));
        Assert.False(gh.IsEffectivelyVisible);

        hub.CheckReplies.Enqueue(["sources.github.maxPages must be a positive whole number."]);
        Field<TextBox>(window, "sources.github.repo").Text = "a/b";
        Settle();

        Assert.True(Field<TextBox>(window, "sources.github.maxPages").IsEffectivelyVisible);
        Assert.Contains("sources.github.maxPages must be a positive whole number.", Texts(window));

        // Closed again, it stays closed while the same error remains.
        Click(window.GetVisualDescendants().OfType<Button>().Single((button) => button.Name == "section:Advanced"));
        hub.CheckReplies.Enqueue(["sources.github.maxPages must be a positive whole number."]);
        Field<TextBox>(window, "sources.github.repo").Text = "a/c";
        Settle();

        Assert.False(Field<TextBox>(window, "sources.github.maxPages").IsEffectivelyVisible);
    }

    [AvaloniaFact]
    public void MultilineFields_Drawn_GrowToALineLimitThenScroll()
    {
        var (window, _) = Open();

        Click(NavButton(window, "source:github"));
        Assert.Equal(20, Field<TextBox>(window, "sources.github.setupPrompt").MaxLines);
        Assert.Equal(8, Field<TextBox>(window, "sources.github.logins").MaxLines);
        Assert.Equal(0, Field<TextBox>(window, "sources.github.repo").MaxLines);

        Click(NavButton(window, "playbook:dev:develop"));

        var template = Field<TextBox>(window, "template");

        Assert.Equal(20, template.MaxLines);
        Assert.True(double.IsNaN(template.Height));
        Assert.True(template.MinHeight < 52);
    }

    [AvaloniaFact]
    public void Advanced_Opened_StaysOpenAfterAReload()
    {
        var (window, editor) = Open();

        Click(NavButton(window, "source:github"));
        Click(window.GetVisualDescendants().OfType<Button>().Single((button) => button.Name == "section:Advanced"));
        editor.Load().GetAwaiter().GetResult();
        Settle();

        Assert.True(Field<TextBox>(window, "sources.github.ghPath").IsEffectivelyVisible);
    }

    [AvaloniaFact]
    public void NamespacePage_CellClicked_DraftsThatPlaybookAndTheNameOpensIt()
    {
        var (window, editor) = Open();

        Click(NavButton(window, "namespace:dev"));
        Assert.True(Cell(window, "dev:develop", "reports.done").IsChecked);
        Assert.False(Cell(window, "dev:review", "approvalSends").IsEnabled);
        var sends = Cell(window, "dev:review", "approvalSends");

        hub.CheckReplies.Enqueue(["playbooks.dev:review: description is required."]);
        Cell(window, "dev:review", "reports.approval").IsChecked = true;
        Settle();

        Assert.True(editor.State!.PlaybookDirty("dev:review"));
        Assert.Same(sends, Cell(window, "dev:review", "approvalSends"));
        Assert.True(sends.IsEnabled);
        Assert.Contains("description is required.", Texts(window.GetVisualDescendants().OfType<StackPanel>().Single((panel) => (string?)panel.Tag == "dev:review")));
        Assert.Equal("Unsaved changes · 1 error", FileStatus(window));
        Assert.Contains(window.GetVisualDescendants().OfType<TextBlock>(), (text) => text.Classes.Contains("dirty") && text.IsEffectivelyVisible);
        Assert.Empty(hub.Saves);

        Click(window.GetVisualDescendants().OfType<Button>().Single((button) => button.Name == "open:dev:review"));
        Assert.Equal("playbook:dev:review", editor.State.Page);
        Assert.True(Field<CheckBox>(window, "reports.approval").IsChecked);
    }

    static string? FileStatus(Window window) => window.GetVisualDescendants().OfType<TextBlock>().Single((text) => text.Name == "FileStatus").Text;

    static Button DialogButton(Window window, string name) => Assert.Single(window.OwnedWindows).GetVisualDescendants().OfType<Button>().Single((button) => button.Name == name);

    /// <summary>A window with an unsaved change, closed with its close button unless told not to, and a flag that turns true when it closes.</summary>
    (SettingsWindow Window, Func<bool> Closed) Changed(bool close = true)
    {
        var (window, _) = Open();
        var closed = false;

        window.Closed += (_, _) => closed = true;
        Field<TextBox>(window, "sessions.concurrency").Text = "3";
        Settle();

        if (close)
        {
            window.Close();
            Settle();
        }

        return (window, () => closed);
    }

    [AvaloniaFact]
    public void Close_NoChanges_ClosesWithoutAsking()
    {
        var (window, _) = Open();
        var closed = false;

        window.Closed += (_, _) => closed = true;
        window.Close();
        Settle();

        Assert.True(closed);
        Assert.Empty(window.OwnedWindows);
    }

    [AvaloniaFact]
    public void Close_ChangesKeepEditing_StaysOpenWithTheDraft()
    {
        var (window, closed) = Changed();

        Assert.Contains("Save changes to settings?", Texts(Assert.Single(window.OwnedWindows)));
        Click(DialogButton(window, "CloseKeep"));

        Assert.False(closed());
        Assert.Equal("3", Field<TextBox>(window, "sessions.concurrency").Text);
        Assert.Empty(hub.Saves);
    }

    [AvaloniaFact]
    public void Close_ChangesDiscard_ClosesWithoutSaving()
    {
        var (window, closed) = Changed();

        Click(DialogButton(window, "CloseDiscard"));

        Assert.True(closed());
        Assert.Empty(hub.Saves);
    }

    [AvaloniaFact]
    public void Close_ChangesSave_SavesAndCloses()
    {
        var (window, closed) = Changed();

        Click(DialogButton(window, "CloseSave"));

        Assert.True(closed());
        Assert.Contains("\"concurrency\":3", Assert.Single(hub.Saves));
    }

    [AvaloniaFact]
    public void Close_ChangesSaveRefused_StaysOpenAndShowsWhy()
    {
        var (window, closed) = Changed();

        hub.SaveReplies.Enqueue(["Switchboard is not running."]);
        Click(DialogButton(window, "CloseSave"));

        Assert.False(closed());
        Assert.Contains("Switchboard is not running.", Texts(window));
    }

    [AvaloniaFact]
    public void Close_SaveChosenWhileASaveIsInFlight_WaitsForItAndCloses()
    {
        var (window, _) = Open();
        var release = new TaskCompletionSource();
        var closed = false;

        window.Closed += (_, _) => closed = true;
        Field<TextBox>(window, "sessions.concurrency").Text = "3";
        Settle();
        hub.HoldSave = () => release.Task;
        Click(PageButton(window, "save"));
        window.Close();
        Settle();
        Click(DialogButton(window, "CloseSave"));
        Assert.False(closed);

        hub.HoldSave = null;
        release.SetResult();
        Settle();

        Assert.True(closed);
        Assert.Single(hub.Saves);
    }

    [AvaloniaFact]
    public void Close_ClickedAgainWhileAsking_AsksOnce()
    {
        var (window, _) = Changed();

        window.Close();
        Settle();

        Assert.Single(window.OwnedWindows);
    }

    [Theory]
    [InlineData("a\r\nb\r\nXY", 6, 4)]
    [InlineData("a\nb\nXY", 4, 4)]
    [InlineData("", 3, 0)]
    public void Logical_CaretAcrossCrLf_MapsBackToTheSameCharacter(string text, int index, int logical)
    {
        Assert.Equal(logical, SettingsWindow.Logical(text, index));
        Assert.Equal(Math.Min(index, text.Length), SettingsWindow.Physical(text, logical));
    }

    static CheckBox Cell(Window window, string playbook, string path) => window.GetVisualDescendants().OfType<CheckBox>().Single((box) => box.Name == $"cell:{playbook}:{path}");

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
    public void Delete_Clicked_AsksInADialogAndRemovesItFromTheDraftOnlyAfterDelete()
    {
        var (window, _) = Open();

        Click(NavButton(window, "playbook:dev:develop"));
        Click(PageButton(window, "delete"));

        var dialog = Assert.Single(window.OwnedWindows);

        Assert.Contains("2 open work items use it. Save removes it from settings.json.", Texts(dialog));

        Click(dialog.GetVisualDescendants().OfType<Button>().Single((button) => button.Name == "ConfirmAction"));

        Assert.DoesNotContain(window.GetVisualDescendants().OfType<Button>(), (button) => (string?)button.Tag == "playbook:dev:develop");
        Assert.Equal("Unsaved changes", FileStatus(window));
        Assert.Empty(hub.Saves);
    }

    [AvaloniaFact]
    public void Delete_DialogCancelled_DeletesNothing()
    {
        var (window, _) = Open();

        Click(NavButton(window, "playbook:dev:review"));
        Click(PageButton(window, "delete"));
        Click(Assert.Single(window.OwnedWindows).GetVisualDescendants().OfType<Button>().Single((button) => button.Name == "ConfirmCancel"));

        Assert.Empty(window.OwnedWindows);
        Assert.NotNull(NavButton(window, "playbook:dev:review"));
        Assert.Equal("Saved", FileStatus(window));
    }

    [AvaloniaFact]
    public void Create_NameTyped_AddsThePlaybookToTheDraftAndShowsIt()
    {
        var (window, _) = Open();

        Click(window.GetVisualDescendants().OfType<Button>().Single((button) => (string?)button.Tag == "new-playbook"));
        window.GetVisualDescendants().OfType<AutoCompleteBox>().Single().Text = "dev";
        window.GetVisualDescendants().OfType<TextBox>().Single((box) => box.Name == "NewName").Text = "fix-tests";
        Settle();
        Click(PageButton(window, "create"));

        Assert.Contains("current", NavButton(window, "playbook:dev:fix-tests").Classes);
        Assert.Contains("●", Texts(NavButton(window, "playbook:dev:fix-tests")));
        Assert.NotNull(Field<TextBox>(window, "template"));
        Assert.Empty(hub.Saves);
    }

    [AvaloniaFact]
    public void NewSource_KindAndNameCreated_OpensTheSourcePageWithTheKindsFields()
    {
        var (window, _) = Open();

        Click(window.GetVisualDescendants().OfType<Button>().Single((button) => (string?)button.Tag == "new-source"));
        window.GetVisualDescendants().OfType<ComboBox>().Single((box) => box.Name == "NewKind").SelectedIndex = 0;
        window.GetVisualDescendants().OfType<TextBox>().Single((box) => box.Name == "NewName").Text = "widgets-dashboard";
        Settle();
        Click(PageButton(window, "create"));

        Assert.Contains("current", NavButton(window, "source:widgets-dashboard").Classes);
        Assert.Contains("widgets-dashboard (GitHub)", Texts(NavButton(window, "source:widgets-dashboard")));
        Assert.NotNull(Field<TextBox>(window, "sources.widgets-dashboard.repo"));
        Assert.Empty(hub.Saves);
    }

    [AvaloniaFact]
    public void RemoveSource_Clicked_RemovesItWithoutAskingAndDiscardRestoresIt()
    {
        var (window, _) = Open();

        Click(NavButton(window, "source:github"));
        Click(PageButton(window, "remove-source"));

        Assert.Empty(window.OwnedWindows);
        Assert.DoesNotContain(window.GetVisualDescendants().OfType<Button>(), (button) => (string?)button.Tag == "source:github");

        var closed = false;
        window.Closed += (_, _) => closed = true;
        Click(PageButton(window, "discard"));

        Assert.True(closed);
        Assert.Empty(hub.Saves);
    }
}
