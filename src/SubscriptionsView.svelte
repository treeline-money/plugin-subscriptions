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

  function getSortIndicator(column: typeof sortBy): string {
    if (sortBy !== column) return "";
    return sortDesc ? " \u2193" : " \u2191";
  }
</script>

<div class="view">
  <header class="header">
    <div class="header-left">
      <h1 class="title">Subscriptions</h1>
      <p class="subtitle">Automatically detected recurring charges</p>
    </div>
    <div class="header-right">
      <label class="checkbox">
        <input type="checkbox" bind:checked={showHidden} />
        <span>Show hidden ({hiddenMerchants.size})</span>
      </label>
      <button class="btn secondary" onclick={() => detectSubscriptions()}>
        Refresh
      </button>
    </div>
  </header>

  {#if isLoading}
    <div class="loading">
      <div class="spinner"></div>
      <span>Analyzing transactions...</span>
    </div>
  {:else if subscriptions.length === 0}
    <div class="empty">
      <div class="empty-icon">$</div>
      <p class="empty-title">No subscriptions detected</p>
      <p class="empty-message">Subscriptions are detected from transactions with regular intervals (weekly, monthly, etc.)</p>
    </div>
  {:else}
    <div class="content">
      <div class="cards">
        <div class="card">
          <span class="card-label">Monthly Cost</span>
          <span class="card-value">{formatCurrency(totalMonthlyCost)}</span>
        </div>
        <div class="card">
          <span class="card-label">Annual Cost</span>
          <span class="card-value">{formatCurrency(totalAnnualCost)}</span>
        </div>
        <div class="card">
          <span class="card-label">Active Subscriptions</span>
          <span class="card-value">{visibleSubscriptions.filter(s => !hiddenMerchants.has(s.merchant)).length}</span>
        </div>
      </div>

      <div class="table-container">
        <table class="table">
          <thead>
            <tr>
              <th class="sortable" onclick={() => toggleSort("merchant")}>
                Merchant{getSortIndicator("merchant")}
              </th>
              <th>Amount</th>
              <th>Frequency</th>
              <th class="sortable" onclick={() => toggleSort("annual_cost")}>
                Annual Cost{getSortIndicator("annual_cost")}
              </th>
              <th class="sortable" onclick={() => toggleSort("last_charge")}>
                Last Charge{getSortIndicator("last_charge")}
              </th>
              <th class="actions-header">Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each sortedSubscriptions as sub}
              <tr class:muted={hiddenMerchants.has(sub.merchant)}>
                <td class="merchant">{sub.merchant}</td>
                <td class="mono">{formatCurrency(sub.amount)}</td>
                <td>
                  <span class="badge">{sub.frequency}</span>
                </td>
                <td class="mono cost">{formatCurrency(sub.annual_cost)}</td>
                <td class="date">{formatDate(sub.last_charge)}</td>
                <td class="actions">
                  <button class="btn-icon" title="View transactions" onclick={() => viewTransactions(sub.merchant)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="11" cy="11" r="8"/>
                      <path d="M21 21l-4.35-4.35"/>
                    </svg>
                  </button>
                  {#if hiddenMerchants.has(sub.merchant)}
                    <button class="btn-icon" title="Restore" onclick={() => unhideSubscription(sub.merchant)}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                        <circle cx="12" cy="12" r="3"/>
                      </svg>
                    </button>
                  {:else}
                    <button class="btn-icon" title="Hide (not a subscription)" onclick={() => hideSubscription(sub.merchant)}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                        <line x1="1" y1="1" x2="23" y2="23"/>
                      </svg>
                    </button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>

<style>
  /* Base Layout - matches app patterns */
  .view {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-family: var(--font-sans, system-ui, -apple-system, sans-serif);
  }

  /* Header */
  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding: var(--spacing-md, 12px) var(--spacing-lg, 16px);
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-primary);
  }

  .header-left {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xs, 4px);
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: var(--spacing-md, 12px);
  }

  .title {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .subtitle {
    font-size: 12px;
    color: var(--text-muted);
    margin: 0;
  }

  /* Content */
  .content {
    flex: 1;
    overflow-y: auto;
    padding: var(--spacing-lg, 16px);
  }

  /* Cards */
  .cards {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--spacing-md, 12px);
    margin-bottom: var(--spacing-lg, 16px);
  }

  .card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md, 6px);
    padding: var(--spacing-md, 12px);
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xs, 4px);
  }

  .card-label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 500;
  }

  .card-value {
    font-size: 24px;
    font-weight: 600;
    color: var(--text-primary);
  }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: var(--radius-sm, 4px);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    border: none;
    transition: all 0.15s;
  }

  .btn.secondary {
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border: 1px solid var(--border-primary);
  }

  .btn.secondary:hover {
    background: var(--bg-primary);
  }

  .btn-icon {
    width: 28px;
    height: 28px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm, 4px);
    color: var(--text-secondary);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
  }

  .btn-icon:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  /* Checkbox */
  .checkbox {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm, 8px);
    font-size: 12px;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .checkbox input {
    accent-color: var(--accent-primary);
  }

  /* Table */
  .table-container {
    overflow-x: auto;
  }

  .table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  .table th {
    text-align: left;
    padding: var(--spacing-sm, 8px) var(--spacing-md, 12px);
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border-bottom: 2px solid var(--border-primary);
    white-space: nowrap;
  }

  .table th.sortable {
    cursor: pointer;
    user-select: none;
  }

  .table th.sortable:hover {
    color: var(--text-primary);
  }

  .table th.actions-header {
    text-align: right;
  }

  .table td {
    padding: var(--spacing-sm, 8px) var(--spacing-md, 12px);
    border-bottom: 1px solid var(--border-primary);
  }

  .table tbody tr:hover {
    background: var(--bg-secondary);
  }

  .table tbody tr.muted {
    opacity: 0.5;
  }

  .merchant {
    font-weight: 500;
    color: var(--text-primary);
  }

  .mono {
    font-family: var(--font-mono, monospace);
  }

  .cost {
    font-weight: 600;
    color: var(--accent-danger, #f85149);
  }

  .date {
    color: var(--text-muted);
    font-size: 12px;
  }

  .actions {
    display: flex;
    gap: var(--spacing-xs, 4px);
    justify-content: flex-end;
  }

  /* Badge */
  .badge {
    display: inline-block;
    padding: 3px 8px;
    background: var(--bg-tertiary);
    color: var(--accent-primary);
    font-size: 10px;
    font-weight: 600;
    border-radius: var(--radius-sm, 4px);
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  /* Loading */
  .loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    gap: var(--spacing-md, 12px);
    color: var(--text-muted);
  }

  .spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--border-primary);
    border-top-color: var(--accent-primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Empty State */
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    text-align: center;
    padding: var(--spacing-xl, 24px);
    color: var(--text-muted);
  }

  .empty-icon {
    font-size: 48px;
    font-weight: 600;
    color: var(--accent-primary);
    opacity: 0.3;
    margin-bottom: var(--spacing-md, 12px);
  }

  .empty-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 var(--spacing-sm, 8px) 0;
  }

  .empty-message {
    font-size: 13px;
    margin: 0;
    max-width: 400px;
  }
</style>
