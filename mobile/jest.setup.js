// Every test builds its own TanStack QueryClient, and each cached query keeps a 5-minute clean-up timer alive.
// Those timers stop Jest from exiting (the CI job then hangs until it is cancelled), so clear every client when a test file ends.
const { QueryClient } = require('@tanstack/react-query');

const clients = new Set();
const original = QueryClient.prototype.defaultQueryOptions;
QueryClient.prototype.defaultQueryOptions = function patched(...args) { clients.add(this); return original.apply(this, args); };

afterAll(() => { clients.forEach((c) => c.clear()); clients.clear(); });

// The phone's storage and connection state are native modules; use their ready-made test doubles.
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('@react-native-community/netinfo', () => require('@react-native-community/netinfo/jest/netinfo-mock.js'));
// files for FormData are Blobs read from disk (expo-file-system); in tests a plain stand-in that keeps the uri so what was sent can be checked
jest.mock('@/lib/uploadPart', () => ({ uploadPart: (uri) => ({ uri, name: 'file', type: 'image/jpeg' }) }));

// Tests wait for screens to settle (waitFor). The default is one second, which a busy machine (or a CI runner running many test files at once) can exceed
// without anything being wrong, so a longer limit stops those random failures. A test that really fails still fails, just a few seconds later.
require('@testing-library/react-native').configure({ asyncUtilTimeout: 6000 });
