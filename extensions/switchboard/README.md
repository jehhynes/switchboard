# Switchboard

Triages tickets assigned to you into playbooks, runs them in background Claude Code sessions, and shows the work in VS Code.

Activation starts the Switchboard hub, a separate process that keeps running when the window reloads and exits 30 minutes after its last window disconnects. Its state and log are in `~/.switchboard`.

For Linux prerequisites, source builds, desktop integration and local voice models, see `docs/install-linux.md` in the source repository.
