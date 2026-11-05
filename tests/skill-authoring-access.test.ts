import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/dataroom/steps", () => ({
  loadDealByIdOrCode: vi.fn(),
}));

vi.mock("@/lib/api/v1/access", () => ({
  classifyInternalUser: vi.fn(),
  userCanAccessDeal: vi.fn(),
}));

vi.mock("@/lib/api/v1/companyAccess", () => ({
  hasCompanyPermissionChecked: vi.fn(),
}));

import { classifyInternalUser, userCanAccessDeal } from "@/lib/api/v1/access";
import { hasCompanyPermissionChecked } from "@/lib/api/v1/companyAccess";
import { loadDealByIdOrCode } from "@/lib/dataroom/steps";
import { requireSkillAuthoringAccess } from "@/lib/skillAuthoring/access";

const userId = "22222222-2222-4222-8222-222222222222";

type DealBankResponse = { data: { bank_id: string } | null; error: unknown };

function adminWithBank(
  response: DealBankResponse = { data: { bank_id: "bank-1" }, error: null },
) {
  const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn().mockResolvedValue(response),
  };
  return {
    from: vi.fn(() => builder),
    rpc,
  } as unknown as SupabaseClient & { rpc: typeof rpc };
}

function allowAll() {
  vi.mocked(loadDealByIdOrCode).mockResolvedValue({
    id: "deal-1",
    code: "PITCH-2026-001",
  });
  vi.mocked(userCanAccessDeal).mockResolvedValue(true);
  vi.mocked(classifyInternalUser).mockResolvedValue("internal");
  vi.mocked(hasCompanyPermissionChecked).mockResolvedValue(true);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("requireSkillAuthoringAccess", () => {
  it("returns 404 when the deal reference cannot be resolved", async () => {
    vi.mocked(loadDealByIdOrCode).mockResolvedValue(null);

    await expect(
      requireSkillAuthoringAccess(
        adminWithBank(),
        userId,
        "missing",
        "11111111-1111-4111-8111-111111111111",
      ),
    ).resolves.toEqual({ ok: false, status: 404, message: "Deal not found." });
  });

  it("returns 404 when resolving the deal throws", async () => {
    vi.mocked(loadDealByIdOrCode).mockRejectedValue(new Error("read failed"));

    await expect(
      requireSkillAuthoringAccess(
        adminWithBank(),
        userId,
        "PITCH-2026-001",
        "11111111-1111-4111-8111-111111111111",
      ),
    ).resolves.toEqual({ ok: false, status: 404, message: "Deal not found." });
  });

  // A caller with no seat and no oversight gets the missing-deal answer, so the
  // route never confirms the deal exists (decision-log D65). The refusal is
  // still audited, and `hidden` tells the publication guard to audit it too.
  it("returns the missing-deal 404 for a user without a deal membership", async () => {
    allowAll();
    vi.mocked(userCanAccessDeal).mockResolvedValue(false);

    await expect(
      requireSkillAuthoringAccess(
        adminWithBank(),
        userId,
        "PITCH-2026-001",
        "11111111-1111-4111-8111-111111111111",
      ),
    ).resolves.toEqual({
      ok: false,
      status: 404,
      message: "Deal not found.",
      hidden: true,
    });
  });

  it("writes the denial audit through the RPC before the hidden 404 for missing deal membership", async () => {
    allowAll();
    vi.mocked(userCanAccessDeal).mockResolvedValue(false);
    const correlationId = "11111111-1111-4111-8111-111111111111";
    const admin = adminWithBank();

    await expect(
      requireSkillAuthoringAccess(admin, userId, "PITCH-2026-001", correlationId),
    ).resolves.toEqual({
      ok: false,
      status: 404,
      message: "Deal not found.",
      hidden: true,
    });
    expect(admin.rpc).toHaveBeenCalledWith("skill_authoring_write_audit", {
      p_actor_id: userId,
      p_action: "skill_authoring.access_denied",
      p_deal_id: "deal-1",
      p_detail: { actorId: userId, correlationId },
    });
  });

  it.each([
    [
      "external membership",
      () => vi.mocked(classifyInternalUser).mockResolvedValue("external"),
    ],
    [
      "missing structure permission",
      () => vi.mocked(hasCompanyPermissionChecked).mockResolvedValue(false),
    ],
  ])(
    "writes the denial audit through the RPC before the browser 403 for %s",
    async (_name, deny) => {
      allowAll();
      deny();
      const correlationId = "11111111-1111-4111-8111-111111111111";
      const admin = adminWithBank();

      await expect(
        requireSkillAuthoringAccess(
          admin,
          userId,
          "PITCH-2026-001",
          correlationId,
        ),
      ).resolves.toEqual({ ok: false, status: 403, message: "Not permitted." });
      expect(admin.rpc).toHaveBeenCalledWith("skill_authoring_write_audit", {
        p_actor_id: userId,
        p_action: "skill_authoring.access_denied",
        p_deal_id: "deal-1",
        p_detail: { actorId: userId, correlationId },
      });
    },
  );

  it("denies without throwing when the denial audit RPC fails", async () => {
    allowAll();
    vi.mocked(userCanAccessDeal).mockResolvedValue(false);
    const admin = adminWithBank();
    admin.rpc = vi.fn().mockRejectedValue(new Error("unavailable"));

    await expect(
      requireSkillAuthoringAccess(
        admin,
        userId,
        "PITCH-2026-001",
        "11111111-1111-4111-8111-111111111111",
      ),
    ).resolves.toEqual({
      ok: false,
      status: 404,
      message: "Deal not found.",
      hidden: true,
    });
  });

  it("returns 403 for an external member", async () => {
    allowAll();
    vi.mocked(classifyInternalUser).mockResolvedValue("external");

    await expect(
      requireSkillAuthoringAccess(
        adminWithBank(),
        userId,
        "PITCH-2026-001",
        "11111111-1111-4111-8111-111111111111",
      ),
    ).resolves.toEqual({ ok: false, status: 403, message: "Not permitted." });
  });

  it("returns 403 without an audit row when the internal-profile check is unreadable", async () => {
    allowAll();
    vi.mocked(classifyInternalUser).mockResolvedValue("error");
    const admin = adminWithBank();

    await expect(
      requireSkillAuthoringAccess(
        admin,
        userId,
        "PITCH-2026-001",
        "11111111-1111-4111-8111-111111111111",
      ),
    ).resolves.toEqual({ ok: false, status: 403, message: "Not permitted." });
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("returns 403 when the structure permission is absent", async () => {
    allowAll();
    vi.mocked(hasCompanyPermissionChecked).mockResolvedValue(false);

    await expect(
      requireSkillAuthoringAccess(
        adminWithBank(),
        userId,
        "PITCH-2026-001",
        "11111111-1111-4111-8111-111111111111",
      ),
    ).resolves.toEqual({ ok: false, status: 403, message: "Not permitted." });
  });

  it("returns 403 without an audit row when the deal bank cannot be read", async () => {
    allowAll();
    const admin = adminWithBank({
      data: null,
      error: { message: "read failed" },
    });

    await expect(
      requireSkillAuthoringAccess(
        admin,
        userId,
        "PITCH-2026-001",
        "11111111-1111-4111-8111-111111111111",
      ),
    ).resolves.toEqual({ ok: false, status: 403, message: "Not permitted." });
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("returns 403 without an audit row when the structure permission is unreadable", async () => {
    allowAll();
    vi.mocked(hasCompanyPermissionChecked).mockResolvedValue("unreadable");
    const admin = adminWithBank();

    await expect(
      requireSkillAuthoringAccess(
        admin,
        userId,
        "PITCH-2026-001",
        "11111111-1111-4111-8111-111111111111",
      ),
    ).resolves.toEqual({ ok: false, status: 403, message: "Not permitted." });
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("returns 403 without an audit row when a checked access dependency throws", async () => {
    allowAll();
    vi.mocked(userCanAccessDeal).mockRejectedValue(new Error("read failed"));
    const admin = adminWithBank();

    await expect(
      requireSkillAuthoringAccess(
        admin,
        userId,
        "PITCH-2026-001",
        "11111111-1111-4111-8111-111111111111",
      ),
    ).resolves.toEqual({ ok: false, status: 403, message: "Not permitted." });
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("returns the server-resolved deal and actor when access is authorized", async () => {
    allowAll();

    await expect(
      requireSkillAuthoringAccess(
        adminWithBank({ data: { bank_id: "bank-7" }, error: null }),
        userId,
        "PITCH-2026-001",
        "11111111-1111-4111-8111-111111111111",
      ),
    ).resolves.toEqual({
      ok: true,
      deal: { id: "deal-1", bankId: "bank-7" },
      userId,
    });
  });
});
