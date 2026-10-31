# Third-party notices

The root MIT license applies to original Alirt code and its original examples. It does not replace third-party licenses, grant rights to user-imported documents or images, or relicense dependencies.

## DeepSeek Harness

Alirt integrates with the public DeepSeek Harness project:

- Upstream: https://github.com/deepseek-ai/deepseek-harness
- Pinned revision: `d743267388641bc76f17c45ce8b4c231aed1d32c`
- Upstream version: `0.2.1-alpha.2`
- License: MIT, copyright 2026 DeepSeek.

The runtime is obtained and built separately. The setup script retains the upstream LICENSE and THIRD_PARTY_NOTICES.md. DSH may include separately licensed packages; its own notices continue to apply. Alirt does not redistribute a copied upstream working tree or prebuilt runtime in this repository.

## Package dependencies

Dependency source, notices and binaries installed by npm remain under their individual licenses. The lockfile pins the dependency graph; it does not place that graph under Alirt's MIT license.

Examples from the installed graph:

| Dependency | License |
| --- | --- |
| React, React DOM, Express, Ajv, Zod, Vite, Vitest, tsx | MIT |
| Lucide React | ISC |
| Sharp | Apache-2.0 |
| TypeScript | Apache-2.0 |
| `@img/sharp-libvips-*` prebuilt image-processing library | LGPL-3.0-or-later |
| caniuse-lite data | CC-BY-4.0 |

Read each installed package's LICENSE/NOTICE files before redistributing installed dependencies or binaries. In particular, a packaged desktop/runtime distribution must satisfy the LGPL and other applicable redistribution conditions; this source repository does not claim that the project MIT notice is sufficient for that distribution.

## Imported material

User-provided cards, presets, world documents, images and scripts remain owned and licensed by their respective rightsholders. The importer preserves data for local author workflows; it does not grant redistribution rights. Such material, operational transcripts and private compatibility extensions are excluded from this repository.
