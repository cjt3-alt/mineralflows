# MineralFlows

A static, client-only web app that visualises critical mineral supply chains on an interactive 3D
globe: where copper, lithium, cobalt, and rare earths are mined, processed, and refined, and how
they move between countries. Flow lines are sized by estimated market value.

There is no backend. The browser reads flat JSON and GeoJSON files from the same origin, and
nothing else.

**Status: phase 0 of 6.** The repo, toolchain, CI, and Pages deployment are in place and a
placeholder page is live. The globe, the data contract, and the ETL are not built yet.

## Development

```bash
npm install
npm run dev        # vite dev server
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm test           # vitest
npm run build      # static bundle into dist/
npm run preview    # serve dist/ locally
```

## Installed versions

Resolved against the npm registry on 2026-08-31, not pinned from memory.

| Package             | Version  |
| ------------------- | -------- |
| vite                | 8.2.2    |
| react / react-dom   | 19.2.8   |
| typescript          | 6.0.3    |
| react-globe.gl      | 2.38.0   |
| three               | 0.185.1  |
| tailwindcss         | 4.3.3    |
| zod                 | 4.5.4    |
| vitest              | 4.1.11   |
| eslint              | 10.9.1   |
| typescript-eslint   | 8.68.0   |

### Two deliberate deviations from the brief

**TypeScript is 6.0.3, not the latest 7.0.2.** `typescript-eslint@8.68.0` declares a peer range of
`typescript >=4.8.4 <6.1.0`. Installing TypeScript 7 would leave linting unsupported. 6.0.3 is the
newest release inside that range. It is pinned as `~6.0.3` so a 6.1 release cannot drift out of the
supported range on its own. Revisit when typescript-eslint ships TS 7 support.

**Vite `base` is `./`, not `/`.** A relative base makes one build work in all three places this is
served from: the project page at `cjt3-alt.github.io/mineralflows/` (which is live now, before DNS
is cut over), the apex domain `mineralflows.com` (once it is), and a plain static file server. An
absolute `/` base would 404 on every asset at the `github.io` URL. There is no client-side router,
so a relative base costs nothing. Data files are fetched relative to the document for the same
reason.

## Deployment

Pushes to `main` run `.github/workflows/deploy.yml`: install, typecheck, lint, test, build, then
publish `dist/` to GitHub Pages via the official Pages actions.

### Manual steps

These cannot be done from code and are yours to do in the browser.

1. **Repo settings → Pages → Build and deployment → Source: GitHub Actions.** Without this the
   workflow's deploy job fails. Do this once.
2. **Repo settings → Pages → Custom domain: `mineralflows.com`**, then tick **Enforce HTTPS** once
   the certificate is issued (it can take up to an hour after DNS resolves).
3. **Add the DNS records below** at your registrar, before step 2.

There is deliberately no `public/CNAME` file in this repo. When Pages publishes from Actions rather
than from a branch, it ignores `CNAME` in the artifact — the custom domain is held in repo settings
instead, which is what step 2 sets.

### DNS records for `mineralflows.com`

Apex A records, from GitHub's Pages documentation:

| Type | Name | Value             |
| ---- | ---- | ----------------- |
| A    | `@`  | `185.199.108.153` |
| A    | `@`  | `185.199.109.153` |
| A    | `@`  | `185.199.110.153` |
| A    | `@`  | `185.199.111.153` |

Apex AAAA records, if your registrar supports IPv6:

| Type | Name | Value                  |
| ---- | ---- | ---------------------- |
| AAAA | `@`  | `2606:50c0:8000::153`  |
| AAAA | `@`  | `2606:50c0:8001::153`  |
| AAAA | `@`  | `2606:50c0:8002::153`  |
| AAAA | `@`  | `2606:50c0:8003::153`  |

And a CNAME so `www` redirects to the apex:

| Type  | Name  | Value                |
| ----- | ----- | -------------------- |
| CNAME | `www` | `cjt3-alt.github.io` |

Note the CNAME target has no repository name in it. Verify the A record IPs against
<https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site>
before relying on them; GitHub has changed them before.

## Licence

MIT.
