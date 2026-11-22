using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Switchboard.Dock.Hub;

namespace Switchboard.Dock.Views;

/// <summary>The wake time Snooze… chose, as epoch milliseconds or null for indefinitely, and the operator's comment or null (PRD R49).</summary>
sealed record SnoozeAnswer(long? Until, string? Comment);

/// <summary>
/// A modal window that asks how long to snooze: the hub's choices, a date, and an optional comment. <c>SnoozeAction</c> returns the answer and
/// <c>SnoozeCancel</c> returns null.
/// </summary>
static class SnoozeDialog
{
    public static Task<SnoozeAnswer?> Ask(Window owner, string title, IReadOnlyList<SnoozeChoice> choices)
    {
        var shell = new DialogShell(owner, $"Snooze {title}", 440);
        var dialog = shell.Window;
        var radios = choices.Select((choice, index) => new RadioButton { Name = $"SnoozeChoice{index}", GroupName = "snooze", Content = choice.Description == "" ? choice.Label : $"{choice.Label} · {choice.Description}", IsChecked = index == 0 }).ToList();
        var first = FirstDay(choices);
        var onDate = new RadioButton { Name = "SnoozeOnDate", GroupName = "snooze", Content = "On", VerticalAlignment = VerticalAlignment.Center, IsEnabled = first is not null };
        var date = new CalendarDatePicker { Name = "SnoozeDate", Width = 200, DisplayDateStart = first, IsEnabled = first is not null, PlaceholderText = "Pick a date" };
        var comment = new TextBox { Name = "SnoozeComment", AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 60, MaxHeight = 200, PlaceholderText = "Comment (optional)" };
        var cancel = shell.Add("SnoozeCancel", "Cancel", DialogButton.Cancel);
        var go = shell.Add("SnoozeAction", "Snooze", DialogButton.Primary);

        void Update() => go.IsEnabled = onDate.IsChecked != true || (date.SelectedDate is { } day && first is { } start && day.Date >= start);

        foreach (var radio in radios.Append(onDate))
        {
            radio.IsCheckedChanged += (_, _) => Update();
        }

        // Focusing the box or opening its calendar chooses On, as picking a date does.
        date.GotFocus += (_, _) => onDate.IsChecked = true;
        date.CalendarOpened += (_, _) => onDate.IsChecked = true;
        date.PropertyChanged += (_, e) =>
        {
            if (e.Property != CalendarDatePicker.SelectedDateProperty)
            {
                return;
            }

            if (date.SelectedDate is not null)
            {
                onDate.IsChecked = true;
            }

            Update();
        };
        go.Click += (_, _) =>
        {
            if (!go.IsEnabled)
            {
                return;
            }

            var chosen = radios.FindIndex((radio) => radio.IsChecked == true);
            var until = chosen >= 0 ? choices[chosen].Until : OnDate(date.SelectedDate!.Value, choices);

            dialog.Close(new SnoozeAnswer(until, string.IsNullOrWhiteSpace(comment.Text) ? null : comment.Text.Trim()));
        };
        cancel.Click += (_, _) => dialog.Close(null);
        var list = new StackPanel { Spacing = 2 };

        foreach (var radio in radios)
        {
            list.Children.Add(radio);
        }

        list.Children.Add(new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Children = { onDate, date } });
        shell.Body.Children.Add(DialogShell.Field("Snooze ends", list));
        shell.Body.Children.Add(DialogShell.Field("Comment", comment));

        return dialog.ShowDialog<SnoozeAnswer?>(owner);
    }

    /// <summary>The first day a date can wake on: the day of the earliest timed choice, Tomorrow; null when the hub sent none.</summary>
    internal static DateTime? FirstDay(IReadOnlyList<SnoozeChoice> choices) =>
        choices.Where((choice) => choice.Until is not null).Select((choice) => (DateTime?)Local(choice.Until!.Value).Date).Min();

    /// <summary>The wake time on <paramref name="day"/>: the time of day the hub's timed choices wake at, which is when a day starts (PRD R49).</summary>
    internal static long OnDate(DateTime day, IReadOnlyList<SnoozeChoice> choices)
    {
        var start = Local(choices.First((choice) => choice.Until is not null).Until!.Value).TimeOfDay;

        return new DateTimeOffset(DateTime.SpecifyKind(day.Date + start, DateTimeKind.Local)).ToUnixTimeMilliseconds();
    }

    static DateTime Local(long milliseconds) => DateTimeOffset.FromUnixTimeMilliseconds(milliseconds).LocalDateTime;
}
