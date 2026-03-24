# Contributing

Contributions are welcome via pull requests. All code is released under the
project's license (see LICENSE).

## Developer Certificate of Origin

All commits must include a
[DCO](https://developercertificate.org/) sign-off line certifying you have the
right to submit the code under this project's license.

Add it automatically with `-s`:

```sh
git commit -s -m "fix: correct edge case in example"
```

To sign off commits you have already made:

```sh
git commit --amend --signoff --no-edit  # last commit
git rebase --signoff HEAD~N             # last N commits
```

Sign-off is verified on every pull request. PRs with unsigned commits will not
be merged.

## Setup

```bash
bun install
```

## Development

```bash
# Run tests
bun test

# Type check
bun run typecheck

# Run example
bun run example/index.ts
```

## Testing

Unit tests use mocked backends - no LLM calls required:

```bash
bun test
```

Integration tests require OpenCode CLI and hit real LLMs:

```bash
OCPIPE_INTEGRATION=1 bun test src/integration.test.ts
```

## Project Structure

```
src/
├── index.ts          # Main exports
├── signature.ts      # Signature and field definitions
├── predict.ts        # Predict class
├── module.ts         # Module and SignatureModule
├── pipeline.ts       # Pipeline orchestration
├── parsing.ts        # JSON parsing utilities
├── state.ts          # State management
├── types.ts          # TypeScript types
├── agent.ts          # OpenCode agent integration
├── testing.ts        # Test utilities
└── paths.ts          # Path constants
example/
├── index.ts          # Hello world example
├── signature.ts      # Example signature
├── module.ts         # Example module
└── correction.ts     # Auto-correction demo
```

## Pull Requests

1. Fork and create a branch
2. Make changes with tests
3. Run `bun test` and `bun run typecheck`
4. Submit PR
