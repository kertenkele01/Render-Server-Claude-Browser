'use strict';
const { spawnSync } = require('node:child_process');
if (!process.env.TEST_DATABASE_URL) {
    console.error('Set TEST_DATABASE_URL to a disposable PostgreSQL database; never use a production database.');
    process.exit(1);
}
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1',
    'test/main-device.test.js', 'test/sync-safety.test.js', 'test/credential-sharing.test.js'], { stdio: 'inherit', env: process.env, windowsHide: true });
process.exit(result.status ?? 1);
