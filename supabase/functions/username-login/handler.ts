export interface LoginDependencies {
  allowedOrigins: readonly string[];
  consumeLimit(clientHash: string, usernameHash: string): Promise<boolean>;
  findAccount(username: string): Promise<{ id: string; email: string } | null>;
  authenticate(
    email: string,
    password: string,
  ): Promise<
    { id: string; access_token: string; refresh_token: string } | null
  >;
}
export class LoginRateLimitError extends Error {}

async function hash(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
async function readBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 4096) {
      await reader.cancel();
      throw new RangeError("Body too large");
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export async function handleUsernameLogin(
  request: Request,
  deps: LoginDependencies,
): Promise<Response> {
  const origin = request.headers.get("origin");
  const allowed = !origin || deps.allowedOrigins.includes(origin);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Vary: "Origin",
    "Access-Control-Allow-Headers":
      "apikey, content-type, authorization, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (allowed && origin) headers["Access-Control-Allow-Origin"] = origin;
  const reply = (status: number, code: string) =>
    new Response(JSON.stringify({ code }), { status, headers });
  if (!allowed) return reply(403, "origin_not_allowed");
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "POST") return reply(405, "method_not_allowed");
  if (
    !request.headers.get("content-type")?.toLowerCase().startsWith(
      "application/json",
    )
  ) return reply(415, "invalid_request");
  let input: unknown;
  try {
    input = await readBody(request);
  } catch (error) {
    return reply(error instanceof RangeError ? 413 : 400, "invalid_request");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return reply(400, "invalid_request");
  }
  const data = input as Record<string, unknown>;
  if (
    Object.keys(data).some((key) => !["username", "password"].includes(key)) ||
    typeof data.username !== "string" || typeof data.password !== "string"
  ) return reply(400, "invalid_request");
  const username = data.username.trim().toLowerCase();
  if (
    !/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username) || !data.password.length ||
    data.password.length > 1024
  ) return reply(400, "invalid_request");
  try {
    // Network headers are supplemental: independent global and username limits always apply.
    const network = (request.headers.get("x-forwarded-for") ||
      request.headers.get("x-real-ip") || "unknown").slice(0, 256);
    if (!(await deps.consumeLimit(await hash(network), await hash(username)))) {
      throw new LoginRateLimitError();
    }
    const account = await deps.findAccount(username);
    // Unknown usernames still go through Auth. Neither lookup emails nor account-existence
    // details are returned to the caller, including when credentials are wrong.
    const verified = await deps.authenticate(
      account?.email || "unassigned-username@example.invalid",
      data.password,
    );
    if (!account || !verified || account.id !== verified.id) {
      return reply(401, "invalid_credentials");
    }
    return new Response(
      JSON.stringify({
        access_token: verified.access_token,
        refresh_token: verified.refresh_token,
      }),
      { status: 200, headers },
    );
  } catch (error) {
    if (error instanceof LoginRateLimitError) {
      headers["Retry-After"] = "60";
      return reply(429, "rate_limited");
    }
    // Do not log request bodies, credentials, tokens or raw provider responses.
    return reply(503, "temporarily_unavailable");
  }
}
