# Security Policy

## Supported versions

Only the `main` branch is supported. There are no maintained release branches;
fixes land on `main` and are deployed with the next site build.

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private
vulnerability reporting instead:

https://github.com/saschagrunert/kml-heatmap/security/advisories/new

Include the affected component (Python pipeline, frontend, container image or
CI), steps to reproduce and, if possible, a suggested fix. You will get a
response within a few days.

## Public tile API keys

The generated site embeds the CARTO and OpenAIP tile API keys in its
`map_config.js`. They are public client-side keys that the browser needs to
load the base map and the Aviation Data layer, so they are published with the
site by design. The `deploy` workflow reads them from the repository secrets;
the generated site itself is not committed. Reports about these keys being
visible on the site are not security issues.

## Automated checks

Every pull request runs bandit, `pip-audit` against the hashed lock files,
`npm audit`, and gitleaks. Dependabot and the weekly `lock` workflow keep the
dependencies current.
