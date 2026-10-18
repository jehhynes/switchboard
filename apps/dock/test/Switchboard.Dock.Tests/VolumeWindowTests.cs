using System.Text.Json.Nodes;
using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Avalonia.VisualTree;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Views;

namespace Switchboard.Dock.Tests;

public sealed class VolumeWindowTests
{
    sealed class VolumeHub : IVolumeHub
    {
        public List<JsonObject> Queries { get; } = [];
        public string? Error { get; set; }
        public TaskCompletionSource? Hold { get; set; }
        public string Timezone { get; set; } = "America/New_York";
        public async Task<(string? Error, JsonNode? Body)> Volume(JsonObject query)
        {
            Queries.Add((JsonObject)query.DeepClone());
            if (Hold is not null) await Hold.Task;
            var json = query.ContainsKey("metric")
                ? """{"total":1,"rows":[{"id":1,"source":"zoho","ref":"#12","title":"A retained ticket","url":"https://example.test/12","at":1791158400000}]}"""
                : """{"timezone":"America/New_York","sources":[],"weeks":[{"week":"2026-10-05","coverage":"partial","counts":{"seen":1,"entered":0,"left":0,"open":1,"assigned":0,"worked":0,"mine":0}},{"week":"2026-09-28","coverage":"unavailable","counts":{"seen":0,"entered":0,"left":0,"open":0,"assigned":0,"worked":0,"mine":0}}]}""";
            return (Error, Error is null ? JsonNode.Parse(json.Replace("America/New_York", Timezone, StringComparison.Ordinal)) : null);
        }
    }

    [AvaloniaFact]
    public async Task VolumeWindow_SelectCount_ListsAndOpensRetainedTicket()
    {
        var hub = new VolumeHub();
        var actions = new FakeActions();
        var window = new VolumeWindow(hub, actions);
        window.Show();
        await window.Load();
        var count = window.GetVisualDescendants().OfType<Button>().Single(b => (string?)b.Tag == "2026-10-05:seen");
        Assert.Equal("1", count.Content);
        count.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        Dispatcher.UIThread.RunJobs();
        Assert.Equal("seen", hub.Queries.Last()["metric"]!.GetValue<string>());
        var link = window.GetVisualDescendants().OfType<Button>().Single(b => b.Content is "zoho #12");
        link.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        Assert.Equal(["https://example.test/12"], actions.Urls);
        Assert.False(window.GetVisualDescendants().OfType<Button>().Single(b => (string?)b.Tag == "2026-09-28:seen").IsEnabled);
        window.Close();
    }

    [AvaloniaFact]
    public async Task VolumeWindow_UnknownTimezone_ShowsExplicitUtcFallback()
    {
        var hub = new VolumeHub { Timezone = "Unknown/Zone" };
        var window = new VolumeWindow(hub, new FakeActions());
        window.Show();
        await window.Load();
        Assert.Contains(window.GetVisualDescendants().OfType<TextBlock>(), t => t.Text?.Contains("Times shown in UTC", StringComparison.Ordinal) == true);
        window.Close();
    }

    [AvaloniaFact]
    public async Task VolumeWindow_RefreshPending_RemovesStaleCountButtons()
    {
        var hub = new VolumeHub();
        var window = new VolumeWindow(hub, new FakeActions());
        window.Show();
        await window.Load();
        hub.Hold = new TaskCompletionSource();
        var loading = window.Load();
        Assert.DoesNotContain(window.GetVisualDescendants().OfType<Button>(), b => b.Tag is string);
        hub.Hold.SetResult();
        await loading;
        Assert.Contains(window.GetVisualDescendants().OfType<Button>(), b => (string?)b.Tag == "2026-10-05:seen");
        window.Close();
    }

    [AvaloniaFact]
    public async Task VolumeWindow_FilterAndFailure_RequestsSourceAndClearsStaleCounts()
    {
        var hub = new VolumeHub();
        var window = new VolumeWindow(hub, new FakeActions());
        window.Show();
        await window.Load();
        window.GetVisualDescendants().OfType<ComboBox>().Single().SelectedIndex = 2;
        Dispatcher.UIThread.RunJobs();
        Assert.Equal("forum", hub.Queries.Last()["source"]!.GetValue<string>());
        hub.Error = "Switchboard is not running.";
        await window.Load();
        Assert.Contains(window.GetVisualDescendants().OfType<TextBlock>(), t => t.Text == hub.Error);
        Assert.DoesNotContain(window.GetVisualDescendants().OfType<Button>(), b => b.Tag is string);
        window.Close();
    }
}
