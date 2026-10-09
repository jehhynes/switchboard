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
    StackPanel notes = new();
    StackPanel errors = new();
    readonly Dictionary<string, StackPanel> fieldErrors = [];

    public SettingsWindow(SettingsEditor editor, IDockActions actions)
    {
        this.editor = editor;
        this.actions = actions;
        Title = "Switchboard Settings";
        Icon = new WindowIcon(Avalonia.Platform.AssetLoader.Open(new Uri("avares://Switchboard.Dock/Assets/dock.ico")));
        Width = 900;
        Height = 700;
        FontFamily = new FontFamily("Segoe UI");
        FontSize = 13;
        this.Bind(BackgroundProperty, this.GetResourceObservable("DockBackground"));
        this.Bind(ForegroundProperty, this.GetResourceObservable("DockForeground"));
        editor.Confirm ??= Ask;

        var navScroll = new ScrollViewer { Content = nav, Width = 230 };
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

    /// <summary>Asks before a delete in a small modal window.</summary>
    async Task<bool> Ask(string question, string detail)
    {
        var dialog = new Window { Title = question, Width = 380, SizeToContent = SizeToContent.Height, CanResize = false, WindowStartupLocation = WindowStartupLocation.CenterOwner };
        var delete = new Button { Name = "ConfirmDelete", Content = "Delete" };
        var cancel = new Button { Name = "ConfirmCancel", Content = "Cancel" };

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
        var focused = (FocusManager?.GetFocusedElement() as Control)?.GetSelfAndLogicalAncestors().OfType<Control>().FirstOrDefault((control) => control.Name is not null && control.Name.Length > 0);
        var caret = FocusManager?.GetFocusedElement() is TextBox text ? (text.SelectionStart, text.SelectionEnd) : ((int, int)?)null;

        DrawPage();

        if (editor.Notice is { } notice)
        {
            Status = notice;
        }

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
                    box.SelectionStart = Math.Min(start, box.Text?.Length ?? 0);
                    box.SelectionEnd = Math.Min(end, box.Text?.Length ?? 0);
                }
            }, DispatcherPriority.Loaded);
        }
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
        var heading = new TextBlock { FontSize = 18, FontWeight = FontWeight.SemiBold, TextWrapping = TextWrapping.Wrap };

        heading.Inlines!.Add(new Avalonia.Controls.Documents.Run(view.Title));

        if (view.Subtitle is not null)
        {
            var muted = new Avalonia.Controls.Documents.Run($"  {view.Subtitle}") { FontSize = 13, FontWeight = FontWeight.Normal };

            muted.Bind(Avalonia.Controls.Documents.TextElement.ForegroundProperty, this.GetResourceObservable("DockMuted"));
            heading.Inlines.Add(muted);
        }

        title.Children.Add(heading);

        if (view.FilePath is { } path)
        {
            var open = new Button { Name = "OpenFile", Content = path, Classes = { "link" } };

            ToolTip.SetTip(open, "Open the file in VS Code");
            open.Click += async (_, _) => Status = await actions.Run(null, new JsonObject { ["type"] = "openUrl", ["url"] = path }, CancellationToken.None);
            title.Children.Add(open);
        }

        var header = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };

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

        foreach (var section in view.Sections)
        {
            if (section.Heading != "")
            {
                page.Children.Add(new TextBlock { Text = section.Heading, FontSize = 15, FontWeight = FontWeight.SemiBold, Margin = new Thickness(0, 8, 0, 0) });
            }

            foreach (var field in section.Fields)
            {
                page.Children.Add(FieldControl(field));
            }
        }

        Update();
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
                    nav.Children.Add(Tinted(new TextBlock { Text = entry.Label, FontSize = 12, Margin = new Thickness(8, 6, 0, 0) }, "DockMuted"));
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

        label.Children.Add(new TextBlock { Text = entry.Kind == "add" ? $"+ {entry.Label}" : entry.Label });

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
                case "save":
                    await editor.Save();
                    break;
                case "save-all":
                    await editor.SaveAll();
                    break;
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
        var name = new TextBox { Name = "NewName", Text = names.Name, PlaceholderText = "develop", MinWidth = 200 };
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

        return new StackPanel
        {
            Spacing = 4,
            Children =
            {
                new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12, Children = { Labelled("Namespace", space), Labelled("Name", name) } },
                Tinted(new TextBlock { Text = "The file is playbooks/<namespace>/<name>.md. Lowercase letters, digits and hyphens.", TextWrapping = TextWrapping.Wrap }, "DockMuted"),
                nameErrors,
            },
        };
    }

    static StackPanel Labelled(string label, Control control) => new() { Spacing = 2, Children = { new TextBlock { Text = label, FontWeight = FontWeight.SemiBold }, control } };

    Control FieldControl(FieldView view)
    {
        var field = view.Field;
        var panel = new StackPanel { Spacing = 3, Margin = new Thickness(0, 4), Tag = field.Path };
        var errorList = new StackPanel();
        Control input;

        switch (field.Kind)
        {
            case FieldKind.Boolean:
            {
                var box = new CheckBox { Content = field.Label, IsChecked = view.Checked };
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
                input = box;
                break;
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
                    MinHeight = field.Kind == FieldKind.Prompt ? 160 : multiline ? 60 : 0,
                };

                if (field.Kind == FieldKind.Prompt)
                {
                    box.FontFamily = new FontFamily("Cascadia Mono,Consolas");
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

        if (field.Kind != FieldKind.Boolean)
        {
            panel.Children.Add(new TextBlock { Text = field.Label, FontWeight = FontWeight.SemiBold });
        }

        panel.Children.Add(input);
        panel.Children.Add(Tinted(new TextBlock { Text = field.Help, TextWrapping = TextWrapping.Wrap, FontSize = 12 }, "DockMuted"));
        panel.Children.Add(errorList);
        fieldErrors[field.Path] = errorList;

        return panel;
    }
}
