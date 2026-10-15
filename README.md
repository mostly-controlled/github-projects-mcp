# GitHub Projects MCP

A small MCP server for GitHub Projects v2.

Issues and pull requests live in separate repositories. GitHub Projects brings them together. This server will let AI agents read that shared board and coordinate work without scanning every repository.

**Status:** Read-only MVP.

Uses the official MCP TypeScript SDK over stdio and GitHub Projects v2 GraphQL. Set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_INSTALLATION_ID`; the installation token is minted at runtime and never logged. The server has no write tools.

Tools: `list_projects(organization, cursor?)`, `get_project(organization, number)`, and `list_project_items(organization, number, cursor?)`. Responses include `pageInfo`; inaccessible/redacted content remains null and GraphQL permission/errors are returned as MCP errors.

Run locally: `npm install && npm test && npm run build && npm start`. A real read requires an existing installation with the GitHub Projects permission; this repository does not change app permissions or include credentials.

MIT licensed. See [LICENSE](LICENSE).
