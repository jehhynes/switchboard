using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Switchboard.Dock.Settings;

public enum FieldKind
{
    Text,
    Integer,
    Number,
    Boolean,
    Select,
    List,
    Prompt,
}

public sealed record FieldOption(string Value, string Label);

/// <summary>
/// A setting or playbook field. <see cref="Path"/> is a dotted path from the settings root, or a playbook field name. <see cref="Help"/> shows in
/// the label's tooltip; empty shows none. <see cref="Placeholder"/> is the value that applies when the field is empty; <see cref="Fallback"/> a
/// checkbox's value when the key is absent; <see cref="ListDefault"/> a list whose default is not empty, so an absent key shows the default and an
/// emptied list is saved as <c>[]</c>. Adjacent checkboxes with the same <see cref="Group"/> share one row under that label.
/// </summary>
public sealed record Field(
    string Path,
    string Label,
    FieldKind Kind,
    string Help,
    string? Placeholder = null,
    IReadOnlyList<FieldOption>? Options = null,
    bool? Fallback = null,
    IReadOnlyList<string>? ListDefault = null,
    string? Group = null);

/// <summary>A page section; an <see cref="Advanced"/> section starts collapsed.</summary>
public sealed record Section(string Heading, IReadOnlyList<Field> Fields, bool Advanced = false);

/// <summary>A column of a namespace's playbook table: a playbook field path, its header and tooltip, and the header it sits under.</summary>
public sealed record TableColumn(string Path, string Label, string Help, string? Group);

public sealed record TableCell(bool Checked, bool Enabled);

/// <summary>The fields the Settings window shows and the rules that turn its inputs into settings and playbooks (PRD R54).</summary>
public static partial class SettingsFields
{
    public static readonly IReadOnlyDictionary<string, string> SourceLabels = new Dictionary<string, string> { ["github"] = "GitHub", ["zoho"] = "Zoho Desk", ["forum"] = "Forum" };

    /// <summary>The reports a task session can send, as checkbox labels and tooltips.</summary>
    public static readonly IReadOnlyList<(string Kind, string Label, string Help)> ReportFields =
    [
        ("done", "Done", "The session closes the work item. Off, its turn ends in Ready for review."),
        ("approval", "Approval", "The session can leave a prompt for you to approve, such as one that posts its draft."),
        ("worktree", "Worktree", "The session can link a worktree it creates. Branch names link worktrees without it."),
        ("playbook", "Playbook", "The session can change its work item's playbook to another in the same namespace, and then runs that playbook's skill."),
        ("paste", "Paste", "The session can name drafted texts, such as a customer reply, that Copy puts on the clipboard on its approval row."),
    ];

    public const string AutoStartHelp = "Start the session after triage, unless nothing is newer than the ticket’s earlier work item. Off, the work item waits in Unstarted for you to start it.";
    public const string RequiresWorktreeHelp = "Run the source’s setup prompt first when the ticket has no worktree.";
    public const string FocusHelp = "The page an item window opens for this playbook’s work, at the earliest comment there that asks for it.";
    public const string ReturnOfHelp = "One playbook per line, such as dev:review-pr for dev:review-pr-followup. Returned also counts the ticket’s earlier work items with these playbooks.";
    public const string ApprovalSendsHelp = "Approve posts or pushes the session’s work. Off, you send it yourself, such as by pasting a reply, and Approve finishes up.";
    public const string RatesHelp = "Triage stores immediacy and severity, which these instructions must define. Off, it stores neither.";
    public const string RepoRootHelp = "The session always runs in the source’s repo root. Off, it runs in the ticket’s worktree, else the repo root.";

    [GeneratedRegex("^[a-z0-9][a-z0-9-]*$")]
    private static partial Regex Segment();

    [GeneratedRegex(@"^-?\d+$")]
    private static partial Regex WholeNumber();

    [GeneratedRegex(@"^-?\d+(\.\d+)?$")]
    private static partial Regex Decimal();

    [GeneratedRegex(@"^(.+)\[(\d+)\]$")]
    private static partial Regex IndexedKey();

    [GeneratedRegex(@"^voice\.personas\[(\d+)\]")]
    private static partial Regex PersonaError();

    public static bool IsSegment(string text) => Segment().IsMatch(text);

    /// <summary>The settings every source has; a change of kind keeps only these, because each plugin rejects another's keys.</summary>
    public static readonly IReadOnlyList<string> CommonSourceKeys = ["kind", "pollIntervalSeconds", "repoRoot", "triagePlaybook", "setupPrompt", "namespace"];

    public static string SourceLabel(string name) => SourceLabels.TryGetValue(name, out var label) ? label : name;

    /// <summary>A source's <c>kind</c>, or its name when it sets none (PRD R3).</summary>
    public static string SourceKind(EditorState state, string name) => SourceKind(state.SettingsValue, name);

    public static string SourceKind(JsonNode? settings, string name) =>
        GetAt(settings, $"sources.{name}.kind") is JsonValue value && value.TryGetValue<string>(out var kind) && kind != "" ? kind : name;

    /// <summary>A source's title: its kind's label, such as GitHub, or for a source named apart from its kind, the name and that label.</summary>
    public static string SourceTitle(EditorState state, string name)
    {
        var kind = SourceKind(state, name);

        return kind == name ? SourceLabel(name) : $"{name} ({SourceLabel(kind)})";
    }

    /// <summary>A path segment's key and, for a list entry such as <c>personas[0]</c>, its index.</summary>
    static (string Key, int? Index) Step(string segment) =>
        IndexedKey().Match(segment) is { Success: true } match && int.TryParse(match.Groups[2].Value, out var index) ? (match.Groups[1].Value, index) : (segment, null);

    /// <summary>The value at a dotted path, whose segments may index a list, as in <c>voice.personas[0].name</c>; null when any part is missing.</summary>
    /// <summary>A path's segments; a <c>voice.playbookPersonas</c> key is a playbook name, which may hold a dot, so it stays one segment.</summary>
    static string[] Segments(string path) =>
        path.StartsWith(AssignmentsPrefix, StringComparison.Ordinal) && path.Length > AssignmentsPrefix.Length
            ? ["voice", "playbookPersonas", path[AssignmentsPrefix.Length..]]
            : path.Split('.');

