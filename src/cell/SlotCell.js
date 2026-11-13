import { DurableObject } from "cloudflare:workers";
import { initSchema } from "./schema.js";
import { ok, fail } from "../lib/response.js";
import { runAlarm } from "./alarm.js";

export default class SlotCell extends DurableObject {
    /**
     * The constructor is invoked once upon creation of the Durable Object, i.e. the first call to
     * 	`DurableObjectStub::get` for a given identifier (no-op constructors can be omitted)
     *
     * @param {DurableObjectState} ctx - The interface for interacting with Durable Object state
     * @param {Env} env - The interface to reference bindings declared in wrangler.jsonc
     */
    constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.storage = ctx.storage;
        this.slotId = ctx.id.name ?? "unknown";
        initSchema(this.sql);
    }

    // method for initializing slots with Insert or ignore if exists
    async initSlots(slots) {
        try {
            for (const slot of slots) {
                if (slot.slot_time <= Date.now()) {
                    return fail({ message: "Slot time must be in the future" });
                }
                if (slot.quota <= 0) {
                    return fail({ message: "Quota must be greater than 0" });
                }
            }

            // 2. Gunakan transactionSync (tanpa tanda kurung () tambahan di akhir)
            this.storage.transactionSync(() => {
                for (const slot of slots) {
                    this.sql.exec(
                        `INSERT OR IGNORE INTO slots (id, slot_time, quota, claimed) VALUES (?, ?, ?, ?)`,
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
            if (!requestId) {
                return fail({ message: "request_id is required" });
            }

            // Bungkus pengecekan & penulisan dalam satu transaksi sinkron agar 100% atomik
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
                            queuePos: existingReq.queue_pos,
                            status: existingReq.status,
                            claimedAt: existingReq.claimed_at,
                            expiresAt: existingReq.expires_at,
                        },
                    };
                }

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

                // 4. Cek apakah user sudah pernah claim dan statusnya masih CLAIMED
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
                const expiresAt = slot.slot_time + 15 * 60 * 1000; // slot_time + 15 menit

                this.sql.exec(
                    `INSERT INTO claims (id, request_id, slot_id, user_id, queue_pos, status, claimed_at, expires_at)
                    VALUES (?, ?, ?, ?, ?, 'CLAIMED', ?, ?)`,
                    claimId,
                    requestId,
                    slotId,
                    userId,
                    queuePos,
                    claimedAt,
                    expiresAt
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
                        queuePos,
                        status: "CLAIMED",
                        claimedAt,
                        expiresAt,
                    },
                };
            });

            if (!result.success) {
                return fail({ message: result.message });
            }

            // 6. Setelah jendela kritis transaksi selesai, jadwalkan alarm untuk auto-expire
            if (result.isNewClaim && typeof this.scheduleNextAlarm === "function") {
                await this.scheduleNextAlarm();
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

    // method for alarm, execute runAlarm method
    async alarm() {
        await runAlarm(this, this.sql, this.slotId);
    }

    // method for fetching all of the defined methods above, this is the main entry point for the Durable Object
    async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        // change the above to switch case for better readability, filter by method first, then use if and else if for path
        switch (method) {
            case "POST":
                if (path === "/init") {
                    const slots = await request.json();
                    return this.initSlots(slots);
                } else if (path === "/slot/claim") {
                    const { userId, slotId, requestId } = await request.json();
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
                } else if (path === "/slot") {
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
