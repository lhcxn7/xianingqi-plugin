// Optional persona profile, stored separately from MEMORY.md and the
// append-only conversation log. The profile is plugin-owned derived state.
// It is NOT always-on: injection still rides recall hits only (no hit,
// no injection — see recall.ts / the dsh shell), and the profile only
// ever rides along with a recall; a no-hit turn injects nothing,
// profile or not.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteText } from "./atomic.ts";
import type { Layer1State } from "./types.ts";

export const PROFILE_FILE = "profile.json";
export type PersonaProfile = NonNullable<Layer1State["profile"]>;

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const out = value.trim().slice(0, 500);
  return out || undefined;
}

/** Read optional profile state; an absent or legacy file is an empty profile. */
export function loadProfile(dataDir: string): PersonaProfile | undefined {
  try {
    const file = join(dataDir, PROFILE_FILE);
    if (!existsSync(file)) return undefined;
    const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const profile: PersonaProfile = {};
    profile.name = cleanString(value.name);
    profile.stage = cleanString(value.stage);
    profile.relationshipStage = cleanString(value.relationshipStage);
    if (typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)) {
      profile.updatedAt = value.updatedAt;
    }
    return Object.values(profile).some((v) => v !== undefined) ? profile : undefined;
  } catch {
    return undefined;
  }
}

/** Persist a sanitized profile atomically. Does not touch MEMORY.md or log.jsonl. */
export function saveProfile(dataDir: string, profile: PersonaProfile): void {
  const clean: PersonaProfile = {};
  clean.name = cleanString(profile.name);
  clean.stage = cleanString(profile.stage);
  clean.relationshipStage = cleanString(profile.relationshipStage);
  if (typeof profile.updatedAt === "number" && Number.isFinite(profile.updatedAt)) {
    clean.updatedAt = profile.updatedAt;
  }
  atomicWriteText(join(dataDir, PROFILE_FILE), JSON.stringify(clean));
}

// 0.4.3: profile.json wins over the layer-1 assembly — not just
// as a sidecar `profile` field, but on the fields themselves:
// profile.name/stage overwrite layer1.name/stage (layer-1 keys
// are the fallback when the profile leaves a field unset), so
// `readLayer1()` / `recall()` / `formatLayer1()` and
// `formatProfileBlock()` all describe the same person.
// relationshipStage has no layer-1 counterpart, it stays inside
// `profile` only; likes/agreements still come from the layer-1
// lists (memory_profile never writes them).
export function mergeProfile(layer1: Layer1State, profile?: PersonaProfile): Layer1State {
  if (!profile) return layer1;
  return {
    ...layer1,
    name: profile.name ?? layer1.name,
    stage: profile.stage ?? layer1.stage,
    profile,
  };
}
