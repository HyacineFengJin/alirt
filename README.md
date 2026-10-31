# Alirt

**A Little Roleplay Test** — a modular local roleplay agent workbench.

Alirt gives characters persistent sessions, separates their knowledge, adjudicates world changes, and asks a writer to compose the approved material. It uses a source-built [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) runtime; the interface and roleplay rules belong to Alirt.

This is an early Web alpha. Autonomous world clocks and Tauri packaging are not implemented. A valid schema does not prove that every sentence of generated prose follows the approved facts. Failed attempts are retained locally; there is no automatic quality retry.

## Run locally

Use **Node.js 24+** and npm.

```sh
npm ci
npm run build
npm start
```

Open <http://127.0.0.1:4317>. Reading, editing native documents and importing your own files work without a model key. Generated stories require a configured key and the pinned DSH runtime; missing runtime returns an explicit error, never demo output.

Development: `npm run dev` starts the API and Vite on loopback. Runtime data, imported material, model transcripts and uploaded images stay under `.rp-data/`, which is ignored by Git. The application is a local authoring tool, not a hosted multi-user service.

### Model runtime

Build the pinned public upstream checkout with its own dependency and native build requirements:

```sh
npm run setup:dsh -- --plan
npm run setup:dsh
```

The script fetches the official source at the pinned revision, builds it, and keeps its licenses in `.rp-runtime/`. It requires git, Node.js 24+, network access to the upstream and registries, and the native toolchain required by that upstream. The first build can take time. The script stops if the dedicated checkout is dirty; it does not overwrite an unrelated directory.

Alternatively, set `RP_DSH_RUNTIME` to an equivalent distribution built from the pinned commit. Set `DEEPSEEK_API_KEY` in the server environment or enter it through the local settings dialog. Keys are not written to story documents or browser storage.

`.env.example` lists supported settings; export them in your shell. The app does not automatically load that file.

## Included mechanisms

- Native character cards and presets with conditional prompt modules, priorities, audience rules, chapters and opening selections.
- Persistent role agents, direct scoped peer mail, explicit presence/lifecycle, and separate user-controlled player identity.
- Typed state transactions, numeric bounds, author corrections, and source-linked knowledge withdrawal.
- World adjudication, a unified prose writer, immutable local-dialogue references, optional advisory review and structured host outputs.
- Explicitly authorized offstage scenes, versioned paper/screen viewing, and a local image library with per-story role bindings and historical display snapshots.
- A session-based AI document workshop and structural Tavern JSON/PNG import. Imported code is retained as data; it is not executed. Conversion is an explicit author workflow, not a claim of arbitrary preset/UI equivalence.

The included harbor card and basic preset are original examples. This repository contains the generic platform and synthetic tests. Personal imports, private compatibility extensions, operational reports, model logs, and third-party cards/presets are not distributed.

## Checks

```sh
npm run typecheck
npm test -- --maxWorkers=1 --no-file-parallelism
npm run build
```

Tests use original synthetic fixtures. Actual model calls are opt-in and require your own runtime and key. Merely starting the app or running these checks does not call a model.

## License

Alirt's original code and original examples are [MIT licensed](LICENSE).

Third-party software keeps its own license. DSH remains under its upstream MIT license; other dependencies include Apache-2.0, ISC, LGPL and other licenses. No third-party runtime binaries, card collections, preset collections or media are bundled here. See [third-party notices](THIRD_PARTY_NOTICES.md). Importing a file does not grant permission to redistribute it or change its license.
