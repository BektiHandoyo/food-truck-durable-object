export const ok = (data) => {
    return Response.json({
        ok: true,
        ...data
    });
}

export const fail = (reason, status = 400) => {
    return Response.json({
        ok: false,
        ...reason
    }, {status});
}

