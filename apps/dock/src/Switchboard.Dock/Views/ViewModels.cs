using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Switchboard.Dock.Hub;
using Switchboard.Dock.Platform;

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
    /// <summary>Blocked on you, Ready for review, In progress and Unstarted start open; Done and Snoozed start closed (PRD R27).</summary>
    // Done's older date bands start closed each run, so the recent ones show first (PRD R27).
    static readonly HashSet<string> OpenByDefault = ["blocked", "review", "progress", "unstarted", "done:Today", "done:Yesterday"];

    /// <summary>The groups whose operator-turn rows F8 visits (PRD R73).</summary>
    static readonly HashSet<string> TurnGroups = ["blocked", "review"];

    /// <summary>Done's date bands the operator opened or closed this run, by key; not kept in <c>dock.json</c> (PRD R27).</summary>
    readonly Dictionary<string, bool> bandsOpen = [];

    string? status;
    string? vsCodeTheme;
    string? connection = "Connecting to Switchboard…";
    string? selected;
    string filter = "";
    bool searchOpen;
    string? adhocRepo;
    JsonNode? groupContent;
    bool viewHeld;
    DockView? pendingView;

    public DockSettings Settings => settings;

    public string? VsCodeTheme => vsCodeTheme;

    public string Theme => settings.Theme;

    public bool SaveTheme(string theme)
    {
        var previous = settings.Theme;
        settings.Theme = theme;
        if (!SaveSettings())
        {
            settings.Theme = previous;
            return false;
        }

        Changed(nameof(Theme));
        return true;
    }

    /// <summary>The resize grip is on the inner edge.</summary>
    public bool GripOnLeft => settings.DockEdge == DockEdge.Right;

    public bool GripOnRight => settings.DockEdge == DockEdge.Left;

    /// <summary>Docks at another edge or monitor, and keeps the choice; a null monitor is the primary one.</summary>
    public void SetPlacement(DockEdge edge, string? monitor)
    {
        settings.Edge = edge == DockEdge.Right ? "right" : "left";
        settings.Monitor = monitor;
        SaveSettings();
        Placed();
    }

    /// <summary>Auto-hide (PRD R71): the header's pin shows <c>pin</c> while it is on and <c>pinned</c> while the dock keeps its strip.</summary>
    public bool AutoHide
    {
        get => settings.AutoHide;
        set
        {
            if (settings.AutoHide == value)
            {
                return;
            }

            settings.AutoHide = value;
            SaveSettings();
            Changed(nameof(AutoHide));
            Changed(nameof(AutoHideGlyph));
            Changed(nameof(AutoHideTip));
        }
    }

    public string AutoHideGlyph => settings.AutoHide ? "\uEB2B" : "\uEBA0";

    public string AutoHideTip => settings.AutoHide ? "Keep the dock open" : "Auto-hide the dock";

    void Placed()
    {
        Changed(nameof(GripOnLeft));
        Changed(nameof(GripOnRight));
    }

    public ObservableCollection<GroupViewModel> Groups { get; } = [];

    public ObservableCollection<string> Notes { get; } = [];

    public IReadOnlyList<SnoozeChoice> Snooze { get; private set; } = [];

    /// <summary>The header's toggles, one per configured source (PRD R3).</summary>
    public ObservableCollection<SourceViewModel> Sources { get; } = [];

    /// <summary>The repos an ad-hoc prompt can run in, the first being the default (PRD R6).</summary>
    public ObservableCollection<string> RepoRoots { get; } = [];

    /// <summary>The schedules the New Ad-hoc Session window can run now (PRD R82).</summary>
    public IReadOnlyList<ScheduleEntry> Schedules { get; private set; } = [];

    /// <summary>The search box's text: only rows whose search text holds every word show, and every group with one shows open (PRD R71).</summary>
    public string Filter
    {
        get => filter;
        set
        {
            Set(ref filter, value ?? "");

            foreach (var group in Groups)
            {
                group.Filter(filter);
            }

        }
    }

    /// <summary>Whether the search box shows; hiding it clears the search.</summary>
    public bool SearchOpen
    {
        get => searchOpen;
        set
        {
            Set(ref searchOpen, value);

            if (!value)
            {
                Filter = "";
            }
        }
    }

    /// <summary>The repo the New Ad-hoc Session window offers first: the last one used, else the first repo root.</summary>
    public string? AdhocRepo
    {
        get => adhocRepo;
        set => Set(ref adhocRepo, value);
    }

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

            foreach (var row in Groups.SelectMany((group) => group.AllRows))
            {
                row.IsSelected = row.Key == value;
            }
        }
    }

    public void Show(Connection state, string? notRunning = null)
    {
        if (state != Hub.Connection.Connected)
        {
            pendingView = null;
            Set(ref vsCodeTheme, null, nameof(VsCodeTheme));
        }

        Connection = state switch
        {
            Hub.Connection.Connected => null,
            Hub.Connection.Connecting => "Connecting to Switchboard…",
            Hub.Connection.NotRunning => notRunning ?? "Switchboard is not running. Open VS Code to start it.",
            Hub.Connection.TooOld => "The running hub has no dock view. Reload a VS Code window to update it.",
            _ => throw new ArgumentOutOfRangeException(nameof(state)),
        };
    }

    internal void HoldView() => viewHeld = true;

    internal void ReleaseView()
    {
        viewHeld = false;
        var view = pendingView;
        pendingView = null;

        if (view is not null)
        {
            Show(view);
        }
    }

    public void Show(DockView view)
    {
        Set(ref vsCodeTheme, view.Theme, nameof(VsCodeTheme));
        if (viewHeld)
        {
            pendingView = view;
            return;
        }

        Show(Hub.Connection.Connected);
        Snooze = view.Snooze;
        Schedules = view.Schedules ?? [];

        if (!Sources.Select((source) => (source.Name, source.Enabled)).SequenceEqual(view.Sources.Select((source) => (source.Name, source.Enabled))))
        {
            Sources.Clear();

            foreach (var source in view.Sources)
            {
                Sources.Add(new SourceViewModel(source.Name, source.Enabled));
            }
        }

        if (!RepoRoots.SequenceEqual(view.RepoRoots))
        {
            RepoRoots.Clear();

            foreach (var repo in view.RepoRoots)
            {
                RepoRoots.Add(repo);
            }

            AdhocRepo = RepoRoots.Contains(AdhocRepo ?? "") ? AdhocRepo : RepoRoots.FirstOrDefault();
        }

        if (!Notes.SequenceEqual(view.Notes))
        {
            Notes.Clear();

            foreach (var note in view.Notes)
            {
                Notes.Add(note);
            }
        }

        // Focus reports carry the whole view; replacing unchanged rows between press and release loses the click.
        var content = JsonSerializer.SerializeToNode(view.Groups);

        if (JsonNode.DeepEquals(groupContent, content))
        {
            return;
        }

        groupContent = content;
        var kept = Groups.ToDictionary((group) => group.Key);

        Groups.Clear();

        foreach (var group in view.Groups)
        {
            var model = kept.GetValueOrDefault(group.Key) ?? new GroupViewModel(group.Key, IsOpen(group.Key), Toggled, IsBandOpen, BandToggled);

            model.Show(group, selected, filter);
            Groups.Add(model);
        }

    }

    bool IsOpen(string key) => settings.Groups.TryGetValue(key, out var open) ? open : OpenByDefault.Contains(key);

    bool IsBandOpen(string key) => bandsOpen.TryGetValue(key, out var open) ? open : OpenByDefault.Contains(key);

    void Toggled(GroupViewModel group)
    {
        settings.Groups[group.Key] = group.IsOpen;
        SaveSettings();
    }

    void BandToggled(BandViewModel band) => bandsOpen[band.Key] = band.IsOpen;

    /// <summary>Keeps the settings; a failure shows on the status line and changes nothing else.</summary>
    public bool SaveSettings()
    {
        try
        {
            save(settings);
            return true;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            Status = $"The dock could not save its settings: {error.Message}";
            return false;
        }
    }

    /// <summary>
    /// Selects the row whose item window or session terminal came to the front, the first in list order when several work items of a ticket share
    /// it, and opens its group; returns its key, or null when no row has that window (PRD R71).
    /// </summary>
    public string? SelectWindow(string name)
    {
        foreach (var group in Groups)
        {
            if (group.AllRows.FirstOrDefault((row) => row.Row.Window?.Name == name || row.Row.Open?.Terminal?.Name == name || row.Row.Terminal?.Name == name) is { } row)
            {
                Reveal(group, row);

                return row.Key;
            }
        }

        return null;
    }

    /// <summary>Clears the selection when the selected row's item window closed.</summary>
    public void WindowClosed(string name)
    {
        if (selected is { } key && Row(key)?.Row.Window?.Name == name)
        {
            Selected = null;
        }
    }

    /// <summary>
    /// Selects the next row on the operator's turn in Blocked on you and Ready for review, in list order after the selection and wrapping, or the
    /// previous one when <paramref name="backwards"/>; returns it, or null when there is none (PRD R73).
    /// </summary>
    public RowViewModel? SelectNextTurn(bool backwards)
    {
        var rows = Groups.SelectMany((group) => group.AllRows.Select((row) => (Group: group, Row: row))).ToList();
        var count = rows.Count;
        var start = rows.FindIndex((entry) => entry.Row.Key == selected);

        if (start < 0)
        {
            start = backwards ? count : -1;
        }

        for (var step = 1; step <= count; step++)
        {
            var (group, row) = rows[(((start + (backwards ? -step : step)) % count) + count) % count];

            if (row.Row.Turn == "operator" && TurnGroups.Contains(group.Key))
            {
                Reveal(group, row);

                return row;
            }
        }

        return null;
    }

    /// <summary>Selects a row and shows it: clears a search that hides it and opens its group and date band.</summary>
    void Reveal(GroupViewModel group, RowViewModel row)
    {
        if (!group.Rows.Contains(row))
        {
            Filter = "";
        }

        if (!group.IsOpen)
        {
            group.Toggle();
        }

        if (group.Bands.FirstOrDefault((band) => band.Rows.Contains(row)) is { IsOpen: false } closed)
        {
            closed.Toggle();
        }

        Selected = row.Key;
    }

    public RowViewModel? Row(string key) => Groups.SelectMany((group) => group.AllRows).FirstOrDefault((row) => row.Key == key);
}

