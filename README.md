# Tripwire

Tripwire watches the assumptions behind your team's decisions and reopens a decision the moment the data says it's no longer true.

Built on Atlassian Forge for Confluence (required) and Jira (optional). Tripwire reads decision pages in Confluence, turns their assumptions into checks (Jira query thresholds, dates, page changes or scheduled check-ins), and gives the owner a Revisit task in Jira when a check trips.

## Features

- **Assumption extraction** – Forge LLM reads a Confluence decision page (forced tool call) and proposes tripwires. Every quote is verified against the page text; JQL is checked by a guard and limited to allowlisted projects. Nothing is watched until the owner clicks **Accept** in the page byline.
- **Trigger kinds**
  - `jql_threshold` – a Jira query count crosses a threshold. Needs two consecutive tripped readings (anti-noise); shows **near** at 80% of the threshold.
  - `date`, `checkin`, `content_change` – trip on the first reading.
- **Revisit tasks** – one Jira work item per decision, with the evidence in the *Decision revisit* issue panel. **Reaffirm** an assumption to re-arm its tripwire. (Supersede is not built yet.)
- **Contradiction Radar** – the **Decision Health** global page in Confluence (tabs *Overview* and *Radar*) flags decisions that may contradict each other and rates cross-team severity.
- **Rovo agent "Decision Steward"** – answers "which decisions rest on outdated assumptions?" through the `list-tripped` action (only pages the user can view).
- **Admin setup in Jira** – Initialise, settings, and demo buttons (**Load demo data**, **Simulate a busy month**, **Reset demo**) that run as queued jobs with progress on the page.
- **Storage** – decisions, tripwires, evaluations and relations live in Forge SQL.

### Teamwork Graph (read-only)

Tripwire only **reads** Teamwork Graph (Preview), for the Radar: `confluencePageContributors` and `atlassianUserInTeams` via `api.asUser().requestTeamworkGraph`. Only aggregate counts are stored; Tripwire writes nothing to the graph. New pages can take a while to be indexed, so Radar team data for freshly created pages may appear later.

## Install (judges)

Installation link (Confluence + Jira):
https://developer.atlassian.com/console/install/8d1eb26f-a9da-4d4e-81f3-1b2bf96a1726?signature=AYABePh55qyEGpc0%2Fds8A8ogu4MAAAADAAdhd3Mta21zAEthcm46YXdzOmttczp1cy13ZXN0LTI6NzA5NTg3ODM1MjQzOmtleS83MDVlZDY3MC1mNTdjLTQxYjUtOWY5Yi1lM2YyZGNjMTQ2ZTcAuAECAQB4CxqLTo9l4lqXuFjNim1xJM%2Bp%2F3TVP9xHS2BrU5DRRucB821x7TGad46AHAtPDliFjQAAAH4wfAYJKoZIhvcNAQcGoG8wbQIBADBoBgkqhkiG9w0BBwEwHgYJYIZIAWUDBAEuMBEEDLvC5ST3gLEH92lsngIBEIA7cbPU1q98Os1y38UWZN7zkrc1MCmZXpQM41Y0dDYGSQhu%2FUjkXd14IeOnQp09SzzP0avUGDDGvqWNa8cAB2F3cy1rbXMAS2Fybjphd3M6a21zOmV1LXdlc3QtMTo3MDk1ODc4MzUyNDM6a2V5LzQ2MzBjZTZiLTAwYzMtNGRlMi04NzdiLTYyN2UyMDYwZTVjYwC4AQICAHi9bVMAkme4qVQX1fQHo6ePw3H40A7cGfz7yrmSfBWMXgFVg1e0wH18fS53qAGf8iU8AAAAfjB8BgkqhkiG9w0BBwagbzBtAgEAMGgGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQMmo2pAo8MSCrnkSI%2BAgEQgDsWI4r3n1qXSnTtWGVJmJz15MZ%2BLNmG1gdP4P%2BGfq95VJJbZs%2F44WB8x%2F%2BbM51wrnRDS3FsOvkNtCfstwAHYXdzLWttcwBLYXJuOmF3czprbXM6dXMtZWFzdC0xOjcwOTU4NzgzNTI0MzprZXkvNmMxMjBiYTAtNGNkNS00OTg1LWI4MmUtNDBhMDQ5NTJjYzU3ALgBAgIAeDYASx0XCjkny4iLV6vz%2BKtEGSGT6kdt0QRpkn6D%2FlVEAbJjkaSsnPr1PTXtQd95ln0AAAB%2BMHwGCSqGSIb3DQEHBqBvMG0CAQAwaAYJKoZIhvcNAQcBMB4GCWCGSAFlAwQBLjARBAxnoRQiFh%2BL9NrL7P4CARCAO6F%2BpoBFH2j3v7u4grdBUh7%2B1VEZN27Nh8IpgNOclYHEuXd%2Bkgqmb4RYPgTJmsbLmqkqbVGn%2BvnvSCHrAgAAAAAMAAAQAAAAAAAAAAAAAAAAAGZ8cXyI87SIFpu6R9BDndf%2F%2F%2F%2F%2FAAAAAQAAAAAAAAAAAAAAAQAAADLebku2wJgkhNhUZxuTszZOfoyl6nr%2FOkoVeMbKY3wgBk75gUCu%2FBRkwtkNE%2BBSdhZS59vcROKYMp25NoBIHIdtoUY%3D&product=confluence&product=jira

Installing requires an organization admin, because Tripwire reads Teamwork Graph.

1. Open the link above and install Tripwire on your site (Confluence and Jira).
2. In Jira, go to **Settings → Apps → Tripwire setup**.
3. Click **Initialise** (a new install sets up its database in a minute or two; the page shows the progress).
4. Click **Load demo data** and wait until the page shows the result (one click; progress is shown while it runs).
5. In Confluence, open the page **Defer CSV export** in the **Decisions (DEC)** space and click **Accept** on its tripwire.
6. Back in Tripwire setup, click **Simulate a busy month** and wait for the result, e.g. "Revisit: SUP-12".
7. Open that Revisit issue in the **SUP** project to see why the decision should be reopened, then click **Reaffirm** on an assumption to re-arm it.
8. In Confluence, open **Decision Health** (Apps menu) and switch to the **Radar** tab to see contradicting decisions.
9. Ask Rovo agent **Decision Steward**: "Which of our decisions rest on outdated assumptions?"

To start over, use **Reset demo** in Tripwire setup.

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

Privacy policy: [docs/PRIVACY.md](docs/PRIVACY.md) · Terms of service: [docs/TERMS.md](docs/TERMS.md)

## License

MIT
