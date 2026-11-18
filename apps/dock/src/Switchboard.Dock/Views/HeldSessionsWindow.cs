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
    readonly TextBlock status = new() { Name = "HeldStatus", TextWrapping = TextWrapping.Wrap };

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

    void Fill()
    {
        rows.Children.Clear();

        if (model.Held.Count == 0)
        {
            rows.Children.Add(new TextBlock { Text = "No held sessions.", Classes = { "muted" } });
            return;
        }

        var header = Row();

        foreach (var (label, width) in Columns)
        {
            header.Children.Add(Cell(label, width, FontWeight.SemiBold));
        }

        rows.Children.Add(header);

        foreach (var held in model.Held)
        {
            var row = Row();
            string[] texts = [held.Item, held.Session, held.NativeSessionId, held.Cwd, held.State, held.Idle, held.Memory, held.Clients.ToString(System.Globalization.CultureInfo.InvariantCulture)];

            foreach (var (text, (_, width)) in texts.Zip(Columns))
            {
                row.Children.Add(Cell(text, width));
            }

            var open = new Button { Content = "Open in terminal", Tag = $"open:{held.Session}", IsEnabled = held.Terminal is not null };
            var stop = new Button { Content = "Stop", Tag = $"stop:{held.Session}", IsEnabled = !held.Exited };

            if (held.Terminal is { } terminal)
            {
                open.Click += async (_, _) => status.Text = await actions.Terminal(null, terminal, CancellationToken.None);
            }

            stop.Click += async (_, _) => status.Text = await hub.StopHeld(held.Session) ?? $"Stopped held session {held.Session}.";
            row.Children.Add(open);
            row.Children.Add(stop);
            rows.Children.Add(row);
        }
    }

    static StackPanel Row() => new() { Orientation = Orientation.Horizontal, Spacing = 8 };

    static TextBlock Cell(string text, double width, FontWeight weight = FontWeight.Normal) =>
        new() { Text = text, Width = width, FontWeight = weight, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center, [ToolTip.TipProperty] = text };
}
