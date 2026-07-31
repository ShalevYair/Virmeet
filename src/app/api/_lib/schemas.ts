// Virmeet — zod request-body schemas for the API routes (spec §5).

import { z } from 'zod';

/**
 * Every route param that names an entity (meeting/persona/meeting-type/file
 * id) is a `randomUUID()` — validate it before it ever reaches
 * `path.join`/`fs.rm` etc. (B2 in WORKPLAN.md). Not a security boundary on
 * its own (Next.js normalizes the path too), but a one-line guard that turns
 * a malformed id into a clean Hebrew 400 instead of an unexplained 404/500.
 */
export const idSchema = z.string().uuid();

export const personaCreateSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  organization: z.string().min(1),
  color: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().min(1),
  webAccess: z.boolean(),
  maxApiCalls: z.number().int().min(1).max(20),
  maxWebSearches: z.number().int().min(0).max(10),
  isActive: z.boolean().optional(),
});

export const personaUpdateSchema = personaCreateSchema.partial();

export const meetingTypeCreateSchema = z.object({
  title: z.string().min(1),
  shortDescription: z.string().min(1),
  prompt: z.string().min(1),
});

export const meetingTypeUpdateSchema = meetingTypeCreateSchema.partial();

export const orgUpdateSchema = z
  .object({
    organizationName: z.string().min(1),
    description: z.string().min(1),
    constraints: z.string().min(1),
  })
  .partial();

export const meetingCreateSchema = z.object({
  title: z.string().min(1),
  meetingTypeIds: z.array(z.string().min(1)).min(1),
  objective: z.string().min(1),
  participantIds: z.array(z.string().min(1)).min(2),
  discussionRounds: z.number().int().min(1).max(4).optional(),
});

// PATCH on a meeting is intentionally restricted to pre-run editable fields
// plus a cancel transition — `.strict()` rejects attempts to smuggle in
// transcript/result/usage/status:'completed' etc. through the client.
export const meetingUpdateSchema = z
  .object({
    title: z.string().min(1),
    objective: z.string().min(1),
    meetingTypeIds: z.array(z.string().min(1)).min(1),
    participantIds: z.array(z.string().min(1)).min(2),
    discussionRounds: z.number().int().min(1).max(4),
    status: z.enum(['draft', 'cancelled']),
  })
  .partial()
  .strict();
