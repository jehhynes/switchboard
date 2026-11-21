using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Switching;

namespace Switchboard.Dock.Views;

public sealed class VolumeWindow : Window
{
    static readonly (string Key, string Label)[] Metrics = [("seen", "Seen in queue"), ("entered", "Entered / returned"), ("left", "Left active queue"), ("open", "Open at end"), ("assigned", "Assigned to you"), ("worked", "Worked by you"), ("mine", "Yours at end")];
    readonly IVolumeHub hub;
    readonly IDockActions actions;
    readonly ComboBox source = new() { Name = "VolumeSource", ItemsSource = new[] { "all", "zoho", "forum" }, SelectedIndex = 0, Width = 130 };
    readonly TextBlock status = new() { Name = "VolumeStatus", TextWrapping = TextWrapping.Wrap };
    readonly StackPanel weeks = new() { Name = "VolumeWeeks", Spacing = 4 };
    readonly StackPanel details = new() { Name = "VolumeDetails", Spacing = 4 };
    int generation;
    string timezone = "America/New_York";
    TimeZoneInfo displayZone = TimeZoneInfo.Utc;

    public VolumeWindow(IVolumeHub hub, IDockActions actions)
    {
        this.hub = hub;
        this.actions = actions;
        Title = "Ticket volume report";
        Width = 1200;
        Height = 750;
        MinWidth = 800;
        FontSize = 13;
        this.Bind(BackgroundProperty, this.GetResourceObservable("DockBackground"));
        this.Bind(ForegroundProperty, this.GetResourceObservable("DockForeground"));
        var refresh = new Button { Content = "Refresh", Name = "RefreshVolume" };
        refresh.Click += async (_, _) => await Load();
        source.SelectionChanged += async (_, _) => await Load();
        var page = new StackPanel { Margin = new Thickness(20, 18, 20, 20), Spacing = 12, Width = 1100, HorizontalAlignment = HorizontalAlignment.Left };
        var hint = new TextBlock { Text = "Observed active queue, Monday to Sunday. Select a count to list its tickets." };

        hint.Bind(TextBlock.ForegroundProperty, this.GetResourceObservable("DockMuted"));
        page.Children.Add(new TextBlock { Text = "Ticket volume report", FontSize = 16, FontWeight = FontWeight.SemiBold });
        page.Children.Add(hint);
        page.Children.Add(new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12, Children = { source, refresh } });
        page.Children.Add(status);
        page.Children.Add(new TextBlock { Text = "Left does not mean resolved: Deferred and other deferrals can leave and return. Worked means a task started in Switchboard. Week-end counts use the last observed state; activity between polls or while Switchboard is off can be missed.", TextWrapping = TextWrapping.Wrap });
        page.Children.Add(weeks);
        page.Children.Add(details);
        Content = new ScrollViewer { Content = page, HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto };
        Closed += (_, _) => generation++;
    }

    public async Task Load()
    {
        var request = ++generation;
        var selected = source.SelectedItem?.ToString() ?? "all";
        details.Children.Clear();
        weeks.Children.Clear();
        status.Text = "Loading…";
        var (error, body) = await hub.Volume(new JsonObject { ["source"] = selected });
        if (request != generation) return;
        weeks.Children.Clear();
        if (error is not null || body is null)
        {
            status.Text = error ?? "No volume data received.";
            return;
        }
        var sources = body["sources"]?.AsArray() ?? [];
        timezone = body["timezone"]?.GetValue<string>() ?? "America/New_York";
        var found = TimeZoneInfo.TryFindSystemTimeZoneById(timezone, out var zone);
        displayZone = zone ?? TimeZoneInfo.Utc;
        status.Text = $"Weeks: {timezone}. " + (found ? "" : "Times shown in UTC; this system cannot resolve the reporting timezone. ") + (sources.Count == 0 ? "Tracking has not started." : string.Join(" · ", sources.Select(s => $"{s!["source"]}: tracking since {Time(s["startedAt"])}, last poll {Time(s["lastAt"])}")));
        var header = Row();
        header.Children.Add(Cell("Week / coverage", 190));
        foreach (var metric in Metrics) header.Children.Add(Cell(metric.Label, 125));
        weeks.Children.Add(header);
        foreach (var week in body["weeks"]?.AsArray() ?? [])
        {
            var key = week!["week"]!.GetValue<string>();
            var coverage = week["coverage"]!.GetValue<string>();
            var row = Row();
            row.Children.Add(Cell($"{key} · {coverage}", 190));
            foreach (var metric in Metrics)
            {
                var button = new Button { Content = coverage == "unavailable" ? "—" : week["counts"]![metric.Key]!.GetValue<int>().ToString(), Width = 125, IsEnabled = coverage != "unavailable", Tag = $"{key}:{metric.Key}" };
                button.Click += async (_, _) => await ShowTickets(selected, key, metric.Key, metric.Label, 0);
                row.Children.Add(button);
            }
            weeks.Children.Add(row);
        }
    }

    async Task ShowTickets(string selected, string week, string metric, string label, int offset)
    {
        var request = ++generation;
        var (error, body) = await hub.Volume(new JsonObject { ["source"] = selected, ["week"] = week, ["metric"] = metric, ["offset"] = offset });
        if (request != generation) return;
        details.Children.Clear();
        details.Children.Add(new TextBlock { Text = error ?? $"{week} · {label} · {body?["total"]} tickets", FontSize = 16 });
        if (error is not null || body is null) return;
        foreach (var ticket in body["rows"]?.AsArray() ?? [])
        {
            var row = Row();
            var link = new Button { Content = $"{ticket!["source"]} {ticket["ref"]}", Width = 160 };
            var url = ticket["url"]!.GetValue<string>();
            link.Click += (_, _) => { if (actions.OpenUrl(url) is { } failure) status.Text = failure; };
            row.Children.Add(link);
            var when = metric is "open" or "mine" ? "Last-observed boundary state" : $"Counted at {Time(ticket["at"])}";
            row.Children.Add(new TextBlock { Text = $"{when} · {ticket["title"]}", VerticalAlignment = VerticalAlignment.Center, TextWrapping = TextWrapping.Wrap, MaxWidth = 800 });
            details.Children.Add(row);
        }
        var pages = Row();
        if (offset > 0) Page("Previous", Math.Max(0, offset - 100));
        if (offset + 100 < body["total"]!.GetValue<int>()) Page("Next", offset + 100);
        details.Children.Add(pages);
        void Page(string text, int next)
        {
            var button = new Button { Content = text };
            button.Click += async (_, _) => await ShowTickets(selected, week, metric, label, next);
            pages.Children.Add(button);
        }
    }

    static StackPanel Row() => new() { Orientation = Orientation.Horizontal, Spacing = 4 };
    static TextBlock Cell(string text, double width) => new() { Text = text, Width = width, TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center };
    string Time(JsonNode? value) => value is null ? "unknown" : TimeZoneInfo.ConvertTime(DateTimeOffset.FromUnixTimeMilliseconds(value.GetValue<long>()), displayZone).ToString("yyyy-MM-dd HH:mm zzz");
}
