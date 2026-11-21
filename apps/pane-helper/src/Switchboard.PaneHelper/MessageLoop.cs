using System.Collections.Concurrent;
using System.Runtime.Versioning;

namespace Switchboard.PaneHelper;

/// <summary>
/// The Win32 message loop of the thread that makes it: out-of-context window event hooks call back inside its <c>GetMessage</c>, and work
/// posted from other threads, such as the hub's lines and timers, runs between messages on the same thread.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class MessageLoop
{
    readonly uint thread;
    readonly ConcurrentQueue<Action> queue = new();

    public MessageLoop()
    {
        thread = Native.GetCurrentThreadId();
        // A thread has a message queue only after its first user32 call that needs one; PostThreadMessage fails before.
        Native.PeekMessage(out _, 0, 0, 0, Native.PmNoRemove);
    }

    /// <summary>Runs <paramref name="work"/> on the loop's thread.</summary>
    public void Post(Action work)
    {
        queue.Enqueue(work);
        Native.PostThreadMessage(thread, Native.WmApp, 0, 0);
    }

    /// <summary>Runs <paramref name="work"/> on the loop's thread after <paramref name="delay"/>, unless disposed first on that thread.</summary>
    public IDisposable After(TimeSpan delay, Action work)
    {
        var timer = new Delayed(this, work);

        timer.Start(delay);
        return timer;
    }

    /// <summary>Ends <see cref="Run"/> once the work before it has run; call it on the loop's thread.</summary>
    public void Quit() => Native.PostQuitMessage(0);

    /// <summary>Delivers messages and runs posted work until <see cref="Quit"/>.</summary>
    public void Run()
    {
        while (Native.GetMessage(out var message, 0, 0, 0) > 0)
        {
            if (message.Window == 0 && message.Id == Native.WmApp)
            {
                while (queue.TryDequeue(out var work))
                {
                    work();
                }

                continue;
            }

            Native.TranslateMessage(ref message);
            Native.DispatchMessage(ref message);
        }
    }

    sealed class Delayed(MessageLoop loop, Action work) : IDisposable
    {
        Timer? timer;
        bool cancelled;

        public void Start(TimeSpan delay) => timer = new Timer((_) => loop.Post(Fire), null, delay, Timeout.InfiniteTimeSpan);

        void Fire()
        {
            if (!cancelled)
            {
                cancelled = true;
                timer?.Dispose();
                work();
            }
        }

        public void Dispose()
        {
            cancelled = true;
            timer?.Dispose();
        }
    }
}
