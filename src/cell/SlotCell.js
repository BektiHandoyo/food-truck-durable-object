import { DurableObject } from "cloudflare:workers";
import { initSchema } from "./schema.js";
import { ok, fail } from "../lib/response.js";
import {runAlarm} from "./alarm.js";

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
        this.slotId = ctx.id.name ?? "unknown";
        initSchema(this.sql);
    }

	// method for initializing slots with Insert or ignore if exists
    async initSlots(slots) {
        try {
            const insertStmt = this.sql.prepare(`
                INSERT OR IGNORE INTO slots (id, slot_time, quota, claimed)
                VALUES (?, ?, ?, ?)
            `);
            this.sql.transaction(() => {
                for (const slot of slots) {
                    insertStmt.run(slot.id, slot.slot_time, slot.quota, slot.claimed ?? 0);
                }
            })();
            return ok({ message: "Slots initialized successfully" });
        } catch (error) {
            return fail({ message: "Failed to initialize slots", error: error.message });
        }
    }

    // metthod for claiming a slot with replay checking, user claim check dimana user hanya claim 1, dan cek bahwa slot beneran ada dan tidak full, expirest at adalah jam pengambilan (slot_time) ditambah 15 menit, insert claim dan update slot.claimed nya sinkron, nah baru setelah jendela kritis, scheduleNextAlarm, return claim id, queue pos, status, claimed_at, expires_at
    
    async claimSlot(userId, slotId) {
        try {
            const slot = this.sql.prepare(`SELECT * FROM slots WHERE id = ?`).get(slotId);
            if (!slot) {
                return fail({ message: "Slot not found" });
            }
            if (slot.claimed >= slot.quota) {
                return fail({ message: "Slot is full" });
            }
            const existingClaim = this.sql.prepare(`SELECT * FROM claims WHERE user_id = ? AND status = 'CLAIMED'`).get(userId);
            if (existingClaim) {
                return fail({ message: "User has already claimed a slot" });
            }
            const claimId = crypto.randomUUID();
            const queuePos = slot.claimed + 1;
            const claimedAt = Date.now();
            const expiresAt = slot.slot_time + 15 * 60 * 1000; // 15 minutes after slot_time
            this.sql.transaction(() => {
                this.sql.prepare(`
                    INSERT INTO claims (id, request_id, user_id, queue_pos, status, claimed_at, expires_at)
                    VALUES (?, ?, ?, ?, 'CLAIMED', ?, ?)
                `).run(claimId, claimId, userId, queuePos, claimedAt, expiresAt);
                this.sql.prepare(`
                    UPDATE slots SET claimed = claimed + 1 WHERE id = ?
                `).run(slotId);
            })();
            return ok({ claimId, queuePos, status: 'CLAIMED', claimedAt, expiresAt });
        } catch (error) {
            return fail({ message: "Failed to claim slot", error: error.message });
        }
    }
    
    // method for displaying the current state of all slots
    async getSlots() {
        try {
            const slots = this.sql.prepare(`SELECT * FROM slots`).all();
            return ok({ slots });
        } catch (error) {
            return fail({ message: "Failed to retrieve slots", error: error.message });
        }
    }  

    // method for displaying the current state for spesific claims with supplied claim id input
    async getClaim(claimId) {
        try {
            const claim = this.sql.prepare(`SELECT * FROM claims WHERE id = ?`).get(claimId);
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
            const claim = this.sql.prepare(`SELECT * FROM claims WHERE id = ?`).get(claimId);
            if (!claim) {
                return fail({ message: "Claim not found" });
            }
            if (claim.status !== 'CLAIMED') {
                return fail({ message: "Claim is not in CLAIMED status" });
            }
            const redeemedAt = Date.now();
            this.sql.transaction(() => {
                this.sql.prepare(`
                    UPDATE claims SET status = 'REDEEMED', redeemed_at = ? WHERE id = ?
                `).run(redeemedAt, claimId);
                this.sql.prepare(`
                    UPDATE slots SET claimed = claimed - 1 WHERE id = ?
                `).run(claim.slot_id);
            })();
            return ok({ message: "Claim redeemed successfully", redeemedAt });
        } catch (error) {
            return fail({ message: "Failed to redeem claim", error: error.message });
        }
    }  
    
    // method for alarm, execute runAlarm method
    async alarm(){
        runAlarm(this, this.sql, this.slotId);
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
                    const { userId, slotId } = await request.json();
                    return this.claimSlot(userId, slotId);
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
