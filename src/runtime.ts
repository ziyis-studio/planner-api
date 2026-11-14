import { createApi } from "./app";
import { supabaseRepository } from "./repository";
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
  );
}
