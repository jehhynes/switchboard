import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

/** Where speech recognition runs: the GPU through sherpa-onnx's CUDA build, or the CPU. */
export type AsrDevice = 'gpu' | 'cpu';

/** The fp32 Nemotron model the GPU runs: CUDA with the int8 model is slower than the CPU (claude-collab `asr-local.js`). */
export const GPU_MODEL = 'sherpa-onnx-nemotron-speech-streaming-en-0.6b-160ms-2026-04-25';
/** The int8 Nemotron model the CPU runs. */
export const CPU_MODEL = 'sherpa-onnx-nemotron-speech-streaming-en-0.6b-160ms-int8-2026-04-25';
/**
 * The CUDA 12 build of sherpa-onnx and the CUDA and cuDNN runtime it loads, in `<voice home>/models`, laid out as claude-collab's
 * `.wip/sherpa-cuda`: `pkg/node_modules` holds `sherpa-onnx-node` and `sherpa-onnx-win-x64` with the CUDA build's DLLs, `cuda-dlls` the runtime.
 */
export const CUDA_FOLDER = 'sherpa-cuda';
/** The model the GPU check runs on the GPU, the voice check's speaker model. */
const CHECK_MODEL = 'wespeaker_en_voxceleb_resnet34_LM.onnx';

/** What the GPU check needs from the machine; the real ones outside tests. */
export interface GpuMachine {
  platform: NodeJS.Platform;
  systemRoot: string | undefined;
  exists(path: string): boolean;
}

export interface CudaPaths {
  /** The folder whose `node_modules` holds the CUDA build. */
  pkg: string;
  /** The CUDA and cuDNN runtime DLLs, put first on the process's PATH. */
  dlls: string;
  model: string;
  checkModel: string;
}

export function cudaPaths(models: string): CudaPaths {
  return {
    pkg: join(models, CUDA_FOLDER, 'pkg'),
    dlls: join(models, CUDA_FOLDER, 'cuda-dlls'),
    model: join(models, GPU_MODEL),
    checkModel: join(models, CHECK_MODEL),
  };
}

/** Why the GPU build is not set up here, or null when every piece is in place (claude-collab `sherpa.js`). */
export function gpuMissing(paths: CudaPaths, machine: GpuMachine): string | null {
  if (machine.platform !== 'win32') {
    return 'the GPU build is set up only on Windows';
  }

  if (!machine.exists(join(machine.systemRoot ?? 'C:\\Windows', 'System32', 'nvcuda.dll'))) {
    return 'no NVIDIA driver (nvcuda.dll)';
  }

  const modules = join(paths.pkg, 'node_modules');

  if (!machine.exists(join(modules, 'sherpa-onnx-node', 'package.json')) || !machine.exists(join(modules, 'sherpa-onnx-win-x64', 'onnxruntime_providers_cuda.dll'))) {
    return `no CUDA build of sherpa-onnx in ${paths.pkg}`;
  }

  const dlls = ['cudart64_12.dll', 'cublas64_12.dll', 'cudnn64_9.dll'].filter((file) => !machine.exists(join(paths.dlls, file)));

  if (dlls.length > 0) {
    return `no ${dlls.join(', ')} in ${paths.dlls}`;
  }

  if (!['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'].every((file) => machine.exists(join(paths.model, file)))) {
    return `no fp32 model in ${paths.model}`;
  }

  if (!machine.exists(paths.checkModel)) {
    return `no speaker model at ${paths.checkModel} to check the GPU with`;
  }

  return null;
}

/**
 * The GPU check's verdict from its output: null when it ran on the GPU, else why not. sherpa-onnx does not fail when CUDA cannot load (a
 * missing DLL, an old driver, a build without the CUDA provider): it prints "Fallback to cpu" and runs on the CPU, which with the fp32 model is slower than the int8 model.
 */
export function gpuCheckVerdict(result: { status: number | null; stdout: string; stderr: string; error?: Error | undefined }): string | null {
  const failed = /Failed to enable CUDA: ?([^\r\n]*)/.exec(result.stderr);

  if (failed !== null) {
    const missing = /depends on "([^"]+)" which is missing/.exec(failed[1]!);

    return missing === null ? `CUDA did not load: ${failed[1]!.trim().slice(0, 300)}` : `CUDA did not load: ${missing[1]} is missing`;
  }

  // A build without the CUDA provider, such as the npm build's DLLs left in place, says to compile with GPU support and runs on the CPU.
  if (/-DSHERPA_ONNX_ENABLE_GPU=ON/.test(result.stderr)) {
    return 'the sherpa-onnx build has no CUDA provider';
  }

  const fallback = /^.*Fallback to cpu.*$/im.exec(result.stderr);

  if (fallback !== null) {
    return `sherpa-onnx fell back to the CPU: ${fallback[0].trim().slice(0, 300)}`;
  }

  if (result.error !== undefined) {
    return `the GPU check did not run: ${result.error.message}`;
  }

  if (result.status !== 0 || !result.stdout.includes('ok')) {
    const why = result.stderr.trim().split(/\r?\n/).at(-1) ?? '';

    return `the GPU check failed (exit ${result.status ?? 'none'})${why === '' ? '' : `: ${why.slice(0, 300)}`}`;
  }

  return null;
}

