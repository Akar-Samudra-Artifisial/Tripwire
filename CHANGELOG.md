# Changelog

Semua perubahan penting dicatat di sini. Format mengikuti Keep a Changelog, versi mengikuti SemVer.

## [Unreleased]

### Added
- Kerangka app Forge "Tripwire" (Confluence wajib, Jira opsional). Modul inti dipasang sejak awal agar tidak perlu major upgrade nanti: Forge SQL, Forge LLM (Claude), trigger halaman Confluence, `scheduledTrigger` harian, antrean `extract` dan `evaluate`, byline Confluence, halaman global "Decision Health", panel isu Jira "Decision revisit", halaman admin "Tripwire setup", serta agen Rovo "Decision Steward" dengan action `list-tripped`. Semua tampilan dan action masih berisi data placeholder.
- Lima jenis pemicu (`jql_threshold`, `graph_relation`, `date`, `content_change`, `checkin`) dengan `validate`/`evaluate` bertipe, model data, dan migrasi awal Forge SQL.
- Scope baca Teamwork Graph (`read:graph:*`) untuk issue, project, user, dan halaman.
