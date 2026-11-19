import { DurableObject } from "cloudflare:workers";
import { initSchema } from "./schema.js";
import { ok, fail } from "../lib/response.js";
import {
    initSlotsSchema,
    claimSlotSchema,
    redeemClaimSchema,
} from "../schemas/slotSchemas.js";

export default class SlotCell extends DurableObject {
    /**
     * @param {DurableObjectState} ctx - The interface for interacting with Durable Object state
     * @param {Env} env - The interface to reference bindings declared in wrangler.jsonc
     */
    constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.storage = ctx.storage;
        this.ctx = ctx;
        this.env = env;
        this.slotId = ctx.id.name ?? "unknown";
        initSchema(this.sql);
    }

    isAuthorized(request) {
        const expectedSecret = this.env?.DO_API_SECRET;
        if (!expectedSecret) {
            return false;
        }

        const headerSecret = request.headers.get("X-API-Secret")?.trim();
        if (headerSecret && headerSecret === expectedSecret) {
            return true;
        }

        const authHeader = request.headers.get("Authorization")?.trim();
        if (authHeader?.startsWith("Bearer ")) {
            const bearerToken = authHeader.slice(7).trim();
            if (bearerToken === expectedSecret) {
                return true;
            }
        }

        return false;
    }

    async parseBody(request, schema) {
        let rawBody;
        try {
            rawBody = await request.json();
        } catch {
            return {
                ok: false,
                response: fail({ message: "Invalid JSON body" }, 400),
            };
        }

        const parsed = schema.safeParse(rawBody);
        if (!parsed.success) {
            return {
                ok: false,
                response: fail(
                    {
                        message: "Invalid request payload",
                        errors: parsed.error.issues.map((issue) => ({
                            path: issue.path.join("."),
                            message: issue.message,
                        })),
                    },
                    400
                ),
            };
        }

        return { ok: true, data: parsed.data };
    }

    async initSlots(slots) {
        try {
            this.storage.transactionSync(() => {
                for (const slot of slots) {
                    this.sql.exec(
                        `INSERT INTO slots (id, slot_time, quota, claimed)
                         VALUES (?, ?, ?, ?)
                         ON CONFLICT(id) DO UPDATE SET
                             slot_time = excluded.slot_time,
                             quota = excluded.quota`,
                        slot.id,
                        slot.slot_time,
                        slot.quota,
                        slot.claimed ?? 0
                    );
                }
            });

            return ok({ message: "Slots initialized successfully" });
        } catch (error) {
            return fail({ message: "Failed to initialize slots", error: error.message });
        }
    }

    async claimSlot(userId, slotId, requestId) {
        try {
            const result = this.storage.transactionSync(() => {
                // 1. Replay check (idempotency)
                const existingReq = this.sql
                    .exec(`SELECT * FROM claims WHERE request_id = ?`, requestId)
                    .toArray()[0];

                if (existingReq) {
                    return {
                        success: true,
                        data: {
                            replayed: true,
                            claimId: existingReq.id,
                            slotId: existingReq.slot_id,
                            queuePos: existingReq.queue_pos,
                            status: existingReq.status,
                            claimedAt: existingReq.claimed_at,
                        },
                    };
                }

                // 2. Cek ketersediaan slot
                const slot = this.sql
                    .exec(`SELECT * FROM slots WHERE id = ?`, slotId)
                    .toArray()[0];

                if (!slot) {
                    return { success: false, message: "Slot not found" };
                }

                // 3. Cek apakah slot sudah penuh
                if (slot.claimed >= slot.quota) {
                    return { success: false, message: "Slot is full" };
                }

                // 4. Cek apakah user sudah memiliki tiket aktif (status = 'CLAIMED') hari ini
                const existingUserClaim = this.sql
                    .exec(
                        `SELECT id FROM claims WHERE user_id = ? AND status = 'CLAIMED'`,
                        userId
                    )
                    .toArray()[0];

                if (existingUserClaim) {
                    return { success: false, message: "User has already claimed a slot" };
                }

                // 5. Insert claim & update counter slot.claimed secara sinkron
                const claimId = crypto.randomUUID();
                const queuePos = slot.claimed + 1;
                const claimedAt = Date.now();

                this.sql.exec(
                    `INSERT INTO claims (id, request_id, slot_id, user_id, queue_pos, status, claimed_at)
                     VALUES (?, ?, ?, ?, ?, 'CLAIMED', ?)`,
                    claimId,
                    requestId,
                    slotId,
                    userId,
                    queuePos,
                    claimedAt
                );

                this.sql.exec(
                    `UPDATE slots SET claimed = claimed + 1 WHERE id = ?`,
                    slotId
                );

                return {
                    success: true,
                    isNewClaim: true,
                    data: {
                        claimId,
                        slotId,
                        queuePos,
                        status: "CLAIMED",
                        claimedAt,
                    },
                };
            });

            if (!result.success) {
                return fail({ message: result.message });
            }

            return ok(result.data);
        } catch (error) {
            return fail({ message: "Failed to claim slot", error: error.message });
        }
    }

    async getSlots() {
        try {
            const rows = this.sql.exec(`SELECT * FROM slots`).toArray();
            const slots = rows.map((slot) => ({
                id: slot.id,
                slot_time: slot.slot_time,
                quota: slot.quota,
                claimed: slot.claimed,
                remaining: Math.max(0, slot.quota - slot.claimed),
            }));
            return ok({ slots });
        } catch (error) {
            return fail({ message: "Failed to retrieve slots", error: error.message });
        }
    }

    async getMyClaim(userId) {
        try {
            if (!userId || !userId.trim()) {
                return fail({ message: "user_id query parameter is required" }, 400);
            }

            const claim = this.sql
                .exec(
                    `SELECT c.id as claimId, c.slot_id as slotId, s.slot_time as slotTime,
                            c.user_id as userId, c.queue_pos as queuePos, c.status,
                            c.claimed_at as claimedAt, c.redeemed_at as redeemedAt
                     FROM claims c
                     LEFT JOIN slots s ON s.id = c.slot_id
                     WHERE c.user_id = ?
                     ORDER BY CASE WHEN c.status = 'CLAIMED' THEN 0 ELSE 1 END, c.claimed_at DESC
                     LIMIT 1`,
                    userId.trim()
                )
                .toArray()[0];

            return ok({ claim: claim ?? null });
        } catch (error) {
            return fail({ message: "Failed to retrieve user claim", error: error.message });
        }
    }

    async getClaim(claimId) {
        try {
            const claim = this.sql.exec(`SELECT * FROM claims WHERE id = ?`, claimId).toArray()[0];
            if (!claim) {
                return fail({ message: "Claim not found" }, 404);
            }
            return ok({ claim });
        } catch (error) {
            return fail({ message: "Failed to retrieve claim", error: error.message });
        }
    }

    async redeemClaim(input) {
        try {
            const payload =
                typeof input === "string" ? { claim_id: input } : input ?? {};
            const { claim_id: claimId, user_id: userId } = payload;

            const result = this.storage.transactionSync(() => {
                let claim;
                if (claimId) {
                    claim = this.sql
                        .exec(`SELECT * FROM claims WHERE id = ?`, claimId)
                        .toArray()[0];
                } else if (userId) {
                    claim = this.sql
                        .exec(
                            `SELECT * FROM claims
                             WHERE user_id = ?
                             ORDER BY CASE
                                 WHEN status = 'CLAIMED' THEN 0
                                 WHEN status = 'REDEEMED' THEN 1
                                 ELSE 2
                             END, claimed_at DESC
                             LIMIT 1`,
                            userId
                        )
                        .toArray()[0];
                }

                if (!claim) {
                    return {
                        success: false,
                        status: 404,
                        reason: { message: "Claim not found" },
                    };
                }

                if (claim.status === "REDEEMED") {
                    return {
                        success: false,
                        status: 409,
                        reason: {
                            message: "Claim has already been redeemed",
                            claimId: claim.id,
                            status: claim.status,
                            redeemedAt: claim.redeemed_at,
                        },
                    };
                }

                if (claim.status === "EXPIRED") {
                    return {
                        success: false,
                        status: 409,
                        reason: {
                            message: "Claim has expired",
                            claimId: claim.id,
                            status: claim.status,
                        },
                    };
                }

                if (claim.status !== "CLAIMED") {
                    return {
                        success: false,
                        status: 400,
                        reason: {
                            message: `Claim cannot be redeemed (status: ${claim.status})`,
                            claimId: claim.id,
                            status: claim.status,
                        },
                    };
                }

                const redeemedAt = Date.now();
                this.sql.exec(
                    `UPDATE claims SET status = 'REDEEMED', redeemed_at = ? WHERE id = ?`,
                    redeemedAt,
                    claim.id
                );

                return {
                    success: true,
                    data: {
                        message: "Claim redeemed successfully",
                        claimId: claim.id,
                        slotId: claim.slot_id,
                        userId: claim.user_id,
                        queuePos: claim.queue_pos,
                        status: "REDEEMED",
                        claimedAt: claim.claimed_at,
                        redeemedAt,
                    },
                };
            });

            if (!result.success) {
                return fail(result.reason, result.status);
            }

            return ok(result.data);
        } catch (error) {
            return fail({ message: "Failed to redeem claim", error: error.message });
        }
    }

    async fetch(request) {
        if (!this.isAuthorized(request)) {
            return fail({ message: "Unauthorized" }, 401);
        }

        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        switch (method) {
            case "POST":
                if (path === "/slots/init" || path === "/init") {
                    const parsed = await this.parseBody(request, initSlotsSchema);
                    if (!parsed.ok) return parsed.response;
                    return this.initSlots(parsed.data);
                } else if (path === "/claim" || path === "/slot/claim") {
                    const parsed = await this.parseBody(request, claimSlotSchema);
                    if (!parsed.ok) return parsed.response;
                    return this.claimSlot(
                        parsed.data.user_id,
                        parsed.data.slot_id,
                        parsed.data.request_id
                    );
                } else if (path === "/redeem") {
                    const parsed = await this.parseBody(request, redeemClaimSchema);
                    if (!parsed.ok) return parsed.response;
                    return this.redeemClaim(parsed.data);
                } else if (path.startsWith("/claim/redeem/")) {
                    const claimId = path.split("/")[3];
                    return this.redeemClaim({ claim_id: claimId });
                } else {
                    return fail({ message: "Not Found" }, 404);
                }
            case "GET":
                if (path === "/") {
                    return ok({ message: "SlotCell Durable Object is running" });
                } else if (path === "/slots" || path === "/slot") {
                    return this.getSlots();
                } else if (path === "/my-claim") {
                    const userId = url.searchParams.get("user_id");
                    return this.getMyClaim(userId);
                } else if (path.startsWith("/claim/")) {
                    const claimId = path.split("/")[2];
                    return this.getClaim(claimId);
                } else {
                    return fail({ message: "Not Found" }, 404);
                }
            default:
                return fail({ message: "Method Not Allowed" }, 405);
        }
    }
}
