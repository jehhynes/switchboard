using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.LogicalTree;
using Avalonia.Media;
using Avalonia.Threading;
using Switchboard.Dock.Settings;
using Switchboard.Dock.Switching;

namespace Switchboard.Dock.Views;

/// <summary>
/// The Settings window (PRD R54): the navigation on the left, the page on the right. It draws what <see cref="SettingsPages"/> gives for the
/// editor's state; while the operator types it updates only the navigation, buttons, notes and errors, so the field keeps focus.
/// </summary>
public sealed class SettingsWindow : Window
{
    readonly SettingsEditor editor;
    readonly IDockActions actions;
    readonly StackPanel nav = new() { Margin = new Thickness(8), Spacing = 2 };
    readonly StackPanel page = new() { Margin = new Thickness(16, 12), Spacing = 10 };
    readonly TextBlock status = new() { Name = "SettingsStatus", Margin = new Thickness(16, 6), TextWrapping = TextWrapping.Wrap, IsVisible = false };
    // The parts of the drawn page that an update changes in place.
    StackPanel buttons = new();
    // Set once the window may close without asking again, and while a close waits for saves or an answer.
    bool closing;
    bool asking;
    StackPanel notes = new();
    StackPanel errors = new();
    readonly Decorator table = new();
    readonly Dictionary<string, StackPanel> fieldErrors = [];
    // Opens the Advanced section that holds a field, by the field's path.
    readonly Dictionary<string, Action> advanced = [];
    // The Advanced sections the operator opened, by page, so a redraw keeps them open.
    readonly HashSet<string> opened = [];
    // The fields that had errors at the last update.
    readonly HashSet<string> erred = [];
    // The drawn table's shape and its controls, which an update changes in place.
    string? tableShape;
    readonly Dictionary<string, Action<TableCell>> cells = [];
    readonly Dictionary<string, (TextBlock Dot, StackPanel Errors)> tableRows = [];

    public SettingsWindow(SettingsEditor editor, IDockActions actions)
    {
        this.editor = editor;
        this.actions = actions;
        Title = "Switchboard Settings";
        Icon = new WindowIcon(Avalonia.Platform.AssetLoader.Open(new Uri("avares://Switchboard.Dock/Assets/dock.ico")));
        Width = 980;
        Height = 700;
        FontFamily = new FontFamily("Segoe UI");
        FontSize = 13;
        this.Bind(BackgroundProperty, this.GetResourceObservable("DockBackground"));
        this.Bind(ForegroundProperty, this.GetResourceObservable("DockForeground"));
        editor.Confirm ??= (question, detail, action) => Ask(question, detail, action);
        Closing += OnClosing;

        var navScroll = new ScrollViewer { Content = nav, Width = 210 };
        var pageScroll = new ScrollViewer { Name = "PageScroller", Content = page, HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled };
        var right = new DockPanel();

        DockPanel.SetDock(status, Avalonia.Controls.Dock.Bottom);
        right.Children.Add(status);
        right.Children.Add(pageScroll);

        var root = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*") };

        navScroll.Bind(BorderBrushProperty, this.GetResourceObservable("DockBorder"));
        Grid.SetColumn(right, 1);
        root.Children.Add(navScroll);
        root.Children.Add(right);
        Content = root;

        editor.Changed += (redraw) => Dispatcher.UIThread.Post(() =>
        {
            if (redraw)
            {
                Draw();
            }
            else
            {
                Update();
            }
        });
        Draw();
    }

    /// <summary>Saves what is pending before the window closes, and asks before closing over changes that cannot be saved.</summary>
    async void OnClosing(object? sender, WindowClosingEventArgs e)
    {
        // The dock closing ends the app, which cannot wait for an answer.
        if (closing || e.CloseReason is WindowCloseReason.ApplicationShutdown or WindowCloseReason.OwnerWindowClosing)
        {
            return;
        }

        e.Cancel = true;

        if (asking)
        {
            return;
        }

        asking = true;

        try
        {
            await editor.Flush();

            if (editor.State?.Unsaved is { Count: > 0 } files &&
                !await Ask("Discard unsaved changes?", $"{string.Join(", ", files)} {(files.Count == 1 ? "has" : "have")} changes that are not saved.", "Discard", "Keep editing"))
            {
                return;
            }
        }
        finally
        {
            asking = false;
        }

        closing = true;
        Close();
    }

