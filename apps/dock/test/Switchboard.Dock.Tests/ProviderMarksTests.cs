using Avalonia.Headless.XUnit;
using Switchboard.Dock.Views;

namespace Switchboard.Dock.Tests;

public sealed class ProviderMarksTests
{
    [AvaloniaFact]
    public void Mark_KnownOrUnknownProvider_DrawsItsMarkOrNothing()
    {
        Assert.Equal("ProviderMark_claude", ProviderMarks.Mark("claude")?.Name);
        Assert.NotNull(ProviderMarks.Mark("codex")?.Data);
        Assert.Null(ProviderMarks.Mark("other"));
    }
}
