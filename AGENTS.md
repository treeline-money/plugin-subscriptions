# Subscriptions Plugin

A Treeline plugin that detects recurring charges and helps track subscription costs.

## Key Files

| File | Purpose |
|------|---------|
| `manifest.json` | Plugin metadata (id: "subscriptions") |
| `src/index.ts` | Plugin entry point |
| `src/SubscriptionsView.svelte` | Main UI component |
| `package.json` | Dependencies (includes `@treeline-money/plugin-sdk`) |

## Quick Commands

```bash
npm install          # Install dependencies
npm run build        # Build to dist/index.js
npm run dev          # Watch mode
tl plugin install .  # Install locally for testing
```

## Plugin Data

This plugin uses a minimal table to track hidden subscriptions. All subscription data is derived on-the-fly from transaction queries:

```sql
CREATE TABLE IF NOT EXISTS sys_plugin_subscriptions (
  merchant_key VARCHAR PRIMARY KEY,   -- unique key for the subscription
  hidden_at TIMESTAMP                 -- when it was hidden (null = visible)
)
```

Note: The plugin does NOT store subscription details (name, amount, frequency). Instead, it:
- Queries transactions with fuzzy matching (Jaro-Winkler similarity)
- Calculates subscription patterns dynamically
- Only persists which subscriptions the user has hidden

## How Detection Works

The plugin analyzes transaction history to find recurring patterns:
1. Groups transactions by similar descriptions (fuzzy matching with Jaro-Winkler)
2. Identifies regular intervals (monthly, yearly)
3. Calculates average amount and frequency
4. Requires 3+ occurrences to detect a pattern
5. Presents detected subscriptions for user review

## SDK Import

All types are imported from the npm package:

```typescript
import type { Plugin, PluginContext, PluginSDK } from "@treeline-money/plugin-sdk";
```

Views receive `sdk` via props:

```svelte
<script lang="ts">
  import type { PluginSDK } from "@treeline-money/plugin-sdk";

  interface Props {
    sdk: PluginSDK;
  }
  let { sdk }: Props = $props();
</script>
```

## SDK Quick Reference

| Method | What it does |
|--------|--------------|
| `sdk.query(sql)` | Read transactions for analysis |
| `sdk.execute(sql)` | Write to sys_plugin_subscriptions |
| `sdk.toast.success/error/info(msg)` | Show notifications |
| `sdk.openView(viewId, props?)` | Navigate to another view |
| `sdk.onDataRefresh(callback)` | React when data changes |
| `sdk.emitDataRefresh()` | Notify other views data changed |
| `sdk.theme.current()` | Get "light" or "dark" |
| `sdk.settings.get/set()` | Persist settings |
| `sdk.currency.format(amount)` | Format as currency |

## Releasing

```bash
./scripts/release.sh 0.1.0   # Tags and pushes, GitHub Action creates release
```

## Full Documentation

See https://github.com/treeline-money/treeline