    /// <summary>A line under the page, such as why Open file did not run; null hides it.</summary>
    public string? Status
    {
        get => status.Text;
        set
        {
            status.Text = value;
            status.IsVisible = value is not null;
        }
    }

    /// <summary>Asks before a delete, a removal or a discard in a small modal window; <paramref name="action"/> labels the button that goes ahead.</summary>
    async Task<bool> Ask(string question, string detail, string action, string cancelLabel = "Cancel")
    {
        var dialog = new Window { Title = question, Width = 380, SizeToContent = SizeToContent.Height, CanResize = false, WindowStartupLocation = WindowStartupLocation.CenterOwner };
        var delete = new Button { Name = "ConfirmAction", Content = action };
        var cancel = new Button { Name = "ConfirmCancel", Content = cancelLabel };

        delete.Classes.Add("accent");
        delete.Click += (_, _) => dialog.Close(true);
        cancel.Click += (_, _) => dialog.Close(false);
        dialog.Bind(BackgroundProperty, this.GetResourceObservable("DockBackground"));
        dialog.Content = new StackPanel
        {
            Margin = new Thickness(16),
            Spacing = 12,
            Children =
            {
                new TextBlock { Text = question, FontWeight = FontWeight.SemiBold, TextWrapping = TextWrapping.Wrap },
                new TextBlock { Text = detail, TextWrapping = TextWrapping.Wrap },
                new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, HorizontalAlignment = HorizontalAlignment.Right, Children = { cancel, delete } },
            },
        };

