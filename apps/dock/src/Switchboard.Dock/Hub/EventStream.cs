namespace Switchboard.Dock.Hub;

/// <summary>One server-sent event: its name and its data lines joined.</summary>
public sealed record ServerEvent(string Name, string Data);

/// <summary>Reads server-sent events line by line, as the hub writes them: <c>event:</c> and <c>data:</c> lines, a blank line ending each, <c>:</c> comments.</summary>
public sealed class EventStream
{
    string name = "message";
    readonly List<string> data = [];

    /// <summary>Takes one line without its line ending; returns the event a blank line completes.</summary>
    public ServerEvent? Read(string line)
    {
        if (line.Length == 0)
        {
            var done = data.Count == 0 ? null : new ServerEvent(name, string.Join('\n', data));

            name = "message";
            data.Clear();

            return done;
        }

        if (line.StartsWith(':'))
        {
            return null;
        }

        var colon = line.IndexOf(':');
        var field = colon < 0 ? line : line[..colon];
        var value = colon < 0 ? "" : line[(colon + 1)..].TrimStart(' ');

        if (field == "event")
        {
            name = value;
        }
        else if (field == "data")
        {
            data.Add(value);
        }

        return null;
    }
}
