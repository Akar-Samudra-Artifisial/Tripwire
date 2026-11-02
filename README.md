# Tripwire

Tripwire watches the assumptions behind your team's decisions and reopens a decision the moment the data says it's no longer true.

Built on Atlassian Forge for Confluence (required) and Jira (optional). Tripwire reads decision pages in Confluence, turns their assumptions into checks (Jira query thresholds, Teamwork Graph relations, dates, page changes or scheduled check-ins), and gives the owner a revisit task when a check trips.

> Status: early scaffold. Views and the Rovo action return placeholder data.

## Installation

Installation link: _coming soon_

Installing requires an organization admin, because Tripwire reads Teamwork Graph.

## Development

```sh
npm install
npm run build          # typecheck + build Custom UI into static/*/build
npm test
forge lint
forge deploy -e development
forge install --site <site>.atlassian.net --product confluence -e development
forge install --site <site>.atlassian.net --product jira -e development
```

## Layout

- `src/core/` – domain model, trigger kinds (`validate` / `evaluate`), Forge SQL migrations
- `src/llm/` – Forge LLM wrapper
- `src/adapters/` – Confluence, Jira, Teamwork Graph, Forge SQL
- `src/surfaces/` – UI resolver, Rovo actions, event triggers and queue consumers
- `ui/` – Custom UI sources, built into `static/`

## License

MIT
