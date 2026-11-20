using System.Text.Json;
using System.Text.Json.Nodes;

namespace Switchboard.Dock.Settings;

/// <summary>A playbook entry of settings.json's <c>playbooks</c> object, as the window edits it (PRD R54).</summary>
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
    IReadOnlyList<string> ReturnOf,
    string Template)
{
    /// <summary>The reports a task playbook can list, in the order the window writes them.</summary>
    public static readonly IReadOnlyList<string> ReportKinds = ["done", "approval", "worktree", "playbook", "paste"];

    /// <summary>The keys of a playbook entry, which the hub accepts and the window has fields for, in the order it writes them.</summary>
    public static readonly IReadOnlyList<string> Keys = ["description", "kind", "autoStart", "requiresWorktree", "workdir", "reports", "approvalSends", "returnOf", "focus", "rates", "provider", "permissionMode", "model", "template"];

    /// <summary>The agent the playbook's sessions run in, or null for the sessions setting (PRD R22).</summary>
    public string? Provider { get; init; }

    /// <summary>The page a task playbook's focus must be on, <c>ticket</c> or <c>pr</c>, or null for any (PRD R79).</summary>
    public string? Focus { get; init; }

    public static readonly PlaybookFields Empty = new("", "task", false, false, null, null, "worktree", [], false, false, [], "");

    /// <summary>
    /// An entry's fields, or null and why it cannot be read: it is not an object, has a key the hub does not know, or a key has the wrong JSON type.
    /// Absent and null keys take their defaults.
    /// </summary>
    public static (PlaybookFields? Fields, string? Error) Read(JsonNode? node)
    {
        if (node is not JsonObject entry)
        {
            return (null, "A playbook must be an object.");
        }

        if (entry.Select((pair) => pair.Key).Where((key) => !Keys.Contains(key)).ToList() is { Count: > 0 } unknown)
        {
            return (null, $"Unknown keys: {string.Join(", ", unknown)}.");
        }

        string? error = null;

        string? Text(string key)
        {
            var value = entry[key];

            if (value is null)
            {
                return null;
            }

            if (value is JsonValue item && item.GetValueKind() == JsonValueKind.String)
            {
                return item.GetValue<string>();
            }

            error ??= $"{key} must be a string.";
            return null;
        }

        bool Flag(string key)
        {
            var value = entry[key];

            if (value is null)
            {
                return false;
            }

            if (value.GetValueKind() is JsonValueKind.True or JsonValueKind.False)
            {
                return value.GetValueKind() == JsonValueKind.True;
            }

            error ??= $"{key} must be true or false.";
            return false;
        }

        IReadOnlyList<string> List(string key)
        {
            var value = entry[key];

            if (value is null)
            {
                return [];
            }

            if (value is JsonArray list && list.All((item) => item?.GetValueKind() == JsonValueKind.String))
            {
                return list.Select((item) => item!.GetValue<string>()).ToList();
            }

            error ??= $"{key} must be a list of strings.";
            return [];
        }

        var fields = new PlaybookFields(
            Text("description") ?? "",
            Text("kind") ?? "task",
            Flag("autoStart"),
            Flag("requiresWorktree"),
            Text("permissionMode"),
            Text("model"),
            Text("workdir") ?? "worktree",
            List("reports"),
            Flag("approvalSends"),
            Flag("rates"),
            List("returnOf"),
            Text("template") ?? "")
        {
            Provider = Text("provider"),
            Focus = Text("focus"),
        };

        return error is null ? (fields, null) : (null, error);
    }

    /// <summary>Every field with its value, for reading one by key and comparing playbooks.</summary>
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
            ["reports"] = Strings(Reports),
            ["approvalSends"] = ApprovalSends,
            ["rates"] = Rates,
            ["returnOf"] = Strings(ReturnOf),
            ["focus"] = Focus,
            ["provider"] = Provider,
            ["template"] = Template,
        };

    /// <summary>The entry the window writes: defaults left out, except <c>autoStart</c> and <c>requiresWorktree</c> on a task playbook, in <see cref="Keys"/> order.</summary>
    public JsonObject ToEntry()
    {
        var task = Kind == "task";
        var entry = new JsonObject { ["description"] = Description };

        if (!task)
        {
            entry["kind"] = Kind;
        }

        if (task || AutoStart)
        {
            entry["autoStart"] = AutoStart;
        }

        if (task || RequiresWorktree)
        {
            entry["requiresWorktree"] = RequiresWorktree;
        }

        if (Workdir != "worktree")
        {
            entry["workdir"] = Workdir;
        }

        if (Reports.Count > 0)
        {
            entry["reports"] = Strings(Reports);
        }

        if (ApprovalSends)
        {
            entry["approvalSends"] = true;
        }

        if (ReturnOf.Count > 0)
        {
            entry["returnOf"] = Strings(ReturnOf);
        }

        if (Focus is not null)
        {
            entry["focus"] = Focus;
        }

        if (Rates)
        {
            entry["rates"] = true;
        }

        if (Provider is not null)
        {
            entry["provider"] = Provider;
        }

        if (PermissionMode is not null)
        {
            entry["permissionMode"] = PermissionMode;
        }

        if (Model is not null)
        {
            entry["model"] = Model;
        }

        entry["template"] = Template;

        return entry;
    }

    /// <summary>Whether two playbooks have the same fields.</summary>
    public static bool Same(PlaybookFields a, PlaybookFields? b) => b is not null && a.ToJson().ToJsonString() == b.ToJson().ToJsonString();

    static JsonArray Strings(IEnumerable<string> items) => new(items.Select((item) => (JsonNode)JsonValue.Create(item)).ToArray());
}

