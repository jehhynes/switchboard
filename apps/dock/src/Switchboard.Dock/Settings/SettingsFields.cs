using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Switchboard.Dock.Settings;

public enum FieldKind
{
    Text,
    Integer,
    Boolean,
    Select,
    List,
    Prompt,
}

public sealed record FieldOption(string Value, string Label);

/// <summary>
/// A setting or playbook field. <see cref="Path"/> is a dotted path from the settings root, or a playbook field name. <see cref="Placeholder"/> is
/// the value that applies when the field is empty; <see cref="Fallback"/> a checkbox's value when the key is absent; <see cref="ListDefault"/>
/// a list whose default is not empty, so an absent key shows the default and an emptied list is saved as <c>[]</c>.
/// </summary>
public sealed record Field(
    string Path,
    string Label,
    FieldKind Kind,
    string Help,
    string? Placeholder = null,
    IReadOnlyList<FieldOption>? Options = null,
    bool? Fallback = null,
    IReadOnlyList<string>? ListDefault = null);

public sealed record Section(string Heading, IReadOnlyList<Field> Fields);

/// <summary>The fields the Settings window shows and the rules that turn its inputs into settings and playbooks (PRD R54).</summary>
public static partial class SettingsFields
{
    public static readonly IReadOnlyDictionary<string, string> SourceLabels = new Dictionary<string, string> { ["github"] = "GitHub", ["zoho"] = "Zoho Desk", ["forum"] = "Forum" };

    static readonly (string Kind, string Label, string Help)[] ReportFields =
    [
        ("done", "Session can report done", "The session closes the work item. Off, its turn ends in Needs you for you to review."),
        ("approval", "Session can report approval", "The session can leave a prompt for you to approve, such as one that posts its draft."),
        ("worktree", "Session can report a worktree", "The session can link a worktree it creates. Branch names link worktrees without it."),
        ("playbook", "Session can change the playbook", "The session can hand its work item to another playbook in the namespace, whose skill it runs."),
        ("paste", "Session can report pastes", "The session can name drafted texts, such as a customer reply, that Copy puts on the clipboard on its approval row."),
    ];

    [GeneratedRegex("^[a-z0-9][a-z0-9-]*$")]
    private static partial Regex Segment();

    [GeneratedRegex(@"^-?\d+$")]
    private static partial Regex WholeNumber();

    public static bool IsSegment(string text) => Segment().IsMatch(text);

    public static string SourceLabel(string name) => SourceLabels.TryGetValue(name, out var label) ? label : name;

    public static JsonNode? GetAt(JsonNode? root, string path)
    {
        foreach (var key in path.Split('.'))
        {
            root = root is JsonObject node ? node[key] : null;
        }

        return root;
    }

    /// <summary>A copy of <paramref name="root"/> with <paramref name="path"/> set, or removed when <paramref name="value"/> is null; intermediate objects are created.</summary>
    public static JsonObject SetAt(JsonObject root, string path, JsonNode? value)
    {
        var copy = root.DeepClone().AsObject();
        var keys = path.Split('.');
        var parent = copy;

        foreach (var key in keys[..^1])
        {
            if (parent[key] is not JsonObject child)
            {
                child = [];
                parent[key] = child;
            }

            parent = child;
        }

        if (value is null)
        {
            parent.Remove(keys[^1]);
        }
        else
        {
            parent[keys[^1]] = value.DeepClone();
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

            // The file holds approvalSends only beside the approval report, so the draft drops it with the report.
            return playbook with { Reports = reports, ApprovalSends = playbook.ApprovalSends && reports.Contains("approval") };
        }

        return key switch
        {
            "autoStart" => playbook with { AutoStart = isChecked },
            "requiresWorktree" => playbook with { RequiresWorktree = isChecked },
            "approvalSends" => playbook with { ApprovalSends = isChecked },
            "rates" => playbook with { Rates = isChecked },
            "permissionMode" => playbook with { PermissionMode = text == "" ? null : text },
            "model" => playbook with { Model = text == "" ? null : text },
            // A task playbook's file cannot hold rates, so keeping it would leave the saved draft unlike the file.
            "kind" => text == "triage" ? playbook with { Kind = "triage" } : playbook with { Kind = "task", Rates = false },
            "workdir" => playbook with { Workdir = text == "repoRoot" ? "repoRoot" : "worktree" },
            "description" => playbook with { Description = text },
            "template" => playbook with { Template = text },
            _ => playbook,
        };
    }

