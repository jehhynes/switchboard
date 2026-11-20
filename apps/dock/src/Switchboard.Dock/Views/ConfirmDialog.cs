using Avalonia.Controls;
using Avalonia.Media;

namespace Switchboard.Dock.Views;

/// <summary>
/// A small modal window that asks before a destructive action, such as Delete or Stop: &lt;c&gt;ConfirmAction&lt;/c&gt;, in the error colour, goes ahead and
/// &lt;c&gt;ConfirmCancel&lt;/c&gt;, which has the focus at first so Enter cancels, does not.
/// </summary>
static class ConfirmDialog
{
    public static Task<bool> Ask(Window owner, string question, string detail, string action)
    {
        var shell = new DialogShell(owner, question, 420);

        shell.Body.Children.Add(new TextBlock { Name = "ConfirmDetail", Text = detail, TextWrapping = TextWrapping.Wrap });
        shell.Add("ConfirmCancel", "Cancel", DialogButton.Cancel).Click += (_, _) => shell.Window.Close(false);
        shell.Add("ConfirmAction", action, DialogButton.Danger).Click += (_, _) => shell.Window.Close(true);

        return shell.Window.ShowDialog<bool>(owner);
    }
}
