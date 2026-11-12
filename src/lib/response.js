export const ok = (data) => {
    return Response.json({
        ok: true,
        ...data
    });
}

export const fail = (reason, status = 200) => {
    return Response.json({
        ok: false,
        error: reason
    }, {status});
}

