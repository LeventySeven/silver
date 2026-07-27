import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The idle reaper sweeps EVERY namespace, so without a throwaway silver root
    // per file, `npm test` would reap the developer's own parked browsers.
    setupFiles: ['tests/setup-silver-home.ts'],
    // Integration tests launch a real Chromium; give them room.
    testTimeout: 45_000,
    hookTimeout: 45_000,
  },
})