    /// <summary>A playbook field's value; a <c>reports.&lt;kind&gt;</c> field is whether the playbook lists that report.</summary>
    public static JsonNode? PlaybookFieldValue(PlaybookFields playbook, string path) =>
        path.StartsWith("reports.", StringComparison.Ordinal) ? JsonValue.Create(playbook.Reports.Contains(path["reports.".Length..])) : playbook.ToJson()[path]?.DeepClone();

    /// <summary>The choices for a select, keeping a configured value that is not among them.</summary>
    static IReadOnlyList<FieldOption> WithCurrent(IReadOnlyList<FieldOption> options, JsonNode? current) =>
        current is JsonValue value && value.TryGetValue<string>(out var text) && text != "" && !options.Any((option) => option.Value == text) ? [.. options, new FieldOption(text, $"{text} (missing)")] : options;

    public static IReadOnlyList<Section> GeneralFields(EditorState state)
    {
        var modes = state.Config.PermissionModes.Select((mode) => new FieldOption(mode, mode)).ToList();

        return
        [
            new Section("Sessions",
            [
                new Field("sessions.concurrency", "Concurrency", FieldKind.Integer, "Sessions that run at once, 1 to 10. A start with no free slot waits as queued.", "2"),
                new Field("sessions.permissionMode", "Permission mode", FieldKind.Select, "Claude Code permission mode for sessions. A playbook can set its own.", "auto", modes),
                new Field("sessions.model", "Model", FieldKind.Text, "The model for sessions. A playbook can set its own.", "Claude's default"),
                new Field("sessions.installHooks", "Install hooks", FieldKind.Boolean, "Add Switchboard’s hooks to your Claude settings, so the dock shows when a session waits for you. Off, the session list alone decides state.", Fallback: true),
                new Field("sessions.debriefs", "Friction debriefs", FieldKind.Boolean, "Ask each session what slowed it down, once its work item is done or 45 minutes after its last turn. The answers go to ~/.claude/.wip/debrief for the friction-review skill.", Fallback: false),
            ]),
            new Section("Triage",
            [
                new Field("triage.model", "Model", FieldKind.Text, "The model that triages work items and pool tickets.", "Claude's default"),
                new Field("triage.concurrency", "Concurrency", FieldKind.Integer, "Triages that run at once.", "2"),
                new Field("triage.timeoutSeconds", "Timeout (seconds)", FieldKind.Integer, "A triage that runs longer fails.", "180"),
            ]),
        ];
    }