/// <summary>
/// A group's rows under one date band of Done, such as <c>Today</c>, or all of another group's rows under no heading (PRD R27). A band's open
/// state lasts until the dock exits.
/// </summary>
public sealed class BandViewModel(string key, string? title, bool open, Action<BandViewModel> toggled) : Observable
{
    bool isOpen = open;
    bool filtering;
    IReadOnlyList<RowViewModel> rows = [];

    public string Key => key;

    public string? Title => title;

    public bool HasTitle => title is not null;

    public bool IsOpen
    {
        get => isOpen;
        private set => Set(ref isOpen, value);
    }

    /// <summary>Open by the operator's choice or while the search box filters; rows under no heading always show.</summary>
    public bool ShowsRows => !HasTitle || IsOpen || filtering;

    public string Chevron => ShowsRows ? "\uEAB4" : "\uEAB6";

    public IReadOnlyList<RowViewModel> Rows => rows;

    public string Count => rows.Count.ToString(System.Globalization.CultureInfo.InvariantCulture);

    public void Show(IReadOnlyList<RowViewModel> shown, bool filtered)
    {
        rows = shown;
        filtering = filtered;
        Changed(nameof(Rows));
        Changed(nameof(Count));
        Changed(nameof(ShowsRows));
        Changed(nameof(Chevron));
    }

