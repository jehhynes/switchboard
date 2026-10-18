namespace Switchboard.Dock.Platform;

/// <summary>
/// Orders what the shell says about full-screen windows: its signal, the service leaving, which means none, and a read made when the service
/// returns. A read reports only when nothing was reported after it started, so a slow read does not undo a later change.
/// </summary>
public sealed class FullScreenReports(Action<IReadOnlyList<string>> report)
{
    readonly Lock gate = new();
    long latest;

    /// <summary>A change the shell signalled.</summary>
    public void Changed(IReadOnlyList<string> monitors)
    {
        lock (gate)
        {
            latest++;
            report(monitors);
        }
    }

    /// <summary>The service left: nothing says a full-screen window covers a monitor any longer.</summary>
    public void Lost() => Changed([]);

    /// <summary>Starts a read; pass what it returns to <see cref="Read"/>.</summary>
    public long Begin()
    {
        lock (gate)
        {
            return ++latest;
        }
    }

    /// <summary>Reports what the read that <see cref="Begin"/> started returned, unless a change or another read came after it.</summary>
    public void Read(long started, IReadOnlyList<string> monitors)
    {
        lock (gate)
        {
            if (started == latest)
            {
                report(monitors);
            }
        }
    }
}
