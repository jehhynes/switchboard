# Install on Linux

This guide covers a source build on Ubuntu 26.04 x86_64 with GNOME, Wayland with XWayland, and PipeWire; other distributions need equivalent packages. Voice recognition on Linux runs on the CPU, because the GPU recogniser needs Windows ([architecture.md § Dictation](architecture.md#dictation)).

## System dependencies

Use Node.js 22.13 or newer, npm, the .NET 10 SDK, Git, VS Code and the CLI of each provider you use. Older Codex CLIs may lack the app-server protocol Switchboard uses; [mechanics.md](mechanics.md) M112 to M115 record the versions tested on Linux.

On Ubuntu 26.04 the distribution repositories provide:

```bash
sudo apt update
sudo apt install git curl ca-certificates tar bzip2 python3 build-essential \
  nodejs npm dotnet-sdk-10.0 pulseaudio-utils libasound2t64 libpulse0 \
  libfontconfig1 libx11-6 libxext6 xwayland libglib2.0-bin ptyxis
```

Install [VS Code for Linux](https://code.visualstudio.com/docs/setup/linux) before running `code`. Install and sign in to the CLI of each provider you use, such as the [Codex CLI](https://developers.openai.com/codex/cli/); Claude is not needed for a Codex-only setup, and `npm ci` installs no provider CLI. For other sources, see [Node.js downloads](https://nodejs.org/en/download) and [Microsoft's Ubuntu .NET instructions](https://learn.microsoft.com/dotnet/core/install/linux-ubuntu-install); do not mix the distribution's and Microsoft's .NET package feeds.

If Node.js comes from a version manager, keep that installation rather than adding a second one, and set `sessions.nodePath` to its absolute executable path when VS Code started from GNOME cannot find `node` on PATH. Check the versions your shell and VS Code use:

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

`pactl` lets dictation pause while another app records audio. `gdbus` watches logind for lock, sleep and session changes. The dock runs under XWayland and uses the GNOME Shell extension to find and raise windows and to follow terminal focus. `ptyxis` is the terminal Switchboard opens. A provider sign-in does not supply the speech API key ([Speech API key and first use](#speech-api-key-and-first-use)).

## Build and install Switchboard

From the repository root:

```bash
npm ci
npm run verify
npm run install-local
npm run test:integration
npm run package --workspace switchboard
code --install-extension extensions/switchboard/switchboard-0.0.0.vsix --force
npm run publish --workspace @switchboard/gnome-shell
```

`npm run install-local` builds Switchboard and installs the hub, the terminal holder, the voice process, the web page's assets and the browser extension into `~/.switchboard`, without VS Code; a running hub restarts onto the new build once it is quiet, and the command waits for that. `node ~/.switchboard/hub.js start` then starts the hub, and `node ~/.switchboard/hub.js autostart on` starts it at login.

The integration tests need a graphical session: run them from your GNOME login, or in an isolated compositor as in [mechanics.md](mechanics.md) M39.

Packaging does not build (`--no-dependencies`), so build before packaging. Reload VS Code when ready. GNOME Shell loads the published extension at the next login; logging out ends desktop sessions, so choose when.

Publish the dock, closing it first if it is running, because it holds its files open:

```bash
npm run publish --workspace @switchboard/dock
```

Start `~/.switchboard/dock/Switchboard.Dock`. To reinstall after a change, see [AGENTS.md § Reinstalling after a change](../AGENTS.md#reinstalling-after-a-change); for checks, see [testing.md](testing.md).

Optional native npm dependencies must install: without `node-pty` there are no held terminals, and without the voice native packages there is no voice. If npm blocks an install script, read its warning and approve that package before rebuilding; do not turn off script checks globally.

For browser integration:

```bash
npm run lint --workspace @switchboard/firefox
```

Load `extensions/chrome/dist` unpacked in Chrome, or `extensions/firefox/dist/manifest.json` temporarily from Firefox's `about:debugging`. A permanent Firefox install needs the signed build ([architecture.md § Browser extension](architecture.md#browser-extension)).

## Local voice models

The models are not in the npm packages or the VSIX. They go in `~/.switchboard/voice/models/`, or `voice/models` in an isolated Switchboard home, never inside a voice build folder.

Allow at least 3 GB free while downloading and extracting; the recognition and speaker downloads total about 468 MiB. The commands add only the named files, keeping existing models and voiceprints. The recognition archive and speaker model come from [sherpa-onnx's releases](https://github.com/k2-fsa/sherpa-onnx/releases); see the [Nemotron documentation](https://k2-fsa.github.io/sherpa/onnx/nemo/nemotron-streaming.html) for the model. Each model has its own upstream licence.

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

Continue only when both hashes match. Stop the voice process before replacing existing model files. For a first installation:

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

The installed models have this layout:

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

Nemotron recognises speech; WeSpeaker computes speaker embeddings. Switchboard builds the hotword vocabulary from `tokens.txt`. Installing the speaker model does not enrol your voice.

### Optional turn model: separate permission required

The [LiveKit model licence](https://huggingface.co/livekit/turn-detector/blob/87e35fcb1e60a569bea70346191c4886ea92e281/LICENSE) restricts use to LiveKit Agents, and Switchboard loads the model directly with ONNX Runtime. Install it only with separate permission for that standalone use; without it, dictation ends a turn on the pause timer.

With that permission, use the multilingual `v0.4.1-intl` model pinned to commit `87e35fcb1e60a569bea70346191c4886ea92e281`, because the commands below need the files at that revision's paths. It adds about 389 MiB of downloads. The two large-file hashes below are upstream LFS identifiers; the others were checked against the files at the pinned revision.

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

The turn worker reads `onnx/model_q8.onnx`, `tokenizer.json`, `tokenizer_config.json` and, optionally, `languages.json` under `livekit-turn-detector/`. Keep them from the same revision, with the licence beside them, and restart the voice process after adding them ([Speech API key and first use](#speech-api-key-and-first-use)).

## Speech API key and first use

Speech output reads `OPENAI_TTS_API_KEY` from `~/.claude/secrets/openai-tts.env`. It is an API credential, separate from a Codex subscription, and local models load without it. Create the file without putting the key in shell history or a repository:

```bash
mkdir -p "$HOME/.claude/secrets"
chmod 700 "$HOME/.claude/secrets"
(umask 077; touch "$HOME/.claude/secrets/openai-tts.env")
chmod 600 "$HOME/.claude/secrets/openai-tts.env"
```

Add `OPENAI_TTS_API_KEY=` followed by the key in a local editor, keeping the file's other contents.

Enable Voice in Switchboard's settings, choose the input and output devices, and use **Enroll my voice**.

The voice process picks up new models as follows:

- Recognition model: stop listening and start again.
- Speaker model added after the voice process first needed it, or the turn model: restart the voice process.

To restart the voice process, check that no reply is playing and no capture is in use, read the PID from `~/.switchboard/voice.json`, check that it is Switchboard's voice process, and send it `SIGTERM`. The hub starts it again within a minute. Restarting VS Code alone may leave it running. `~/.switchboard/voice.log` shows which recogniser loaded and any missing-file errors. Never delete models, voiceprints or your running voice process as a test cleanup step.

## Verification and troubleshooting

- `npm run verify` checks builds, types, isolated tests and coverage; it does not show that the local models load or that the audio devices work.
- No recognition: check the exact directory name and its four files (`encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, `tokens.txt`). An empty directory, or an ONNX file saved as a Git LFS pointer, is not a model.
- Turn-model errors: check the pinned revision, all five checksums and the `onnx/model_q8.onnx` path. Without separate permission, leave the model out and use the pause timer.
- Dictation does not pause for another app: `pactl -f json list source-outputs` and `pactl subscribe` must work in the environment that starts the voice process; a user-local `pactl` must be on that process's PATH.
- Terminal voice focus stale: publish the GNOME Shell extension and log in again; its D-Bus interface must include `TerminalUnfocused`.
- Missing native library: run `ldd` on the failing `.node` or `.so` file and install the distribution package for each `not found` entry. Do not copy Windows DLLs into a Linux build.
- Playback fails with no key: configure the speech API key; reinstalling models does not fix authentication.

For live acceptance, test a short dictated phrase, a reply through the chosen speakers, another app taking the microphone, and leaving a session terminal; then enrolment, barge-in and room hold. Model-loading checks do not validate recognition accuracy, speaker identity or echo cancellation. See [testing.md](testing.md) and [mechanics.md](mechanics.md) for the recorded checks and their limits.
