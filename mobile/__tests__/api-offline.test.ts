import { ApiError, api } from '@/lib/api';
import i18n from '@/i18n';

jest.mock('@/lib/auth', () => ({ getIdToken: jest.fn(async () => 'tok-123') }));

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });
const reply = (status: number, body: unknown) => ({ ok: status < 300, status, statusText: 'x', text: async () => JSON.stringify(body) }) as Response;

test('no connection: a plain, translated message, not a developer note', async () => {
  global.fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed')) as any;
  const err = await api('/api/v1/me').catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({ status: 0, code: 'OFFLINE', message: 'No internet connection. Please connect and try again.' });
  expect(err.message).not.toMatch(/EXPO_PUBLIC|API is running|mobile\/\.env|localhost|http/i);
});

test('no answer in time: a plain message, and the code the queue recognises', async () => {
  global.fetch = jest.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' })) as any;
  const err = await api('/api/v1/me', { timeoutMs: 10 }).catch((e) => e);
  expect(err).toMatchObject({ status: 0, code: 'TIMEOUT', message: 'The server did not answer. Please try again in a moment.' });
});

test('the message follows the language on screen', async () => {
  await i18n.changeLanguage('hi');
  global.fetch = jest.fn().mockRejectedValue(new TypeError('x')) as any;
  const err = await api('/api/v1/me').catch((e) => e);
  expect(err.message).toBe('इंटरनेट नहीं है। कृपया जुड़कर फिर कोशिश करें।');
  await i18n.changeLanguage('en');
});

test('an idempotency key is sent as a header, so the server does the entry once however often it arrives', async () => {
  const fetchMock = jest.fn().mockResolvedValue(reply(200, { ok: true }));
  global.fetch = fetchMock as any;
  await api('/api/v1/owner/units', { body: { a: 1 }, ownerAccount: 'o1', idempotencyKey: 'abcdef1234567890' });
  const sent = fetchMock.mock.calls[0][1];
  expect(sent.headers['Idempotency-Key']).toBe('abcdef1234567890');
  expect(sent.headers['X-Owner-Account']).toBe('o1');
  expect(sent.headers.Authorization).toBe('Bearer tok-123');
  expect(sent.method).toBe('POST');
});

test('without a key, no key header is sent (everything else behaves as before)', async () => {
  const fetchMock = jest.fn().mockResolvedValue(reply(200, {}));
  global.fetch = fetchMock as any;
  await api('/api/v1/me');
  expect(fetchMock.mock.calls[0][1].headers['Idempotency-Key']).toBeUndefined();
  expect(fetchMock.mock.calls[0][1].method).toBe('GET');
});

test('an answer from the server (even an error) is never mistaken for a lost connection', async () => {
  global.fetch = jest.fn().mockResolvedValue(reply(409, { error: { code: 'UNIT_OCCUPIED', message: 'S-01 is already let' } })) as any;
  const err = await api('/api/v1/owner/tenancies', { body: {} }).catch((e) => e);
  expect(err).toMatchObject({ status: 409, code: 'UNIT_OCCUPIED', message: 'S-01 is already let' });
});
