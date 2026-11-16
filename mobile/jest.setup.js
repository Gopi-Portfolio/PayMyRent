// Every test builds its own TanStack QueryClient, and each cached query keeps a 5-minute clean-up timer alive.
// Those timers stop Jest from exiting (the CI job then hangs until it is cancelled), so clear every client when a test file ends.
const { QueryClient } = require('@tanstack/react-query');

const clients = new Set();
const original = QueryClient.prototype.defaultQueryOptions;
QueryClient.prototype.defaultQueryOptions = function patched(...args) { clients.add(this); return original.apply(this, args); };

afterAll(() => { clients.forEach((c) => c.clear()); clients.clear(); });
