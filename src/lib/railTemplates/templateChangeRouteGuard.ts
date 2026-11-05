import {
  classifyInternalUser,
  resolveDealStepStructureCapability,
  userCanAccessDeal,
} from "@/lib/api/v1/access";
import { dealNotVisible } from "@/lib/api/v1/dealNotVisible";
import { jsonError, requireApiUser } from "@/lib/api/v1/http";
import { requireFlag } from "@/lib/api/v1/requireFlag";
import { loadDealByIdOrCode } from "@/lib/dataroom/steps";

export async function requireTemplateChangeReader(dealIdOrCode: string) {
  const gate = await requireFlag("template_change_review");
  if (gate) return { ok: false as const, response: gate };

  const auth = await requireApiUser();
  if (!auth.ok) return { ok: false as const, response: auth.response };

  const deal = await loadDealByIdOrCode(auth.admin, dealIdOrCode);
  if (!deal) return { ok: false as const, response: jsonError("Deal not found", 404) };

  // Access before the wall (D65): an unseated caller, internal or external,
  // gets the missing-deal answer. Only a seated external caller reaches the
  // wall's "Not found", and they already know the deal exists.
  const allowed = await userCanAccessDeal(auth.admin, auth.user.id, deal.id);
  if (!allowed) return { ok: false as const, response: dealNotVisible() };

  const wall = await classifyInternalUser(auth.admin, auth.user.id);
  if (wall === "error") {
    return { ok: false as const, response: jsonError("Profile lookup failed", 500) };
  }
  if (wall !== "internal") return { ok: false as const, response: jsonError("Not found", 404) };

  return { ok: true as const, auth, deal };
}

export async function requireTemplateChangeDecider(dealIdOrCode: string) {
  const reader = await requireTemplateChangeReader(dealIdOrCode);
  if (!reader.ok) return reader;

  const capable = await resolveDealStepStructureCapability(reader.auth.admin, reader.auth.user.id);
  if (capable === "unreadable") {
    return { ok: false as const, response: jsonError("Permission lookup failed", 500) };
  }
  if (!capable) {
    return { ok: false as const, response: jsonError("You cannot change this project rail", 403) };
  }

  return reader;
}
