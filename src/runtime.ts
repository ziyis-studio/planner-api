import { createApi } from "./app.js";
import { supabaseRepository } from "./repository.js";
export function runtimeApi() {
  const {
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY,
    API_ALLOWED_ORIGINS = "",
  } = process.env;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY)
    throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required.");
  return createApi(
    supabaseRepository(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY),
    API_ALLOWED_ORIGINS.split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    async (input) => {
      const response = await fetch(
        new URL("/functions/v1/username-login", SUPABASE_URL),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(15000),
          redirect: "error",
        },
      );
      return { status: response.status, data: await response.json() };
    },
  );
}
