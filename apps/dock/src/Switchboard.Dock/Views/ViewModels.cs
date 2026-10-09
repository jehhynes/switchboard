using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using Switchboard.Dock.Hub;

namespace Switchboard.Dock.Views;

public abstract class Observable : INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;

    protected void Set<T>(ref T field, T value, [CallerMemberName] string name = "")
    {
        if (!EqualityComparer<T>.Default.Equals(field, value))
        {
            field = value;
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
        }
    }

    protected void Changed(string name) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}

/// <summary>The dock's list: the hub's groups and rows, the groups the operator opened or closed, the selected row, and the status line.</summary>
public sealed class DockViewModel(DockSettings settings, Action<DockSettings> save) : Observable
{
    /// <summary>Needs you, Working and Unstarted start open; Done and Snoozed start closed (PRD R27).</summary>
    static readonly HashSet<string> OpenByDefault = ["needs", "working", "unstarted"];

    string? status;
    string? connection = "Connecting to Switchboard…";
    string? selected;

    public DockSettings Settings => settings;

    public ObservableCollection<GroupViewModel> Groups { get; } = [];

    public ObservableCollection<string> Notes { get; } = [];

    public IReadOnlyList<SnoozeChoice> Snooze { get; private set; } = [];

    /// <summary>What the last click could not do, shown until the next click.</summary>
    public string? Status
    {
        get => status;
        set => Set(ref status, value);
    }

    /// <summary>Why the dock has no current view, or null while it has one.</summary>
    public string? Connection
    {
        get => connection;
        private set => Set(ref connection, value);
    }

    public string? Selected
    {
        get => selected;
        set
        {
            Set(ref selected, value);

            foreach (var row in Groups.SelectMany((group) => group.Rows))
            {
                row.IsSelected = row.Key == value;
            }
        }
    }

    public void Show(Connection state) =>
        Connection = state switch
        {
            Hub.Connection.Connected => null,
            Hub.Connection.Connecting => "Connecting to Switchboard…",
            Hub.Connection.NotRunning => "Switchboard is not running. Open VS Code to start it.",
            Hub.Connection.TooOld => "The running hub has no dock view. Reload a VS Code window to update it.",
            _ => throw new ArgumentOutOfRangeException(nameof(state)),
        };

    public void Show(DockView view)
    {
        Show(Hub.Connection.Connected);
        Snooze = view.Snooze;

        Notes.Clear();

        foreach (var note in view.Notes)
        {
            Notes.Add(note);
        }

        var kept = Groups.ToDictionary((group) => group.Key);

        Groups.Clear();

        foreach (var group in view.Groups)
        {
            var model = kept.GetValueOrDefault(group.Key) ?? new GroupViewModel(group.Key, settings.Groups.TryGetValue(group.Key, out var open) ? open : OpenByDefault.Contains(group.Key), Toggled);

            model.Show(group, selected);
            Groups.Add(model);
        }
    }

    void Toggled(GroupViewModel group)
    {
        settings.Groups[group.Key] = group.IsOpen;
        SaveSettings();
    }

    /// <summary>Keeps the settings; a failure shows on the status line and changes nothing else.</summary>
    public void SaveSettings()
    {
        try
        {
            save(settings);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            Status = $"The dock could not save its settings: {error.Message}";
        }
    }

    /// <summary>
    /// Selects the row whose item window came to the front, the first in list order when several work items of a ticket share it, and opens its
    /// group; returns its key, or null when no row has that window.
    /// </summary>
    public string? SelectWindow(string name)
    {
        foreach (var group in Groups)
        {
            if (group.Rows.FirstOrDefault((row) => row.Row.Window?.Name == name) is { } row)
            {
                if (!group.IsOpen)
                {
                    group.Toggle();
                }

                Selected = row.Key;

                return row.Key;
            }
        }

        return null;
    }

    public RowViewModel? Row(string key) => Groups.SelectMany((group) => group.Rows).FirstOrDefault((row) => row.Key == key);
}

public sealed class GroupViewModel(string key, bool open, Action<GroupViewModel> toggled) : Observable
{
    bool isOpen = open;
    string title = "";
    string? empty;
    IReadOnlyList<RowViewModel> rows = [];

    public string Key => key;

    public string Title
    {
        get => title;
        private set => Set(ref title, value);
    }

    public bool IsOpen
    {
        get => isOpen;
        private set => Set(ref isOpen, value);
    }

    /// <summary>The codicon of the group's open or closed state.</summary>
    public string Chevron => IsOpen ? "" : "";

    public IReadOnlyList<RowViewModel> Rows
    {
        get => rows;
        private set => Set(ref rows, value);
    }

    public string Count => Rows.Count.ToString(System.Globalization.CultureInfo.InvariantCulture);

    public string? Empty
    {
        get => empty;
        private set => Set(ref empty, value);
    }

    public bool ShowEmpty => Rows.Count == 0 && Empty is not null;

    public void Show(DockGroup group, string? selected)
    {
        Title = group.Title;
        Empty = group.Empty;
        Rows = group.Rows.Select((row) => new RowViewModel(row) { IsSelected = row.Key == selected }).ToList();
        Changed(nameof(Count));
        Changed(nameof(ShowEmpty));
    }

    public void Toggle()
    {
        IsOpen = !IsOpen;
        Changed(nameof(Chevron));
        toggled(this);
    }
}

/// <summary>One row's texts, as the hub sent them.</summary>
public sealed class RowViewModel(DockRow row) : Observable
{
    bool isSelected;

    public DockRow Row => row;

    public string Key => row.Key;

    public string Title => row.Title;

    public bool IsPriority => row.Priority is not null;

    public string? PriorityTitle => row.Priority;

    public string Time => row.Time?.Text ?? "";

    public string? TimeTitle => row.Time?.Title;

    /// <summary>The playbook's namespace and colon, shown muted (PRD R27).</summary>
    public string Namespace => row.Playbook.Contains(':') ? row.Playbook[..(row.Playbook.IndexOf(':') + 1)] : "";

    public string Name => row.Playbook.Contains(':') ? row.Playbook[(row.Playbook.IndexOf(':') + 1)..] : row.Playbook;

    public string Ticket => row.Ticket;

    public string Source => row.Source;

    public bool HasMark => row.Mark is not null;

    public string MarkGlyph => row.Mark?.Glyph ?? "";

    public string? MarkTitle => row.Mark?.Title;

    public bool MarkFailed => row.Mark?.Kind == "failed";

    /// <summary>Running and Triaging spin, as in the panel.</summary>
    public bool MarkSpins => row.Mark?.Kind is "running" or "triaging";

    public IReadOnlyList<DetailViewModel> Details { get; } = row.Details.Select((detail) => new DetailViewModel(detail)).ToList();

    public bool IsGithub => row.Source == "github";

    public bool IsZoho => row.Source == "zoho";

    public bool IsForum => row.Source == "forum";

    public bool HasThirdLine => row.Mark is not null || row.Details.Count > 0;

    public bool StripeWarning => row.Stripe == Tone.Warning;

    public bool StripeError => row.Stripe == Tone.Error;

    public bool IsSelected
    {
        get => isSelected;
        set => Set(ref isSelected, value);
    }
}

/// <summary>A piece of line 3, coloured by its tone.</summary>
public sealed class DetailViewModel(DockText text)
{
    public string Text => text.Text;

    public string? Title => text.Title;

    public bool IsWarning => text.Tone == Tone.Warning;

    public bool IsError => text.Tone == Tone.Error;
}
