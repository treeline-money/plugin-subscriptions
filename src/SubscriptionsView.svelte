<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { PluginSDK } from "./types";

  interface Props {
    sdk: PluginSDK;
  }
  let { sdk }: Props = $props();

  // Types
  interface Subscription {
    merchant: string;
    amount: number;
    frequency: string;
    interval_days: number;
    occurrence_count: number;
    annual_cost: number;
    last_charge: string;
    first_charge: string;
    is_hidden: boolean;
  }

  interface HiddenSubscription {
    merchant: string;
    hidden_at: string;
  }

  // State
  let subscriptions = $state<Subscription[]>([]);
  let hiddenMerchants = $state<Set<string>>(new Set());
  let isLoading = $state(true);
  let showHidden = $state(false);
  let theme = $state<"light" | "dark">("light");
  let sortBy = $state<"annual_cost" | "merchant" | "last_charge">("annual_cost");
  let sortDesc = $state(true);

  // Computed
  let visibleSubscriptions = $derived(
    subscriptions.filter(s => showHidden || !hiddenMerchants.has(s.merchant))
  );

  let sortedSubscriptions = $derived.by(() => {
    const sorted = [...visibleSubscriptions];
    sorted.sort((a, b) => {
      let cmp = 0;
      if (sortBy === "annual_cost") {
        cmp = a.annual_cost - b.annual_cost;
      } else if (sortBy === "merchant") {
        cmp = a.merchant.localeCompare(b.merchant);
      } else if (sortBy === "last_charge") {
        cmp = a.last_charge.localeCompare(b.last_charge);
      }
      return sortDesc ? -cmp : cmp;
    });
    return sorted;
  });

  let totalAnnualCost = $derived(
    visibleSubscriptions
      .filter(s => !hiddenMerchants.has(s.merchant))
      .reduce((sum, s) => sum + s.annual_cost, 0)
  );

  let totalMonthlyCost = $derived(totalAnnualCost / 12);

  // Lifecycle
  let unsubscribe: (() => void) | null = null;

  onMount(async () => {
    theme = sdk.theme.current();
    sdk.theme.subscribe((t: string) => {
      theme = t as "light" | "dark";
    });

    unsubscribe = sdk.onDataRefresh(() => {
      detectSubscriptions();
    });

    await ensureTable();
    await loadHiddenMerchants();
    await detectSubscriptions();
  });

  onDestroy(() => {
    if (unsubscribe) unsubscribe();
  });

  // Database setup
  async function ensureTable() {
    try {
      await sdk.execute(`
        CREATE TABLE IF NOT EXISTS sys_plugin_subscriptions (
          merchant VARCHAR PRIMARY KEY,
          hidden_at TIMESTAMP
        )
      `);
    } catch (e) {
      // Table might already exist
    }
  }

  async function loadHiddenMerchants() {
    try {
      const rows = await sdk.query<HiddenSubscription>(
        "SELECT merchant FROM sys_plugin_subscriptions WHERE hidden_at IS NOT NULL"
      );
      hiddenMerchants = new Set(rows.map(r => r.merchant));
    } catch (e) {
      // Table might not exist yet
    }
  }

  // Subscription detection
  async function detectSubscriptions() {
    isLoading = true;
    try {
      // Find recurring transactions by grouping on description and looking for patterns
      const rows = await sdk.query<{
        merchant: string;
        avg_amount: number;
        occurrence_count: number;
        avg_interval: number;
        stddev_interval: number;
        last_charge: string;
        first_charge: string;
      }>(`
        WITH merchant_transactions AS (
          SELECT
            description as merchant,
            amount,
            transaction_date,
            LAG(transaction_date) OVER (PARTITION BY description ORDER BY transaction_date) as prev_date
          FROM transactions
          WHERE amount < 0  -- Only charges
            AND description IS NOT NULL
            AND description != ''
        ),
        merchant_intervals AS (
          SELECT
            merchant,
            amount,
            transaction_date,
            DATEDIFF('day', prev_date, transaction_date) as interval_days
          FROM merchant_transactions
          WHERE prev_date IS NOT NULL
        ),
        merchant_stats AS (
          SELECT
            merchant,
            AVG(ABS(amount)) as avg_amount,
            COUNT(*) + 1 as occurrence_count,
            AVG(interval_days) as avg_interval,
            STDDEV(interval_days) as stddev_interval,
            MAX(transaction_date) as last_charge,
            MIN(transaction_date) as first_charge
          FROM merchant_intervals
          GROUP BY merchant
          HAVING
            COUNT(*) >= 2  -- At least 3 occurrences
            AND AVG(interval_days) BETWEEN 5 AND 400  -- Between weekly and yearly
            AND STDDEV(interval_days) < AVG(interval_days) * 0.3  -- Low variance (consistent interval)
        )
        SELECT * FROM merchant_stats
        ORDER BY avg_amount * (365.0 / avg_interval) DESC
      `);

      // Rows come back as arrays: [merchant, avg_amount, occurrence_count, avg_interval, stddev_interval, last_charge, first_charge]
      subscriptions = rows.map((row: any) => {
        const merchant = row[0] as string;
        const avg_amount = row[1] as number;
        const occurrence_count = row[2] as number;
        const avg_interval = row[3] as number;
        const last_charge = row[5] as string;
        const first_charge = row[6] as string;

        const intervalDays = Math.round(avg_interval);
        let frequency = "unknown";

        if (intervalDays <= 8) frequency = "weekly";
        else if (intervalDays <= 16) frequency = "bi-weekly";
        else if (intervalDays <= 35) frequency = "monthly";
        else if (intervalDays <= 100) frequency = "quarterly";
        else if (intervalDays <= 200) frequency = "semi-annual";
        else frequency = "annual";

        const annualCost = avg_amount * (365 / intervalDays);

        return {
          merchant,
          amount: Math.round(avg_amount * 100) / 100,
          frequency,
          interval_days: intervalDays,
          occurrence_count,
          annual_cost: Math.round(annualCost * 100) / 100,
          last_charge,
          first_charge,
          is_hidden: hiddenMerchants.has(merchant),
        };
      });
    } catch (e) {
      sdk.toast.error("Failed to detect subscriptions", e instanceof Error ? e.message : String(e));
    } finally {
      isLoading = false;
    }
  }

  // Actions
  async function hideSubscription(merchant: string) {
    try {
      await sdk.execute(`
        INSERT INTO sys_plugin_subscriptions (merchant, hidden_at)
        VALUES ('${merchant.replace(/'/g, "''")}', NOW())
        ON CONFLICT (merchant) DO UPDATE SET hidden_at = NOW()
      `);
      hiddenMerchants = new Set([...hiddenMerchants, merchant]);
      sdk.toast.info("Hidden", `${merchant} won't appear in your subscriptions`);
    } catch (e) {
      sdk.toast.error("Failed to hide", e instanceof Error ? e.message : String(e));
    }
  }

  async function unhideSubscription(merchant: string) {
    try {
      await sdk.execute(`
        DELETE FROM sys_plugin_subscriptions WHERE merchant = '${merchant.replace(/'/g, "''")}'
      `);
      const newHidden = new Set(hiddenMerchants);
      newHidden.delete(merchant);
      hiddenMerchants = newHidden;
      sdk.toast.info("Restored", `${merchant} is visible again`);
    } catch (e) {
      sdk.toast.error("Failed to restore", e instanceof Error ? e.message : String(e));
    }
  }

  function viewTransactions(merchant: string) {
    sdk.openView("transactions", {
      initialFilter: `description = '${merchant.replace(/'/g, "''")}'`
    });
  }

  function formatCurrency(amount: number): string {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(amount);
  }

  function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function toggleSort(column: typeof sortBy) {
    if (sortBy === column) {
      sortDesc = !sortDesc;
    } else {
      sortBy = column;
      sortDesc = true;
    }
  }
