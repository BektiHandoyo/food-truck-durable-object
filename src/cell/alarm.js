export const scheduleNextAlarm = async (ctx, sql) => {
    const minExpiresAt = sql.exec(`
        SELECT MIN(expires_at) as min_expires_at FROM claims WHERE status = 'CLAIMED' AND expires_at IS NOT NULL
    `).toArray();

    if (!minExpiresAt) {
        await ctx.storage.deleteAlarm();
        return;
    }

    // if exist, set the alarm to the next soonest expires_at plus Date now with Math.max 
    const nextAlarm = Math.max(minExpiresAt, Date.now());
    await ctx.storage.setAlarm(nextAlarm);
}

export const runAlarm = async (ctx, sql, slotId) => {
    const expiredClaims = sql.exec(`
        SELECT * FROM claims WHERE status = 'CLAIMED' AND expires_at <= ?
    `, Date.now()).toArray();
    
    if (expiredClaims.length > 0) {
        ctx.storage.transactionSync(() => {
            for (const claim of expiredClaims) {
                sql.exec(`UPDATE claims SET status = 'EXPIRED' WHERE id = ?`, claim.id);
                sql.exec(`UPDATE slots SET claimed = claimed - 1 WHERE id = ?`, claim.slot_id);
            }
        });
    }

    await scheduleNextAlarm(ctx, sql);    
}

