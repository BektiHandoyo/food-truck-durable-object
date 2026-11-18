import { DurableObject } from "cloudflare:workers";
import { initSchema } from "./schema.js";
import { ok, fail } from "../lib/response.js";

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
        this.slotId = ctx.id.name ?? "unknown";
        initSchema(this.sql);
    }

    async initSlots(input) {
        try {
            const slots = Array.isArray(input) ? input : input?.slots;
            if (!Array.isArray(slots) || slots.length === 0) {
                return fail({ message: "Slots array is required" });
            }

            for (const slot of slots) {
                if (!slot?.id || slot?.slot_time === undefined || slot?.slot_time === null || String(slot.slot_time).trim() === "") {
                    return fail({ message: "Each slot must have id and slot_time" });
                }
                if (typeof slot.quota !== "number" || slot.quota <= 0) {
                    return fail({ message: "Quota must be greater than 0" });
                }
            }

            this.storage.transactionSync(() => {
                for (const slot of slots) {
                    this.sql.exec(
                        `INSERT INTO slots (id, slot_time, quota, claimed)
                         VALUES (?, ?, ?, ?)
                         ON CONFLICT(id) DO UPDATE SET
                             slot_time = excluded.slot_time,
                             quota = excluded.quota`,
                        String(slot.id),
                        String(slot.slot_time),
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
            if (!userId || !slotId || !requestId) {
                return fail({ message: "user_id, slot_id, and request_id are required" });
            }

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

                // 5. Insert claim & update counter slot.claimed secara sinkron (tanpa auto-expire alarm)
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

    // method for displaying the current state of all slots
    async getSlots() {
        try {
            const slots = this.sql.exec(`SELECT * FROM slots`).toArray();
            return ok({ slots });
        } catch (error) {
            return fail({ message: "Failed to retrieve slots", error: error.message });
        }
    }

    // method for displaying the current state for spesific claims with supplied claim id input
    async getClaim(claimId) {
        try {
            const claim = this.sql.exec(`SELECT * FROM claims WHERE id = ?`, claimId).toArray()[0];
            if (!claim) {
                return fail({ message: "Claim not found" });
            }
            return ok({ claim });
        } catch (error) {
            return fail({ message: "Failed to retrieve claim", error: error.message });
        }
    }

    // method for redeeming a claim, check if claim exists and status is CLAIMED, then update status to REDEEMED and set redeemed_at to current timestamp, also decrement the claimed count in slots table
    async redeemClaim(claimId) {
        try {
            const claim = this.sql
                .exec(`SELECT * FROM claims WHERE id = ?`, claimId)
                .toArray()[0];

            if (!claim) {
                return fail({ message: "Claim not found" });
            }

            if (claim.status !== "CLAIMED") {
                return fail({ message: `Claim cannot be redeemed (status: ${claim.status})` });
            }

            const redeemedAt = Date.now();

            // Langsung exec tanpa transactionSync dan tanpa .run()
            this.sql.exec(
                `UPDATE claims SET status = 'REDEEMED', redeemed_at = ? WHERE id = ?`,
                redeemedAt,
                claimId
            );

            return ok({
                message: "Claim redeemed successfully",
                claimId,
                status: "REDEEMED",
                redeemedAt,
            });
        } catch (error) {
            return fail({ message: "Failed to redeem claim", error: error.message });
        }
    }

    // method for fetching all of the defined methods above, this is the main entry point for the Durable Object
    async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        switch (method) {
            case "POST":
                if (path === "/init" || path === "/slots/init") {
                    const slots = await request.json();
                    return this.initSlots(slots);
                } else if (path === "/slot/claim" || path === "/claim") {
                    const body = await request.json();
                    const userId = body.user_id ?? body.userId;
                    const slotId = body.slot_id ?? body.slotId;
                    const requestId = body.request_id ?? body.requestId;
                    return this.claimSlot(userId, slotId, requestId);
                } else if (path.startsWith("/claim/redeem/")) {
                    const claimId = path.split("/")[3];
                    return this.redeemClaim(claimId);
                } else {
                    return fail({ message: "Not Found" });
                }
            case "GET":
                if (path === "/") {
                    return ok({ message: "SlotCell Durable Object is running" });
                } else if (path === "/slot" || path === "/slots") {
                    return this.getSlots();
                } else if (path.startsWith("/claim/")) {
                    const claimId = path.split("/")[2];
                    return this.getClaim(claimId);
                } else {
                    return fail({ message: "Not Found" });
                }
            default:
                return fail({ message: "Method Not Allowed" });
        }
    }
}
