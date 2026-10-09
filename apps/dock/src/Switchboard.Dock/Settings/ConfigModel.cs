using System.Text.Json.Nodes;

namespace Switchboard.Dock.Settings;

/// <summary>A playbook's front matter and template, as the hub reads and writes them (PRD R54).</summary>
public sealed record PlaybookFields(
    string Description,
    string Kind,
    bool AutoStart,
    bool RequiresWorktree,
    string? PermissionMode,
    string? Model,
    string Workdir,
    IReadOnlyList<string> Reports,
    bool ApprovalSends,
    bool Rates,
    string Template)
{
    /// <summary>The reports a task playbook can list, in front matter order.</summary>
    public static readonly IReadOnlyList<string> ReportKinds = ["done", "approval", "worktree", "playbook", "paste"];

    public static readonly PlaybookFields Empty = new("", "task", false, false, null, null, "worktree", [], false, false, "");

    public static PlaybookFields FromJson(JsonNode node) =>
        new(
            Text(node, "description") ?? "",
            Text(node, "kind") ?? "task",
            node["autoStart"]?.GetValue<bool>() ?? false,
            node["requiresWorktree"]?.GetValue<bool>() ?? false,
            Text(node, "permissionMode"),
            Text(node, "model"),
            Text(node, "workdir") ?? "worktree",
            node["reports"] is JsonArray reports ? reports.Select((report) => report?.GetValue<string>() ?? "").ToList() : [],
            node["approvalSends"]?.GetValue<bool>() ?? false,
            node["rates"]?.GetValue<bool>() ?? false,
            Text(node, "template") ?? "");

    static string? Text(JsonNode node, string key) => node[key] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    /// <summary>The fields in the order the hub's playbook files hold them.</summary>
    public JsonObject ToJson() =>
        new()
        {
            ["description"] = Description,
            ["kind"] = Kind,
            ["autoStart"] = AutoStart,
            ["requiresWorktree"] = RequiresWorktree,
            ["permissionMode"] = PermissionMode,
            ["model"] = Model,
            ["workdir"] = Workdir,
            ["reports"] = new JsonArray(Reports.Select((report) => (JsonNode)JsonValue.Create(report)).ToArray()),
            ["approvalSends"] = ApprovalSends,
            ["rates"] = Rates,
            ["template"] = Template,
        };

    /// <summary>Whether two playbooks are the same once saved: saving gives the template a final newline.</summary>
    public static bool Same(PlaybookFields a, PlaybookFields? b)
    {
        static string Saved(PlaybookFields playbook)
        {
            var template = playbook.Template.Replace("\r\n", "\n");

            return (playbook with { Template = template.Length > 0 && !template.EndsWith('\n') ? template + "\n" : template }).ToJson().ToJsonString();
        }

        return b is not null && Saved(a) == Saved(b);
    }
}

/// <summary>settings.json as the hub read it: its value, or null and the error when it is not valid JSON.</summary>
public sealed record SettingsFile(string Path, string? Version, JsonNode? Value, string? Error);

/// <summary>A playbook file: its fields, or null and the error when the hub would leave it out.</summary>
public sealed record PlaybookFile(string Name, string Path, string Version, PlaybookFields? Playbook, string? Error);

/// <summary>What <c>POST /config/read</c> answers: the files, the choices the editor offers, the open work items per playbook, and the config folder.</summary>
public sealed record EditorConfig(
    SettingsFile Settings,
    IReadOnlyList<PlaybookFile> Playbooks,
    IReadOnlyList<string> PermissionModes,
    IReadOnlyList<string> TemplateVariables,
    IReadOnlyList<string> SourceKinds,
    IReadOnlyDictionary<string, int> InUse,
    string ConfigDir = "")
{
    public static EditorConfig Parse(JsonNode body)
    {
        var settings = body["settings"] ?? new JsonObject();
        var strings = (string key) => body[key] is JsonArray list ? list.Select((entry) => entry?.GetValue<string>() ?? "").ToList() : [];

        return new EditorConfig(
            new SettingsFile(settings["path"]?.GetValue<string>() ?? "", settings["version"]?.GetValue<string>(), settings["value"]?.DeepClone(), settings["error"]?.GetValue<string>()),
            body["playbooks"] is JsonArray playbooks
                ? playbooks.OfType<JsonNode>().Select((entry) => new PlaybookFile(
                    entry["name"]?.GetValue<string>() ?? "",
                    entry["path"]?.GetValue<string>() ?? "",
                    entry["version"]?.GetValue<string>() ?? "",
                    entry["playbook"] is JsonObject fields ? PlaybookFields.FromJson(fields) : null,
                    entry["error"]?.GetValue<string>())).ToList()
                : [],
            strings("permissionModes"),
            strings("templateVariables"),
            strings("sourceKinds"),
            body["inUse"] is JsonObject inUse ? inUse.ToDictionary((entry) => entry.Key, (entry) => entry.Value?.GetValue<int>() ?? 0) : new Dictionary<string, int>(),
            body["configDir"]?.GetValue<string>() ?? "");
    }
}

/// <summary>The hub's config requests for the Settings window (PRD R54).</summary>
public interface IConfigHub
{
    /// <summary>The files and choices, or null and why not.</summary>
    Task<(EditorConfig? Config, string? Error)> ReadConfig();

    /// <summary>Every error the hub would report for a draft, or null when the hub did not answer.</summary>
    Task<IReadOnlyList<string>?> CheckConfig(JsonObject body);

    /// <summary>Writes settings.json or a playbook; returns the refusal's errors, empty when it saved.</summary>
    Task<IReadOnlyList<string>> SaveConfig(JsonObject body);

    /// <summary>Deletes a playbook file read from <paramref name="configDir"/>; returns the refusal's errors, empty when it deleted.</summary>
    Task<IReadOnlyList<string>> DeletePlaybook(string name, string version, string configDir);
}
