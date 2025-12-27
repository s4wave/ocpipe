# Contributing

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

## License

By contributing, you agree that your contributions will be licensed under MIT.
