#!/usr/bin/env node
import { main } from './cli';
import type { MinimalFetch } from '../index';

main(process.argv.slice(2), {
  env: process.env,
  fetchImpl: globalThis.fetch as unknown as MinimalFetch,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (text) => process.stderr.write(text),
  nowMs: () => BigInt(Date.now()),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}).then((code) => {
  process.exitCode = code;
});
