# Install on Linux

This guide covers a source build on Ubuntu 26.04 x86_64 with GNOME, Wayland/XWayland and PipeWire. It was checked on 2026-11-20. Other distributions need equivalent packages. Linux voice recognition currently uses the CPU; the CUDA setup described in architecture.md is Windows-only.

## System dependencies

Use Node.js 22.13 or newer, npm, the .NET 10 SDK, Git, VS Code and the CLI for each provider you use. Node 24.22.1, .NET 10.0.115 and Codex 0.171.0 were used for verification. Older Codex versions may not support the app-server protocol Switchboard uses.

On Ubuntu 26.04, these packages are available from the distribution repositories:

```bash
sudo apt update
sudo apt install git curl ca-certificates tar bzip2 python3 build-essential \
  nodejs npm dotnet-sdk-10.0 pulseaudio-utils libasound2t64 libpulse0 \
  libfontconfig1 libx11-6 libxext6 xwayland libglib2.0-bin ptyxis
```

Install [VS Code for Linux](https://code.visualstudio.com/docs/setup/linux) before invoking `code`. For Codex sessions, follow the [official Codex CLI installation and sign-in instructions](https://developers.openai.com/codex/cli/); only the selected provider's CLI and sign-in are required. Claude is optional for a Codex-only setup. Provider installation is separate from the repository's `npm ci`.

If Node is already installed through another manager, keep that installation instead of adding a second one. Set `sessions.nodePath` to its absolute executable path if a VS Code launched from GNOME cannot find that manager's `node` on PATH. Check the versions used by your shell and VS Code:

```bash
node --version
npm --version
dotnet --version
code --version
codex --version
# If using Claude:
claude --version
command -v node codex pactl gdbus ptyxis
# If using Claude:
command -v claude
pactl info
```

`pactl` is needed to pause dictation while another app records audio. `gdbus` watches logind for lock, sleep and session changes. The dock uses XWayland and the GNOME extension for window and terminal focus. `ptyxis` is the tested external terminal. Use your provider's own sign-in before starting sessions; Codex sign-in does not provide the speech API key.

Sources: [Node.js downloads](https://nodejs.org/en/download), [Microsoft's Ubuntu .NET instructions](https://learn.microsoft.com/dotnet/core/install/linux-ubuntu-install), and the package candidates from Ubuntu 26.04. Do not mix distribution and Microsoft .NET package feeds.

## Build and install Switchboard

From the repository root:

```bash
npm ci
npm run verify
npm run test:integration
npm run package --workspace switchboard
code --install-extension extensions/switchboard/switchboard-0.0.0.vsix --force
npm run publish --workspace @switchboard/gnome-shell
```

The integration tests require a graphical session. Run them from your GNOME login, or an isolated compositor as described in mechanics M39.

The extension package script uses `--no-dependencies`; build before packaging. Reload VS Code when ready. GNOME Shell loads the published extension at the next login; logging out ends desktop sessions, so choose when to do that.

Close the running dock before publishing it:

```bash
npm run publish --workspace @switchboard/dock
```

Start `~/.switchboard/dock/Switchboard.Dock`. See [AGENTS.md](../AGENTS.md) for deployment rules and [testing.md](testing.md) for the verification contract. Optional native npm dependencies must install successfully; missing `node-pty` prevents held terminals, and missing voice native packages prevents voice. If npm blocks an install script, inspect its warning and approve the specific required package before rebuilding; do not disable script checks globally.

For browser integration:

```bash
npm run lint --workspace @switchboard/firefox
```

Load `extensions/chrome/dist` unpacked in Chrome, or `extensions/firefox/dist/manifest.json` temporarily in Firefox's `about:debugging`. A permanent Firefox installation needs the signing procedure in [architecture.md](architecture.md).

## Local voice models

The model files are separate from npm packages and the VSIX. Default location: `~/.switchboard/voice/models/`. For an isolated Switchboard home, use its `voice/models` instead. Do not put them inside a hashed voice build folder.

Allow at least 3 GB of free space while downloading and extracting. The recognition and speaker downloads below total about 468 MiB. Preserve existing models and voiceprints; the commands install only the named files. The recognition archive and speaker model come from [sherpa-onnx's releases](https://github.com/k2-fsa/sherpa-onnx/releases); model details are in the [Nemotron documentation](https://k2-fsa.github.io/sherpa/onnx/nemo/nemotron-streaming.html). Each model has its own upstream license.

Create a download folder and fetch the exact assets:

```bash
(
set -eu
mkdir -p "$HOME/.cache/switchboard-models"
cd "$HOME/.cache/switchboard-models"
asr_model=sherpa-onnx-nemotron-speech-streaming-en-0.6b-160ms-int8-2026-04-25
curl -fL --retry 3 -o "$asr_model.tar.bz2" \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$asr_model.tar.bz2"
curl -fL --retry 3 -o wespeaker_en_voxceleb_resnet34_LM.onnx \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx
cat > SHA256SUMS <<'SUMS'
0ae73a41cd51599dc7cac9ac083d9d35de53d762ca45923505fde47a3751814b  sherpa-onnx-nemotron-speech-streaming-en-0.6b-160ms-int8-2026-04-25.tar.bz2
e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012  wespeaker_en_voxceleb_resnet34_LM.onnx
SUMS
sha256sum --check SHA256SUMS
)
```

Continue only when both hashes match. Stop the voice process before replacing any existing model files. For a first installation:

```bash
(
set -eu
cd "$HOME/.cache/switchboard-models"
asr_model=sherpa-onnx-nemotron-speech-streaming-en-0.6b-160ms-int8-2026-04-25
sha256sum --check SHA256SUMS
voice_models="$HOME/.switchboard/voice/models"
mkdir -p "$voice_models"
tar -xjf "$asr_model.tar.bz2" -C "$voice_models"
cp wespeaker_en_voxceleb_resnet34_LM.onnx "$voice_models/"
)
```

The installed recognition and speaker models have this layout:

```text
~/.switchboard/voice/models/
├── sherpa-onnx-nemotron-speech-streaming-en-0.6b-160ms-int8-2026-04-25/
│   ├── encoder.int8.onnx
│   ├── decoder.int8.onnx
│   ├── joiner.int8.onnx
│   ├── tokens.txt
│   └── README.md
└── wespeaker_en_voxceleb_resnet34_LM.onnx
```

Nemotron recognises speech; WeSpeaker provides speaker embeddings. Switchboard generates the hotword vocabulary from `tokens.txt`. Speaker enrolment is separate from installing the speaker model.

### Optional turn model: separate permission required

The published [LiveKit model licence](https://huggingface.co/livekit/turn-detector/blob/87e35fcb1e60a569bea70346191c4886ea92e281/LICENSE) restricts use to LiveKit Agents. Switchboard loads the model directly with ONNX Runtime. Install it only if you have separate permission covering that standalone use. Otherwise leave it absent: dictation uses the existing pause timer.

With that permission, use the multilingual `v0.4.1-intl` model pinned to commit `87e35fcb1e60a569bea70346191c4886ea92e281`. The repository's current `main` has a different layout. This adds about 389 MiB of downloads. The two large-file hashes below are upstream LFS identifiers; the remaining hashes were checked against files at the pinned revision.

```bash
(
set -eu
mkdir -p "$HOME/.cache/switchboard-models"
cd "$HOME/.cache/switchboard-models"
voice_models="$HOME/.switchboard/voice/models"
turn_revision=87e35fcb1e60a569bea70346191c4886ea92e281
mkdir -p livekit-turn-detector/onnx
for model_file in onnx/model_q8.onnx tokenizer.json tokenizer_config.json languages.json LICENSE; do
  curl -fL --retry 3 -o "livekit-turn-detector/$model_file" \
    "https://huggingface.co/livekit/turn-detector/resolve/$turn_revision/$model_file"
done
cat > livekit-turn-detector/SHA256SUMS <<'SUMS'
bd2c30776882138a1d95a07faddc13756fe1a35bef6323505f1124fca349bc9c  onnx/model_q8.onnx
9c5ae00e602b8860cbd784ba82a8aa14e8feecec692e7076590d014d7b7fdafa  tokenizer.json
83df6c86106c7f332995b3c456bc6a424cc46ee348bf4e0ae1b5410c63f4393f  tokenizer_config.json
05a16e11e4282173331dbf140624048e581a727ba45c361bed35e3014ad68187  languages.json
4f5b74db4fd26299a166688de8a3bde046fd7d9cc13ecab64532c24310bc18d7  LICENSE
SUMS
(cd livekit-turn-detector && sha256sum --check SHA256SUMS)
mkdir -p "$voice_models/livekit-turn-detector/onnx"
for model_file in onnx/model_q8.onnx tokenizer.json tokenizer_config.json languages.json LICENSE; do
  cp "livekit-turn-detector/$model_file" "$voice_models/livekit-turn-detector/$model_file"
done
)
```

The turn worker reads `livekit-turn-detector/onnx/model_q8.onnx`, `tokenizer.json`, `tokenizer_config.json` and optional `languages.json`. Keep them from the same revision. Preserve the downloaded licence alongside them. Restart the voice process after adding the turn model, as described below.

## Speech API key and first use

Speech output reads `OPENAI_TTS_API_KEY` from `~/.claude/secrets/openai-tts.env`. This is a separate API credential, not a Codex subscription token. Create or edit the file locally without putting the key in shell history or repository files:

```bash
mkdir -p "$HOME/.claude/secrets"
chmod 700 "$HOME/.claude/secrets"
(umask 077; touch "$HOME/.claude/secrets/openai-tts.env")
chmod 600 "$HOME/.claude/secrets/openai-tts.env"
```

Use a local editor to add `OPENAI_TTS_API_KEY=` followed by the key. Keep any existing secret-file contents. This credential is required for speech output, not local model loading.

Enable Voice in Switchboard's settings, choose the input and output devices, and use **Enroll my voice**. The turn model is selected at voice-process startup. After adding recognition or speaker assets, stop listening and start it again to reload recognition. For a complete voice-process restart, first check that no reply is playing or microphone capture is in use; read the PID from `~/.switchboard/voice.json`, verify it belongs to Switchboard's voice process, and send that PID `SIGTERM`. The hub supervises it and starts it again within a minute. Restarting VS Code alone may leave it running. Check `~/.switchboard/voice.log` for recogniser selection or missing-file errors. Never delete models, voiceprints or the operator's running voice process as a test cleanup step.

## Verification and troubleshooting

- `npm run verify` proves builds, types, isolated tests and coverage; it does not prove that the local models can load or that audio devices work.
- No recognition: verify all four Nemotron files and the exact directory name. An empty directory or an ONNX download saved as a Git LFS pointer is not a model.
- Turn-model errors: check the pinned revision, all five checksums and the `onnx/model_q8.onnx` layout. Without separate permission, leave this model absent and use the pause timer.
- Other-app pause missing: `pactl -f json list source-outputs` and `pactl subscribe` must work in the environment that starts the voice process. A user-local `pactl` must be on that process's PATH.
- Terminal voice focus stale: publish the GNOME extension and log in again. Its D-Bus interface must include `TerminalUnfocused`.
- Missing native library: use `ldd` on the failing `.node` or `.so` file and install the distribution package for each `not found` entry. Do not copy Windows DLLs into a Linux build.
- Playback fails with no key: configure the separate TTS credential; reinstalling the models cannot repair authentication.

For live acceptance, test a short dictated phrase, a reply through the chosen speakers, another app taking the microphone, and leaving a session terminal. Then test enrolment, barge-in and room hold. Model-loading checks alone do not validate recognition accuracy, speaker identity or acoustic echo cancellation. See [testing.md](testing.md) and [mechanics.md](mechanics.md) for the recorded checks and their limits.