    const string AssignmentsPrefix = "voice.playbookPersonas.";

    public static JsonNode? GetAt(JsonNode? root, string path)
    {
        foreach (var segment in Segments(path))
        {
            var (key, index) = Step(segment);

            root = root is JsonObject node ? node[key] : null;

            if (index is { } at)
            {
                root = root is JsonArray list && at < list.Count ? list[at] : null;
            }
        }

        return root;
    }

    /// <summary>A copy of <paramref name="root"/> with <paramref name="path"/> set, or removed when <paramref name="value"/> is null; intermediate objects are created.</summary>
    /// <remarks>A list entry on the path, as in <c>voice.personas[0].name</c>, must exist and, when not last, be an object; otherwise nothing changes.</remarks>
    public static JsonObject SetAt(JsonObject root, string path, JsonNode? value)
    {
        var copy = root.DeepClone().AsObject();
        var keys = Segments(path);
        var parent = copy;

        foreach (var segment in keys[..^1])
        {
            var (key, index) = Step(segment);

            if (index is { } at)
            {
                if (parent[key] is not JsonArray list || at >= list.Count || list[at] is not JsonObject entry)
                {
                    return root.DeepClone().AsObject();
                }

                parent = entry;
                continue;
            }

            if (parent[key] is not JsonObject child)
            {
                child = [];
                parent[key] = child;
            }

            parent = child;
        }

        var (last, lastIndex) = Step(keys[^1]);

        if (lastIndex is { } position)
        {
            if (parent[last] is not JsonArray list || position >= list.Count)
            {
                return root.DeepClone().AsObject();
            }

            if (value is null)
            {
                list.RemoveAt(position);
            }
            else
            {
                list[position] = value.DeepClone();
            }

            return copy;
        }

        if (value is null)
        {
            parent.Remove(last);
        }
        else
        {
            parent[last] = value.DeepClone();
        }

        return copy;
    }

    /// <summary>A copy of <paramref name="root"/> with a playbook entry set, or removed when <paramref name="entry"/> is null; an edited entry keeps its place.</summary>
    public static JsonObject WithPlaybook(JsonObject root, string name, JsonNode? entry)
    {
        var copy = root.DeepClone().AsObject();

        if (copy["playbooks"] is not JsonObject playbooks)
        {
            playbooks = [];
            copy["playbooks"] = playbooks;
        }

        if (entry is null)
        {
            playbooks.Remove(name);
        }
        else
        {
            playbooks[name] = entry.DeepClone();
        }

        return copy;
    }