    public void Toggle()
    {
        IsOpen = !IsOpen;
        Changed(nameof(ShowsRows));
        Changed(nameof(Chevron));
        toggled(this);
    }
}

public sealed class GroupViewModel(string key, bool open, Action<GroupViewModel> toggled, Func<string, bool>? bandOpen = null, Action<BandViewModel>? bandToggled = null)
    : Observable
{
    readonly Dictionary<string, BandViewModel> kept = [];
    bool isOpen = open;
    string glyph = "";
    IReadOnlyList<BandViewModel> bands = [];
    string title = "";
    string? empty;
    string filter = "";
    IReadOnlyList<RowViewModel> all = [];
    IReadOnlyList<RowViewModel> rows = [];

    public string Key => key;

    public string Title
    {
        get => title;
        private set => Set(ref title, value);
    }

    /// <summary>The operator's choice, kept across runs.</summary>
    public bool IsOpen
    {
        get => isOpen;
        private set => Set(ref isOpen, value);
    }

    bool Filtering => filter.Trim() != "";

    /// <summary>Open by the operator's choice, or while the search box filters.</summary>
    public bool ShowsRows => IsOpen || Filtering;

    /// <summary>Hidden while the search box filters out all its rows.</summary>
    public bool IsShown => !Filtering || Rows.Count > 0;

    /// <summary>The codicon of the group's open or closed state.</summary>
    public string Chevron => ShowsRows ? "\uEAB4" : "\uEAB6";

    /// <summary>The rows the search box lets through.</summary>
    public IReadOnlyList<RowViewModel> Rows
    {
        get => rows;
        private set => Set(ref rows, value);
    }

    public IReadOnlyList<RowViewModel> AllRows => all;

    /// <summary>The shown rows by date band, in list order; Done's rows are sorted newest first, so each band's rows are consecutive.</summary>
    public IReadOnlyList<BandViewModel> Bands
    {
        get => bands;
        private set => Set(ref bands, value);
    }

    public string Count => Rows.Count.ToString(System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>An empty group's badge is muted, as in the VS Code panel.</summary>
    public bool IsZero => Rows.Count == 0;

    /// <summary>The group's codicon, such as an eye for Ready for review.</summary>
    public string Glyph
    {
        get => glyph;
        private set => Set(ref glyph, value);
    }

    public string? Empty
    {
        get => empty;
        private set => Set(ref empty, value);
    }

    public bool ShowEmpty => Rows.Count == 0 && Empty is not null && !Filtering;

    public void Show(DockGroup group, string? selected, string filtering)
    {
        Title = group.Title;
        Glyph = group.Glyph;
        Empty = group.Empty;
        all = group.Rows.Select((row) => new RowViewModel(row) { IsSelected = row.Key == selected }).ToList();
        Filter(filtering);
    }

    public void Filter(string text)
    {
        filter = text;
        Rows = all.Where((row) => Matches(row.Row.Search, text)).ToList();
        Bands = Rows.GroupBy((row) => row.Row.Band).Select((rows) => BandOf(rows.Key, rows.ToList())).ToList();
        Changed(nameof(Count));
        Changed(nameof(IsZero));
        Changed(nameof(ShowEmpty));
        Changed(nameof(ShowsRows));
        Changed(nameof(IsShown));
        Changed(nameof(Chevron));
    }

    BandViewModel BandOf(string? title, IReadOnlyList<RowViewModel> rows)
    {
        var bandKey = title is null ? key : $"{key}:{title}";

        if (!kept.TryGetValue(bandKey, out var band))
        {
            band = new BandViewModel(bandKey, title, bandOpen?.Invoke(bandKey) ?? true, (changed) => bandToggled?.Invoke(changed));
            kept[bandKey] = band;
        }

        band.Show(rows, Filtering);

        return band;
    }

    /// <summary>Whether the search text holds every word of the filter, ignoring case.</summary>
    public static bool Matches(string search, string filter) =>
        filter.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).All((word) => search.Contains(word, StringComparison.CurrentCultureIgnoreCase));

    public void Toggle()
    {
        IsOpen = !IsOpen;
        Changed(nameof(ShowsRows));
        Changed(nameof(Chevron));
        toggled(this);
    }
}

