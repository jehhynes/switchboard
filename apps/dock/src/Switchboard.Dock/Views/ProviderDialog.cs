using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;

namespace Switchboard.Dock.Views;

/// <summary>Provider choice for a new conversation or ad-hoc prompt; it never changes the configured default.</summary>
static class ProviderDialog
{
    internal sealed record Option(string Id, string Label)
    {
        public override string ToString() => Label;
    }

    public static ComboBox Box(string preferred, string name, IReadOnlyList<string>? installed = null)
    {
        var options = new Option[] { new("claude", "Claude"), new("codex", "Codex") }.Where(one => installed is null || installed.Contains(one.Id)).ToArray();
        return new ComboBox { Name = name, ItemsSource = options, SelectedIndex = Math.Max(0, Array.FindIndex(options, one => one.Id == preferred)), HorizontalAlignment = HorizontalAlignment.Stretch };
    }

    /// <summary>
    /// Asks which provider a new conversation starts in, with &lt;paramref name="preferred"/&gt; selected, naming &lt;paramref name="folder"/&gt; when given, as
    /// New conversation in a folder does; returns the provider, or null on Cancel.
    /// </summary>
    public static Task<string?> Ask(Window owner, string preferred, string? folder = null)
    {
        var shell = new DialogShell(owner, "New conversation in a folder", 420, folder);
        var choice = Box(preferred, "SessionProvider");

        shell.Body.Children.Add(DialogShell.Field("Provider", choice));
        shell.Add("SessionCancel", "Cancel", DialogButton.Cancel).Click += (_, _) => shell.Window.Close(null);
        shell.Add("SessionCreate", "Create", DialogButton.Primary).Click += (_, _) => shell.Window.Close((choice.SelectedItem as Option)?.Id);

        return shell.Window.ShowDialog<string?>(owner);
    }
}
