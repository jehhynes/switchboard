import { build } from 'esbuild';
import { bundle, writeCopied } from './build.mjs';

writeCopied();
await build(bundle);