    /// <summary>Reads a settings field's input; null removes the key, so the default applies. Text that is not a whole number is kept, so the check names the field.</summary>
    public static JsonNode? ReadField(FieldKind kind, string text, bool isChecked = false, bool keepEmpty = false)
    {
        switch (kind)
        {
            case FieldKind.Boolean:
                return JsonValue.Create(isChecked);
            case FieldKind.Integer:
                return text.Trim() == "" ? null : WholeNumber().IsMatch(text.Trim()) && long.TryParse(text.Trim(), out var number) ? JsonValue.Create(number) : JsonValue.Create(text);
            case FieldKind.Number:
                return text.Trim() == "" ? null
                    : Decimal().IsMatch(text.Trim()) && double.TryParse(text.Trim(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var real) ? JsonValue.Create(real) : JsonValue.Create(text);
            case FieldKind.List:
            {
                var lines = text.Split('\n').Select((line) => line.Trim()).Where((line) => line != "").ToList();

                return lines.Count == 0 && !keepEmpty ? null : new JsonArray(lines.Select((line) => (JsonNode)JsonValue.Create(line)).ToArray());
            }
            case FieldKind.Text:
            case FieldKind.Select:
            case FieldKind.Prompt:
                return text == "" ? null : JsonValue.Create(text);
            default:
                throw new ArgumentOutOfRangeException(nameof(kind));
        }
    }

    /// <summary>A playbook with one field changed from its input.</summary>
    public static PlaybookFields ApplyPlaybookField(PlaybookFields playbook, string key, string text, bool isChecked = false)
    {
        if (key.StartsWith("reports.", StringComparison.Ordinal) && PlaybookFields.ReportKinds.Contains(key["reports.".Length..]))
        {
            var kind = key["reports.".Length..];
            var listed = playbook.Reports.Where((report) => report != kind).Concat(isChecked ? [kind] : []).ToList();
            var reports = PlaybookFields.ReportKinds.Where(listed.Contains).ToList();

            // The hub accepts approvalSends only beside the approval report, so the draft drops it with the report.
            return playbook with { Reports = reports, ApprovalSends = playbook.ApprovalSends && reports.Contains("approval") };
        }

        return key switch
        {
            "autoStart" => playbook with { AutoStart = isChecked },
            "requiresWorktree" => playbook with { RequiresWorktree = isChecked },
            "approvalSends" => playbook with { ApprovalSends = isChecked },
            "rates" => playbook with { Rates = isChecked },
            "provider" => playbook with { Provider = text == "" ? null : text },
            "focus" => playbook with { Focus = text == "" ? null : text },
            "permissionMode" => playbook with { PermissionMode = text == "" ? null : text },
            "model" => playbook with { Model = text == "" ? null : text },
            "returnOf" => playbook with { ReturnOf = text.Split(['\n', ',']).Select((line) => line.Trim()).Where((line) => line != "").Distinct(StringComparer.Ordinal).ToList() },
            // The hub accepts reports only on a task playbook and rates only on a triage one, so the draft drops the other kind's keys.
            "kind" => text == "triage" ? playbook with { Kind = "triage", Reports = [], ApprovalSends = false, ReturnOf = [], Focus = null } : playbook with { Kind = "task", Rates = false },
            "workdir" => playbook with { Workdir = text == "repoRoot" ? "repoRoot" : "worktree" },
            "description" => playbook with { Description = text },
            "template" => playbook with { Template = text },
            _ => playbook,
        };
    }

    /// <summary>The checkbox columns of a namespace's playbook table: the task columns when it has a task playbook, Rates when it has a triage one.</summary>
    public static IReadOnlyList<TableColumn> TableColumns(IEnumerable<PlaybookFields> playbooks)
    {
        var kinds = playbooks.Select((playbook) => playbook.Kind).ToHashSet(StringComparer.Ordinal);
        List<TableColumn> columns = [];

        if (kinds.Contains("task"))
        {
            columns.Add(new("autoStart", "Auto", AutoStartHelp, "Start"));
            columns.Add(new("requiresWorktree", "Needs worktree", RequiresWorktreeHelp, "Start"));

            foreach (var (kind, label, help) in ReportFields)
            {
                columns.Add(new($"reports.{kind}", label, help, "Reports"));

                if (kind == "approval")
                {
                    columns.Add(new("approvalSends", "Sends", ApprovalSendsHelp, "Reports"));
                }
            }

            columns.Add(new("workdir", "Repo root", RepoRootHelp, null));
        }

        if (kinds.Contains("triage"))
        {
            columns.Add(new("rates", "Rates", RatesHelp, null));
        }

        return columns;
    }

    /// <summary>A playbook's checkbox in a table column, or null when the column does not apply to its kind. Sends is enabled only with Approval.</summary>
    public static TableCell? Cell(PlaybookFields playbook, string path) =>
        (path, playbook.Kind) switch
        {
            ("rates", "triage") => new(playbook.Rates, true),
            ("rates", _) or (_, "triage") => null,
            ("workdir", _) => new(playbook.Workdir == "repoRoot", true),
            ("approvalSends", _) => new(playbook.ApprovalSends, playbook.Reports.Contains("approval")),
            _ => new(PlaybookFieldValue(playbook, path) is JsonValue flag && flag.TryGetValue<bool>(out var on) && on, true),
        };

    /// <summary>A playbook with a table checkbox changed; Repo root sets the working directory.</summary>
    public static PlaybookFields ApplyPlaybookCell(PlaybookFields playbook, string path, bool isChecked) =>
        path == "workdir" ? ApplyPlaybookField(playbook, "workdir", isChecked ? "repoRoot" : "worktree") : ApplyPlaybookField(playbook, path, "", isChecked);

    /// <summary>A playbook field's value; a <c>reports.&lt;kind&gt;</c> field is whether the playbook lists that report.</summary>
    public static JsonNode? PlaybookFieldValue(PlaybookFields playbook, string path) =>
        path.StartsWith("reports.", StringComparison.Ordinal) ? JsonValue.Create(playbook.Reports.Contains(path["reports.".Length..])) : playbook.ToJson()[path]?.DeepClone();

    /// <summary>A provider's name in the window.</summary>
    static string ProviderName(string provider) => provider switch
    {
        "claude" => "Claude",
        "codex" => "Codex",
        _ => provider,
    };

    /// <summary>The choices for a select, keeping a configured value that is not among them.</summary>
    static IReadOnlyList<FieldOption> WithCurrent(IReadOnlyList<FieldOption> options, JsonNode? current) =>
        current is JsonValue value && value.TryGetValue<string>(out var text) && text != "" && !options.Any((option) => option.Value == text) ? [.. options, new FieldOption(text, $"{text} (missing)")] : options;

    public static IReadOnlyList<Section> GeneralFields(EditorState state)
    {
        var modes = state.Config.PermissionModes.Select((mode) => new FieldOption(mode, mode)).ToList();
        var codexModes = (state.Config.CodexPermissionModes ?? []).Select((mode) => new FieldOption(mode, mode)).ToList();
        var providers = (state.Config.Providers ?? []).Select((provider) => new FieldOption(provider, ProviderName(provider))).ToList();

        return
        [
            new Section("Sessions",
            [
                new Field("sessions.provider", "Default agent", FieldKind.Select, "The agent playbook and ad-hoc sessions run in. A playbook can name its own.", "claude", providers),
                new Field("sessions.concurrency", "Concurrency", FieldKind.Integer, "Sessions that run at once, 1 to 10. A start with no free slot waits as queued.", "2"),
                new Field("sessions.codeMode", "Code Mode (experimental)", FieldKind.Boolean, "New Claude sessions use Claude Code’s Code Mode and open in a terminal instead of the Claude view. They keep running between turns until you stop them or they sit idle for an hour. They use your Claude subscription sign-in; the gateway in your Claude settings does not apply. Sessions already started keep their mode. Needs Install hooks.", Fallback: false),
                new Field("sessions.debriefs", "Friction debriefs", FieldKind.Boolean, "Ask each session what slowed it down, once its work item is done or 45 minutes after its last turn. The answers go to ~/.claude/.wip/debrief for the friction-review skill.", Fallback: false),
            ]),
            new Section("Claude sessions",
            [
                new Field("sessions.model", "Model", FieldKind.Text, "A playbook can set its own.", "Claude's default"),
                new Field("sessions.permissionMode", "Permission mode", FieldKind.Select, "A playbook can set its own.", "auto", modes),
            ]),
            new Section("Codex sessions",
            [
                new Field("sessions.codex.model", "Model", FieldKind.Text, "A playbook can set its own.", "Codex's default"),
                new Field("sessions.codex.permissionMode", "Permission mode", FieldKind.Select, "A playbook can set its own. Commands in Codex’s sandbox cannot use your sign-ins, such as gh’s, so skills that call them need bypassPermissions.", "bypassPermissions", codexModes),
            ]),
            new Section("Triage",
            [
                new Field("triage.concurrency", "Concurrency", FieldKind.Integer, "Triages that run at once.", "2"),
                new Field("triage.model", "Model", FieldKind.Text, "Triage uses the default agent. A model from the other agent falls back to its default.", "Agent's default"),
                new Field("triage.timeoutSeconds", "Timeout (seconds)", FieldKind.Integer, "", "180"),
            ]),
            // The Settings window draws the dock theme, kept in dock.json, first in this section.
            new Section("Dock",
            [
                new Field("dock.openVSCode", "Rows open in", FieldKind.Select, "Where a row opens its work. Only for review opens the session in a terminal, Ptyxis on Linux or Windows Terminal on Windows, until its work awaits approval or is finished, so fewer VS Code windows stay open.", "always", [new FieldOption("always", "Always"), new FieldOption("review", "Only for review")]),
                new Field("dock.openIn", "Row click opens", FieldKind.Select, "Where a click on a row opens its work item. Web app shows it in the installed Switchboard web app, bringing its window forward, or opens the web page in your browser when the app is not open. Alt-click opens the other.", "vscode", [new FieldOption("vscode", "VS Code"), new FieldOption("web", "Web app")]),
                new Field("dock.openTerminal", "Terminal for \"Open in terminal\"", FieldKind.Select, "Where Open in terminal runs when Rows open in is Always. VS Code when open brings forward the session's terminal app window when there is one, else uses the item window's terminal while that window is open, else the terminal app: Ptyxis on Linux, Windows Terminal on Windows. On Linux without Switchboard's GNOME Shell extension it uses the item window. Only for review always uses the terminal app.", "vscode", [new FieldOption("vscode", "VS Code"), new FieldOption("app", "Terminal app"), new FieldOption("auto", "VS Code when open")]),
            ]),
            new Section("Alerts",
            [
                new Field("alerts.surface", "Needs-you alerts from", FieldKind.Select, "Where a work item that starts needing you is announced, so one event alerts once. Web app when open uses the installed Switchboard web app while it is open, else the dock. Web page when open uses any open Switchboard web page, the installed app first, else the dock. A web page announces only once you allowed its notifications, which it asks for at your first click in it, and plays the needs-you sound when the voice does not.", "auto", [new FieldOption("auto", "Web app when open"), new FieldOption("web", "Web page when open"), new FieldOption("dock", "Dock")]),
            ]),
            new Section("Web page",
            [
                new Field("web.chromePane", "Chrome pane (experimental)", FieldKind.Boolean, "Experimental, Windows only, and may break with Chrome updates. Shows the selected work item's ticket and pull request in a Chrome window that Switchboard keeps over the installed web page's right column, without the dock. Needs the Switchboard Chrome extension, paired from the page's view options.", Fallback: false),
            ]),
            // The Settings window draws the paired devices and Pair a device after this section (architecture.md § Remote access).
            new Section("Remote access",
            [
                new Field("web.tailscale", "Tailscale", FieldKind.Boolean, "Let your devices open the web page through your tailnet. Switchboard adds this computer's Tailscale name and login to Allowed hosts and Allowed logins. Tailscale must be running here, and tailscale serve must point to the page's port, as in tailscale serve --bg 47616. Pair each device with Pair a device. Do not use Tailscale Funnel.", Fallback: false),
                new Field("web.remoteHosts", "Allowed hosts", FieldKind.List, "One per line, such as pc.tailnet.ts.net, without https:// or a port: other names the page answers as through tailscale serve. With Tailscale on, this computer's own Tailscale name needs no line."),
                new Field("web.remoteLogins", "Allowed logins", FieldKind.List, "One per line, such as you@example.com: the Tailscale logins whose devices may pair and use the page; other people on your tailnet are refused. With Tailscale on, this computer's owner needs no line."),
            ]),
            new Section("Advanced",
            [
                new Field("sessions.installHooks", "Install hooks", FieldKind.Boolean, "Add Switchboard’s hooks to your Claude and Codex settings, so the dock shows when a session waits for you or runs in VS Code. Off, the session list and Codex’s run output alone decide state.", Fallback: true),
                new Field("sessions.claudePath", "Claude Code path", FieldKind.Text, "The Claude Code CLI the hub and Open in terminal run. Set its full path when their PATH does not include it.", "claude"),
                new Field("sessions.codexPath", "Codex path", FieldKind.Text, "The Codex CLI the hub and Open in terminal run. Set its full path when their PATH does not include it, such as a Codex installed through nvm.", "codex"),
                new Field("sessions.nodePath", "Node.js path", FieldKind.Text, "The Node.js that Switchboard’s hooks and session reports run. Set its full path, with no spaces, when the agents’ PATH does not include it, such as a Node.js installed through nvm.", "node"),
            ], Advanced: true),
        ];
    }

    /// <summary>The voices of OpenAI's realtime speech, as core's <c>TTS_VOICES</c> lists them.</summary>
    public static readonly IReadOnlyList<string> TtsVoices = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"];

    /// <summary>The speaking styles, as core's <c>SPEECH_STYLES</c> lists them.</summary>
    public static readonly IReadOnlyList<string> SpeechStyles = ["none", "pair", "upbeat", "deadpan", "expressive"];

    /// <summary>The choices of <c>voice.duplex.local</c> and <c>voice.duplex.remote</c>, as core's <c>DUPLEX_MODES</c> lists them.</summary>
    static readonly IReadOnlyList<FieldOption> DuplexModes = [new FieldOption("auto", "Auto"), new FieldOption("full", "Full duplex"), new FieldOption("half", "Half duplex")];

    const string DuplexInfo = "Whether the mic listens while the voice speaks. Auto listens when capture cancels the echo; otherwise it pauses while a reply plays until it measures that replies do not reach the mic, as with headphones. Full duplex always listens, so talking over a reply stops it; choose it with headphones. Half duplex always pauses.";

    static string Capitalized(string text) => text == "" ? text : char.ToUpperInvariant(text[0]) + text[1..];

    static IReadOnlyList<FieldOption> Choices(IEnumerable<string> values) => values.Select((value) => new FieldOption(value, Capitalized(value))).ToList();

    static string Setting(EditorState state, string path, string fallback) =>
        GetAt(state.SettingsValue, path) is JsonValue value && value.TryGetValue<string>(out var text) && text != "" ? text : fallback;

    /// <summary>
    /// The Voice page (PRD R105, R106): speech settings, then a select per playbook with a persona (<c>voice.playbookPersonas</c>), each offering the
    /// roster's personas and None, which removes the assignment.
    /// </summary>
    public static IReadOnlyList<Section> VoiceFields(EditorState state)
    {
        var value = state.SettingsValue;
        var personas = PersonaOptions(state);
        var assigned = GetAt(value, "voice.playbookPersonas") is JsonObject map ? map.Select((entry) => entry.Key).ToList() : [];
        var playbooks = state.PlaybookNames;

        return
        [
            new Section("Speech",
            [
                new Field("voice.enabled", "Enabled", FieldKind.Boolean, "Read replies aloud: the voice process, Speak replies, Talk here and personas. Off, nothing is spoken and no session gets a persona.", Fallback: false),
                new Field("voice.voice", "Voice", FieldKind.Select, "The voice replies are read in when no persona applies. OpenAI recommends Marin and Cedar.", "marin", WithCurrent(Choices(TtsVoices), GetAt(value, "voice.voice"))),
                new Field("voice.style", "Style", FieldKind.Select, "How replies are read when no persona applies, unless Expressive delivery is on.", "none", WithCurrent(Choices(SpeechStyles), GetAt(value, "voice.style"))),
                new Field("voice.speed", "Speed", FieldKind.Number, "0.25 to 1.5; 1 is the voice’s own pace.", "1"),
                new Field("voice.expressive", "Expressive delivery", FieldKind.Boolean, "Ask Claude for a tone line with each spoken reply, and read the reply in that tone instead of the style.", Fallback: false),
                new Field("voice.briefReplies", "Brief replies", FieldKind.Boolean, "Show only the primary response of a reply that has details, with the details behind Show more. Off, replies show in full.", Fallback: false),
                new Field("voice.awayMinutes", "Away timeout (minutes)", FieldKind.Integer, "1 to 1440. With the focus outside every Switchboard window for this long, the voice stops speaking for its session.", "2"),
                new Field("voice.needsYouSound", "Needs-you sound", FieldKind.Boolean, "Play a short sound between spoken replies when another work item starts needing you.", Fallback: true),
                new Field("voice.outputDevice", "Output device", FieldKind.Text, "Part of the playback device’s name, such as Speakers. Empty uses the system default.", "System default"),
            ]),
            new Section("Spoken alerts",
            [
                new Field("voice.spokenAlerts", "Spoken alerts", FieldKind.Boolean, "When a session the voice is not speaking for finishes or waits on you, say so, as in “Hey Alex? Tinker finished Fix the badge.”, and read its reply if you answer “yes” or “tell me”.", Fallback: true),
                new Field("voice.operatorName", "Your name", FieldKind.Text, "The name alerts call you by. Empty says only “Hey?”.", "No name"),
                new Field("voice.alertOn.finished", "Alert when a turn finishes", FieldKind.Boolean, "", Fallback: true),
                new Field("voice.alertOn.question", "Alert on a question", FieldKind.Boolean, "", Fallback: true),
                new Field("voice.alertOn.permission", "Alert on a permission prompt", FieldKind.Boolean, "", Fallback: true),
                new Field("voice.alertAnswerSeconds", "Answer window (seconds)", FieldKind.Integer, "3 to 60. How long the voice listens for your answer after an alert, even after the away or mic idle timeout; the mic must be on.", "10"),
            ]),
            new Section("Dictation",
            [
                new Field("voice.micIdleMinutes", "Mic idle timeout (minutes)", FieldKind.Integer, "0 to 1440. After this many minutes of silence the mic stops listening, even with the voice here; 0 never stops it.", "10"),
                new Field("voice.endPauseMs", "End-of-message pause (ms)", FieldKind.Integer, "500 to 20000. How long a pause ends a dictated message; turn detection shortens it when the words look finished.", "3000"),
                new Field("voice.inputDevice", "Input device", FieldKind.Text, "Part of the capture device’s name, such as Headset. Empty uses the system default.", "System default"),
                new Field("voice.halfDuplexTailMs", "Listening pause after speech (ms)", FieldKind.Integer, "0 to 5000. With no echo cancellation, as over Remote Desktop, the mic stops listening while the voice speaks and for this long after, and talking over a reply does not stop it.", "800"),
                new Field("voice.duplex.local", "Duplex on this computer", FieldKind.Select, DuplexInfo, "auto", DuplexModes),
                new Field("voice.duplex.remote", "Duplex over Remote Desktop", FieldKind.Select, DuplexInfo + " Used while Switchboard runs in a Remote Desktop session.", "auto", DuplexModes),
            ]),
            new Section("Voice check",
            [
                new Field("voice.matchThreshold", "Voice match", FieldKind.Number, "0 to 1. A dictated piece that matches your enrolled voice less than this is dropped as someone else’s; one or two words get 0.15 less.", "0.6"),
                new Field("voice.pitchLowFactor", "Low pitch factor", FieldKind.Number, "1 to 3. A voiced moment at or under this many times your enrolled voice’s 90th-percentile pitch counts as low.", "1.22"),
                new Field("voice.pitchMinLowShare", "Least low share", FieldKind.Number, "0 to 1. A piece with a smaller share of low moments is dropped as someone else’s; 0 turns the pitch check off.", "0.2"),
                new Field("voice.roomHold", "Hold dictation when another person speaks", FieldKind.Boolean, "When Switchboard detects another voice, it keeps dictated messages in the composer until you press Enter. Turn this off if other people often speak nearby.", Fallback: true),
                new Field("voice.roomHoldSeconds", "Dictation hold time (seconds)", FieldKind.Integer, "Keep dictated messages in the composer for 1 to 3600 seconds after another voice was last detected.", "60"),
            ], Advanced: true),
            new Section("Playbook personas",
                assigned.Select((playbook) => new Field($"voice.playbookPersonas.{playbook}", playbooks.Contains(playbook) ? playbook : $"{playbook} (missing)", FieldKind.Select, "",
                    Options: WithCurrent([new FieldOption("", "None"), .. personas], GetAt(value, $"voice.playbookPersonas.{playbook}")))).ToList()),
        ];
    }

    /// <summary>The roster's personas as choices: each persona with an ID, by its name and ID, in roster order.</summary>
    public static IReadOnlyList<FieldOption> PersonaOptions(EditorState state) =>
        state.PersonaIds.Distinct(StringComparer.Ordinal).Select((id) => new FieldOption(id, $"{state.PersonaName(id)} ({id})")).ToList();

    /// <summary>The task playbooks with no persona yet, which the Voice page's Assign offers.</summary>
    public static IReadOnlyList<string> UnassignedPlaybooks(EditorState state)
    {
        var assigned = GetAt(state.SettingsValue, "voice.playbookPersonas") as JsonObject;

        return state.PlaybookNames.Where((name) => state.PlaybookValue(name)?.Kind == "task" && assigned?.ContainsKey(name) != true).ToList();
    }

    /// <summary>A persona's fields (PRD R106); its ID is set by New persona and not edited, because sessions and assignments store it.</summary>
    public static IReadOnlyList<Section> PersonaFields(EditorState state, int index)
    {
        var path = $"voice.personas[{index}]";
        var value = state.SettingsValue;

        if (GetAt(value, path) is not JsonObject)
        {
            return [];
        }

        var voice = Setting(state, "voice.voice", "marin");
        var style = Setting(state, "voice.style", "none");

        return
        [
            new Section("Persona",
            [
                new Field($"{path}.name", "Name", FieldKind.Text, "1 to 40 characters. The Conversation view’s header shows it."),
                new Field($"{path}.voice", "Voice", FieldKind.Select, "", Options: WithCurrent([new FieldOption("", $"Voice setting ({Capitalized(voice)})"), .. Choices(TtsVoices)], GetAt(value, $"{path}.voice"))),
                new Field($"{path}.style", "Style", FieldKind.Select, "", Options: WithCurrent([new FieldOption("", $"Voice setting ({Capitalized(style)})"), .. Choices(SpeechStyles)], GetAt(value, $"{path}.style"))),
                new Field($"{path}.personality", "Personality", FieldKind.Prompt, "At most 600 characters. How its spoken replies sound, and a tone section in its sessions’ prompts; it never changes how they work."),
            ]),
        ];
    }

    static readonly IReadOnlyDictionary<string, (string Key, Field Field, bool Advanced)[]> OptionFields = new Dictionary<string, (string, Field, bool)[]>
    {
        ["github"] =
        [
            ("repo", new Field("", "Repository", FieldKind.Text, "", "owner/name"), false),
            ("logins", new Field("", "Logins", FieldKind.List, "One per line. Your GitHub logins: comments and commits by them are yours, and with Require assignee on, an issue assigned to any of them is yours."), false),
            ("requireAssignee", new Field("", "Require assignee", FieldKind.Boolean, "Off, an issue in an assigned status is yours whoever is assigned.", Fallback: true), false),
            ("waitForBlockers", new Field("", "Wait for blockers", FieldKind.Boolean, "On, an issue's work starts only once the issues blocking it close. Leave off to start stacked work from a blocker's branch.", Fallback: false), false),
            ("includeClosed", new Field("", "Include closed issues", FieldKind.Boolean, "On, a closed issue in an assigned status is still yours, for a team that closes issues before they merge.", Fallback: false), false),
            ("project.owner", new Field("", "Project owner", FieldKind.Text, ""), false),
            ("project.number", new Field("", "Project number", FieldKind.Integer, ""), false),
            ("project.statusField", new Field("", "Status field", FieldKind.Text, "", "Status"), false),
            ("assignedStatuses", new Field("", "Assigned statuses", FieldKind.List, "One per line. An issue in one of these project statuses is yours. Empty, an issue in any status, or none, is yours."), false),
            ("rolesFile", new Field("", "Roles file", FieldKind.Text, "A JSON file of {\"login\": {\"roles\": [\"tester\"]}}. Triage shows each comment author's roles. Starts with ~ or is absolute."), true),
            ("branchPattern", new Field("", "Branch pattern", FieldKind.Text, "A regular expression whose first group is the issue number a worktree branch names.", "^(\\d+)-"), true),
            ("ghPath", new Field("", "gh path", FieldKind.Text, "", "gh"), true),
            ("maxPages", new Field("", "Page limit", FieldKind.Integer, "A poll that needs more pages of 100 issues fails.", "5"), true),
        ],
        ["zoho"] =
        [
            ("orgId", new Field("", "Organization ID", FieldKind.Text, ""), false),
            ("agentId", new Field("", "Agent ID", FieldKind.Text, "Your Zoho agent ID."), false),
            ("escalationField", new Field("", "Escalation field", FieldKind.Text, "The custom field that holds the escalation tier.", "cf_queue"), true),
            ("escalationValue", new Field("", "Escalation value", FieldKind.Text, "The escalation tier that puts a ticket in scope.", "Support"), true),
            ("automationAgentIds", new Field("", "Automation agent IDs", FieldKind.List, "One per line. Agents whose hold on a ticket is not a claim. Empty means none.", ListDefault: ["8000000000000000002", "8000000000000000003"]), true),
            ("tokenCommand", new Field("", "Token command", FieldKind.Text, "Prints a Desk access token. Runs in Git Bash.", "bash ~/.claude/scripts/desk-token.sh"), true),
            ("apiBase", new Field("", "API base", FieldKind.Text, "", "https://desk.zoho.com/api/v1"), true),
            ("maxPages", new Field("", "Page limit", FieldKind.Integer, "A poll that needs more pages fails.", "20"), true),
        ],
        ["forum"] =
        [
            ("userId", new Field("", "User ID", FieldKind.Text, "Your forum user ID."), false),
            ("forumId", new Field("", "Forum ID", FieldKind.Integer, "", "11"), true),
            ("queryCommand", new Field("", "Query command", FieldKind.Text, "Runs SQL from stdin against the forum database. Runs in Git Bash.", "bash ~/.claude/scripts/run-forum-sql.sh"), true),
            ("maxRows", new Field("", "Row limit", FieldKind.Integer, "A poll that returns this many open topics is incomplete.", "500"), true),
            ("auditDatabase", new Field("", "Audit database", FieldKind.Text, "The change-history database on the same host.", "audit"), true),
        ],
    };

    public static IReadOnlyList<Section> SourceFields(EditorState state, string name)
    {
        var path = $"sources.{name}";
        var value = state.SettingsValue;
        var triage = state.PlaybookNames.Where((name) => state.PlaybookValue(name)?.Kind == "triage").Select((name) => new FieldOption(name, name));
        List<Field> common =
        [
            new Field($"{path}.pollIntervalSeconds", "Poll interval (seconds)", FieldKind.Integer, "At least 10.", "300"),
            new Field($"{path}.repoRoot", "Repo root", FieldKind.Text, "The repository sessions run in when the ticket has no worktree."),
            new Field($"{path}.namespace", "Namespace", FieldKind.Select, "Triage chooses among this namespace’s task playbooks.",
                Options: WithCurrent([new FieldOption("", "Every namespace"), .. state.Namespaces.Select((entry) => new FieldOption(entry, entry))], GetAt(value, $"{path}.namespace"))),
            new Field($"{path}.triagePlaybook", "Triage playbook", FieldKind.Select, "",
                Options: WithCurrent([new FieldOption("", "None"), .. triage], GetAt(value, $"{path}.triagePlaybook"))),
            new Field($"{path}.setupPrompt", "Setup prompt", FieldKind.Prompt, "Runs before a playbook that requires a worktree, when the ticket has none."),
        ];
        // adhoc holds only the ad-hoc repo root, so it has no plugin to choose.
        if (name != "adhoc")
        {
            common.Insert(0, new Field($"{path}.kind", "Kind", FieldKind.Select, "The plugin that reads the source. Changing it drops the old plugin's settings.",
                Options: WithCurrent([new FieldOption("", $"Same as the name ({name})"), .. state.Config.SourceKinds.Select((entry) => new FieldOption(entry, SourceLabel(entry)))], GetAt(value, $"{path}.kind"))));
        }

        var kind = SourceKind(state, name);
        var options = OptionFields.TryGetValue(kind, out var fields) ? fields.Select((entry) => (Field: entry.Field with { Path = $"{path}.{entry.Key}" }, entry.Advanced)).ToList() : [];
        List<Section> sections = [new Section("Source", common)];

        if (options.Any((entry) => !entry.Advanced))
        {
            sections.Add(new Section(SourceLabel(kind), [.. options.Where((entry) => !entry.Advanced).Select((entry) => entry.Field)]));
        }

        if (options.Any((entry) => entry.Advanced))
        {
            sections.Add(new Section("Advanced", [.. options.Where((entry) => entry.Advanced).Select((entry) => entry.Field)], Advanced: true));
        }

        return sections;
    }

    static readonly IReadOnlyList<FieldOption> Weekdays = new[] { "mon", "tue", "wed", "thu", "fri", "sat", "sun" }.Select((day) => new FieldOption(day, day)).ToList();

    /// <summary>A schedule's fields (PRD R82); the day and time show only for the period that uses them.</summary>
    public static IReadOnlyList<Section> ScheduleFields(EditorState state, string name)
    {
        var path = $"schedules.{name}";
        var every = GetAt(state.SettingsValue, $"{path}.every") is JsonValue value && value.TryGetValue<string>(out var text) ? text : "";
        var tasks = state.PlaybookNames.Where((entry) => state.PlaybookValue(entry)?.Kind == "task").Select((entry) => new FieldOption(entry, entry));
        List<Field> fields =
        [
            new Field($"{path}.playbook", "Playbook", FieldKind.Select, "The task playbook each run starts. It cannot need a worktree.",
                Options: WithCurrent([new FieldOption("", "None"), .. tasks], GetAt(state.SettingsValue, $"{path}.playbook"))),
            new Field($"{path}.repoRoot", "Repo root", FieldKind.Text, "The directory its sessions run in."),
            new Field($"{path}.every", "Runs", FieldKind.Select, "Off, it runs only when you choose it in New ad-hoc session.",
                Options: [new FieldOption("", "Only by hand"), new FieldOption("day", "Every day"), new FieldOption("week", "Every week"), new FieldOption("month", "Every month")]),
        ];

        if (every == "week")
        {
            fields.Add(new Field($"{path}.day", "Day", FieldKind.Select, "", Options: WithCurrent(Weekdays, GetAt(state.SettingsValue, $"{path}.day"))));
        }
        else if (every == "month")
        {
            fields.Add(new Field($"{path}.day", "Day of the month", FieldKind.Integer, "1 to 31. A month without that day runs on its last day."));
        }

        if (every != "")
        {
            fields.Add(new Field($"{path}.at", "Time", FieldKind.Text, "Local time, 24-hour. A run whose time passed while Switchboard was stopped starts once when it starts again.", "09:00"));
        }

        return [new Section("Schedule", fields)];
    }

    public static IReadOnlyList<Field> PlaybookFieldsOf(EditorState state, PlaybookFields playbook)
    {
        var sessions = state.SettingsValue;
        string? Setting(string path) => GetAt(sessions, path) is JsonValue value && value.TryGetValue<string>(out var text) && text != "" ? text : null;
        var defaultProvider = Setting("sessions.provider") ?? "claude";
        var codex = (playbook.Provider ?? defaultProvider) == "codex";
        var mode = Setting(codex ? "sessions.codex.permissionMode" : "sessions.permissionMode") ?? (codex ? "bypassPermissions" : "auto");
        var model = Setting(codex ? "sessions.codex.model" : "sessions.model");
        var modes = codex ? state.Config.CodexPermissionModes ?? [] : state.Config.PermissionModes;
        List<Field> fields =
        [
            new Field("description", "Description", FieldKind.Text, "Tells triage when to choose this playbook. One line."),
            new Field("kind", "Kind", FieldKind.Select, "A triage playbook holds a source’s classifier instructions and is never chosen for work.", Options: [new FieldOption("task", "task"), new FieldOption("triage", "triage")]),
        ];

        if (playbook.Kind == "triage")
        {
            fields.Add(new Field("rates", "Rates importance", FieldKind.Boolean, RatesHelp));
        }

        if (playbook.Kind == "task")
        {
            fields.Add(new Field("autoStart", "Automatically", FieldKind.Boolean, AutoStartHelp, Group: "Start"));
            fields.Add(new Field("requiresWorktree", "Needs a worktree", FieldKind.Boolean, RequiresWorktreeHelp, Group: "Start"));
            fields.AddRange(ReportFields.Select((report) => new Field($"reports.{report.Kind}", report.Label, FieldKind.Boolean, report.Help, Group: "Reports")));

            if (playbook.Reports.Contains("approval"))
            {
                fields.Add(new Field("approvalSends", "Approve sends the work", FieldKind.Boolean, ApprovalSendsHelp));
            }

            fields.Add(new Field("workdir", "Working directory", FieldKind.Select, "",
                Options: [new FieldOption("worktree", "The ticket’s worktree, else the repo root"), new FieldOption("repoRoot", "Always the source’s repo root")]));
            fields.Add(new Field("provider", "Agent", FieldKind.Select, "The agent this playbook’s sessions run in.",
                Options: WithCurrent([new FieldOption("", $"Sessions setting ({ProviderName(defaultProvider)})"), .. (state.Config.Providers ?? []).Select((entry) => new FieldOption(entry, ProviderName(entry)))], playbook.Provider is null ? null : JsonValue.Create(playbook.Provider))));
            fields.Add(new Field("permissionMode", "Permission mode", FieldKind.Select, codex ? "Commands in Codex’s sandbox cannot use your sign-ins, such as gh’s." : "",
                Options: WithCurrent([new FieldOption("", $"Sessions setting ({mode})"), .. modes.Select((entry) => new FieldOption(entry, entry))], playbook.PermissionMode is null ? null : JsonValue.Create(playbook.PermissionMode))));
            fields.Add(new Field("model", "Model", FieldKind.Text, "", $"Sessions setting ({model ?? (codex ? "Codex’s default" : "Claude’s default")})"));
            fields.Add(new Field("returnOf", "Return of", FieldKind.List, ReturnOfHelp));
            fields.Add(new Field("focus", "Focus page", FieldKind.Select, FocusHelp,
                Options: WithCurrent([new FieldOption("", "Any page"), new FieldOption("ticket", "The ticket"), new FieldOption("pr", "The pull request")], playbook.Focus is null ? null : JsonValue.Create(playbook.Focus))));
        }

        fields.Add(new Field(
            "template",
            playbook.Kind == "triage" ? "Classifier instructions" : "Prompt",
            FieldKind.Prompt,
            playbook.Kind == "triage"
                ? "The classifier’s system prompt. {{playbooks}} inserts the task playbooks as “- name: description” lines; without it, triage appends them."
                : $"Variables: {string.Join(' ', state.Config.TemplateVariables.Select((name) => $"{{{{{name}}}}}"))}. Switchboard adds the commands for the checked reports, with stage and link."));

        return fields;
    }

    /// <summary>The field an error names, by the longest path it contains. Under <c>sources</c>, a parent path such as <c>sources.github</c> names its first field.</summary>
    public static string? FieldOfError(string error, IEnumerable<string> paths)
    {
        // The path stands alone: not part of a longer path, though a sentence's final period may follow it.
        static bool Names(string error, string path) => Regex.IsMatch(error, $@"(^|[^\w.]){Regex.Escape(path)}($|[^\w.]|\.(\s|$))");

        (string Path, int Length)? best = null;

        foreach (var path in paths)
        {
            var segments = path.Split('.');
            var shortest = segments[0] is "sources" or "schedules" ? 2 : segments.Length;

            for (var length = segments.Length; length >= shortest; length--)
            {
                if (Names(error, string.Join('.', segments[..length])) && (best is null || length > best.Value.Length))
                {
                    best = (path, length);
                }
            }
        }

        return best?.Path;
    }

    /// <summary>The field a playbook error names: the key it starts with, or the template.</summary>
    public static string? PlaybookFieldOfError(string error, IEnumerable<string> paths) =>
        paths.FirstOrDefault((path) => error.StartsWith($"{path} ", StringComparison.Ordinal)) ?? (error.Contains("template", StringComparison.OrdinalIgnoreCase) ? "template" : null);

    /// <summary>Every settings field path of the general, voice, persona, source and schedule pages.</summary>
    public static IReadOnlyList<string> AllSettingsPaths(EditorState state)
    {
        var sources = state.SettingsValue?["sources"] is JsonObject configured ? configured.Select((entry) => entry.Key).ToList() : [];

        return GeneralFields(state).Concat(VoiceFields(state)).Concat(Enumerable.Range(0, state.PersonaCount).SelectMany((index) => PersonaFields(state, index)))
            .Concat(sources.SelectMany((name) => SourceFields(state, name))).Concat(state.ScheduleNames.SelectMany((name) => ScheduleFields(state, name)))
            .SelectMany((section) => section.Fields).Select((field) => field.Path).ToList();
    }

    /// <summary>The page that holds each settings error's field; an error with no field maps to null and shows on every settings page.</summary>
    public static IReadOnlyDictionary<string, string?> SettingsErrorPages(EditorState state)
    {
        var paths = AllSettingsPaths(state);
        var pages = new Dictionary<string, string?>();

        foreach (var error in state.SettingsErrors)
        {
            var path = FieldOfError(error, paths);

            // A persona's or the voice section's error that names no field, such as an entry that is not an object, shows on its page.
            pages[error] = path is null
                ? PersonaError().Match(error) is { Success: true } persona ? $"persona:{persona.Groups[1].Value}"
                    : error.StartsWith("voice.", StringComparison.Ordinal) ? "voice"
                    : null
                : path.StartsWith("sources.", StringComparison.Ordinal) ? $"source:{path.Split('.')[1]}"
                : path.StartsWith("schedules.", StringComparison.Ordinal) ? $"schedule:{path.Split('.')[1]}"
                : PersonaError().Match(path) is { Success: true } field ? $"persona:{field.Groups[1].Value}"
                : path.StartsWith("voice.", StringComparison.Ordinal) ? "voice"
                : "general";
        }

        return pages;
    }
}
