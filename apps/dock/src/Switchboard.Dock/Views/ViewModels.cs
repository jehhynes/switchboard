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
public sealed class DockViewModel(DockSettings settings, Action<DockSettings> save, TimeProvider? time = null) : Observable
{
    /// <summary>How long the search box waits after a key before it searches, and the fewest characters it searches for (PRD R63).</summary>
    public static readonly TimeSpan SearchDelay = TimeSpan.FromMilliseconds(250);

    public const int SearchMinimum = 3;

    /// <summary>The searched time ranges, from the Done list's two weeks to all time (PRD R63).</summary>
    public static readonly IReadOnlyList<string> Ranges = ["Last 2 weeks", "Last month", "Last 3 months", "All time"];

    readonly TimeProvider clock = time ?? TimeProvider.System;

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
    string query = "";
    ITimer? searchTimer;
    int typedRun;
    int range;
    int searchRun;
    bool searchPending;
    string? searchError;
    IReadOnlyList<DockRow> older = [];
    bool olderMore;
    DockGroup? doneGroup;
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

    IReadOnlyList<DockHeld> held = [];
    string? heldNote;

    /// <summary>The held sessions, orphans first, for the held sessions window (PRD R94).</summary>
    public IReadOnlyList<DockHeld> Held
    {
        get => held;
        private set
        {
            // Records compare their lists by reference, so the content is compared as JSON.
            if (!JsonNode.DeepEquals(JsonSerializer.SerializeToNode(held), JsonSerializer.SerializeToNode(value)))
            {
                held = value;
                Changed(nameof(Held));
            }
        }
    }

    /// <summary>How many held sessions have no work item, shown above the groups while there are any (PRD R94).</summary>
    public string? HeldNote
    {
        get => heldNote;
        private set => Set(ref heldNote, value);
    }

    /// <summary>
    /// The search applied: only rows whose search text holds every word show, and every group with one shows open (PRD R63). Setting it applies it
    /// at once and puts it in the search box.
    /// </summary>
    public string Filter
    {
        get => filter;
        set
        {
            CancelTimer();
            Set(ref query, value ?? "", nameof(Query));
            Apply(value ?? "");
        }
    }

    /// <summary>
    /// The search box's text. It searches 250 ms after the last key once it has 3 characters, and at once when it is a listed row's ticket or link
    /// key, such as &lt;c&gt;18941&lt;/c&gt;, &lt;c&gt;gh 18941&lt;/c&gt; or &lt;c&gt;PR #19002&lt;/c&gt;; shorter text shows every row (PRD R63).
    /// </summary>
    public string Query
    {
        get => query;
        set
        {
            Set(ref query, value ?? "");
            CancelTimer();
            var text = query.Trim();

            if (text == "")
            {
                Apply("");
            }
            // A key's number, so `#107` finds the row whose key is `gh 107`.
            else if (IsKey(text))
            {
                Apply(BareKey(text));
            }
            else if (text.Length < SearchMinimum)
            {
                Apply("");
            }
            else
            {
                var typed = query;
                var run = typedRun;

                searchTimer = clock.CreateTimer((_) => Avalonia.Threading.Dispatcher.UIThread.Post(() =>
                {
                    // A key since, even one that typed the same text again, waits its own delay.
                    if (run == typedRun)
                    {
                        Apply(typed);
                    }
                }), null, SearchDelay, Timeout.InfiniteTimeSpan);
            }
        }
    }

    void CancelTimer()
    {
        typedRun++;
        searchTimer?.Dispose();
        searchTimer = null;
    }

    /// <summary>Whether the text is a number, or a listed row's ticket key or a link's key, with or without &lt;c&gt;gh&lt;/c&gt;, &lt;c&gt;PR&lt;/c&gt; or &lt;c&gt;#&lt;/c&gt;.</summary>
    bool IsKey(string text)
    {
        var bare = BareKey(text);

        // A ticket or pull request number, listed or not, such as older work's (PRD R63).
        if (bare != "" && bare.All(char.IsAsciiDigit))
        {
            return true;
        }

        return Groups.SelectMany((group) => group.AllRows).Any((row) => BareKey(row.Ticket) == bare || row.Links.Any((link) => BareKey(link.Label) == bare));
    }

    static string BareKey(string key)
    {
        var bare = key.Trim().ToLowerInvariant();

        foreach (var prefix in new[] { "gh ", "pr " })
        {
            if (bare.StartsWith(prefix, StringComparison.Ordinal))
            {
                bare = bare[prefix.Length..].TrimStart();
            }
        }

        return bare.TrimStart('#');
    }

