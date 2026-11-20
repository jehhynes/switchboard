using System.ComponentModel;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Switching;

namespace Switchboard.Dock.Views;

/// <summary>
/// The held sessions window (PRD R94): every session the terminal holder holds, orphans first, with Open in terminal, which attaches in the
/// terminal app, and Stop. It follows the hub's view.
/// </summary>
public sealed class HeldSessionsWindow : Window
{
    static readonly (string Label, double Width)[] Columns = [("Work item", 110), ("Switchboard ID", 110), ("Claude ID", 280), ("Folder", 260), ("State", 80), ("Idle", 70), ("Memory", 80), ("Terminals", 70)];
    readonly DockViewModel model;
    readonly IHub hub;
    readonly IDockActions actions;
    readonly StackPanel rows = new() { Name = "HeldRows", Spacing = 4 };
    // Each session's row, kept while the session is held, so a view that changes only its texts keeps its buttons and their focus.
    readonly Dictionary<string, HeldRow> shown = [];
    readonly StackPanel header = Row();
    readonly TextBlock none = new() { Text = "No held sessions.", Classes = { "muted" } };
    readonly TextBlock status = new() { Name = "HeldStatus", TextWrapping = TextWrapping.Wrap };

    /// <summary>Asks before Stop; tests replace it, as a modal dialog would wait for a click.</summary>
    internal Func<Window, string, string, string, Task<bool>> Confirm { get; set; } = ConfirmDialog.Ask;

    public HeldSessionsWindow(DockViewModel model, IHub hub, IDockActions actions)
    {
        this.model = model;
        this.hub = hub;
        this.actions = actions;
        Title = "Held Sessions";
        Width = 1400;
        Height = 500;
        FontSize = 13;
        this.Bind(BackgroundProperty, this.GetResourceObservable("DockBackground"));
        this.Bind(ForegroundProperty, this.GetResourceObservable("DockForeground"));
        var page = new StackPanel { Margin = new Thickness(16), Spacing = 12 };
        page.Children.Add(status);
        page.Children.Add(rows);
        Content = new ScrollViewer { Content = page, HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto };
        model.PropertyChanged += Follow;
        Closed += (_, _) => model.PropertyChanged -= Follow;
        Fill();
    }

    void Follow(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(DockViewModel.Held))
        {
            Fill();
        }
    }

    /// <summary>Shows the view's held sessions, updating the rows of sessions still held in place and adding or removing only the others.</summary>
    void Fill()
    {
        if (header.Children.Count == 0)
        {
            foreach (var (label, width) in Columns)
            {
                header.Children.Add(Cell(label, width, FontWeight.SemiBold));
            }
        }

        foreach (var gone in shown.Keys.Except(model.Held.Select((held) => held.Session)).ToList())
        {
            shown.Remove(gone);
        }

        List<Control> wanted = model.Held.Count == 0 ? [none] : [header];

        foreach (var held in model.Held)
        {
            if (!shown.TryGetValue(held.Session, out var row))
            {
                row = new HeldRow(this, held.Session);
                shown[held.Session] = row;
            }

            row.Show(held);
            wanted.Add(row.Panel);
        }

        for (var index = 0; index < wanted.Count; index++)
        {
            if (index < rows.Children.Count && rows.Children[index] == wanted[index])
            {
                continue;
            }

            if (rows.Children.IndexOf(wanted[index]) is var at and >= 0)
            {
                rows.Children.Move(at, index);
            }
            else
            {
                rows.Children.Insert(index, wanted[index]);
            }
        }

        while (rows.Children.Count > wanted.Count)
        {
            rows.Children.RemoveAt(rows.Children.Count - 1);
        }
    }

    /// <summary>One held session's cells and buttons; the buttons act on the session as the latest view shows it.</summary>
    sealed class HeldRow
    {
        readonly TextBlock[] cells;
        readonly Button open;
        readonly Button stop;
        DockHeld? held;

        public HeldRow(HeldSessionsWindow window, string session)
        {
            Panel = Row();
            cells = Columns.Select((column) => Cell("", column.Width)).ToArray();
            open = new Button { Content = "Open in terminal", Tag = $"open:{session}" };
            stop = new Button { Content = "Stop", Tag = $"stop:{session}" };
            open.Click += async (_, _) =>
            {
                if (held?.Terminal is { } terminal)
                {
                    window.status.Text = await window.actions.Terminal(null, terminal, CancellationToken.None);
                }
            };
            stop.Click += async (_, _) =>
            {
                // Stop ends a live process, so it asks first, naming the session, as Delete does.
                if (held is not { } shown || !await window.Confirm(window, StopQuestion(shown), $"Session {shown.Session} in {shown.Cwd}. Its process ends and anything it is doing stops.", "Stop"))
                {
                    return;
                }

                window.status.Text = await window.hub.StopHeld(session) ?? $"Stopped held session {session}.";
            };

            foreach (var cell in cells)
            {
                Panel.Children.Add(cell);
            }

            Panel.Children.Add(open);
            Panel.Children.Add(stop);
        }

        public StackPanel Panel { get; }

        static string StopQuestion(DockHeld held) => held.Orphan ? $"Stop held session {held.Session}?" : $"Stop the held session of {held.Item}?";

        public void Show(DockHeld next)
        {
            held = next;
            string[] texts = [next.Item, next.Session, next.NativeSessionId, next.Cwd, next.State, next.Idle, next.Memory, next.Clients.ToString(System.Globalization.CultureInfo.InvariantCulture)];

            foreach (var (cell, text) in cells.Zip(texts))
            {
                cell.Text = text;
                ToolTip.SetTip(cell, text);
            }

            open.IsEnabled = next.Terminal is not null;
            stop.IsEnabled = !next.Exited;
        }
    }

    static StackPanel Row() => new() { Orientation = Orientation.Horizontal, Spacing = 8 };

    static TextBlock Cell(string text, double width, FontWeight weight = FontWeight.Normal) =>
        new() { Text = text, Width = width, FontWeight = weight, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center, [ToolTip.TipProperty] = text };
}
