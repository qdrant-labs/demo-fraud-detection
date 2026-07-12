// The public attack launcher. A visitor is assigned a pre-seeded persona (their
// "normal life"), taps one of three attack cards, and watches the generated
// sequence score and flare on the wall. Persona assignment happens server-side
// because world.ts pulls node:crypto for its IDs; the persona rides into the
// client component and is kept until the visitor reloads. Nothing about the
// visitor is persisted (PLAN: no audience identities beyond the assignment).

import { assignPersona } from "@/lib/persona";
import LaunchClient from "./launch-client";

export const dynamic = "force-dynamic";

export default function LaunchPage() {
  const { tenantId, persona } = assignPersona();
  return <LaunchClient tenantId={tenantId} persona={persona} />;
}
