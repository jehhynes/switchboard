import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CPU_MODEL, cudaPaths, gpuCheck, gpuCheckVerdict, gpuMissing, SherpaRuntime } from '../src/sherpa.js';
import type { GpuMachine } from '../src/sherpa.js';

const MODELS = join('h', 'voice', 'models');
const PATHS = cudaPaths(MODELS);
/** Every file the GPU build needs, as `gpuMissing` looks for them. */
const ALL = [
  join('C:\\Windows', 'System32', 'nvcuda.dll'),
  join(PATHS.pkg, 'node_modules', 'sherpa-onnx-node', 'package.json'),
  join(PATHS.pkg, 'node_modules', 'sherpa-onnx-win-x64', 'onnxruntime_providers_cuda.dll'),
  ...['cudart64_12.dll', 'cublas64_12.dll', 'cudnn64_9.dll'].map((file) => join(PATHS.dlls, file)),
  ...['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'].map((file) => join(PATHS.model, file)),
  PATHS.checkModel,
];

const machine = (without: string[] = [], platform: NodeJS.Platform = 'win32'): GpuMachine => ({
  platform,
  systemRoot: 'C:\\Windows',
  exists: (path) => ALL.includes(path) && !without.includes(path),
});

describe('gpuMissing', () => {
  it('says which piece of the GPU build is missing, and null when all are there', () => {
    expect(gpuMissing(PATHS, machine())).toBeNull();
    expect(gpuMissing(PATHS, machine([], 'linux'))).toBe('the GPU build is set up only on Windows');
    expect(gpuMissing(PATHS, machine([ALL[0]!]))).toBe('no NVIDIA driver (nvcuda.dll)');
    expect(gpuMissing(PATHS, machine([ALL[2]!]))).toBe(`no CUDA build of sherpa-onnx in ${PATHS.pkg}`);
    expect(gpuMissing(PATHS, machine([ALL[3]!, ALL[5]!]))).toBe(`no cudart64_12.dll, cudnn64_9.dll in ${PATHS.dlls}`);
    expect(gpuMissing(PATHS, machine([join(PATHS.model, 'joiner.onnx')]))).toBe(`no fp32 model in ${PATHS.model}`);
    expect(gpuMissing(PATHS, machine([PATHS.checkModel]))).toBe(`no speaker model at ${PATHS.checkModel} to check the GPU with`);
  });
});

describe('gpuCheckVerdict', () => {
  it('passes only an "ok" with no CUDA failure, and names a missing DLL from sherpa-onnx\'s fallback line', () => {
    expect(gpuCheckVerdict({ status: 0, stdout: 'ok\n', stderr: '' })).toBeNull();
    // sherpa-onnx falls back to the CPU and the check still prints ok: the fallback line decides.
    const fallback =
      'session.cc:AppendCudaProviderV2:200 Failed to enable CUDA: provider_bridge_ort.cc:1988 [ONNXRuntimeError] : 1 : FAIL : Error loading "onnxruntime_providers_cuda.dll" which depends on "cublasLt64_12.dll" which is missing. (Error 126)\r\n. Available providers: CUDAExecutionProvider, CPUExecutionProvider, . Fallback to cpu\r\n';
    expect(gpuCheckVerdict({ status: 0, stdout: 'ok\n', stderr: fallback })).toBe('CUDA did not load: cublasLt64_12.dll is missing');
    expect(gpuCheckVerdict({ status: 0, stdout: 'ok\n', stderr: 'Failed to enable CUDA: CUDA driver version is insufficient\n' })).toBe('CUDA did not load: CUDA driver version is insufficient');
    // The CPU build's DLLs, as sherpa-onnx 2.0.1 prints it, and any other fallback.
    expect(gpuCheckVerdict({ status: 0, stdout: 'ok\n', stderr: 'session.cc:AppendCudaProviderV2 Please compile with -DSHERPA_ONNX_ENABLE_GPU=ON. Available providers: CPUExecutionProvider, . Fallback to cpu!\r\n' })).toBe('the sherpa-onnx build has no CUDA provider');
    expect(gpuCheckVerdict({ status: 0, stdout: 'ok\n', stderr: 'x\nprovider.cc:1 cuda unusable. Fallback to cpu!\r\n' })).toBe('sherpa-onnx fell back to the CPU: provider.cc:1 cuda unusable. Fallback to cpu!');
    expect(gpuCheckVerdict({ status: 1, stdout: '', stderr: 'warm\nCannot find module x\n' })).toBe('the GPU check failed (exit 1): Cannot find module x');
    expect(gpuCheckVerdict({ status: null, stdout: '', stderr: '' })).toBe('the GPU check failed (exit none)');
    expect(gpuCheckVerdict({ status: 0, stdout: 'no embedding\n', stderr: '' })).toBe('the GPU check failed (exit 0)');
    expect(gpuCheckVerdict({ status: null, stdout: '', stderr: '', error: new Error('spawnSync node ETIMEDOUT') })).toBe('the GPU check did not run: spawnSync node ETIMEDOUT');
  });
});

