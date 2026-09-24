# Security Policy

## Supported versions

Only the `main` branch is supported. There are no releases or release
branches; fixes land on `main` and are deployed with the next site build.

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private
vulnerability reporting instead:

https://github.com/saschagrunert/kml-heatmap/security/advisories/new

Include the affected component (Python pipeline, frontend, container image or
CI), steps to reproduce and, if possible, a suggested fix. You will get a
response within a few days.

## Public tile API key

The generated site embeds the CARTO tile API key in its `map_config.js`. It
is a public client-side key that the browser needs to load the base map, so
it is published with the site by design. The `site` job of the `test`
workflow reads it from the repository secrets; the generated site itself is
not committed. Reports about this key being visible on the site are not
security issues. The aviation overlay (open flightmaps) needs no key.

## Automated checks

Every pull request and push runs bandit, `pip-audit` against the hashed lock
files, `npm audit`, and a gitleaks scan of the whole commit history, and the
same job runs weekly so new advisories show up without a push. Every
GitHub Action is pinned by commit SHA and every container image by digest,
and every job that checks out the repository leaves no credentials in the
checkout. Dependabot and the weekly `lock` workflow keep the dependencies
current.

## Content Security Policy

The generated page carries a CSP in a `<meta>` tag. Scripts, styles, fonts
and workers load only from the site itself; there is no `'unsafe-inline'`
for scripts or styles. Only `connect-src` names foreign hosts: CARTO
(`basemaps.cartocdn.com` for the style, `*.basemaps.cartocdn.com` for the
tiles, glyphs and sprite of the base map), the open flightmaps tile server
(`nwy-tiles-api.prod.newaydata.com`) and the elevation tiles on AWS
(`s3.amazonaws.com`) the 3D view draws its relief from. MapLibre fetches
every tile, so `img-src` allows only the site itself, `data:` and `blob:`.
MapLibre GL JS is published with the
site as ES modules and starts its worker from one of them, so
`worker-src 'self'` is enough and no `blob:` worker is allowed.
Colours computed at runtime are applied through the CSSOM, and a test fails
on any CSP violation the page reports. A meta CSP cannot set
`frame-ancestors`, and GitHub Pages sends no such header, so the site can be
framed; it holds no state an embedding page could change.
