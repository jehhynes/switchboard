using Avalonia.Controls;

namespace Switchboard.Dock.Views;

/// <summary>Provider and model for a new standalone session.</summary>
static class NewSessionDialog
{
    internal sealed record Choice(string Provider, string? Model);

    public static Task<Choice?> Ask(Window owner, string folder, string preferred, string? claudeModel, string? codexModel, IReadOnlyList<string>? installed, string? note = null)
    {
        var shell = new DialogShell(owner, "New session", 420, folder);
        var provider = ProviderDialog.Box(preferred, "SessionProvider", installed);
        var model = new TextBox { Name = "SessionModel", PlaceholderText = "Provider default", Text = (provider.SelectedItem as ProviderDialog.Option)?.Id == "codex" ? codexModel : claudeModel };
        provider.SelectionChanged += (_, _) => model.Text = (provider.SelectedItem as ProviderDialog.Option)?.Id == "codex" ? codexModel : claudeModel;
        shell.Body.Children.Add(DialogShell.Field("Provider", provider));
        shell.Body.Children.Add(DialogShell.Field("Model", model));
        if (note is not null) shell.Body.Children.Add(shell.Note(note));
        shell.Add("SessionCancel", "Cancel", DialogButton.Cancel).Click += (_, _) => shell.Window.Close(null);
        shell.Add("SessionStart", "Start", DialogButton.Primary).Click += (_, _) =>
            shell.Window.Close(new Choice((provider.SelectedItem as ProviderDialog.Option)?.Id ?? "claude", string.IsNullOrWhiteSpace(model.Text) ? null : model.Text.Trim()));
        return shell.Window.ShowDialog<Choice?>(owner);
    }
}
