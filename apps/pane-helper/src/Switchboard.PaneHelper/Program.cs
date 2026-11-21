using System.Text;
using System.Text.Json.Nodes;
using Switchboard.PaneHelper;

// The Chrome pane helper (PRD R113, architecture.md § Pane helper), which the hub starts while a page needs the pane: it reads the hub's
// orders from stdin and writes its reports to stdout, one JSON object per line, and lets the pane go and exits when stdin closes.
if (!OperatingSystem.IsWindows())
{
    Console.Error.WriteLine("The Chrome pane helper runs on Windows only.");
    return 2;
}

var homeAt = Array.IndexOf(args, "--home");

if (homeAt < 0 || homeAt + 1 >= args.Length)
{
    Console.Error.WriteLine("Usage: Switchboard.PaneHelper --home <Switchboard home>");
    return 2;
}

var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
var loop = new MessageLoop();
using var native = new Win32PaneNative(args[homeAt + 1]);
var written = new object();

void Send(JsonObject report)
{
    lock (written)
    {
        output.WriteLine(PaneProtocol.Line(report));
    }
}

// The hub is gone when stdout no longer takes a line; the pane is let go as when stdin closes.
var pane = new ChromePane(native, (report) =>
{
    try
    {
        Send(report);
    }
    catch (IOException)
    {
        loop.Post(() => loop.Quit());
    }
}, loop.After);

native.Moved += pane.Moved;
native.Destroyed += pane.Destroyed;
native.Foreground += pane.Foreground;

new Thread(() =>
{
    try
    {
        while (input.ReadLine() is { } line)
        {
            if (PaneProtocol.ParseOrder(line) is { } order)
            {
                loop.Post(() => pane.Order(order));
            }
        }
    }
    catch (IOException)
    {
        // A broken pipe ends the input as a close does.
    }

    loop.Post(() => loop.Quit());
}) { IsBackground = true, Name = "hub input" }.Start();

native.Log("pane helper started");

try
{
    Send(PaneProtocol.Ready);
}
catch (IOException)
{
    return 1;
}

loop.Run();
pane.Order(new PaneOrder(null, null));
native.Log("pane helper stopped");
return 0;