    static readonly IReadOnlyDictionary<string, (string Key, Field Field)[]> OptionFields = new Dictionary<string, (string, Field)[]>
    {
        ["github"] =
        [
            ("repo", new Field("", "Repository", FieldKind.Text, "The repository whose issues are yours.", "owner/name")),
            ("logins", new Field("", "Logins", FieldKind.List, "GitHub logins, one per line. An issue assigned to any of them is yours.")),
            ("project.owner", new Field("", "Project owner", FieldKind.Text, "The owner of the project board.")),
            ("project.number", new Field("", "Project number", FieldKind.Integer, "The project board number.")),
            ("project.statusField", new Field("", "Status field", FieldKind.Text, "The project field that holds the status.", "Status")),
            ("assignedStatuses", new Field("", "Assigned statuses", FieldKind.List, "Project statuses that make an issue yours, one per line.")),
            ("branchPattern", new Field("", "Branch pattern", FieldKind.Text, "A regular expression whose first group is the issue number a worktree branch names.", "^(\\d+)-")),
            ("ghPath", new Field("", "gh path", FieldKind.Text, "The gh executable.", "gh")),
            ("maxPages", new Field("", "Page limit", FieldKind.Integer, "A poll that needs more pages of 100 issues fails.", "5")),
            ("rolesFile", new Field("", "Roles file", FieldKind.Text, "A JSON file of {\"login\": {\"roles\": [\"tester\"]}}. Triage shows each comment author's roles. Starts with ~ or is absolute.")),
        ],
        ["zoho"] =
        [
            ("orgId", new Field("", "Organization ID", FieldKind.Text, "The Desk organization ID.")),
            ("agentId", new Field("", "Agent ID", FieldKind.Text, "Your Zoho agent ID.")),
            ("tokenCommand", new Field("", "Token command", FieldKind.Text, "Prints a Desk access token. Runs in Git Bash.", "bash ~/.claude/scripts/desk-token.sh")),
            ("apiBase", new Field("", "API base", FieldKind.Text, "The Desk REST API.", "https://desk.zoho.com/api/v1")),
            ("escalationField", new Field("", "Escalation field", FieldKind.Text, "The custom field that holds the escalation tier.", "cf_queue")),
            ("escalationValue", new Field("", "Escalation value", FieldKind.Text, "The escalation tier that puts a ticket in scope.", "Support")),
            ("automationAgentIds", new Field("", "Automation agent IDs", FieldKind.List, "Agents whose hold on a ticket is not a claim, one per line. Empty means none.", ListDefault: ["8000000000000000002", "8000000000000000003"])),
            ("maxPages", new Field("", "Page limit", FieldKind.Integer, "A poll that needs more pages fails.", "20")),
        ],
        ["forum"] =
        [
            ("userId", new Field("", "User ID", FieldKind.Text, "Your forum user ID.")),
            ("forumId", new Field("", "Forum ID", FieldKind.Integer, "The Forum forum ID.", "11")),
            ("queryCommand", new Field("", "Query command", FieldKind.Text, "Runs SQL from stdin against the forum database. Runs in Git Bash.", "bash ~/.claude/scripts/run-forum-sql.sh")),
            ("maxRows", new Field("", "Row limit", FieldKind.Integer, "A poll that returns this many open topics is incomplete.", "500")),
            ("auditDatabase", new Field("", "Audit database", FieldKind.Text, "The change-history database on the same host.", "audit")),
        ],
    };

    public static IReadOnlyList<Section> SourceFields(EditorState state, string name)
    {
        var path = $"sources.{name}";
        var value = state.SettingsValue;
        var triage = state.Config.Playbooks.Where((entry) => entry.Playbook?.Kind == "triage").Select((entry) => new FieldOption(entry.Name, entry.Name));
        List<Field> common =
        [
            new Field($"{path}.enabled", "Poll this source", FieldKind.Boolean, "A disabled source is not polled and its pool is hidden. Its work items stay.", Fallback: false),
            new Field($"{path}.pollIntervalSeconds", "Poll interval (seconds)", FieldKind.Integer, "At least 10.", "300"),
            new Field($"{path}.repoRoot", "Repo root", FieldKind.Text, "The repository sessions run in when the ticket has no worktree."),
            new Field($"{path}.namespace", "Namespace", FieldKind.Select, "Triage chooses among this namespace’s task playbooks.",
                Options: WithCurrent([new FieldOption("", "Every namespace"), .. state.Namespaces.Select((entry) => new FieldOption(entry, entry))], GetAt(value, $"{path}.namespace"))),
            new Field($"{path}.triagePlaybook", "Triage playbook", FieldKind.Select, "The classifier’s instructions for this source.",
                Options: WithCurrent([new FieldOption("", "None"), .. triage], GetAt(value, $"{path}.triagePlaybook"))),
            new Field($"{path}.setupPrompt", "Setup prompt", FieldKind.Prompt, "Runs before a playbook that requires a worktree, when the ticket has none."),
        ];
        var options = OptionFields.TryGetValue(name, out var fields) ? fields.Select((entry) => entry.Field with { Path = $"{path}.{entry.Key}" }).ToList() : [];

        return options.Count == 0 ? [new Section("Source", common)] : [new Section("Source", common), new Section(SourceLabel(name), options)];
    }

