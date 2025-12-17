# Subscriptions Plugin

A Treeline plugin that detects recurring charges and helps track subscription costs.

## Key Files

| File | Purpose |
|------|---------|
| `manifest.json` | Plugin metadata (id: "subscriptions") |
| `src/index.ts` | Plugin entry point |
| `src/SubscriptionsView.svelte` | Main UI component |
| `src/types.ts` | TypeScript types for the Plugin SDK |

## Quick Commands

```bash
npm install          # Install dependencies
npm run build        # Build to dist/index.js
npm run dev          # Watch mode
tl plugin install .  # Install locally for testing
```

## Plugin Data

This plugin stores detected subscriptions in `sys_plugin_subscriptions` table:

```sql
CREATE TABLE IF NOT EXISTS sys_plugin_subscriptions (
  id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  amount DECIMAL NOT NULL,
  frequency VARCHAR,           -- monthly, yearly, etc.
  last_charge_date DATE,
  next_charge_date DATE,
  category VARCHAR,
  is_hidden BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
```

## How Detection Works

The plugin analyzes transaction history to find recurring patterns:
1. Groups transactions by similar descriptions (fuzzy matching)
2. Identifies regular intervals (monthly, yearly)
3. Calculates average amount and frequency
4. Presents detected subscriptions for user review

## SDK Quick Reference

Views receive `sdk` via props:

```svelte
<script lang="ts">
  import type { PluginSDK } from "./types";
  let { sdk }: { sdk: PluginSDK } = $props();
</script>
```

| Method | What it does |
|--------|--------------|
| `sdk.query(sql)` | Read transactions for analysis |
| `sdk.execute(sql)` | Write to sys_plugin_subscriptions |
| `sdk.toast.success/error(msg)` | Show notifications |
| `sdk.theme.current()` | Get "light" or "dark" |
| `sdk.settings.get/set()` | Persist settings |

## Releasing

```bash
./scripts/release.sh 0.1.0   # Tags and pushes, GitHub Action creates release
```

## Full Documentation

See https://github.com/zack-schrag/treeline-money/blob/main/docs/plugins.md
