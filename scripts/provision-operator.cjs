'use strict';

const { openStore } = require('../lib/store');
const auth = require('../lib/auth');

async function provisionOperator(store, email, password, promoteExisting = false) {
    const reserved = (process.env.ADMIN_EMAILS || '').split(',').map(auth.normaliseEmail);
    if (auth.emailProblem(email) || !reserved.includes(email)) throw new Error('Adres ADMIN_EMAILS içinde olmalı.');
    const existing = await store.getAccountByEmail(email);
    if (existing) {
        if (!promoteExisting) throw new Error('Hesap zaten var. Sahipliğini kontrol edip --promote-existing ile açıkça yükseltin.');
        return store.setAccountAdmin(existing.id, true);
    }
    if (promoteExisting) throw new Error('Yükseltilecek hesap bulunamadı.');
    const problem = auth.passwordProblem(password);
    if (problem) throw new Error(problem);
    const hashed = await auth.hashPassword(password);
    const account = await store.createAccount({ email, ...hashed });
    return store.setAccountAdmin(account.id, true);
}

async function main() {
    if (typeof process.loadEnvFile === 'function') {
        try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const email = auth.normaliseEmail(process.argv[2]);
    const promote = process.argv[3] === '--promote-existing';
    if (!email || (process.argv[3] && !promote)) throw new Error('Kullanım: node scripts/provision-operator.cjs <email> [--promote-existing]');
    let password = '';
    if (!promote) {
        // Read from stdin, never from command arguments or environment variables.
        // For a terminal, disable echo; for a pipe, accept exactly one line.
        const { Writable } = require('node:stream');
        const readline = require('node:readline/promises');
        const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
        process.stderr.write('Yeni operatör parolası: ');
        const input = readline.createInterface({ input: process.stdin, output: silent, terminal: !!process.stdin.isTTY });
        try { password = await input.question(''); } finally { input.close(); process.stderr.write('\n'); }
    }
    const store = await openStore();
    try { await provisionOperator(store, email, password, promote); }
    finally { password = ''; await store.close(); }
    console.log('Operatör hesabı hazır. Röleyi yeniden başlatın.');
}

if (require.main === module) main().catch(() => {
    // Do not print database errors, connection strings or input secrets.
    console.error('Operatör oluşturulamadı. ADMIN_EMAILS, hesap varlığı ve depo erişimini kontrol edin.');
    process.exitCode = 1;
});
module.exports = { provisionOperator };
