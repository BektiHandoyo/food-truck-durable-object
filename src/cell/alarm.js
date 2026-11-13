export const scheduleNextAlarm = async (ctx, sql) => {
    const minExpiresAt = sql.prepare(`
        SELECT MIN(expires_at) as min_expires_at FROM claims WHERE status = 'CLAIMED' AND expires_at IS NOT NULL
    `).get().min_expires_at;

    if (!minExpiresAt) {
        ctx.storage.deleteAlarm();
        return;
    }

    // if exist, set the alarm to the next soonest expires_at plus Date now with Math.max 
    const nextAlarm = Math.max(minExpiresAt, Date.now());
    await ctx.storage.setAlarm(nextAlarm);
}

export const runAlarm = async (ctx, sql, slotId) => {
    const expiredClaims = sql.prepare(`
        SELECT * FROM claims WHERE status = 'CLAIMED' AND expires_at <= ?
    `).all(Date.now());
    
    if (expiredClaims.length > 0) {
        const updateSlotStmt = sql.prepare(`
            UPDATE slots SET claimed = claimed - 1 WHERE id = ?
        `);
        const updateClaimStmt = sql.prepare(`
            UPDATE claims SET status = 'EXPIRED' WHERE id = ?
        `);

        const transaction = sql.transaction((claims) => {
            for (const claim of claims) {
                updateSlotStmt.run(claim.slot_id);
                updateClaimStmt.run(claim.id);
            }
        });

        transaction(expiredClaims);
    }

    scheduleNextAlarm(ctx, sql);    
}