/// <summary>settings.json as the hub read it: its value, or null and the error when it is not valid JSON.</summary>
public sealed record SettingsFile(string Path, string? Version, JsonNode? Value, string? Error);

/// <summary>
/// What <c>POST /config/read</c> answers: settings.json, the choices the editor offers, the open work items per playbook, whether each configured
/// source is on, which the hub stores outside settings.json, and the config folder.
/// </summary>
public sealed record EditorConfig(
    SettingsFile Settings,
    IReadOnlyList<string> PermissionModes,
    IReadOnlyList<string> TemplateVariables,
    IReadOnlyList<string> SourceKinds,
    IReadOnlyDictionary<string, int> InUse,
    IReadOnlyDictionary<string, bool> Enabled,
    string ConfigDir = "",
    IReadOnlyList<string>? CodexPermissionModes = null,
    IReadOnlyList<string>? Providers = null)
{
    public static EditorConfig Parse(JsonNode body)
    {
        var settings = body["settings"] ?? new JsonObject();
        var strings = (string key) => body[key] is JsonArray list ? list.Select((entry) => entry?.GetValue<string>() ?? "").ToList() : [];

        return new EditorConfig(
            new SettingsFile(settings["path"]?.GetValue<string>() ?? "", settings["version"]?.GetValue<string>(), settings["value"]?.DeepClone(), settings["error"]?.GetValue<string>()),
            strings("permissionModes"),
            strings("templateVariables"),
            strings("sourceKinds"),
            body["inUse"] is JsonObject inUse ? inUse.ToDictionary((entry) => entry.Key, (entry) => entry.Value?.GetValue<int>() ?? 0) : new Dictionary<string, int>(),
            body["enabled"] is JsonObject enabled ? enabled.ToDictionary((entry) => entry.Key, (entry) => entry.Value?.GetValueKind() == JsonValueKind.True) : new Dictionary<string, bool>(),
            body["configDir"]?.GetValue<string>() ?? "",
            strings("codexPermissionModes"),
            strings("providers"));
    }
}

/// <summary>A save's refusal, or no errors and the written file's version, null from a hub that does not send it.</summary>
public sealed record SaveReply(IReadOnlyList<string> Errors, string? Version);

/// <summary>
/// Voiceprint enrolment as the hub reports it (architecture.md § Voice check and barge-in): <c>idle</c>, <c>starting</c>, <c>recording</c>,
/// <c>enrolled</c>, <c>failed</c> or <c>cancelled</c>; when a recording ends, in epoch milliseconds; why it failed; and when the saved voiceprint was made.
/// </summary>
public sealed record Enrollment(string State, long? EndsAt, string? Error, string? EnrolledAt)
{
    /// <summary>Starting or recording, while the window asks again how it stands.</summary>
    public bool Active => State is "starting" or "recording";

    public static Enrollment? Parse(JsonNode? node)
    {
        if (node is not JsonObject value)
        {
            return null;
        }

        string? Text(string key) => value[key] is JsonValue text && text.TryGetValue<string>(out var read) ? read : null;

        return new Enrollment(Text("state") ?? "idle", value["endsAt"] is JsonValue at && at.TryGetValue<long>(out var ends) ? ends : null, Text("error"), Text("enrolledAt"));
    }
}

/// <summary>An enrolment request's refusal or failure, or null, and how enrolment stands when the hub said.</summary>
public sealed record EnrollReply(string? Error, Enrollment? Enrollment);

/// <summary>The hub's config requests for the Settings window (PRD R54).</summary>
public interface IConfigHub
{
    /// <summary>settings.json and the choices, or null and why not.</summary>
    Task<(EditorConfig? Config, string? Error)> ReadConfig();

    /// <summary>Every error the hub would report for a draft of settings.json, or null when the hub did not answer.</summary>
    Task<IReadOnlyList<string>?> CheckConfig(JsonObject settings);

    /// <summary>Writes settings.json if it is still at <paramref name="version"/>; returns the refusal's errors, or none and the version written.</summary>
    Task<SaveReply> SaveConfig(JsonObject value, string? version, string configDir);

    /// <summary>Voiceprint enrolment: <c>start</c>, <c>cancel</c> or <c>status</c>; a hub without it answers a refusal.</summary>
    Task<EnrollReply> Enroll(string action) => Task.FromResult(new EnrollReply("This hub cannot enrol a voice; restart Switchboard.", null));
}