    void Apply(string text)
    {
        if (filter == text)
        {
            return;
        }

        Set(ref filter, text, nameof(Filter));
        DropOlder();

        foreach (var group in Groups)
        {
            group.Filter(filter);
        }

        SearchOlder();
        SearchChanged();
    }

    /// <summary>The searched time range, an index of &lt;see cref="Ranges"/&gt;: 0 is the Done list's two weeks, which the dock has; the others ask the hub.</summary>
    public int Range
    {
        get => range;
        set
        {
            var next = Math.Clamp(value, 0, Ranges.Count - 1);

            if (range == next)
            {
                return;
            }

            range = next;
            Changed(nameof(Range));
            Changed(nameof(RangeText));
            DropOlder();
            SearchOlder();
            SearchChanged();
        }
    }

    public string RangeText => Ranges[range];

    /// <summary>Widens the searched range by one step (PRD R63).</summary>
    public void SearchFurther() => Range = range + 1;

    /// <summary>Asks the hub for the Done rows before the Done list (PRD R63); a newer search or range drops an answer that comes after it.</summary>
    public Func<string, long, Task<SearchReply>>? SearchHub { get; set; }

    bool Filtering => filter.Trim() != "";

    async void SearchOlder()
    {
        if (!Filtering || range == 0 || SearchHub is null)
        {
            return;
        }

        var run = ++searchRun;
        var now = clock.GetLocalNow();
        var since = range switch { 1 => now.AddMonths(-1).ToUnixTimeMilliseconds(), 2 => now.AddMonths(-3).ToUnixTimeMilliseconds(), _ => 0 };

        searchPending = true;
        SearchChanged();
        var reply = await SearchHub(filter.Trim(), since);

        if (run != searchRun)
        {
            return;
        }

        searchPending = false;
        searchError = reply.Error is null ? null : $"The hub could not search further back: {reply.Error}";
        older = reply.Rows;
        olderMore = reply.More;
        ShowDone();
        SearchChanged();
    }

    /// <summary>Drops the rows of the last search before the Done list, and any answer still to come.</summary>
    void DropOlder()
    {
        searchRun++;
        searchPending = false;
        searchError = null;
        olderMore = false;

        if (older.Count > 0)
        {
            older = [];
            ShowDone();
        }
    }

    /// <summary>Shows Done's rows from the view and, after them, those the hub found before the Done list.</summary>
    void ShowDone()
    {
        if (doneGroup is not null && Groups.FirstOrDefault((group) => group.Key == "done") is { } done)
        {
            var listed = doneGroup.Rows.Select((row) => row.Key).ToHashSet();

            done.Show(doneGroup with { Rows = [.. doneGroup.Rows, .. older.Where((row) => !listed.Contains(row.Key))] }, selected, filter);
        }
    }

    /// <summary>Whether the search box shows the end of its results: what was searched and how to search further back.</summary>
    public bool ShowsSearchEnd => searchOpen && Filtering;

    public bool IsSearchPending => searchPending;

    /// <summary>Nothing matched in the range searched, once the hub answered.</summary>
    public bool NoMatches => Filtering && !searchPending && Groups.All((group) => group.Rows.Count == 0);

    public string NoMatchText => range == Ranges.Count - 1 ? $"No matches for “{filter.Trim()}”." : $"No matches for “{filter.Trim()}” in the {Ranges[range].ToLowerInvariant()}.";

    /// <summary>Search further back: at the end of the results whenever the range is not all time, however many rows match.</summary>
    public bool CanSearchFurther => Filtering && range < Ranges.Count - 1;

    /// <summary>All time, beside Search further back when nothing matched and one step back is not already all time.</summary>
    public bool OffersAllTime => NoMatches && range < Ranges.Count - 2;

    public string? SearchNote => searchError ?? (searchPending ? "Searching…" : olderMore ? $"Showing the newest {older.Count} matches from before the last 2 weeks. Add words to narrow the search." : null);

    void SearchChanged()
    {
        Changed(nameof(ShowsSearchEnd));
        Changed(nameof(IsSearchPending));
        Changed(nameof(NoMatches));
        Changed(nameof(NoMatchText));
        Changed(nameof(CanSearchFurther));
        Changed(nameof(OffersAllTime));
        Changed(nameof(SearchNote));
    }

    /// <summary>Whether the search box shows; hiding it clears the search and its range.</summary>
    public bool SearchOpen
    {
        get => searchOpen;
        set
        {
            Set(ref searchOpen, value);

            if (!value)
            {
                Range = 0;
                Filter = "";
            }

            SearchChanged();
        }
    }

    /// <summary>The repo the New Ad-hoc Session window offers first: the last one used, else the first repo root.</summary>
    public string? AdhocRepo
    {
        get => adhocRepo;
        set => Set(ref adhocRepo, value);
    }