</script>

<div class="container" class:dark={theme === "dark"}>
  <header>
    <div class="header-left">
      <h1>Subscriptions</h1>
      <p class="subtitle">Automatically detected recurring charges</p>
    </div>
    <div class="header-right">
      <label class="toggle">
        <input type="checkbox" bind:checked={showHidden} />
        <span>Show hidden ({hiddenMerchants.size})</span>
      </label>
      <button class="btn secondary" onclick={() => detectSubscriptions()}>
        Refresh
      </button>
    </div>
  </header>

  {#if isLoading}
    <div class="loading">Analyzing transactions...</div>
  {:else if subscriptions.length === 0}
    <div class="empty">
      <p>No recurring subscriptions detected.</p>
      <p class="hint">Subscriptions are detected from transactions with regular intervals (weekly, monthly, etc.)</p>
    </div>
  {:else}
    <div class="summary-cards">
      <div class="summary-card">
        <span class="label">Monthly Cost</span>
        <span class="value">{formatCurrency(totalMonthlyCost)}</span>
      </div>
      <div class="summary-card">
        <span class="label">Annual Cost</span>
        <span class="value">{formatCurrency(totalAnnualCost)}</span>
      </div>
      <div class="summary-card">
        <span class="label">Active Subscriptions</span>
        <span class="value">{visibleSubscriptions.filter(s => !hiddenMerchants.has(s.merchant)).length}</span>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th class="sortable" onclick={() => toggleSort("merchant")}>
            Merchant {sortBy === "merchant" ? (sortDesc ? "↓" : "↑") : ""}
          </th>
          <th>Amount</th>
          <th>Frequency</th>
          <th class="sortable" onclick={() => toggleSort("annual_cost")}>
            Annual Cost {sortBy === "annual_cost" ? (sortDesc ? "↓" : "↑") : ""}
          </th>
          <th class="sortable" onclick={() => toggleSort("last_charge")}>
            Last Charge {sortBy === "last_charge" ? (sortDesc ? "↓" : "↑") : ""}
          </th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each sortedSubscriptions as sub}
          <tr class:hidden={hiddenMerchants.has(sub.merchant)}>
            <td class="merchant">{sub.merchant}</td>
            <td class="amount">{formatCurrency(sub.amount)}</td>
            <td class="frequency">
              <span class="badge">{sub.frequency}</span>
            </td>
            <td class="annual-cost">{formatCurrency(sub.annual_cost)}</td>
            <td class="date">{formatDate(sub.last_charge)}</td>
            <td class="actions">
              <button class="btn-icon" title="View transactions" onclick={() => viewTransactions(sub.merchant)}>
                🔍
              </button>
              {#if hiddenMerchants.has(sub.merchant)}
                <button class="btn-icon" title="Restore" onclick={() => unhideSubscription(sub.merchant)}>
                  👁
                </button>
              {:else}
                <button class="btn-icon" title="Hide (not a subscription)" onclick={() => hideSubscription(sub.merchant)}>
                  🙈
                </button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .container {
    padding: 24px;
    font-family: system-ui, -apple-system, sans-serif;
    color: #1a1a1a;
    background: #ffffff;
    min-height: 100%;
  }

  .container.dark {
    color: #e5e5e5;
    background: #1a1a1a;
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 24px;
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  h1 {
    font-size: 24px;
    font-weight: 600;
    margin: 0;
  }

  .subtitle {
    color: #666;
    margin: 4px 0 0;
    font-size: 14px;
  }

  .dark .subtitle {
    color: #888;
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: #666;
    cursor: pointer;
  }

  .dark .toggle {
    color: #888;
  }

  .btn {
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border: none;
  }

  .btn.secondary {
    background: #e5e7eb;
    color: #374151;
  }

  .dark .btn.secondary {
    background: #3a3a3a;
    color: #e5e5e5;
  }

  .btn.secondary:hover {
    background: #d1d5db;
  }

  .dark .btn.secondary:hover {
    background: #4a4a4a;
  }

  .loading, .empty {
    text-align: center;
    padding: 48px;
    color: #666;
  }

  .dark .loading, .dark .empty {
    color: #888;
  }

  .hint {
    font-size: 13px;
    margin-top: 8px;
  }

  .summary-cards {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    margin-bottom: 24px;
  }

  .summary-card {
    background: #f8f9fa;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .dark .summary-card {
    background: #2a2a2a;
    border-color: #3a3a3a;
  }

  .summary-card .label {
    font-size: 12px;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .dark .summary-card .label {
    color: #888;
  }

  .summary-card .value {
    font-size: 24px;
    font-weight: 600;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th, td {
    padding: 12px;
    text-align: left;
    border-bottom: 1px solid #e5e7eb;
  }

  .dark th, .dark td {
    border-color: #3a3a3a;
  }

  th {
    font-size: 12px;
    font-weight: 600;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .dark th {
    color: #888;
  }

  th.sortable {
    cursor: pointer;
  }

  th.sortable:hover {
    color: #3b82f6;
  }

  tr:hover {
    background: #f8f9fa;
  }

  .dark tr:hover {
    background: #2a2a2a;
  }

  tr.hidden {
    opacity: 0.5;
  }

  .merchant {
    font-weight: 500;
  }

  .amount, .annual-cost {
    font-family: ui-monospace, monospace;
    font-size: 13px;
  }

  .annual-cost {
    font-weight: 600;
    color: #dc2626;
  }

  .dark .annual-cost {
    color: #f87171;
  }

  .date {
    font-size: 13px;
    color: #666;
  }

  .dark .date {
    color: #888;
  }

  .badge {
    display: inline-block;
    padding: 2px 8px;
    background: #e0f2fe;
    color: #0369a1;
    font-size: 11px;
    font-weight: 500;
    border-radius: 4px;
    text-transform: uppercase;
  }

  .dark .badge {
    background: #1e3a5f;
    color: #7dd3fc;
  }

  .actions {
    display: flex;
    gap: 4px;
  }

  .btn-icon {
    width: 28px;
    height: 28px;
    padding: 0;
    border: none;
    background: transparent;
    cursor: pointer;
    border-radius: 4px;
    font-size: 14px;
  }

  .btn-icon:hover {
    background: #e5e7eb;
  }

  .dark .btn-icon:hover {
    background: #3a3a3a;
  }
</style>
