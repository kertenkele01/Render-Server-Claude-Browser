# Browser tool review — 2026-09-30

Reviewed all 30 advertised tools, their relay dispatch mappings, Android command handlers and the operating guide returned to AI clients.

The relay supplies tool schemas, descriptions and the documentation response. Browser execution, credentials, profile isolation, permissions and approvals remain on the Android device. Page content and owner-supplied names retain their original language.

## Findings and changes

- Runtime descriptions were already English, but Turkish declarations and an unused Turkish guide duplicated them. Removed those copies; `AI_TOOL_COPY` now owns the English descriptions and parameter text. Documentation is derived from the served schemas.
- Unknown documentation names silently returned the entire guide. Non-string arguments and inherited object keys could cause an exception. Documentation now validates bounded string arguments and own tool keys, returns actionable English errors with supported choices, marks MCP results with `isError`, and returns HTTP 400 through REST. Invalid arguments are not echoed or logged.
- Schemas did not express several existing device constraints. Added the 1–30 field batch limit, date format, select/wait argument alternatives and mutually exclusive grid-cell/pixel click modes. These are metadata for callers; the phone continues to enforce its own checks.
- Focused guides now include nested form fields, parameter constraints and argument-combination rules. Added conservative read-only, destructive, idempotency and external-interaction hints. These are advisory [MCP ToolAnnotations](https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations), never permission grants.
- Clarified credential-field requirements and the explicit unattended-mode exception to approval prompts.
- Added English Plus/Pro information to the full operating guide and to `tool_name: "membership"` or `category: "membership"`. Quotas are read from the current relay policy on each request; Plus purchase availability follows relay billing configuration. No private account status or fixed price is exposed. Pro's current operator-assigned quota tier is separate from its future services, which are explicitly marked planned and unavailable as MCP tools. All plans retain the same device security boundary.

## Validation

- Main project: all 145 server tests passed, including all focused tool guides, English-only metadata, malformed values/prototype keys, REST/MCP error consistency and membership parity across both MCP transports.
- Membership tests verify changed live policy is reflected without mutating previous responses and that planned Pro services do not become active benefits.
- Render checkout: all 145 server tests passed; the changed runtime and test files match the main project.
- Existing tests still verify device response content passes through unchanged, including non-English page content.

This review covers tool metadata and relay behavior verified with a simulated device. It does not claim a new physical-device end-to-end test or completed Render deployment.
