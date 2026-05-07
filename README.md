# dps-store-desktop

DPS Store Windows desktop application (Electron).

## Requirements

- Node.js 20+
- pnpm 9+

## Development

```bash
pnpm install
pnpm dev
```

Override the target server with an env var when running locally:

```bash
DPS_BASE_URL=https://staging.example.com pnpm dev
```

## Build (Windows)

```bash
pnpm build:win
```

The NSIS installer is written to `release/`.

## License

TBD
