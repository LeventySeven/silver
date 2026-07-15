#!/usr/bin/env node
/**
 * `uab` CLI entrypoint — STUB (full dispatcher lands in a later task, plan §Task 11).
 *
 * For now this only resolves the `bin` and prints a version envelope so the
 * package is installable and `build` produces a runnable `dist/cli.js`.
 */
import { ok, print } from './core/envelope.js'

const argv = process.argv.slice(2)
const json = argv.includes('--json')

print(ok({ name: 'uab', version: '0.1.0', status: 'scaffold' }), json)
