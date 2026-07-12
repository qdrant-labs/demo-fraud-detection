// Assign a random pre-seeded persona for the wall's launch drawer, served by
// GET /api/persona.
//
// Lives outside world.ts on purpose: visitor assignment is meant to be random,
// and world.ts guarantees "no Math.random()" so the synthetic world stays a
// pure function of its seed.
import {
  makeProfile,
  personaSummary,
  TENANT_COUNT,
  type PersonaSummary,
} from "./world";

export function assignPersona(): { tenantId: string; persona: PersonaSummary } {
  const profile = makeProfile(Math.floor(Math.random() * TENANT_COUNT));
  return { tenantId: profile.id, persona: personaSummary(profile) };
}
