using Tmds.DBus.Protocol;

namespace Switchboard.Dock.Platform;

/// <summary>
/// The Switchboard GNOME Shell extension's <c>switchboard.Shell</c> service on the session bus (<c>extensions/gnome-shell</c>). Calls block for at
/// most <see cref="Timeout"/>; each runs on the thread pool, so a call from the UI thread does not wait on a continuation queued to it.
/// </summary>
public sealed class GnomeShell : IShell, IDisposable
{
    const string Service = "switchboard.Shell";
    const string ObjectPath = "/switchboard/Shell";

    static readonly TimeSpan Timeout = TimeSpan.FromSeconds(2);

    readonly DBusConnection connection;
    readonly List<IDisposable> watches = [];

    GnomeShell(DBusConnection connection) => this.connection = connection;

    /// <summary>Connects to the session bus; null when there is none or the extension's service is not on it.</summary>
    public static GnomeShell? Connect()
    {
        if (DBusAddress.Session is not { } address)
        {
            return null;
        }

        var connection = new DBusConnection(address);

        try
        {
            Wait(Task.Run(async () =>
            {
                await connection.ConnectAsync();
                return true;
            }));

            var shell = new GnomeShell(connection);

            shell.Windows();
            return shell;
        }
        catch (ShellException)
        {
            connection.Dispose();
            return null;
        }
    }

    public IReadOnlyList<ShellWindow> Windows() => List("Windows");

    public IReadOnlyList<ShellWindow> Terminals() => List("Terminals");

    IReadOnlyList<ShellWindow> List(string method) => Wait(Task.Run(() =>
    {
        using var writer = connection.GetMessageWriter();

        writer.WriteMethodCallHeader(Service, ObjectPath, Service, method);

        return connection.CallMethodAsync(writer.CreateMessage(), static (message, _) =>
        {
            var reader = message.GetBodyReader();
            var end = reader.ReadArrayStart(DBusType.Struct);
            List<ShellWindow> windows = [];

            while (reader.HasNext(end))
            {
                reader.AlignStruct();
                windows.Add(new ShellWindow(reader.ReadUInt64(), reader.ReadString()));
            }

            return (IReadOnlyList<ShellWindow>)windows;
        }, null);
    }));

    public bool Activate(ulong id, string monitor) => Wait(Task.Run(() =>
    {
        using var writer = connection.GetMessageWriter();

        writer.WriteMethodCallHeader(Service, ObjectPath, Service, "Activate", "ts");
        writer.WriteUInt64(id);
        writer.WriteString(monitor);

        return connection.CallMethodAsync(writer.CreateMessage(), static (message, _) => message.GetBodyReader().ReadBool(), null);
    }));

    public IReadOnlyList<string> FullScreen() => Wait(Task.Run(() =>
    {
        using var writer = connection.GetMessageWriter();

        writer.WriteMethodCallHeader(Service, ObjectPath, Service, "FullScreen");

        return connection.CallMethodAsync(writer.CreateMessage(), static (message, _) => ReadMonitors(message), null);
    }));

    static IReadOnlyList<string> ReadMonitors(Message message) => message.GetBodyReader().ReadArrayOfString();

    /// <remarks>
    /// When the extension is turned off it reports no monitors, as nothing then says otherwise, and when it is turned on again it reports the
    /// monitors it reads then.
    /// </remarks>
    public void WatchFullScreen(Action<IReadOnlyList<string>> changed)
    {
        var reports = new FullScreenReports(changed);
        MessageValueReader<IReadOnlyList<string>> read = static (message, _) => ReadMonitors(message);
        // Completions, such as the connection closing, are not reported without ObserverFlags asking for them.
        Action<Notification<IReadOnlyList<string>>> handle = (notification) =>
        {
            if (notification.HasValue)
            {
                reports.Changed(notification.Value);
            }
        };
        MessageValueReader<(string Name, string Owner)> readOwner = static (message, _) =>
        {
            var reader = message.GetBodyReader();
            var name = reader.ReadString();

            reader.ReadString();
            return (name, reader.ReadString());
        };
        Action<Notification<(string Name, string Owner)>> handleOwner = (notification) =>
        {
            if (!notification.HasValue || notification.Value.Name != Service)
            {
                return;
            }

            if (notification.Value.Owner == "")
            {
                reports.Lost();
                return;
            }

            var started = reports.Begin();

            // Read on the thread pool: this handler runs on the connection's receive loop, which the reply needs.
            Task.Run(() =>
            {
                try
                {
                    reports.Read(started, FullScreen());
                }
                catch (ShellException)
                {
                    // Turned off again before it answered; that change reports no monitors.
                }
            });
        };

        watches.Add(Wait(Task.Run(async () => await connection.WatchSignalAsync(Service, ObjectPath, Service, "FullScreenChanged", read, handle, ObserverFlags.None, false, null))));
        watches.Add(Wait(Task.Run(async () => await connection.WatchSignalAsync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "NameOwnerChanged", readOwner, handleOwner, ObserverFlags.None, false, null))));
    }

    public void WatchTerminalFocused(Action<string> focused)
    {
        MessageValueReader<string> read = static (message, _) => message.GetBodyReader().ReadString();
        Action<Notification<string>> handle = (notification) =>
        {
            if (notification.HasValue)
            {
                focused(notification.Value);
            }
        };

        watches.Add(Wait(Task.Run(async () => await connection.WatchSignalAsync(Service, ObjectPath, Service, "TerminalFocused", read, handle, ObserverFlags.None, false, null))));
    }

    static T Wait<T>(Task<T> call)
    {
        try
        {
            return call.Wait(Timeout) ? call.Result : throw new ShellException($"GNOME Shell did not answer within {Timeout.TotalSeconds:0} seconds.");
        }
        catch (AggregateException error) when (error.InnerException is { } inner)
        {
            throw new ShellException(inner.Message, inner);
        }
    }

    public void Dispose()
    {
        foreach (var watch in watches)
        {
            watch.Dispose();
        }

        connection.Dispose();
    }
}
