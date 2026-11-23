# Switchboard

Triages tickets assigned to you into playbooks, runs them in background Claude Code sessions, and shows the work in VS Code.

Activation starts the Switchboard hub, a separate process that keeps running when the window reloads, and after the last window closes, until it is stopped. `node ~/.switchboard/hub.js autostart on` starts it at login and installs a supervisor that starts it again if it crashes. Its state and log are in `~/.switchboard`.

For Linux prerequisites, source builds, desktop integration and local voice models, see `docs/install-linux.md` in the source repository.
