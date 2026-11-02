# Tripwire Privacy Policy

Last updated: 2 November 2026

Tripwire is built by Bayu Trisnapati as an entry to Atlassian Codegeist 2026. It is an Atlassian Forge app for Confluence (required) and Jira (optional). It reads decision pages in Confluence, extracts the assumptions behind each decision, and opens a Revisit work item in Jira when an assumption no longer holds.

This policy explains what data the app handles.

## Where the app runs

Tripwire runs entirely on Atlassian's Forge platform. It does not send data to servers operated by the developer or by any third party. It makes no network calls outside Atlassian product APIs and Forge services.

To extract assumptions from a decision page, Tripwire uses Forge LLM: a Claude model hosted by Atlassian inside the Forge platform. The page content sent to the model stays within Atlassian.

## Data the app accesses

Within the site where it is installed, and only as far as the permissions you approve at install time allow:

- **Confluence:** pages, their labels and spaces, to find decision pages and read their content (`read:confluence-content.*`, `read:page:confluence`, `read:label:confluence`, `read:space:confluence`)
- **Jira:** issues and projects, to evaluate tripwire queries (JQL) and to track Revisit work items (`read:jira-work`)
- **Teamwork Graph (read-only):** relations between issues, projects, users and pages (`read:graph:*`)

The Rovo agent "Decision Steward" uses the same data. It lists only decisions on pages the asking user can view.

## Data the app writes

- **Revisit work items:** when a confirmed tripwire trips, Tripwire creates a Jira issue for the decision owner, and adds comments and transitions to it.
- **Load demo data:** only when an admin presses this button, Tripwire creates a demo Jira project, a Confluence space, a decision page and demo Jira tickets.

Outside demo data, Tripwire does not change the content of your Confluence pages. Page-related actions run as the user where needed, so Tripwire checks the user's own permissions first, for example that the user can view or edit the decision page.

## Data storage

Data the app persists is kept in Atlassian-hosted Forge SQL, separate for each installation:

- decisions: page ID, page title, a summary of the decision, team, decision date and topics
- assumptions: quotes taken from the decision page and a short summary of each
- tripwires: their specification (for example a JQL query and threshold, or a date) and status
- evaluation results: the numbers measured (such as issue counts) and the outcome
- revisits: the Jira issue key, status and outcome
- settings for the installation
- contradiction radar: pairs of decisions that may conflict, with a short summary, and Teamwork Graph aggregates for each pair (how many people contributed to each page and to both, and the names of their teams). Contributor account IDs are used only to compute these numbers and are not stored
- Atlassian account IDs: the decision owner, the user who confirmed a tripwire, and the user who resolved a revisit

The app does not store names or email addresses. The developer has no access to your data. The app does not sell or share your data, and does not use it for advertising or model training. It uses no third-party analytics.

## Personal data

The only personal data Tripwire stores is Atlassian account IDs, as listed above. The app displays user names that Atlassian returns, for example the owner of a decision. It does not store them or copy them outside Atlassian.

## Removing data

Uninstalling the app removes its Forge SQL data, following Atlassian's Forge data retention rules. Jira issues and Confluence content that Tripwire created stay in your site until you delete them.

## Contact

Questions: bayutrisnapati@gmail.com
