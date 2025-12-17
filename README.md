# Subscriptions

A [Treeline](https://github.com/zack-schrag/treeline-money) plugin that detects recurring charges and tracks subscription costs.

Features:
- Automatic detection of recurring charges
- Monthly/yearly cost breakdown
- Hide subscriptions you don't want to track
- See when subscriptions will next charge

## Installation

### From Community Plugins (Recommended)

1. Open Treeline
2. Go to Settings > Plugins > Community Plugins
3. Find "Subscriptions" and click Install
4. Restart Treeline

### Manual Installation

```bash
tl plugin install https://github.com/zack-schrag/treeline-subscriptions
# Restart Treeline
```

## Development

```bash
git clone https://github.com/zack-schrag/treeline-subscriptions
cd treeline-subscriptions
npm install
npm run build
tl plugin install .
```

## License

MIT
