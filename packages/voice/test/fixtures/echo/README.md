# Echo check fixtures

Captures from `packages/voice/scripts/echo-check.mjs` on 2026-11-20 (mechanics M94, M98), 16 kHz mono 16-bit, cut to their first 4 s; the operator was silent in each. The script opened the mic, waited 0.5 s, and then played `played.wav` aloud three times in a row.

| File | What |
|---|---|
| `played.wav` | The clip played, a TTS voice saying "Tests passed and the new build is ready", 24 kHz mono 16-bit |
| `echo-local.wav` | Raw capture on this computer: a Logitech BRIO hearing LG HDR 4K speakers |
| `echo-remote.wav` | Raw capture over Remote Desktop, through the "Remote Audio" device, the client's speakers playing |
| `quiet.wav` | Capture in Windows' communications mode with its echo cancellation on, on this computer: the echo taken out, which stands in for headphones |
