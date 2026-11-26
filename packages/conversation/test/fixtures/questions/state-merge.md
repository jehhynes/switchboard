Fix 4 is ready.

1. **State.** Merge fix 4's state work into `main`? {#state-merge}
   This also confirms the four recommendations applied earlier:
   - mid-turn `[state]` isn't relied on, and `report stage` handles updates between tool calls;
   - a state is asked for at each change of phase and at the end of a turn that changed it;
   - `n/total` is an optional prefix on the headline;
   - only a body change marks a state unread.

   Verify passes and Codex's three review findings are fixed. Merging migrates stored statuses and stages into the new states table on your hub. I'll merge, reinstall and push.
   - A) Accept and merge (recommended) — the stored data is migrated when the hub restarts.
   - B) Change something first — tell me what to adjust.
