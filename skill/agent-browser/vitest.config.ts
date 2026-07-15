import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration tests launch a real Chromium; give them room.
    testTimeout: 45_000,
    hookTimeout: 45_000,
  },
})