/** Runs `gpucheck.js` (`gpuCheck.ts`) in a child process with the CUDA runtime on its PATH: null when CUDA works, else why not. */
export function gpuCheck(script: string): (paths: CudaPaths) => string | null {
  return (paths) => {
    if (!existsSync(script)) {
      return `no GPU check script at ${script}`;
    }

    const result = spawnSync(process.execPath, [script, `--pkg=${paths.pkg}`, `--model=${paths.checkModel}`], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
      env: { ...process.env, PATH: `${paths.dlls}${delimiter}${process.env.PATH ?? ''}` },
    });

    return gpuCheckVerdict({ status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error });
  };
}

let gc: (() => void) | null | undefined;

/**
 * Runs a full garbage collection, so native objects dropped since, such as a replaced recogniser, are released by their finalizers on the next
 * turn of the event loop; `--expose-gc` set at run time makes `gc` available to a new context. Does nothing where V8 refuses the flag.
 */
export function collectGarbage(): void {
  if (gc === undefined) {
    try {
      setFlagsFromString('--expose-gc');
      gc = runInNewContext('gc') as () => void;
    } catch {
      gc = null;
    }
  }

  gc?.();
}

/** sherpa-onnx as loaded, the device it runs recognition on, and why not the GPU when not. */
export interface Sherpa {
  device: AsrDevice;
  module: unknown;
  /** The recogniser's model folder for the device. */
  model: string;
  /** Why recognition is not on the GPU, or null. */
  why: string | null;
}

export interface SherpaDeps {
  /** The models folder, `<voice home>/models`. */
  models: string;
  /** The script the bundled sherpa-onnx is resolved from: the voice process's own. */
  requireFrom: string;
  machine?: GpuMachine;
  check(paths: CudaPaths): string | null;
  /** Loads `sherpa-onnx-node` as seen from a file; Node's require outside tests. */
  load?: (from: string) => unknown;
  /** Puts a folder first on the process's PATH. */
  prependPath?: (dir: string) => void;
  log(line: string): void;
}

const realMachine: GpuMachine = { platform: process.platform, systemRoot: process.env.SystemRoot, exists: existsSync };

/**
 * The sherpa-onnx build this process uses, chosen at the first load and kept (claude-collab `sherpa.js`): the CUDA build when it is set up
 * and the GPU check passes, else the npm build on the CPU, with why logged. Recognition and the voice check both use it: the two builds ship
 * DLLs with the same names, and Windows binds a second addon to whichever `onnxruntime.dll` loaded first, so loading the CPU build first would
 * leave recognition on the CPU. A load that fails, with why, is tried again at the next call, so a package put back needs no restart.
 */
export class SherpaRuntime {
  #loaded: Sherpa | null = null;

  constructor(private readonly deps: SherpaDeps) {}

  get(): Sherpa | { error: string } {
    if (this.#loaded !== null) {
      return this.#loaded;
    }

    const load = this.deps.load ?? ((from: string) => createRequire(from)('sherpa-onnx-node'));
    const paths = cudaPaths(this.deps.models);
    let why = gpuMissing(paths, this.deps.machine ?? realMachine) ?? this.deps.check(paths);

    if (why === null) {
      try {
        // onnxruntime loads the CUDA provider and its DLLs when a recogniser is created, searching the PATH, which Node updates in place.
        (this.deps.prependPath ?? ((dir: string) => (process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ''}`)))(paths.dlls);
        this.#loaded = { device: 'gpu', module: load(join(paths.pkg, 'x.js')), model: paths.model, why: null };
        this.deps.log(`Speech recognition runs on the GPU: sherpa-onnx's CUDA build from ${paths.pkg}, the fp32 model.`);
        return this.#loaded;
      } catch (error) {
        why = `the CUDA build did not load: ${(error as Error).message}`;
      }
    }

    try {
      this.#loaded = { device: 'cpu', module: load(this.deps.requireFrom), model: join(this.deps.models, CPU_MODEL), why };
    } catch (error) {
      return { error: `sherpa-onnx did not load: ${(error as Error).message}` };
    }

    this.deps.log(`Speech recognition runs on the CPU, the int8 model: ${why}.`);
    return this.#loaded;
  }
}
