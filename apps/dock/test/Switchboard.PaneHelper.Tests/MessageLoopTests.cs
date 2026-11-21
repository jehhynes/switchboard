namespace Switchboard.PaneHelper.Tests;

public sealed class MessageLoopTests
{
    /// <summary>Runs a loop on its own thread, as the helper's main thread does, until it quits or the test gives up.</summary>
    static List<string> RunLoop(Action<MessageLoop, List<string>> start)
    {
        var seen = new List<string>();
        var thread = new Thread(() =>
        {
            var loop = new MessageLoop();

            start(loop, seen);
            loop.Run();
            seen.Add("ended");
        });

        thread.Start();
        Assert.True(thread.Join(TimeSpan.FromSeconds(10)), "The loop did not end.");
        return seen;
    }

    [Fact]
    public void Post_FromAnotherThread_RunsOnTheLoopThreadInOrder()
    {
        var loopThread = 0;
        var seen = RunLoop((loop, seen) =>
        {
            loopThread = Environment.CurrentManagedThreadId;
            new Thread(() =>
            {
                loop.Post(() => seen.Add($"one {Environment.CurrentManagedThreadId == loopThread}"));
                loop.Post(() => seen.Add("two"));
                loop.Post(loop.Quit);
            }).Start();
        });

        Assert.Equal(["one True", "two", "ended"], seen);
    }

    [Fact]
    public void After_DisposedOrNot_RunsOnlyTheTimerLeftRunning()
    {
        var seen = RunLoop((loop, seen) =>
        {
            var cancelled = loop.After(TimeSpan.FromMilliseconds(20), () => seen.Add("cancelled"));

            cancelled.Dispose();
            loop.After(TimeSpan.FromMilliseconds(50), () => seen.Add("kept"));
            loop.After(TimeSpan.FromMilliseconds(200), loop.Quit);
        });

        Assert.Equal(["kept", "ended"], seen);
    }
}
