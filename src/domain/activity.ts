import { z } from "zod";
export const activityKind = z.enum(["task", "project"]);
export const activitySchema = z
  .object({
    id: z.uuid(),
    target_kind: activityKind,
    target_id: z.uuid(),
    body: z.string().trim().min(1).max(10000),
    created_at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type ActivityLog = z.infer<typeof activitySchema>;
export const activityWriteSchema = z
  .object({
    id: z.uuid(),
    kind: activityKind,
    targetId: z.uuid(),
    body: z.string().trim().min(1).max(10000),
  })
  .strict();
export const activityQuerySchema = z
  .object({
    kind: activityKind,
    id: z.uuid(),
    beforeAt: z.iso.datetime({ offset: true }).optional(),
    beforeId: z.uuid().optional(),
  })
  .strict()
  .refine(
    (q) => !!q.beforeAt === !!q.beforeId,
    "A complete cursor is required.",
  );
export type ActivityQuery = z.infer<typeof activityQuerySchema>;