describe('gpuCheck', () => {
  it('runs the check script with the CUDA runtime first on its PATH, and says so when the script is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gpucheck-'));
    const paths = { ...cudaPaths(dir), dlls: join(dir, 'dlls') };

    try {
      writeFileSync(join(dir, 'check.js'), `process.stdout.write(process.env.PATH.split(${JSON.stringify(delimiter)})[0] === ${JSON.stringify(paths.dlls)} && process.argv.includes('--model=' + ${JSON.stringify(paths.checkModel)}) ? 'ok' : 'wrong')`);
      expect(gpuCheck(join(dir, 'check.js'))(paths)).toBeNull();
      expect(process.env.PATH?.startsWith(paths.dlls)).toBe(false);
      expect(gpuCheck(join(dir, 'none.js'))(paths)).toBe(`no GPU check script at ${join(dir, 'none.js')}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SherpaRuntime', () => {
  function setup(options: { machine?: GpuMachine; check?: string | null; fail?: (from: string) => boolean } = {}) {
    const loads: string[] = [];
    const paths: string[] = [];
    const logs: string[] = [];
    const checks: string[] = [];
    const runtime = new SherpaRuntime({
      models: MODELS,
      requireFrom: join('b', 'voice.js'),
      machine: options.machine ?? machine(),
      check: (cuda) => {
        checks.push(cuda.pkg);
        return options.check ?? null;
      },
      load: (from) => {
        loads.push(from);

        if (options.fail?.(from) === true) {
          throw new Error(`Cannot load from ${from}`);
        }

        return { from };
      },
      prependPath: (dir) => paths.push(dir),
      log: (line) => logs.push(line),
    });

    return { runtime, loads, paths, logs, checks };
  }

  it('loads the CUDA build with its runtime on the PATH when the GPU check passes, logs it, and keeps it', () => {
    const { runtime, loads, paths, logs, checks } = setup();

    expect(runtime.get()).toEqual({ device: 'gpu', module: { from: join(PATHS.pkg, 'x.js') }, model: PATHS.model, why: null });
    expect(runtime.get()).toMatchObject({ device: 'gpu' });
    expect([loads.length, checks, paths]).toEqual([1, [PATHS.pkg], [PATHS.dlls]]);
    expect(logs).toEqual([`Speech recognition runs on the GPU: sherpa-onnx's CUDA build from ${PATHS.pkg}, the fp32 model.`]);
  });

  it('runs on the CPU with why logged when the build is missing, without running the check', () => {
    const { runtime, loads, paths, logs, checks } = setup({ machine: machine([ALL[0]!]) });

    expect(runtime.get()).toEqual({ device: 'cpu', module: { from: join('b', 'voice.js') }, model: join(MODELS, CPU_MODEL), why: 'no NVIDIA driver (nvcuda.dll)' });
    expect([loads, checks, paths]).toEqual([[join('b', 'voice.js')], [], []]);
    expect(logs).toEqual(['Speech recognition runs on the CPU, the int8 model: no NVIDIA driver (nvcuda.dll).']);
  });

  it('runs on the CPU when the GPU check fails or the CUDA build does not load', () => {
    const failed = setup({ check: 'CUDA did not load: cublasLt64_12.dll is missing' });

    expect(failed.runtime.get()).toMatchObject({ device: 'cpu', why: 'CUDA did not load: cublasLt64_12.dll is missing' });
    expect(failed.paths).toEqual([]);

    const broken = setup({ fail: (from) => from.startsWith(PATHS.pkg) });

    expect(broken.runtime.get()).toMatchObject({ device: 'cpu', module: { from: join('b', 'voice.js') }, why: `the CUDA build did not load: Cannot load from ${join(PATHS.pkg, 'x.js')}` });
    expect(broken.logs).toEqual([`Speech recognition runs on the CPU, the int8 model: the CUDA build did not load: Cannot load from ${join(PATHS.pkg, 'x.js')}.`]);
  });

  it('says why when no build loads, and tries again at the next call', () => {
    let missing = true;
    const { runtime, logs } = setup({ machine: machine([], 'linux'), fail: () => missing });

    expect(runtime.get()).toEqual({ error: `sherpa-onnx did not load: Cannot load from ${join('b', 'voice.js')}` });
    expect(logs).toEqual([]);
    missing = false;
    expect(runtime.get()).toMatchObject({ device: 'cpu', why: 'the GPU build is set up only on Windows' });
  });
});
