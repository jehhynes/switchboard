using System.Text.Json.Nodes;
using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Threading;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Views;

namespace Switchboard.Dock.Tests;

/// <summary>The note above the groups while the phone was lost (PRD R119): untoned, and absent while the voice is off by choice.</summary>
public sealed class VoiceNoteTests
{
    const string Lost = "Voice stopped unexpectedly on the paired device. Select Voice on this device there, or Talk here on this computer.";

    static (MainWindow Window, DockViewModel Model) Open()
    {
        var model = new DockViewModel(new DockSettings(), (_) => { });
        var window = new MainWindow(model, null, new FakeHub(), new FakeActions(), docked: false);

        model.Show(Fixtures.View);
        window.Show();
        Dispatcher.UIThread.RunJobs();

        return (window, model);
    }

    [Fact]
    public void Parse_HubVoiceNote_ReadsItAndNoneWithout()
    {
        var json = JsonNode.Parse(Fixtures.DockJson)!.AsObject();

        Assert.Null(DockView.Parse(json.ToJsonString()).VoiceNote);
        json["voiceNote"] = Lost;
        Assert.Equal(Lost, DockView.Parse(json.ToJsonString()).VoiceNote);
    }

    [AvaloniaFact]
    public void VoiceNote_PhoneLostThenTakenBack_ShowsItMutedThenHidesIt()
    {
        var (window, model) = Open();
        var line = window.FindControl<TextBlock>("VoiceNoteLine")!;

        Assert.False(line.IsVisible);

        model.Show(Fixtures.View with { VoiceNote = Lost });
        Dispatcher.UIThread.RunJobs();
        Assert.True(line.IsVisible);
        Assert.Equal(Lost, line.Text);
        Assert.DoesNotContain("warning", line.Classes);
        Assert.Equal(window.FindResource(window.ActualThemeVariant, "DockMuted"), line.Foreground);

        model.Show(Fixtures.View);
        Dispatcher.UIThread.RunJobs();
        Assert.False(line.IsVisible);
        window.Close();
    }
}