        return await dialog.ShowDialog<bool>(this);
    }

    /// <summary>Draws the page again, keeping focus and the caret in the same field, as a reload after a save or an edit on disk redraws it.</summary>
    void Draw()
    {
        KeepFocus(DrawPage);

        if (editor.Notice is { } notice)
        {
            Status = notice;
        }
    }

    /// <summary>Runs <paramref name="draw"/>, then puts focus and the caret back in the named control that had them.</summary>
    void KeepFocus(Action draw)
    {
        var focused = (FocusManager?.GetFocusedElement() as Control)?.GetSelfAndLogicalAncestors().OfType<Control>().FirstOrDefault((control) => control.Name is not null && control.Name.Length > 0);
        // The caret is kept as an index into the text with CRLF counted as one character, because drafts hold LF and the box may show CRLF.
        var caret = FocusManager?.GetFocusedElement() is TextBox text ? (Logical(text.Text, text.SelectionStart), Logical(text.Text, text.SelectionEnd)) : ((int, int)?)null;

        draw();

        if (focused?.Name is { } name)
        {
            Dispatcher.UIThread.Post(() =>
            {
                if (page.GetLogicalDescendants().OfType<Control>().FirstOrDefault((control) => control.Name == name) is not { } again)
                {
                    return;
                }

                var box = again as TextBox ?? again.GetLogicalDescendants().OfType<TextBox>().FirstOrDefault();

                (box ?? again).Focus();

                if (box is not null && caret is var (start, end))
                {
                    box.SelectionStart = Physical(box.Text, start);
                    box.SelectionEnd = Physical(box.Text, end);
                }
            }, DispatcherPriority.Loaded);
        }
    }

    /// <summary>The index in <paramref name="text"/> with each CRLF counted as one character.</summary>
    internal static int Logical(string? text, int index) => (text ?? "")[..Math.Min(index, text?.Length ?? 0)].Replace("\r\n", "\n").Length;

    /// <summary>The index in <paramref name="text"/> of the <paramref name="logical"/>th character, counting each CRLF as one.</summary>
    internal static int Physical(string? text, int logical)
    {
        var value = text ?? "";
        var index = 0;

        for (var count = 0; count < logical && index < value.Length; count++)
        {
            index += value[index] == '\r' && index + 1 < value.Length && value[index + 1] == '\n' ? 2 : 1;
        }

        return index;
    }

    void DrawPage()
    {
        page.Children.Clear();
        fieldErrors.Clear();
        buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top };
        notes = new StackPanel { Spacing = 4 };
        errors = new StackPanel { Spacing = 4 };

        if (editor.State is not { } state)
        {
            DrawNav(null);
            page.Children.Add(new TextBlock { Text = editor.Error ?? "Reading the settings…", TextWrapping = TextWrapping.Wrap });
            return;
        }

        var view = SettingsPages.Page(state);
        var title = new StackPanel { Spacing = 2 };

        title.Children.Add(new TextBlock { Text = view.Title, FontSize = 18, FontWeight = FontWeight.SemiBold, TextWrapping = TextWrapping.Wrap });

        if (view.FilePath is { } path)
        {
            var open = new Button { Name = "OpenFile", Content = path, Classes = { "link" }, FontSize = 12 };

            ToolTip.SetTip(open, "Open the file in VS Code");
            open.Click += async (_, _) => Status = await actions.Run(null, new JsonObject { ["type"] = "openUrl", ["url"] = path }, CancellationToken.None);
            title.Children.Add(open);
        }

        var header = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto"), Margin = new Thickness(0, 0, 0, 4) };

        Grid.SetColumn(buttons, 1);
        header.Children.Add(title);
        header.Children.Add(buttons);
        page.Children.Add(header);
        page.Children.Add(notes);
        page.Children.Add(errors);

        if (view.Message is not null)
        {
            page.Children.Add(new TextBlock { Text = view.Message, TextWrapping = TextWrapping.Wrap });
        }

        if (view.NewName is { } names)
        {
            page.Children.Add(NameFields(names));
        }

        advanced.Clear();

        foreach (var section in view.Sections)
        {
            var rows = new StackPanel { Spacing = 2 };

            foreach (var run in Runs(section.Fields))
            {
                rows.Children.Add(run.Count > 1 || run[0].Field.Group is not null ? GroupRow(run) : FieldControl(run[0]));
            }

            if (section.Advanced)
            {
                var key = $"{state.Page}/{section.Heading}";
                var chevron = new TextBlock { FontFamily = Codicons, FontSize = 14, VerticalAlignment = VerticalAlignment.Center };
                var toggle = new Button
                {
                    Name = $"section:{section.Heading}",
                    Background = Brushes.Transparent,
                    Padding = new Thickness(0),
                    Margin = new Thickness(0, 8, 0, 2),
                    Content = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, Children = { chevron, new TextBlock { Text = section.Heading, FontSize = 15, FontWeight = FontWeight.SemiBold } } },
                };

                void Show(bool open)
                {
                    rows.IsVisible = open;
                    chevron.Text = open ? "\uEAB4" : "\uEAB6";

                    if (open)
                    {
                        opened.Add(key);
                    }
                    else
                    {
                        opened.Remove(key);
                    }
                }

                Show(opened.Contains(key));
                toggle.Click += (_, _) => Show(!rows.IsVisible);

                foreach (var field in section.Fields)
                {
                    advanced[field.Field.Path] = () => Show(true);
                }

                page.Children.Add(toggle);
                page.Children.Add(rows);
                continue;
            }

            if (section.Heading != "")
            {
                page.Children.Add(new TextBlock { Text = section.Heading, FontSize = 15, FontWeight = FontWeight.SemiBold, Margin = new Thickness(0, 8, 0, 2) });
            }

            page.Children.Add(rows);
        }

        table.Child = null;
        tableShape = null;

        if (view.Table is not null)
        {
            page.Children.Add(table);
        }

        Update();
    }

    /// <summary>Splits fields into runs: each checkbox group's adjacent fields together, every other field alone.</summary>
    static List<List<FieldView>> Runs(IReadOnlyList<FieldView> fields)
    {
        List<List<FieldView>> runs = [];

        foreach (var field in fields)
        {
            if (field.Field.Group is { } group && runs.Count > 0 && runs[^1][0].Field.Group == group)
            {
                runs[^1].Add(field);
            }
            else
            {
                runs.Add([field]);
            }
        }

        return runs;
    }

    /// <summary>Updates the navigation, buttons, notes and errors without replacing the fields.</summary>
    void Update()
    {
        if (editor.State is not { } state)
        {
            Draw();
            return;
        }

        var view = SettingsPages.Page(state);

        DrawNav(state);
        buttons.Children.Clear();
        if (view.Saved is { } saved)
        {
            var text = saved switch
            {
                SaveState.Saved => "Saved",
                SaveState.Saving => "Saving…",
                SaveState.NotSaved => "Not saved",
                _ => throw new ArgumentOutOfRangeException(nameof(view)),
            };

            buttons.Children.Add(Tinted(new TextBlock { Name = "SaveState", Text = text, VerticalAlignment = VerticalAlignment.Center, FontSize = 12, Margin = new Thickness(0, 0, 6, 0) }, saved == SaveState.NotSaved ? "DockWarning" : "DockMuted"));
        }

        foreach (var button in view.Buttons)
        {
            buttons.Children.Add(PageButton(button));
        }

        notes.Children.Clear();

        foreach (var note in view.Notes)
        {
            notes.Children.Add(Tinted(new TextBlock { Text = note, TextWrapping = TextWrapping.Wrap }, "DockWarning"));
        }

        errors.Children.Clear();

        foreach (var error in view.Errors)
        {
            errors.Children.Add(Tinted(new TextBlock { Text = error, TextWrapping = TextWrapping.Wrap }, "DockError"));
        }

        foreach (var field in view.Sections.SelectMany((section) => section.Fields))
        {
            if (fieldErrors.TryGetValue(field.Field.Path, out var panel))
            {
                ShowErrors(panel, field.Errors);
            }

            // A new error inside a collapsed Advanced section opens it; the operator can close it again.
            if (field.Errors.Count > 0 && !erred.Contains(field.Field.Path) && advanced.TryGetValue(field.Field.Path, out var open))
            {
                open();
            }
        }

        erred.Clear();

        foreach (var field in view.Sections.SelectMany((section) => section.Fields).Where((field) => field.Errors.Count > 0))
        {
            erred.Add(field.Field.Path);
        }

        if (view.Table is { } rows)
        {
            UpdateTable(rows);
        }

        if (view.NewName is { } names && fieldErrors.TryGetValue("name", out var nameErrors))
        {
            ShowErrors(nameErrors, names.Error is null ? [] : [names.Error]);
        }
    }

    void ShowErrors(StackPanel panel, IReadOnlyList<string> list)
    {
        panel.Children.Clear();

        foreach (var error in list)
        {
            panel.Children.Add(Tinted(new TextBlock { Text = error, TextWrapping = TextWrapping.Wrap }, "DockError"));
        }
    }

    T Tinted<T>(T text, string brush)
        where T : TextBlock
    {
        text.Bind(TextBlock.ForegroundProperty, this.GetResourceObservable(brush));
        return text;
    }

    void DrawNav(EditorState? state)
    {
        nav.Children.Clear();

        if (state is null)
        {
            return;
        }

        foreach (var entry in SettingsPages.Nav(state))
        {
            switch (entry.Kind)
            {
                case "heading":
                    nav.Children.Add(new TextBlock { Text = entry.Label.ToUpperInvariant(), FontSize = 11, FontWeight = FontWeight.SemiBold, Margin = new Thickness(4, 10, 0, 2) });
                    break;
                case "namespace":
                    var button = NavButton(entry);

                    button.Margin = new Thickness(0, 4, 0, 0);
                    nav.Children.Add(button);
                    break;
                default:
                    nav.Children.Add(NavButton(entry));
                    break;
            }
        }
    }

    Button NavButton(NavEntry entry)
    {
        var label = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        var text = new TextBlock { Text = entry.Kind == "add" ? $"+ {entry.Label}" : entry.Label };

        if (entry.Kind == "namespace")
        {
            text.FontSize = 12;
            Tinted(text, "DockMuted");
            ToolTip.SetTip(text, $"Edit the {entry.Label} playbooks in a table");
        }

        label.Children.Add(text);

        if (entry.Note is not null)
        {
            label.Children.Add(Tinted(new TextBlock { Text = entry.Note }, "DockMuted"));
        }

        if (entry.Dirty)
        {
            label.Children.Add(new TextBlock { Text = "●", Classes = { "dirty" } });
            ToolTip.SetTip(label, "Unsaved changes");
        }

        if (entry.HasErrors)
        {
            label.Children.Add(Tinted(new TextBlock { Text = "⚠", Classes = { "errors" } }, "DockError"));
        }

        var button = new Button { Content = label, HorizontalAlignment = HorizontalAlignment.Stretch, Background = Brushes.Transparent, Padding = new Thickness(8, 3), Tag = entry.Argument };

        if (entry.Current)
        {
            button.Bind(BackgroundProperty, this.GetResourceObservable("DockSelected"));
            button.Classes.Add("current");
        }

        button.Classes.Add("nav");
        button.Click += async (_, _) =>
        {
            if (entry.Command == "add-source")
            {
                await editor.AddSource(entry.Argument!);
            }
            else
            {
                await editor.Navigate(entry.Argument!);
            }
        };

        return button;
    }

    Button PageButton(PageButton spec)
    {
        var button = new Button { Content = spec.Label, IsEnabled = spec.Enabled, Tag = spec.Command };

        if (spec.Primary)
        {
            button.Classes.Add("accent");
        }

        if (spec.Tip is not null)
        {
            ToolTip.SetTip(button, spec.Tip);
        }

        button.Click += async (_, _) =>
        {
            switch (spec.Command)
            {
                case "revert":
                    await editor.Revert();
                    break;
                case "create":
                    await editor.Create();
                    break;
                case "delete":
                    await editor.Delete();
                    break;
                case "remove-source":
                    await editor.RemoveSource(spec.Argument!);
                    break;
            }
        };

        return button;
    }

    Control NameFields(NewNameView names)
    {
        var space = new AutoCompleteBox { Name = "NewNamespace", Text = names.Namespace, ItemsSource = names.Namespaces, PlaceholderText = "dev", MinWidth = 160 };
        var name = new TextBox { Name = "NewName", Text = names.Name, PlaceholderText = "develop", MinWidth = 200, VerticalContentAlignment = VerticalAlignment.Center };
        var nameErrors = new StackPanel();

        space.TextChanged += (_, _) =>
        {
            if ((space.Text ?? "") != editor.State?.NewPlaybook.Namespace)
            {
                editor.EditNewName(space.Text ?? "", null);
            }
        };
        name.TextChanged += (_, _) =>
        {
            if ((name.Text ?? "") != editor.State?.NewPlaybook.Name)
            {
                editor.EditNewName(null, name.Text ?? "");
            }
        };
        fieldErrors["name"] = nameErrors;

        var parts = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, Children = { space, new TextBlock { Text = ":", VerticalAlignment = VerticalAlignment.Center }, name } };

        return Row("Name", "The file is playbooks/<namespace>/<name>.md. Lowercase letters, digits and hyphens.", new StackPanel { Spacing = 3, Children = { parts, nameErrors } });
    }

    /// <summary>A labelled row: the label and its info icon on the left, the content on the right.</summary>
    Control Row(string label, string help, Control content, Action? tapped = null)
    {
        var caption = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 5, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 4, 12, 0) };
        var text = new TextBlock { Text = label, TextWrapping = TextWrapping.Wrap, MaxWidth = 150 };

        if (tapped is not null)
        {
            text.Cursor = new Avalonia.Input.Cursor(Avalonia.Input.StandardCursorType.Hand);
            text.Tapped += (_, _) => tapped();
        }

        caption.Children.Add(text);

        if (help != "")
        {
            caption.Children.Add(Info(help));
        }

        var row = new Grid { ColumnDefinitions = new ColumnDefinitions("170,*"), Margin = new Thickness(0, 3) };

        Grid.SetColumn(content, 1);

        row.Children.Add(caption);
        row.Children.Add(content);

        return row;
    }

    static FontFamily Codicons => (FontFamily)Application.Current!.FindResource("Codicons")!;

    /// <summary>The info icon whose tooltip explains a field.</summary>
    TextBlock Info(string help)
    {
        var icon = Tinted(new TextBlock { Text = "\uEA74", FontFamily = Codicons, FontSize = 13, VerticalAlignment = VerticalAlignment.Center, Classes = { "info" } }, "DockMuted");

        ToolTip.SetTip(icon, new TextBlock { Text = help, TextWrapping = TextWrapping.Wrap, MaxWidth = 360 });
        ToolTip.SetShowDelay(icon, 150);
        return icon;
    }

    /// <summary>A field's input and, under it, the errors that name it; tagged with the field's path.</summary>
    StackPanel Holder(FieldView view, Control input)
    {
        var errorList = new StackPanel();
        var holder = new StackPanel { Spacing = 3, Tag = view.Field.Path, Children = { input, errorList } };

        fieldErrors[view.Field.Path] = errorList;
        return holder;
    }

    /// <summary>A checkbox group's row: one checkbox per field, labelled with its own name and explained by its tooltip.</summary>
    Control GroupRow(IReadOnlyList<FieldView> views)
    {
        var boxes = new WrapPanel { Orientation = Orientation.Horizontal };

        foreach (var view in views)
        {
            var box = CheckBoxFor(view);

            box.Content = view.Field.Label;
            box.MinWidth = 0;
            box.Margin = new Thickness(0, 0, 14, 0);

            if (view.Field.Help != "")
            {
                ToolTip.SetTip(box, new TextBlock { Text = view.Field.Help, TextWrapping = TextWrapping.Wrap, MaxWidth = 360 });
            }

            boxes.Children.Add(Holder(view, box));
        }

        return Row(views[0].Field.Group ?? views[0].Field.Label, "", boxes);
    }

    CheckBox CheckBoxFor(FieldView view)
    {
        var field = view.Field;
        var box = new CheckBox { Name = $"field:{field.Path}", IsChecked = view.Checked };
        var shown = view.Checked;

        // Controls also raise their change events when they first lay out; only the operator's changes are edits.
        box.IsCheckedChanged += (_, _) =>
        {
            if (box.IsChecked == true != shown)
            {
                shown = box.IsChecked == true;
                editor.Edit(field, "", shown);
            }
        };

        return box;
    }

    Control FieldControl(FieldView view)
    {
        var field = view.Field;
        Control input;

        switch (field.Kind)
        {
            case FieldKind.Boolean:
            {
                var box = CheckBoxFor(view);

                return Row(field.Label, field.Help, Holder(view, box), tapped: () => box.IsChecked = box.IsChecked != true);
            }
            case FieldKind.Select:
            {
                var options = field.Options ?? [];
                var box = new ComboBox { ItemsSource = options.Select((option) => option.Label).ToList(), MinWidth = 260 };

                var shown = view.Selected;

                box.SelectedIndex = options.ToList().FindIndex((option) => option.Value == view.Selected);
                box.SelectionChanged += (_, _) =>
                {
                    if (box.SelectedIndex >= 0 && options[box.SelectedIndex].Value != shown)
                    {
                        shown = options[box.SelectedIndex].Value;
                        editor.Edit(field, shown);
                    }
                };
                input = box;
                break;
            }
            default:
            {
                var multiline = field.Kind is FieldKind.List or FieldKind.Prompt;
                var box = new TextBox
                {
                    Text = view.Text,
                    PlaceholderText = field.Placeholder,
                    AcceptsReturn = multiline,
                    TextWrapping = multiline ? TextWrapping.Wrap : TextWrapping.NoWrap,
                    // A multiline box grows with its text up to MaxLines, then scrolls.
                    MaxLines = field.Kind == FieldKind.Prompt ? 20 : multiline ? 8 : 0,
                };

                if (field.Kind == FieldKind.Prompt)
                {
                    box.FontFamily = new FontFamily("Cascadia Mono,Consolas");
                }

                if (field.Kind == FieldKind.Integer)
                {
                    box.Width = 120;
                    box.HorizontalAlignment = HorizontalAlignment.Left;
                }

                var shown = view.Text;

                box.TextChanged += (_, _) =>
                {
                    var text = (box.Text ?? "").Replace("\r\n", "\n");

                    if (text != shown)
                    {
                        shown = text;
                        editor.Edit(field, text);
                    }
                };
                input = box;
                break;
            }
        }

        input.Name = $"field:{field.Path}";

        if (input is ComboBox)
        {
            input.HorizontalAlignment = HorizontalAlignment.Left;
        }

        return Row(field.Label, field.Help, Holder(view, input));
    }

    /// <summary>Draws the table when its rows or columns changed, else sets its checkboxes, dots and errors in place, so a click is not lost.</summary>
    void UpdateTable(PlaybookTable view)
    {
        var shape = string.Join('|', view.Columns.Select((column) => column.Path)) + "/" + string.Join('|', view.Rows.Select((row) => $"{row.Name}:{string.Concat(row.Cells.Select((cell) => cell is null ? '-' : '+'))}"));

        if (shape != tableShape)
        {
            tableShape = shape;
            cells.Clear();
            tableRows.Clear();
            KeepFocus(() => table.Child = TableControl(view));
        }

        foreach (var row in view.Rows)
        {
            for (var index = 0; index < view.Columns.Count; index++)
            {
                if (row.Cells[index] is { } cell && cells.TryGetValue($"{row.Name}:{view.Columns[index].Path}", out var set))
                {
                    set(cell);
                }
            }

            if (tableRows.TryGetValue(row.Name, out var parts))
            {
                parts.Dot.IsVisible = row.Dirty;
                parts.Errors.Children.Clear();

                foreach (var error in row.Errors)
                {
                    parts.Errors.Children.Add(Tinted(new TextBlock { Text = error, TextWrapping = TextWrapping.Wrap, MaxWidth = 640 }, "DockError"));
                }

                parts.Errors.IsVisible = row.Errors.Count > 0;
            }
        }
    }

    /// <summary>A namespace's playbooks as rows of checkboxes under grouped column headers; a row's name opens its page.</summary>
    Control TableControl(PlaybookTable view)
    {
        var grid = new Grid { HorizontalAlignment = HorizontalAlignment.Left };
        var grouped = view.Columns.Any((column) => column.Group is not null);
        var row = 0;

        grid.ColumnDefinitions.Add(new ColumnDefinition(GridLength.Auto));

        foreach (var _ in view.Columns)
        {
            grid.ColumnDefinitions.Add(new ColumnDefinition(GridLength.Auto) { MinWidth = 44 });
        }

        void Add(Control control, int at, int column, int span = 1)
        {
            Grid.SetRow(control, at);
            Grid.SetColumn(control, column);
            Grid.SetColumnSpan(control, span);
            grid.Children.Add(control);
        }

        if (grouped)
        {
            grid.RowDefinitions.Add(new RowDefinition(GridLength.Auto));

            for (var start = 0; start < view.Columns.Count;)
            {
                var group = view.Columns[start].Group;
                var end = start;

                while (end + 1 < view.Columns.Count && view.Columns[end + 1].Group == group)
                {
                    end++;
                }

                if (group is not null)
                {
                    var rule = new Border { BorderThickness = new Thickness(0, 0, 0, 1), Margin = new Thickness(4, 0), Child = new TextBlock { Text = group, FontWeight = FontWeight.SemiBold, HorizontalAlignment = HorizontalAlignment.Center } };

                    rule.Bind(Border.BorderBrushProperty, this.GetResourceObservable("DockBorder"));
                    Add(rule, row, start + 1, end - start + 1);
                }

                start = end + 1;
            }

            row++;
        }

        grid.RowDefinitions.Add(new RowDefinition(GridLength.Auto));
        Add(Tinted(new TextBlock { Text = "Name", Margin = new Thickness(0, 4, 0, 4), VerticalAlignment = VerticalAlignment.Bottom }, "DockMuted"), row, 0);

        for (var index = 0; index < view.Columns.Count; index++)
        {
            var column = view.Columns[index];
            var heading = Tinted(new TextBlock { Text = column.Label, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(5, 4) }, "DockMuted");

            ToolTip.SetTip(heading, new TextBlock { Text = column.Help, TextWrapping = TextWrapping.Wrap, MaxWidth = 360 });
            Add(heading, row, index + 1);
        }

        row++;

        foreach (var entry in view.Rows)
        {
            grid.RowDefinitions.Add(new RowDefinition(GridLength.Auto));

            var line = new Border { BorderThickness = new Thickness(0, 1, 0, 0) };
            var name = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 4, 16, 4) };
            var open = new Button { Name = $"open:{entry.Name}", Content = entry.Label, Classes = { "link" }, Tag = $"playbook:{entry.Name}" };

            line.Bind(Border.BorderBrushProperty, this.GetResourceObservable("DockBorder"));
            Add(line, row, 0, view.Columns.Count + 1);

            if (entry.Description != "")
            {
                ToolTip.SetTip(open, new TextBlock { Text = entry.Description, TextWrapping = TextWrapping.Wrap, MaxWidth = 360 });
            }

            open.Click += async (_, _) => await editor.Navigate($"playbook:{entry.Name}");
            name.Children.Add(open);

            var dot = new TextBlock { Text = "●", Classes = { "dirty" } };

            name.Children.Add(dot);
            Add(name, row, 0);

            for (var index = 0; index < view.Columns.Count; index++)
            {
                if (entry.Cells[index] is not { } cell)
                {
                    continue;
                }

                var path = view.Columns[index].Path;
                var box = new CheckBox { Name = $"cell:{entry.Name}:{path}", IsChecked = cell.Checked, IsEnabled = cell.Enabled, MinWidth = 0, HorizontalAlignment = HorizontalAlignment.Center, Padding = new Thickness(0) };
                var shown = cell.Checked;

                box.IsCheckedChanged += (_, _) =>
                {
                    if (box.IsChecked == true != shown)
                    {
                        shown = box.IsChecked == true;
                        editor.EditCell(entry.Name, path, shown);
                    }
                };
                cells[$"{entry.Name}:{path}"] = (value) =>
                {
                    shown = value.Checked;
                    box.IsChecked = value.Checked;
                    box.IsEnabled = value.Enabled;
                };
                Add(box, row, index + 1);
            }

            row++;

            var list = new StackPanel { Spacing = 2, Margin = new Thickness(0, 0, 0, 6), Tag = entry.Name };

            tableRows[entry.Name] = (dot, list);
            grid.RowDefinitions.Add(new RowDefinition(GridLength.Auto));
            Add(list, row, 0, view.Columns.Count + 1);
            row++;
        }

        return new ScrollViewer { Content = grid, HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto, VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled };
    }
}
