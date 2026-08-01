// Virmeet — zod schemas shared by seed-loader.ts (loading public/seed/*.json)
// and persona-io.ts (exporting/importing a persona as a standalone JSON
// file). Same shape in both places by design (spec §3.1, §5.3).

import { z } from 'zod';

export const embeddedFileSchema = z.object({
  name: z.string().min(1),
  text: z.string(),
});
export type EmbeddedFileSeed = z.infer<typeof embeddedFileSchema>;

export const personaSeedSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  organization: z.string().min(1),
  color: z.string().min(1),
  prompt: z.string().min(1),
  webAccess: z.boolean(),
  maxApiCalls: z.number().int().min(1).max(20),
  maxWebSearches: z.number().int().min(0).max(10),
  isActive: z.boolean().optional(),
  // Paths relative to public/seed/ — the mechanism for files added through
  // the GitHub UI. Validated against path traversal at load time.
  files: z.array(z.string().min(1)).optional(),
  // Text embedded directly in the JSON — the mechanism the app itself uses
  // when exporting a persona that has browser-uploaded files.
  embeddedFiles: z.array(embeddedFileSchema).optional(),
});
export type PersonaSeed = z.infer<typeof personaSeedSchema>;

/** Accepts either a single persona or an array — persona-io.ts import supports both. */
export const personaSeedFileSchema = z.union([personaSeedSchema, z.array(personaSeedSchema)]);

export const meetingTypeSeedSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  shortDescription: z.string().min(1),
  prompt: z.string().min(1),
  isBuiltIn: z.boolean().optional(),
});
export type MeetingTypeSeed = z.infer<typeof meetingTypeSeedSchema>;

export const orgSettingsSeedSchema = z.object({
  organizationName: z.string().min(1),
  description: z.string().min(1),
  constraints: z.string().min(1),
});
export type OrgSettingsSeed = z.infer<typeof orgSettingsSeedSchema>;

export const seedManifestSchema = z.object({
  version: z.string(),
  generatedAt: z.string(),
  orgSettings: z.string().nullable(),
  personas: z.array(z.string()),
  meetingTypes: z.array(z.string()),
  sharedFiles: z.array(z.string()),
});
export type SeedManifest = z.infer<typeof seedManifestSchema>;
