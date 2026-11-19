import { z } from "zod";

export const slotItemSchema = z.object({
    id: z.string().trim().min(1, "slot.id is required"),
    slot_time: z
        .union([z.string().trim().min(1), z.number()])
        .transform((val) => String(val)),
    quota: z.number().int().positive("quota must be greater than 0"),
    claimed: z.number().int().min(0).optional(),
});

export const initSlotsSchema = z
    .union([
        z.array(slotItemSchema).min(1, "At least one slot is required"),
        z.object({
            slots: z.array(slotItemSchema).min(1, "At least one slot is required"),
        }),
    ])
    .transform((val) => (Array.isArray(val) ? val : val.slots));

export const claimSlotSchema = z.object({
    user_id: z.string().trim().min(1, "user_id is required"),
    slot_id: z.string().trim().min(1, "slot_id is required"),
    request_id: z.string().trim().min(1, "request_id is required"),
});

export const redeemClaimSchema = z
    .object({
        claim_id: z.string().trim().min(1, "claim_id cannot be empty").optional(),
        user_id: z.string().trim().min(1, "user_id cannot be empty").optional(),
    })
    .refine((data) => Boolean(data.claim_id || data.user_id), {
        message: "Either claim_id or user_id is required",
    });

export const closeSessionSchema = z.object({
    slot_ids: z
        .array(z.string().trim().min(1, "slot_id cannot be empty"))
        .min(1, "slot_ids cannot be empty")
        .optional(),
    food_truck_id: z.string().trim().min(1, "food_truck_id cannot be empty").optional(),
});


