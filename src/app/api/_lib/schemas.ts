// Virmeet — zod request-body schemas for the API routes (spec §5).

import { z } from 'zod';

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
    maxMeetingApiCalls: z.number().int().min(1).max(500),
    maxMeetingTokens: z.number().int().min(1000).max(20_000_000),
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
export const askFollowUpSchema = z.object({
  personaId: z.string().min(1),
  question: z.string().min(1),
});

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
