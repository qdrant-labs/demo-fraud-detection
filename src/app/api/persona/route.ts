// Assigns a pre-seeded persona for the wall's inline launcher drawer. Shares
// assignPersona() with the /launch server component so the two cannot drift.
import { assignPersona } from "@/lib/persona";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(assignPersona());
}
