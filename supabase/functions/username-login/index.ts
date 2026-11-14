import { createClient } from "@supabase/supabase-js";
import { handleUsernameLogin, LoginRateLimitError } from "./handler.ts";
import { allowedLoginOrigins } from "./origins.ts";

function environmentKey(name: string, legacy: string) {
  const values = Deno.env.get(name);
  return values
    ? (JSON.parse(values) as Record<string, string>).default
    : Deno.env.get(legacy);
}
Deno.serve(async (request: Request) => {
  const url = Deno.env.get("SUPABASE_URL");
  const secret = environmentKey(
    "SUPABASE_SECRET_KEYS",
    "SUPABASE_SERVICE_ROLE_KEY",
  );
  const publishable = environmentKey(
    "SUPABASE_PUBLISHABLE_KEYS",
    "SUPABASE_ANON_KEY",
  );
  const allowedOrigins = allowedLoginOrigins(
    Deno.env.get("APP_ALLOWED_ORIGINS"),
  );
  return handleUsernameLogin(request, {
    allowedOrigins,
    async consumeLimit(clientHash, usernameHash) {
      if (!url || !secret || !publishable) {
        throw new Error("Missing server configuration");
      }
      const admin = createClient(url, secret, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          fetch: (input, init) =>
            fetch(input, { ...init, signal: AbortSignal.timeout(12_000) }),
        },
      });
      const { data, error } = await admin.rpc(
        "planner_consume_username_login_limit",
        { p_client_hash: clientHash, p_username_hash: usernameHash },
      );
      if (error) throw new Error("Limiter unavailable");
      return data === true;
    },
    async findAccount(username) {
      const admin = createClient(url!, secret!, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          fetch: (input, init) =>
            fetch(input, { ...init, signal: AbortSignal.timeout(12_000) }),
        },
      });
      const profile = await admin.from("account_profiles").select("user_id").eq(
        "username",
        username,
      ).maybeSingle();
      if (profile.error) throw new Error("Account lookup unavailable");
      if (!profile.data) return null;
      const { data, error } = await admin.auth.admin.getUserById(
        profile.data.user_id,
      );
      if (error?.status === 404) return null;
      if (error) throw new Error("Account lookup unavailable");
      return data.user?.email
        ? { id: data.user.id, email: data.user.email }
        : null;
    },
    async authenticate(email, password) {
      // Never reuse an authenticated SDK client between requests.
      const auth = createClient(url!, publishable!, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          fetch: (input, init) =>
            fetch(input, { ...init, signal: AbortSignal.timeout(12_000) }),
        },
      });
      const { data, error } = await auth.auth.signInWithPassword({
        email,
        password,
      });
      if (error?.status === 429) throw new LoginRateLimitError();
      if (error && (!error.status || error.status >= 500)) {
        throw new Error("Auth unavailable");
      }
      if (error || !data.session || !data.user) return null;
      return {
        id: data.user.id,
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      };
    },
  });
});
