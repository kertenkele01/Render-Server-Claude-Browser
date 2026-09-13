'use strict';

// Express 4 does not forward rejected promises to error middleware. Apply the
// same boundary to every route, including routes added in the future.
function protectAsyncRoutes(app) {
    const wrap = handler => {
        if (Array.isArray(handler)) return handler.map(wrap);
        if (typeof handler !== 'function' || handler.length === 4) return handler;
        return function (req, res, next) {
            try { Promise.resolve(handler(req, res, next)).catch(next); }
            catch (error) { next(error); }
        };
    };
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']) {
        const register = app[method];
        app[method] = function (route, ...handlers) {
            // app.get(setting) is also Express's settings getter.
            return register.call(this, route, ...handlers.map(wrap));
        };
    }
}

function errorResponse(error, req, res, next) {
    if (res.headersSent) return next(error);
    const status = error.status === 413 ? 413 : error.status === 400 ? 400 : 500;
    // Parser errors may contain the complete request body, including passwords.
    // Never pass error.message, error.stack or the body to the log/response.
    console.warn(`[HTTP] Request failed (${status})`);
    res.status(status).json({
        error: status === 500 ? 'server_error' : 'invalid_request',
        message: status === 500 ? 'İstek tamamlanamadı. Daha sonra tekrar deneyin.' : 'İstek biçimi veya boyutu geçersiz.'
    });
}

module.exports = { protectAsyncRoutes, errorResponse };