/// <summary>A source's on/off toggle in the header (PRD R3), labelled as its key pills are, such as <c>gh</c>.</summary>
public sealed class SourceViewModel(string name, bool enabled)
{
    public string Name => name;

    public bool Enabled => enabled;

    public bool IsGithub => name == "github";

    public bool IsZoho => name == "zoho";

    public bool IsForum => name == "forum";

    public string Tip => $"{name}: {(enabled ? "polled. Click to stop polling it." : "not polled. Click to poll it.")}";
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

    /// <summary>How many times the same work came back (PRD R51), on line 2.</summary>
    public string ReturnedText => row.Returned > 0 ? $"{row.Returned}" : "";

    public bool HasReturned => row.Returned > 0;

    /// <summary>The operator's comments (PRD R87), as an icon on line 2 with the comments as its tooltip.</summary>
    public bool HasComment => row.Comment is not null;

    public string CommentGlyph => row.Comment?.Glyph ?? "";

    public string? CommentTitle => row.Comment?.Title;

    /// <summary>The ticket's URL, which its key pill opens; empty for an ad-hoc ticket.</summary>
    public string Url => row.Url;

    /// <summary>The ticket's links, as badges after its key on line 2 (PRD R52).</summary>
    public IReadOnlyList<DockLink> Links => row.Links;

    public bool HasMain => row.Main is not null;

    public string Main => row.Main ?? "";

    /// <summary>The main control's codicon, before its label.</summary>
    public string MainGlyph => row.MainGlyph ?? "";

    /// <summary>For Approve, the prompt it runs (PRD R27).</summary>
    public string? MainTitle => row.MainTitle;

    /// <summary>Approve takes the accent colour (PRD R27).</summary>
    public bool MainIsApprove => row.Main == "Approve";

    public bool HasCopy => row.Pastes.Count > 0;

    public string CopyTitle => row.Pastes.Count == 1 ? $"Copy {row.Pastes[0].Label}" : "Copy…";

    public DockCommand? Report => row.Commands.FirstOrDefault((command) => command.Label == "Open report");

    public bool HasReport => Report is not null;

    /// <summary>Whether the row has any button, so a row without one keeps its full width on hover.</summary>
    public bool HasActions => HasMain || HasCopy || HasReport;

    public string ReportTitle => Report?.Command["url"]?.GetValue<string>() is { } file ? Path.GetFileName(file) : "";

    public bool StripeWarning => row.Stripe == Tone.Warning;

    public bool StripeError => row.Stripe == Tone.Error;

    /// <summary>The operator's turn in Ready for review (PRD R27).</summary>
    public bool StripeTurn => row.Stripe == Tone.Turn;

    /// <summary>A Ready for review row on the agent's turn shows dimmed (PRD R27).</summary>
    public bool IsDim => row.Dim;

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