    /// <summary>The result of the last action, such as what a click could not do; the window shows it as a toast that hides after a time.</summary>
    public string? Status
    {
        get => status;
        // Always raised, so the same message again restarts the toast's time.
        set
        {
            status = value;
            Changed(nameof(Status));
        }
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
        Held = view.Held ?? [];
        HeldNote = view.HeldNote;

        // Groups are updated in place, so an open source menu, its anchor and its focus survive the snapshot a toggle sends.
        var groups = view.Sources.Select((group) => group.Current).ToList();

        if (!Sources.Select((group) => (group.Kind, group.Names)).SequenceEqual(groups.Select((group) => (group.Kind, string.Join(" ", group.Sources.Select((source) => source.Name)))), EqualityComparer<(string, string)>.Default))
        {
            Sources.Clear();

            foreach (var group in groups)
            {
                Sources.Add(new SourceViewModel(group));
            }
        }
        else
        {
            foreach (var (model, group) in Sources.Zip(groups))
            {
                model.Update(group);
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

        doneGroup = view.Groups.FirstOrDefault((group) => group.Key == "done");

        foreach (var group in view.Groups)
        {
            var model = kept.GetValueOrDefault(group.Key) ?? new GroupViewModel(group.Key, IsOpen(group.Key), Toggled, IsBandOpen, BandToggled);

            model.Show(group, selected, filter);
            Groups.Add(model);
        }

        // The rows the hub found before the Done list stay while their search does.
        if (older.Count > 0)
        {
            ShowDone();
        }

        SearchChanged();

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
            // A folder window has no sb: title, so no row is found by its window's name (architecture.md § Dock).
            if (group.AllRows.FirstOrDefault((row) => (row.Row.Window is { Folder: null } window && window.Name == name) || row.Row.Open?.Terminal?.Name == name || row.Row.Terminal?.Name == name) is { } row)
            {
                Reveal(group, row);

                return row.Key;
            }
        }

        return null;
    }

    /// <summary>
    /// The Switchboard session ID of the Code Mode session whose attach terminal has the window name, among the rows and the held sessions, or
    /// null for any other window (architecture.md § Voice).
    /// </summary>
    public string? TerminalSession(string name) =>
        Groups.SelectMany((group) => group.AllRows).SelectMany((row) => new[] { row.Row.Terminal, row.Row.Open?.Terminal }).Concat(Held.Select((one) => one.Terminal))
            .FirstOrDefault((terminal) => terminal is { CodeMode: true } && terminal.Name == name)?.SessionId;

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

    /// <summary>A band of Done, which draws only its rows in view.</summary>
    public bool InDone => key == "done" || key.StartsWith("done:", StringComparison.Ordinal);

    public bool IsOpen
    {
        get => isOpen;
        private set => Set(ref isOpen, value);
    }

    /// <summary>Open by the operator's choice or while the search box filters; rows under no heading always show.</summary>
    public bool ShowsRows => !HasTitle || IsOpen || filtering;

    public string Chevron => ShowsRows ? "\uEAB4" : "\uEAB6";

    public IReadOnlyList<RowViewModel> Rows => rows;

    /// <summary>
    /// The rows the list draws, the same as &lt;see cref="Rows"/&gt;, changed by inserting and removing rows, so a search keeps the rows it still shows
    /// instead of drawing every row again.
    /// </summary>
    public ObservableCollection<RowViewModel> Shown { get; } = [];

    public string Count => rows.Count.ToString(System.Globalization.CultureInfo.InvariantCulture);

    public void Show(IReadOnlyList<RowViewModel> shown, bool filtered)
    {
        rows = shown;
        filtering = filtered;
        Lists.Sync(Shown, shown);
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

static class Lists
{
    /// <summary>
    /// Makes &lt;paramref name="target"/&gt; hold &lt;paramref name="items"/&gt; in order. When both keep one order, as a narrower or wider search of the same
    /// rows does, it merges them in one pass with the fewest inserts and removals; after many changes or a new order it lists them again.
    /// </summary>
    public static void Sync<T>(ObservableCollection<T> target, IReadOnlyList<T> items) where T : class
    {
        var wanted = new HashSet<T>(items, ReferenceEqualityComparer.Instance);
        var kept = target.Where(wanted.Contains).ToList();
        var position = new Dictionary<T, int>(ReferenceEqualityComparer.Instance);

        for (var at = 0; at < items.Count; at++)
        {
            position[items[at]] = at;
        }

        var ordered = kept.Select((item) => position[item]).Zip(kept.Select((item) => position[item]).Skip(1)).All((pair) => pair.First < pair.Second);
        var changes = target.Count - kept.Count + items.Count - kept.Count;

        // Each insert or removal shifts the rest of the collection, so many of them cost more than listing the rows again.
        if (!ordered || changes > 64)
        {
            if (changes > 0 || !ordered)
            {
                target.Clear();

                foreach (var item in items)
                {
                    target.Add(item);
                }
            }

            return;
        }

        var index = 0;

        foreach (var item in items)
        {
            while (index < target.Count && !wanted.Contains(target[index]))
            {
                target.RemoveAt(index);
            }

            if (index == target.Count || !ReferenceEquals(target[index], item))
            {
                target.Insert(index, item);
            }

            index++;
        }

        while (target.Count > index)
        {
            target.RemoveAt(target.Count - 1);
        }
    }
}

public sealed class GroupViewModel(string key, bool open, Action<GroupViewModel> toggled, Func<string, bool>? bandOpen = null, Action<BandViewModel>? bandToggled = null)
    : Observable
{
    readonly Dictionary<string, BandViewModel> kept = [];
    bool isOpen = open;
    string glyph = "";
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

    /// <summary>
    /// The shown rows by date band, in list order; Done's rows are sorted newest first, so each band's rows are consecutive. Changed in place, so a
    /// search does not draw the bands it keeps again.
    /// </summary>
    public ObservableCollection<BandViewModel> Bands { get; } = [];

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
        Lists.Sync(Bands, Rows.GroupBy((row) => row.Row.Band).Select((rows) => BandOf(rows.Key, rows.ToList())).ToList());
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

/// <summary>
/// A header icon for the sources of one kind (PRD R3, R71): its kind's logo, on while any of its sources is polled. With one source a click toggles
/// it; with several it opens a menu of <see cref="Entries"/>.
/// </summary>
public sealed class SourceViewModel : Observable
{
    bool enabled;
    string tip;

    public SourceViewModel(SourceGroup group)
    {
        Kind = group.Kind;
        Names = string.Join(" ", group.Sources.Select((source) => source.Name));
        Entries = group.Sources.Select((source) => new SourceEntryViewModel(source.Name, source.Enabled)).ToList();
        enabled = group.Enabled;
        tip = group.Title;
    }

    public string Kind { get; }

    /// <summary>The sources' names, which identify the group across snapshots.</summary>
    public string Names { get; }

    public IReadOnlyList<SourceEntryViewModel> Entries { get; }

    public bool Enabled { get => enabled; private set => Set(ref enabled, value); }

    public string Tip { get => tip; private set => Set(ref tip, value); }

    /// <summary>The only source's name, or the kind for a menu, for screen readers.</summary>
    public string Name => Entries.Count == 1 ? Entries[0].Name : Kind;

    public bool IsMenu => Entries.Count > 1;

    public bool IsGithub => Kind == "github";

    public bool IsZoho => Kind == "zoho";

    public bool IsForum => Kind == "forum";

    /// <summary>Takes a snapshot's states for the same sources.</summary>
    public void Update(SourceGroup group)
    {
        Enabled = group.Enabled;
        Tip = group.Title;

        foreach (var (entry, source) in Entries.Zip(group.Sources))
        {
            entry.Enabled = source.Enabled;
        }
    }
}

/// <summary>One source in a kind's menu, checked while it is polled.</summary>
public sealed class SourceEntryViewModel(string name, bool enabled) : Observable
{
    bool enabled = enabled;

    public string Name => name;

    public bool Enabled { get => enabled; set => Set(ref enabled, value); }
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

    public bool IsGithub => row.SourceKind == "github";

    public bool IsZoho => row.SourceKind == "zoho";

    public bool IsForum => row.SourceKind == "forum";

    public bool HasThirdLine => row.Mark is not null || row.Details.Count > 0;

    /// <summary>How many times the same work came back (PRD R51), on line 2.</summary>
    public string ReturnedText => row.Returned > 0 ? $"{row.Returned}" : "";

    public bool HasReturned => row.Returned > 0;

    /// <summary>
    /// Unread replies and statuses of the work item's current session in its Conversation view (PRD R100), as a count after the title; a hub from
    /// before unread counts sends none.
    /// </summary>
    public bool HasUnread => row.Unread > 0;

    public string UnreadText => row.Unread > 0 ? $"{row.Unread}" : "";

    public string UnreadTitle => row.Unread == 1 ? "1 unread reply or status in its Conversation view" : $"{row.Unread} unread replies and statuses in its Conversation view";

    /// <summary>The mic mark on the row whose session the voice speaks for (architecture.md § Voice), before the unread count.</summary>
    public bool HasVoice => row.Voice is not null;

    public string VoiceGlyph => row.Voice?.Glyph ?? "";

    public string? VoiceTitle => row.Voice?.Title;

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
