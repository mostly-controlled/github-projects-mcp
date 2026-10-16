# GitHub Projects MCP

A small MCP server for GitHub Projects v2.

Issues and pull requests live in separate repositories. GitHub Projects brings them together. This server will let AI agents read that shared board and coordinate work without scanning every repository.

**Status:** Read-only by default; Projects v2 write tools are explicitly gated.

Uses the official MCP TypeScript SDK over stdio and GitHub Projects v2 GraphQL. Set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_INSTALLATION_ID`; the installation token is minted at runtime and never logged. Reads remain available by default. Writes additionally require `GITHUB_PROJECTS_V2_WRITE_ENABLED=true` and `GITHUB_PROJECTS_V2_WRITE_ALLOWLIST` as a JSON array of exact organization/project pairs, for example `[{"organization":"acme","projectId":"PVT_1"}]`. Invalid or missing write configuration fails closed. Write tools are `add_project_v2_item_by_id`, `update_project_v2_item_field_value`, and `delete_project_v2_item`. Add checks current project items and returns the existing item instead of creating a duplicate; delete checks membership and treats an absent item as a safe no-op.

Tools: `list_projects(organization, cursor?)`, `get_project(organization, number)`, and `list_project_items(organization, number, cursor?)`. Responses include `pageInfo`; inaccessible/redacted content remains null and GraphQL permission/errors are returned as MCP errors.

Run locally: `npm install && npm test && npm run build && npm start`. A real read requires an existing installation with the GitHub Projects permission; this repository does not change app permissions or include credentials. Tests use mocks only; no live write tests are included. The write runtime is not validated against live GitHub.

MIT licensed. See [LICENSE](LICENSE).
