using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.VisualTree;

namespace Switchboard.Dock.Views;

/// <summary>What a dialog button does: a secondary choice, Cancel, the main action, or a destructive main action.</summary>
enum DialogButton
{
    Secondary,
    Cancel,
    Primary,
    Danger,
}

/// <summary>
/// The dock's dialog layout, shared by every dialog so they look and behave alike: a title and an optional subtitle, a body of labelled fields,
/// and a footer of buttons on the right, Cancel before the main action. Enter runs the main action (Ctrl+Enter from a multi-line box, where
/// Enter starts a line) and Escape cancels; a destructive action is drawn in the error colour and is never run by Enter, and the focus starts
/// on Cancel instead.
/// </summary>
sealed class DialogShell
{
    readonly StackPanel buttons = new() { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
    Control? first;

    public DialogShell(Window owner, string title, double width, string? subtitle = null)
    {
        Window = new Window
        {
            Title = title,
            Width = width,
            SizeToContent = SizeToContent.Height,
            CanResize = false,
            ShowInTaskbar = false,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            FontSize = 13,
        };
        Window.Classes.Add("dialog");
        Window.Bind(Window.BackgroundProperty, owner.GetResourceObservable("DockBackground"));
        Window.Bind(Window.ForegroundProperty, owner.GetResourceObservable("DockForeground"));

        var heading = new StackPanel { Spacing = 4 };

        heading.Children.Add(new TextBlock { Name = "DialogTitle", Text = title, FontSize = 16, FontWeight = FontWeight.SemiBold, TextWrapping = TextWrapping.Wrap });

        if (subtitle is not null)
        {
            var sub = new TextBlock { Name = "DialogSubtitle", Text = subtitle, TextWrapping = TextWrapping.Wrap };

            sub.Bind(TextBlock.ForegroundProperty, owner.GetResourceObservable("DockMuted"));
            heading.Children.Add(sub);
        }

        var footer = new Border { Padding = new Thickness(20, 12), BorderThickness = new Thickness(0, 1, 0, 0), Child = buttons };

        footer.Bind(Border.BackgroundProperty, owner.GetResourceObservable("DockDialogFooter"));
        footer.Bind(Border.BorderBrushProperty, owner.GetResourceObservable("DockBorder"));
        var content = new StackPanel { Margin = new Thickness(20, 18, 20, 20), Spacing = 16, Children = { heading, Body } };

        // The fields come before the footer, so Tab reaches them first.
        Grid.SetRow(footer, 1);
        Window.Content = new Grid { RowDefinitions = new RowDefinitions("*,Auto"), Children = { content, footer } };
        Window.Opened += (_, _) => (first ?? FirstField() ?? buttons.Children.OfType<Button>().LastOrDefault())?.Focus(NavigationMethod.Tab);
        // Ctrl+Enter runs the main action from anywhere, such as a multi-line box, where Enter starts a new line.
        Window.AddHandler(InputElement.KeyDownEvent, (_, e) =>
        {
            if (e.Key != Key.Enter || Main is not { IsEffectivelyEnabled: true, IsDefault: true } main)
            {
                return;
            }

            // Plain Enter runs a main action that is not destructive, unless a focused button, a multi-line box or an open list takes it.
            var focused = Window.FocusManager?.GetFocusedElement();
            var plain = e.KeyModifiers == KeyModifiers.None
                && focused is not Button and not TextBox { AcceptsReturn: true } and not ComboBox { IsDropDownOpen: true } and not CalendarDatePicker { IsDropDownOpen: true };

            if (plain || e.KeyModifiers == KeyModifiers.Control)
            {
                e.Handled = true;
                main.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
            }
        }, Avalonia.Interactivity.RoutingStrategies.Tunnel);
    }

    public Window Window { get; }

    /// <summary>The dialog's fields, top to bottom.</summary>
    public StackPanel Body { get; } = new() { Spacing = 14 };

    /// <summary>The main action, which Enter runs unless it is destructive; null until one is added.</summary>
    public Button? Main { get; private set; }

    /// <summary>Adds a button to the footer, in order from the left.</summary>
    public Button Add(string name, string label, DialogButton kind)
    {
        var button = new Button { Name = name, Content = label };

        button.Classes.Add("dialog");

        switch (kind)
        {
            case DialogButton.Cancel:
                button.IsCancel = true;
                break;
            case DialogButton.Primary:
                button.Classes.Add("accent");
                button.IsDefault = true;
                Main = button;
                break;
            case DialogButton.Danger:
                button.Classes.Add("danger");
                Main = button;
                break;
        }

        buttons.Children.Add(button);

        // A destructive action starts with the focus on Cancel, so Enter cancels.
        if (kind == DialogButton.Danger && buttons.Children.OfType<Button>().FirstOrDefault((each) => each.IsCancel) is { } cancel)
        {
            first ??= cancel;
        }

        return button;
    }

    /// <summary>Puts the focus on <paramref name="control"/> when the dialog opens instead of the first field.</summary>
    public void FocusFirst(Control control) => first = control;

    /// <summary>The first field that shows and takes input, a choice group's checked button rather than its first, or null.</summary>
    Control? FirstField() =>
        Body.GetVisualDescendants().OfType<Control>().FirstOrDefault((control) => control is TextBox or ComboBox or CheckBox or CalendarDatePicker or RadioButton
            && control.IsEffectivelyVisible && control.IsEffectivelyEnabled && control.Focusable && (control is not RadioButton radio || radio.IsChecked == true));

    /// <summary>A field: its label above its control, or the control alone with no label.</summary>
    public static StackPanel Field(string? label, Control input, string? name = null)
    {
        var field = new StackPanel { Spacing = 6, Name = name };

        if (label is not null)
        {
            field.Children.Add(new TextBlock { Text = label, FontWeight = FontWeight.SemiBold });
        }

        field.Children.Add(input);
        return field;
    }

    /// <summary>A muted note, such as what a field does.</summary>
    public TextBlock Note(string? text, string? name = null) => Tinted(new TextBlock { Name = name, Text = text, TextWrapping = TextWrapping.Wrap }, "DockMuted");

    /// <summary>An error line in the error colour, hidden until it has a text.</summary>
    public TextBlock Error(string name) => Tinted(new TextBlock { Name = name, TextWrapping = TextWrapping.Wrap, IsVisible = false }, "DockError");

    TextBlock Tinted(TextBlock text, string brush)
    {
        text.Bind(TextBlock.ForegroundProperty, Window.GetResourceObservable(brush));
        return text;
    }
}
