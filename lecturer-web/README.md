# Attendance lecturer web

React 19 + Vite client for the authenticated lecturer and administrator workflows in Attendance-System.

## Local development

1. Install Node.js 24 or newer.
2. From this directory, run \`npm ci\`.
3. Start the Vite development server with \`npm run dev\`.

The Vite development server falls back to \`http://localhost:3000/api/v1\` when
\`VITE_API_BASE_URL\` is omitted. Copy \`.env.example\` only when your local API
uses that address. To work against staging, set \`VITE_API_BASE_URL\` to the
public HTTPS API ending exactly in \`/api/v1\`.

Do not put access tokens, provider keys, passwords, or other secrets in Vite
environment variables; values prefixed with \`VITE_\` are embedded in the browser
bundle.

## Verify before delivery

- \`npm test\` runs deterministic Node.js unit and source-contract tests.
- \`npm run lint\` runs ESLint.
- \`VITE_API_BASE_URL=https://your-api.example/api/v1 npm run build\` validates the
  production API origin and builds the site.
- With the same \`VITE_API_BASE_URL\` value, run
  \`npm run check:build-api-origin\` to confirm the built bundle embeds the
  configured API origin and does not contain the retired staging host.

The source-contract tests compare frontend endpoint paths against the current
backend router definitions. They do not replace authorized staging/browser
end-to-end testing.
