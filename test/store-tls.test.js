'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { databaseSslOptions } = require('../lib/store');

test('Postgres TLS follows the connection route and explicit sslmode', () => {
    assert.equal(databaseSslOptions('postgres://u:p@localhost/db'), false);
    assert.equal(databaseSslOptions('postgres://u:p@dpg-c123-a/db'), false);
    assert.equal(databaseSslOptions('postgres://u:p@db.example.com/db?sslmode=disable'), false);
    assert.deepEqual(
        databaseSslOptions('postgres://u:p@db.example.com/db?sslmode=require'),
        { rejectUnauthorized: false }
    );
    assert.deepEqual(
        databaseSslOptions('postgres://u:p@db.example.com/db'),
        { rejectUnauthorized: true }
    );
    assert.deepEqual(
        databaseSslOptions('postgres://u:p@db.example.com/db?sslmode=require', {
            DATABASE_CA_CERT: 'line-one\\nline-two'
        }),
        { rejectUnauthorized: true, ca: 'line-one\nline-two' }
    );
});
