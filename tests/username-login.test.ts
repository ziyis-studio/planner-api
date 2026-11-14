import { expect, test, vi } from 'vitest';
import { handleUsernameLogin } from '../supabase/functions/username-login/handler';
import type { LoginDependencies } from '../supabase/functions/username-login/handler';
import { allowedLoginOrigins } from '../supabase/functions/username-login/origins';

test('production login permits only the exact app origin and preserves configured local access', async () => {
  const deps = dependencies();
  deps.allowedOrigins = allowedLoginOrigins(' http://localhost:3000,https://trusted.example, ');
  expect(deps.allowedOrigins).toEqual([
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://planner-core-puce.vercel.app',
    'https://trusted.example',
  ]);
  for (const origin of [
    'https://planner-core-puce.vercel.app',
    'https://another-preview.vercel.app',
    'https://planner-core-puce.vercel.app.untrusted.example',
  ]) {
    const response = await handleUsernameLogin(
      new Request('https://example.invalid', { method: 'OPTIONS', headers: { Origin: origin } }),
      deps,
    );
    const allowed = origin === 'https://planner-core-puce.vercel.app';
    expect(response.status).toBe(allowed ? 204 : 403);
    expect(response.headers.get('access-control-allow-origin')).toBe(allowed ? origin : null);
  }
  expect(deps.authenticate).not.toHaveBeenCalled();
});

function dependencies() {
  return {
    allowedOrigins: ['http://localhost:3000'],
    consumeLimit: vi.fn<LoginDependencies['consumeLimit']>().mockResolvedValue(true),
    findAccount: vi
      .fn<LoginDependencies['findAccount']>()
      .mockResolvedValue({ id: 'owner', email: 'private@example.invalid' }),
    authenticate: vi.fn<LoginDependencies['authenticate']>().mockResolvedValue({
      id: 'owner',
      access_token: 'test-token',
      refresh_token: 'test-refresh',
    }),
  };
}
function request(body: unknown, origin = 'http://localhost:3000') {
  return new Request('https://example.invalid/username-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Forwarded-For': '192.0.2.1' },
    body: JSON.stringify(body),
  });
}
test('username login normalizes the alias, authenticates its owner and returns only the session', async () => {
  const deps = dependencies();
  const response = await handleUsernameLogin(
    request({ username: ' Alice ', password: 'test-password' }),
    deps,
  );
  expect(response.status).toBe(200);
  expect(deps.findAccount).toHaveBeenCalledWith('alice');
  expect(deps.consumeLimit).toHaveBeenCalledWith(
    expect.stringMatching(/^[a-f0-9]{64}$/),
    expect.stringMatching(/^[a-f0-9]{64}$/),
  );
  expect(deps.authenticate).toHaveBeenCalledWith('private@example.invalid', 'test-password');
  expect(await response.json()).toEqual({
    access_token: 'test-token',
    refresh_token: 'test-refresh',
  });
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
});
test('unknown usernames and wrong passwords share one failure and never disclose an email', async () => {
  const unknown = dependencies();
  unknown.findAccount.mockResolvedValue(null);
  unknown.authenticate.mockResolvedValue(null);
  const wrong = dependencies();
  wrong.authenticate.mockResolvedValue(null);
  const a = await handleUsernameLogin(
    request({ username: 'unknown', password: 'test-password' }),
    unknown,
  );
  const b = await handleUsernameLogin(
    request({ username: 'alice', password: 'wrong-password' }),
    wrong,
  );
  expect(a.status).toBe(401);
  expect(b.status).toBe(401);
  expect(await a.text()).toBe(await b.text());
  expect(unknown.authenticate).toHaveBeenCalledOnce();
});
test('a successful password for a different identity never becomes a username session', async () => {
  const deps = dependencies();
  deps.authenticate.mockResolvedValue({
    id: 'different-account',
    access_token: 'test-token',
    refresh_token: 'test-refresh',
  });
  const response = await handleUsernameLogin(
    request({ username: 'alice', password: 'test-password' }),
    deps,
  );
  expect(response.status).toBe(401);
});
test('rate limits run before looking up the account or trying its password', async () => {
  const deps = dependencies();
  deps.consumeLimit.mockResolvedValue(false);
  const response = await handleUsernameLogin(
    request({ username: 'alice', password: 'test-password' }),
    deps,
  );
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('60');
  expect(deps.findAccount).not.toHaveBeenCalled();
  expect(deps.authenticate).not.toHaveBeenCalled();
});
test('provider failures are generic and do not return raw service details', async () => {
  const deps = dependencies();
  deps.findAccount.mockRejectedValue(new Error('private-provider-details'));
  const response = await handleUsernameLogin(
    request({ username: 'alice', password: 'test-password' }),
    deps,
  );
  expect(response.status).toBe(503);
  expect(await response.text()).toBe('{"code":"temporarily_unavailable"}');
});
test('CORS rejects unknown origins and permits a valid preflight without a credential attempt', async () => {
  const deps = dependencies();
  const blocked = await handleUsernameLogin(
    request({ username: 'alice', password: 'test-password' }, 'https://untrusted.example'),
    deps,
  );
  expect(blocked.status).toBe(403);
  expect(blocked.headers.get('access-control-allow-origin')).toBeNull();
  const options = await handleUsernameLogin(
    new Request('https://example.invalid', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:3000' },
    }),
    deps,
  );
  expect(options.status).toBe(204);
  expect(deps.consumeLimit).not.toHaveBeenCalled();
});
test('malformed, oversized and unsupported requests cannot reach the credential service', async () => {
  const deps = dependencies();
  for (const body of [
    null,
    [],
    { username: 'ab', password: 'test' },
    { username: 'alice', password: '' },
    { username: 'alice', password: 'test', email: 'injected@example.invalid' },
  ]) {
    expect((await handleUsernameLogin(request(body), deps)).status).toBe(400);
  }
  expect(
    (await handleUsernameLogin(request({ username: 'alice', password: 'x'.repeat(5000) }), deps))
      .status,
  ).toBe(413);
  expect((await handleUsernameLogin(new Request('https://example.invalid'), deps)).status).toBe(
    405,
  );
  expect(deps.consumeLimit).not.toHaveBeenCalled();
});
