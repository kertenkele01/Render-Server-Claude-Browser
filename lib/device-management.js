'use strict';
const {createPublicKey, verify} = require('crypto');
function validPublicKey(value) {
    try {
        if (typeof value !== 'string' || value.length > 256) return false;
        const key = createPublicKey({key:Buffer.from(value, 'base64'), format:'der', type:'spki'});
        return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
    } catch (_) { return false; }
}
function validSignature(publicKey, payload, signature) {
    try {
        return validPublicKey(publicKey) && typeof payload === 'string' && payload.length <= 8192 &&
            typeof signature === 'string' && signature.length <= 128 &&
            verify('sha256', Buffer.from(payload), {key:Buffer.from(publicKey, 'base64'), format:'der', type:'spki'}, Buffer.from(signature, 'base64'));
    } catch (_) { return false; }
}
function permissions(device) {
    let p;
    try { p = JSON.parse(device?.backupPolicy?.payload || '{}'); } catch (_) { p = {}; }
    return {canReadTokens:p.canReadTokens !== false, canRenewTokens:p.canRenewTokens === true,
        canBecomeMain:p.canBecomeMain !== false};
}
function parsePolicy(envelope) {
    try {
        const p = JSON.parse(envelope.payload);
        if (p.version !== 1 || !Number.isSafeInteger(p.revision) || p.revision < 1 ||
            !['accountId','mainDeviceId','targetDeviceId','mainPublicKey','targetPublicKey'].every(k => typeof p[k] === 'string' && p[k].length <= 256) ||
            !p.accountId || !p.mainDeviceId || !p.targetDeviceId || p.mainDeviceId === p.targetDeviceId ||
            !['canReadTokens','canRenewTokens','canBecomeMain'].every(k => typeof p[k] === 'boolean') ||
            (p.canRenewTokens && !p.canReadTokens) ||
            !validSignature(p.mainPublicKey, envelope.payload, envelope.signature) ||
            (p.canRenewTokens && !validPublicKey(p.targetPublicKey))) return null;
        return p;
    } catch (_) { return null; }
}
function parseRotation(envelope) {
    try {
        const r = JSON.parse(envelope.payload), pkg = envelope.credentialPackage;
        if (Object.keys(envelope).some(k=>!['payload','signature','accountProof','credentialPackage'].includes(k)) ||
            Object.keys(r).some(k=>!['version','accountId','clientId','requesterId','originDeviceId','publicKey','nonce','previousHash','secretHash',
                'authority','policy','previousRevision','revision','cookieKeyRevision'].includes(k)) ||
            !pkg || Object.keys(pkg).some(k=>!['iv','ciphertext'].includes(k))) return null;
        if (r.version !== 2 || !['accountId','clientId','requesterId','originDeviceId','publicKey','nonce','previousHash','secretHash','authority'].every(k=>typeof r[k]==='string') ||
            !/^[A-Za-z0-9_-]{16,80}$/.test(r.nonce) || !/^[a-f0-9]{64}$/.test(r.previousHash) ||
            !/^[a-f0-9]{64}$/.test(r.secretHash) || r.secretHash===r.previousHash ||
            !Number.isSafeInteger(r.previousRevision) || r.previousRevision<0 || r.revision!==r.previousRevision+1 || !Number.isSafeInteger(r.revision) ||
            !Number.isSafeInteger(r.cookieKeyRevision) || r.cookieKeyRevision<0 ||
            !['main','origin','backup'].includes(r.authority) || !validSignature(r.publicKey,envelope.payload,envelope.signature) ||
            !/^[A-Za-z0-9+/]{43}=$/.test(envelope.accountProof || '') || !pkg || Buffer.from(pkg.iv || '', 'base64').length!==12 ||
            Buffer.from(pkg.ciphertext || '', 'base64').length<17 || Buffer.from(pkg.ciphertext || '', 'base64').length>1040) return null;
        return r;
    } catch (_) { return null; }
}
// Routing acceptance only: phones verify the account-key proof themselves.
function rotationDecision(a,d,c,bound,e) {
    const r=parseRotation(e);
    if (!r || !a || !d || !c || d.accountId!==a.id || c.accountId!==a.id || r.accountId!==a.id || r.clientId!==c.id ||
        r.requesterId!==d.id || r.originDeviceId!==c.deviceId || r.publicKey!==d.managementPublicKey || !bound) return 'denied';
    const rights=permissions(d), isMain=a.defaultDeviceId===d.id;
    if (!isMain && !rights.canReadTokens) return 'denied';
    if (c.credentialRotation?.payload===e.payload && c.credentialRotation?.accountProof===e.accountProof) return 'duplicate';
    const originWithoutMain=r.authority==='origin' && c.deviceId===d.id && !a.defaultDeviceId && !d.backupPolicy;
    if (!isMain && !originWithoutMain && !rights.canRenewTokens) return 'denied';
    if (r.authority==='main' && !isMain || r.authority==='origin' && c.deviceId!==d.id) return 'denied';
    if (r.authority==='backup') {
        const p=parsePolicy(r.policy);
        if (!p || !p.canReadTokens || !p.canRenewTokens || p.accountId!==a.id || p.targetDeviceId!==d.id || p.targetPublicKey!==d.managementPublicKey ||
            r.policy.payload!==d.backupPolicy?.payload || r.policy.signature!==d.backupPolicy?.signature || r.policy.accountProof!==d.backupPolicy?.accountProof ||
            !/^[A-Za-z0-9+/]{43}=$/.test(r.policy.accountProof || '')) return 'denied';
    }
    if (r.previousHash!==c.secretHash || r.previousRevision!==(c.credentialRevision || 0) || r.cookieKeyRevision!==(a.cookieKeyRevision || 0)) return 'conflict';
    return 'ok';
}
module.exports = {validPublicKey, validSignature, permissions, parsePolicy, parseRotation, rotationDecision};