    public static IReadOnlyList<Field> PlaybookFieldsOf(EditorState state, PlaybookFields playbook)
    {
        var sessions = state.SettingsValue;
        var mode = GetAt(sessions, "sessions.permissionMode") is JsonValue modeValue && modeValue.TryGetValue<string>(out var modeText) ? modeText : null;
        var model = GetAt(sessions, "sessions.model") is JsonValue modelValue && modelValue.TryGetValue<string>(out var modelText) && modelText != "" ? modelText : null;
        List<Field> fields =
        [
            new Field("description", "Description", FieldKind.Text, "Tells triage when to choose this playbook. One line."),
            new Field("kind", "Kind", FieldKind.Select, "A triage playbook holds a source’s classifier instructions and is never chosen for work.", Options: [new FieldOption("task", "task"), new FieldOption("triage", "triage")]),
        ];

        if (playbook.Kind == "triage")
        {
            fields.Add(new Field("rates", "Rates importance", FieldKind.Boolean, "Triage stores immediacy and severity, which these instructions must define. Off, it stores neither."));
        }

        if (playbook.Kind == "task")
        {
            fields.Add(new Field("autoStart", "Start automatically", FieldKind.Boolean, "Start the session after triage. Off, the work item waits in Unstarted for you to start it."));
            fields.Add(new Field("requiresWorktree", "Requires a worktree", FieldKind.Boolean, "Run the source’s setup prompt first when the ticket has no worktree."));

            foreach (var (kind, label, help) in ReportFields)
            {
                fields.Add(new Field($"reports.{kind}", label, FieldKind.Boolean, help));

                if (kind == "approval" && playbook.Reports.Contains("approval"))
                {
                    fields.Add(new Field("approvalSends", "Approve sends the work", FieldKind.Boolean, "Approve posts or pushes the session’s work. Off, you send it yourself, such as by pasting a reply, and Approve finishes up."));
                }
            }

            fields.Add(new Field("workdir", "Working directory", FieldKind.Select, "Where the session runs.",
                Options: [new FieldOption("worktree", "The ticket’s worktree, else the repo root"), new FieldOption("repoRoot", "Always the source’s repo root")]));
            fields.Add(new Field("permissionMode", "Permission mode", FieldKind.Select, "Claude Code permission mode for this playbook’s sessions.",
                Options: [new FieldOption("", $"Sessions setting ({mode ?? "auto"})"), .. state.Config.PermissionModes.Select((entry) => new FieldOption(entry, entry))]));
            fields.Add(new Field("model", "Model", FieldKind.Text, "The model for this playbook’s sessions.", $"Sessions setting ({model ?? "Claude’s default"})"));
        }

        fields.Add(new Field(
            "template",
            playbook.Kind == "triage" ? "Classifier instructions" : "Prompt",
            FieldKind.Prompt,
            playbook.Kind == "triage"
                ? "The classifier’s system prompt. {{playbooks}} inserts the task playbooks as “- name: description” lines; without it, triage appends them."
                : $"Variables: {string.Join(' ', state.Config.TemplateVariables.Select((name) => $"{{{{{name}}}}}"))}. Switchboard adds the commands for the reports checked above, with stage and link."));

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
            var shortest = segments[0] == "sources" ? 2 : segments.Length;

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

    /// <summary>Every settings field path of the general and source pages.</summary>
    public static IReadOnlyList<string> AllSettingsPaths(EditorState state)
    {
        var sources = state.SettingsValue?["sources"] is JsonObject configured ? configured.Select((entry) => entry.Key).ToList() : [];

        return GeneralFields(state).Concat(sources.SelectMany((name) => SourceFields(state, name))).SelectMany((section) => section.Fields).Select((field) => field.Path).ToList();
    }

    /// <summary>The page that holds each settings error's field; an error with no field maps to null and shows on every settings page.</summary>
    public static IReadOnlyDictionary<string, string?> SettingsErrorPages(EditorState state)
    {
        var paths = AllSettingsPaths(state);
        var pages = new Dictionary<string, string?>();

        foreach (var error in state.SettingsErrors)
        {
            var path = FieldOfError(error, paths);

            pages[error] = path is null ? null : path.StartsWith("sources.", StringComparison.Ordinal) ? $"source:{path.Split('.')[1]}" : "general";
        }

        return pages;
    }
}
