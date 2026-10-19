using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Interactivity;
using Avalonia.Media;
using Avalonia.Styling;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Views;

namespace Switchboard.Dock.Tests;

public sealed class ThemeTests
{
    [Theory]
    [InlineData("light", "light")]
    [InlineData("dark", "dark")]
    [InlineData("vscode", "vscode")]
    [InlineData("system", "system")]
    [InlineData("unknown", "system")]
    [InlineData(null, "system")]
    public void Settings_Reload_KeepsSupportedThemes(string? theme, string expected)
    {
        var home = Fixtures.TempFolder();
        new DockSettings { Theme = theme! }.Save(home);
        Assert.Equal(expected, DockSettings.Load(home).Theme);
    }

    [AvaloniaFact]
    public void Theme_Saved_UpdatesWindowsAndSavesChoice()
    {
        var saved = new List<string>();
        var model = new DockViewModel(new DockSettings(), settings => saved.Add(settings.Theme));
        var window = new MainWindow(model, null, new FakeHub(), new FakeActions(), false);
        var dialog = new Window();
        window.Show();
        dialog.Show();
        try
        {
            Assert.Equal(ThemeVariant.Default, Application.Current!.RequestedThemeVariant);
            Assert.True(model.SaveTheme("light"));
            Assert.Equal(ThemeVariant.Light, window.ActualThemeVariant);
            Assert.Equal(ThemeVariant.Light, dialog.ActualThemeVariant);
            Assert.Equal(Color.Parse("#F8F8F8"), ((ISolidColorBrush)window.Background!).Color);
            Assert.True(model.SaveTheme("dark"));
            Assert.Equal(ThemeVariant.Dark, dialog.ActualThemeVariant);
            Assert.Equal(Color.Parse("#181818"), ((ISolidColorBrush)window.Background!).Color);
            Assert.True(model.SaveTheme("system"));
            Assert.Equal(ThemeVariant.Default, Application.Current.RequestedThemeVariant);
            Assert.Equal(["light", "dark", "system"], saved);
        }
        finally
        {
            window.Close();
            dialog.Close();
            Application.Current!.RequestedThemeVariant = ThemeVariant.Default;
        }
    }

    [AvaloniaFact]
    public void VsCodeTheme_ReportsAndDisconnect_FollowsOnlyWhenSelected()
    {
        var model = new DockViewModel(new DockSettings { Theme = "vscode" }, _ => { });
        var window = new MainWindow(model, null, new FakeHub(), new FakeActions(), false);
        window.Show();
        try
        {
            Assert.Equal(ThemeVariant.Default, Application.Current!.RequestedThemeVariant);
            model.Show(Fixtures.View with { Theme = "dark" });
            Assert.Equal(ThemeVariant.Dark, window.ActualThemeVariant);
            model.Show(Fixtures.View with { Theme = "light" });
            Assert.Equal(ThemeVariant.Light, window.ActualThemeVariant);
            Assert.True(model.SaveTheme("dark"));
            model.Show(Fixtures.View with { Theme = "dark" });
            model.Show(Fixtures.View with { Theme = "light" });
            Assert.Equal(ThemeVariant.Dark, window.ActualThemeVariant);
            Assert.True(model.SaveTheme("vscode"));
            Assert.Equal(ThemeVariant.Light, window.ActualThemeVariant);
            model.Show(Connection.NotRunning);
            Assert.Equal(ThemeVariant.Default, Application.Current.RequestedThemeVariant);
        }
        finally
        {
            window.Close();
            Application.Current!.RequestedThemeVariant = ThemeVariant.Default;
        }
    }

}
