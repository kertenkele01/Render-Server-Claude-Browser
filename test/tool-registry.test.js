'use strict';

/**
 * Tool-registry consistency.
 *
 * Adding a tool means touching four places that do not know about each other:
 * the MCP schema list, the tool-name to command-type switch, the REST fallback
 * routes, and the documentation the agent reads. Miss one and the failure is
 * quiet in the worst way — the client sees the tool, calls it, and gets
 * "Tool not found" or a route that answers with nothing.
 *
 * Read from source rather than by starting a relay: these are static facts
 * about the file, and a test that boots a server to learn them would be slower
 * and no more certain.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

/** Tool names as declared in the MCP schema list. */
function declaredTools() {
    const names = new Set();
    const pattern = /name:\s*"(browser_[a-z_]+)",\s*\n\s*description:/g;
    let match;
    while ((match = pattern.exec(SOURCE)) !== null) names.add(match[1]);
    return names;
}

/** Tool names the dispatch switch knows how to turn into a command. */
function dispatchedTools() {
    const names = new Set();
    const pattern = /case "(browser_[a-z_]+)":/g;
    let match;
    while ((match = pattern.exec(SOURCE)) !== null) names.add(match[1]);
    return names;
}

/** Tool names with an entry in the documentation the agent can request. */
function documentedTools() {
    const names = new Set();
    const pattern = /^\s{8}(browser_[a-z_]+):\s*\{$/gm;
    let match;
    while ((match = pattern.exec(SOURCE)) !== null) names.add(match[1]);
    return names;
}

test('her araç şemasının bir komut karşılığı var', () => {
    const declared = declaredTools();
    const dispatched = dispatchedTools();

    // The documentation tool answers on the relay itself and never reaches a
    // device, so it is deliberately absent from the switch.
    const relayHandled = new Set(['browser_get_tool_documentation']);

    assert.ok(declared.size > 15, `beklenenden az araç bulundu: ${declared.size}`);

    for (const name of declared) {
        if (relayHandled.has(name)) continue;
        assert.ok(
            dispatched.has(name),
            `'${name}' şemada var ama switch içinde yok — istemci aracı görür, çağırınca "Tool not found" alır`
        );
    }
});

test('form araçları eksiksiz kayıtlı', () => {
    // The five tools the form work added. Named one by one on purpose: a
    // regression that drops one of them is otherwise invisible until a booking
    // form fails on somebody's phone.
    const formTools = [
        'browser_select_option',
        'browser_pick_date',
        'browser_read_form',
        'browser_fill_form',
        'browser_handle_dialog'
    ];

    const declared = declaredTools();
    const dispatched = dispatchedTools();
    const documented = documentedTools();

    for (const name of formTools) {
        assert.ok(declared.has(name), `'${name}' araç şeması eksik`);
        assert.ok(dispatched.has(name), `'${name}' komut eşlemesi eksik`);
        assert.ok(documented.has(name), `'${name}' dokümantasyonu eksik`);
        assert.ok(
            SOURCE.includes(`'/mcp/tools/${name}'`),
            `'${name}' için REST yolu eksik`
        );
    }
});

test('etkileşim kategorisi form araçlarını listeler', () => {
    // The category listing is how an agent that asks "what can I do here"
    // discovers them; a tool missing from it exists but is never found.
    const category = SOURCE.match(/interaction:\s*\{[\s\S]*?tools:\s*\[([\s\S]*?)\]/);
    assert.ok(category, 'interaction kategorisi bulunamadı');

    for (const name of ['browser_select_option', 'browser_pick_date', 'browser_read_form', 'browser_fill_form']) {
        assert.ok(category[1].includes(name), `'${name}' interaction kategorisinde listelenmemiş`);
    }
});
