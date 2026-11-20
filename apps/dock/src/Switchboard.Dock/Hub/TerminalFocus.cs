namespace Switchboard.Dock.Hub;

/// <summary>
/// Tells the hub which session's terminal window is in front, or that none is (<c>POST /dock/focus</c>, architecture.md § Voice), once per change
/// and in order, with when it changed, so the voice follows a session's terminal window as it follows an item window.
/// </summary>
public sealed class TerminalFocus(IHub hub, Func<long>? now = null)
{
    readonly Func<long> now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    string? reported;
    long reportedAt;
    bool known;
    Task last = Task.CompletedTask;

    /// <summary>The session whose terminal window is in front, or null for any other window; posted when it changed.</summary>
    public Task Report(string? sessionId)
    {
        if (known && sessionId == reported)
        {
            return last;
        }

        known = true;
        reported = sessionId;
        reportedAt = now();
        return last = Post(last, sessionId, reportedAt);
    }

    /// <summary>The dock connected to a hub, which may have started since: it hears the last report again, with when it happened.</summary>
    public Task Resend() => known ? last = Post(last, reported, reportedAt) : Task.CompletedTask;

    async Task Post(Task before, string? sessionId, long at)
    {
        await before;
        // A refusal, such as for a session the hub no longer has, changes nothing in the dock.
        await hub.Focus(sessionId, at);
    }
}
