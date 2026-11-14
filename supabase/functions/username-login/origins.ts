// Exact app origins only. A Vercel preview is not automatically trusted.
export function allowedLoginOrigins(configured = ""): string[] {
  return [
    ...new Set([
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "https://planner-core-puce.vercel.app",
      ...configured.split(",").map((origin) => origin.trim()).filter(Boolean),
    ]),
  ];
}
