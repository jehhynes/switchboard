using Switchboard.Dock.Switching;

namespace Switchboard.Dock.Tests;

public sealed class PasteTests
{
    [Fact]
    public void Read_DraftWithMarkAndTrailingSpace_ReturnsTheTextOnly()
    {
        var file = Path.Combine(Fixtures.TempFolder(), "reply.md");

        File.WriteAllText(file, "\uFEFFHello,\n\nThanks.\n  \n", new System.Text.UTF8Encoding(true));

        Assert.Equal("Hello,\n\nThanks.", Paste.Read(file));
    }

    [Fact]
    public void Read_MissingFile_Throws()
    {
        Assert.Throws<FileNotFoundException>(() => Paste.Read(Path.Combine(Fixtures.TempFolder(), "gone.md")));
    }
}
