// Assigns a pre-seeded persona for the wall's inline launcher drawer.
import { assignPersona } from "@/lib/persona";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(assignPersona());
}
