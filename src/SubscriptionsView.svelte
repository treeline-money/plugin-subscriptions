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
  let searchQuery = $state("");
  let cursorIndex = $state(0);

  // Refs
  let containerEl = $state<HTMLDivElement | null>(null);
  let searchInputEl = $state<HTMLInputElement | null>(null);

  // Computed
  let visibleSubscriptions = $derived(
    subscriptions.filter(s => {
      const isHidden = hiddenMerchants.has(s.merchant);
      if (!showHidden && isHidden) return false;
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        return s.merchant.toLowerCase().includes(query);
      }
      return true;
    })
  );

  let sortedSubscriptions = $derived(
    [...visibleSubscriptions].sort((a, b) => b.annual_cost - a.annual_cost)
  );

  let activeCount = $derived(
    subscriptions.filter(s => !hiddenMerchants.has(s.merchant)).length
  );

  let hiddenCount = $derived(hiddenMerchants.size);

  let totalAnnualCost = $derived(
    subscriptions
      .filter(s => !hiddenMerchants.has(s.merchant))
      .reduce((sum, s) => sum + s.annual_cost, 0)
  );

  let totalMonthlyCost = $derived(totalAnnualCost / 12);

  let selectedSubscription = $derived(sortedSubscriptions[cursorIndex] || null);

  // Lifecycle
  let unsubscribe: (() => void) | null = null;

  onMount(async () => {
    unsubscribe = sdk.onDataRefresh(() => {
      detectSubscriptions();
    });

    await ensureTable();
    await loadHiddenMerchants();
    await detectSubscriptions();

    // Focus container for keyboard nav
    containerEl?.focus();
  });

  onDestroy(() => {
    if (unsubscribe) unsubscribe();
  });

  // Database
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

  async function detectSubscriptions() {
    isLoading = true;
    try {
      const rows = await sdk.query<any>(`
        WITH merchant_transactions AS (
          SELECT
            description as merchant,
            amount,
            transaction_date,
            LAG(transaction_date) OVER (PARTITION BY description ORDER BY transaction_date) as prev_date
          FROM transactions
          WHERE amount < 0
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
            COUNT(*) >= 2
            AND AVG(interval_days) BETWEEN 5 AND 400
            AND STDDEV(interval_days) < AVG(interval_days) * 0.3
        )
        SELECT * FROM merchant_stats
        ORDER BY avg_amount * (365.0 / avg_interval) DESC
      `);

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

        return {
          merchant,
          amount: Math.round(avg_amount * 100) / 100,
          frequency,
          interval_days: intervalDays,
          occurrence_count,
          annual_cost: Math.round(avg_amount * (365 / intervalDays) * 100) / 100,
          last_charge,
          first_charge,
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
      sdk.toast.info("Hidden", `"${merchant}" marked as not a subscription`);
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
      sdk.toast.info("Restored", `"${merchant}" is visible again`);
    } catch (e) {
      sdk.toast.error("Failed to restore", e instanceof Error ? e.message : String(e));
    }
  }

  function viewTransactions(merchant: string) {
    sdk.openView("transactions", {
      initialFilter: `description = '${merchant.replace(/'/g, "''")}'`
    });
  }

  // Formatting
  function formatCurrency(amount: number): string {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(amount);
  }

  function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function formatFrequency(freq: string): string {
    return freq.charAt(0).toUpperCase() + freq.slice(1);
  }

  // Keyboard navigation
  function handleKeyDown(e: KeyboardEvent) {
    // Ignore if typing in search
    if (document.activeElement === searchInputEl) {
      if (e.key === "Escape") {
        searchQuery = "";
        searchInputEl?.blur();
        containerEl?.focus();
      }
      return;
    }

    const sub = selectedSubscription;

    switch (e.key) {
      case "j":
      case "ArrowDown":
        e.preventDefault();
        cursorIndex = Math.min(cursorIndex + 1, sortedSubscriptions.length - 1);
        break;
      case "k":
      case "ArrowUp":
        e.preventDefault();
        cursorIndex = Math.max(cursorIndex - 1, 0);
        break;
      case "Enter":
        if (sub) {
          e.preventDefault();
          viewTransactions(sub.merchant);
        }
        break;
      case "h":
        if (sub) {
          e.preventDefault();
          if (hiddenMerchants.has(sub.merchant)) {
            unhideSubscription(sub.merchant);
          } else {
            hideSubscription(sub.merchant);
          }
        }
        break;
      case "/":
        e.preventDefault();
        searchInputEl?.focus();
        break;
      case "Escape":
        searchQuery = "";
        break;
    }
  }

  // Keep cursor in bounds when list changes
  $effect(() => {
    if (cursorIndex >= sortedSubscriptions.length) {
      cursorIndex = Math.max(0, sortedSubscriptions.length - 1);
    }
  });
</script>

<div
  class="subscriptions-view"
  bind:this={containerEl}
  onkeydown={handleKeyDown}
  tabindex="-1"
  role="application"
>
  <!-- Header -->
  <header class="header">
    <div class="title-row">
      <h1 class="title">Subscriptions</h1>
      {#if !isLoading}
        <span class="count-badge">{activeCount} active</span>
        {#if hiddenCount > 0}
          <span class="hidden-badge">{hiddenCount} hidden</span>
        {/if}
      {/if}
      <div class="header-spacer"></div>
      <button class="refresh-btn" onclick={() => detectSubscriptions()} disabled={isLoading}>
        Refresh
      </button>
    </div>
  </header>

  <!-- Filter Bar -->
  <div class="filter-bar">
    <div class="search-container">
      <span class="search-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/>
          <path d="M21 21l-4.35-4.35"/>
        </svg>
      </span>
      <input
        type="text"
        class="search-input"
        placeholder="Search subscriptions... (/ to focus)"
        bind:value={searchQuery}
        bind:this={searchInputEl}
      />
      {#if searchQuery}
        <button class="clear-search" onclick={() => { searchQuery = ""; containerEl?.focus(); }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      {/if}
    </div>
    <button
      class="filter-toggle"
      class:active={showHidden}
      onclick={() => showHidden = !showHidden}
    >
      <span class="toggle-track">
        <span class="toggle-thumb"></span>
      </span>
      <span class="toggle-label">Show hidden</span>
    </button>
  </div>

  <!-- Main Content -->
  <div class="main-content">
    {#if isLoading}
      <div class="loading">
        <div class="spinner"></div>
        <span>Analyzing transactions...</span>
      </div>
    {:else if sortedSubscriptions.length === 0}
      <div class="empty">
        {#if searchQuery}
          <p class="empty-message">No subscriptions matching "{searchQuery}"</p>
        {:else}
          <p class="empty-message">No recurring subscriptions detected.</p>
          <p class="empty-hint">Subscriptions are found by analyzing transaction patterns.</p>
        {/if}
      </div>
    {:else}
      <div class="split-view">
        <!-- Table -->
        <div class="table-container">
          <table class="table">
            <thead>
              <tr>
                <th class="col-merchant">Merchant</th>
                <th class="col-amount">Amount</th>
                <th class="col-frequency">Frequency</th>
                <th class="col-annual">Annual</th>
              </tr>
            </thead>
            <tbody>
              {#each sortedSubscriptions as sub, i}
                <tr
                  class:selected={i === cursorIndex}
                  class:hidden={hiddenMerchants.has(sub.merchant)}
                  onclick={() => cursorIndex = i}
                  ondblclick={() => viewTransactions(sub.merchant)}
                >
                  <td class="col-merchant">
                    <span class="merchant-name">{sub.merchant}</span>
                  </td>
                  <td class="col-amount">{formatCurrency(sub.amount)}</td>
                  <td class="col-frequency">
                    <span class="frequency-badge">{sub.frequency}</span>
                  </td>
                  <td class="col-annual">{formatCurrency(sub.annual_cost)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        <!-- Sidebar -->
        <aside class="sidebar">
          {#if selectedSubscription}
            {@const sub = selectedSubscription}
            {@const isHidden = hiddenMerchants.has(sub.merchant)}
            <div class="sidebar-section">
              <h3 class="sidebar-title">Selected</h3>
              <div class="detail-card">
                <div class="detail-merchant">{sub.merchant}</div>
                {#if isHidden}
                  <span class="hidden-indicator">Hidden</span>
                {/if}
              </div>
            </div>

            <div class="sidebar-section">
              <div class="detail-row">
                <span class="detail-label">Amount</span>
                <span class="detail-value">{formatCurrency(sub.amount)}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Frequency</span>
                <span class="detail-value">{formatFrequency(sub.frequency)}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Annual Cost</span>
                <span class="detail-value cost">{formatCurrency(sub.annual_cost)}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Last Charge</span>
                <span class="detail-value">{formatDate(sub.last_charge)}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">First Seen</span>
                <span class="detail-value">{formatDate(sub.first_charge)}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Occurrences</span>
                <span class="detail-value">{sub.occurrence_count}</span>
              </div>
            </div>

            <div class="sidebar-section sidebar-actions">
              <button class="action-btn primary" onclick={() => viewTransactions(sub.merchant)}>
                View Transactions
              </button>
              {#if isHidden}
                <button class="action-btn" onclick={() => unhideSubscription(sub.merchant)}>
                  Restore
                </button>
              {:else}
                <button class="action-btn" onclick={() => hideSubscription(sub.merchant)}>
                  Hide (Not a Subscription)
                </button>
              {/if}
            </div>
          {:else}
            <div class="sidebar-empty">
              <p>Select a subscription to see details</p>
            </div>
          {/if}

          <div class="sidebar-section summary">
            <h3 class="sidebar-title">Summary</h3>
            <div class="summary-row">
              <span class="summary-label">Monthly</span>
              <span class="summary-value">{formatCurrency(totalMonthlyCost)}</span>
            </div>
            <div class="summary-row">
              <span class="summary-label">Annual</span>
              <span class="summary-value">{formatCurrency(totalAnnualCost)}</span>
            </div>
          </div>
        </aside>
      </div>
    {/if}
  </div>

  <!-- Keyboard Hints -->
  <footer class="keyboard-hints">
    <span class="hint"><kbd>j</kbd><kbd>k</kbd> nav</span>
    <span class="hint"><kbd>Enter</kbd> view txns</span>
    <span class="hint"><kbd>h</kbd> hide/restore</span>
    <span class="hint"><kbd>/</kbd> search</span>
  </footer>
</div>

<style>
  .subscriptions-view {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-family: var(--font-sans, system-ui, -apple-system, sans-serif);
    outline: none;
  }

  /* Header */
  .header {
    padding: var(--spacing-md, 12px) var(--spacing-lg, 16px);
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-primary);
  }

  .title-row {
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

  .count-badge {
    font-size: 11px;
    font-weight: 500;
    color: var(--accent-primary);
    padding: 2px 8px;
    background: rgba(88, 166, 255, 0.1);
    border-radius: 10px;
  }

  .hidden-badge {
    font-size: 11px;
    font-weight: 500;
    color: var(--text-muted);
    padding: 2px 8px;
    background: var(--bg-tertiary);
    border-radius: 10px;
  }

  .header-spacer {
    flex: 1;
  }

  .refresh-btn {
    padding: 4px 10px;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }

  .refresh-btn:hover:not(:disabled) {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  .refresh-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Filter Bar */
  .filter-bar {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm, 8px);
    padding: var(--spacing-sm, 8px);
    background: var(--bg-primary);
    border-bottom: 1px solid var(--border-primary);
  }

  .search-container {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    height: 36px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
  }

  .search-container:focus-within {
    border-color: var(--accent-primary);
  }

  .search-icon {
    color: var(--text-muted);
    display: flex;
    align-items: center;
  }

  .search-input {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--text-primary);
    font-size: 14px;
    outline: none;
  }

  .search-input::placeholder {
    color: var(--text-muted);
  }

  .clear-search {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px;
    display: flex;
    align-items: center;
  }

  .clear-search:hover {
    color: var(--text-primary);
  }

  .filter-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    height: 36px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    cursor: pointer;
  }

  .filter-toggle:hover {
    border-color: var(--text-muted);
  }

  .filter-toggle.active {
    background: var(--accent-primary);
    border-color: var(--accent-primary);
  }

  .toggle-track {
    width: 28px;
    height: 16px;
    background: var(--bg-tertiary);
    border-radius: 8px;
    position: relative;
  }

  .filter-toggle.active .toggle-track {
    background: rgba(255, 255, 255, 0.3);
  }

  .toggle-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    background: var(--text-muted);
    border-radius: 50%;
    transition: left 0.2s;
  }

  .filter-toggle.active .toggle-thumb {
    left: 14px;
    background: white;
  }

  .toggle-label {
    font-size: 12px;
    color: var(--text-secondary);
    font-weight: 500;
  }

  .filter-toggle.active .toggle-label {
    color: white;
  }

  /* Main Content */
  .main-content {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .loading, .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    gap: var(--spacing-md, 12px);
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

  .empty-message {
    font-size: 14px;
    margin: 0;
  }

  .empty-hint {
    font-size: 12px;
    margin: 0;
  }

  /* Split View */
  .split-view {
    flex: 1;
    display: flex;
    overflow: hidden;
  }

  /* Table */
  .table-container {
    flex: 1;
    overflow-y: auto;
    min-width: 0;
  }

  .table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  .table thead {
    position: sticky;
    top: 0;
    background: var(--bg-secondary);
    z-index: 1;
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
  }

  .table td {
    padding: var(--spacing-sm, 8px) var(--spacing-md, 12px);
    border-bottom: 1px solid var(--border-primary);
  }

  .table tbody tr {
    cursor: pointer;
  }

  .table tbody tr:hover {
    background: var(--bg-secondary);
  }

  .table tbody tr.selected {
    background: var(--bg-active, rgba(88, 166, 255, 0.1));
  }

  .table tbody tr.hidden {
    opacity: 0.5;
  }

  .col-merchant {
    min-width: 200px;
  }

  .col-amount, .col-annual {
    font-family: var(--font-mono, monospace);
    text-align: right;
    white-space: nowrap;
  }

  .col-frequency {
    white-space: nowrap;
  }

  .merchant-name {
    font-weight: 500;
    color: var(--text-primary);
  }

  .frequency-badge {
    display: inline-block;
    padding: 2px 6px;
    background: var(--bg-tertiary);
    color: var(--accent-primary);
    font-size: 10px;
    font-weight: 600;
    border-radius: 4px;
    text-transform: uppercase;
  }

  /* Sidebar */
  .sidebar {
    width: 280px;
    background: var(--bg-secondary);
    border-left: 1px solid var(--border-primary);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }

  .sidebar-section {
    padding: var(--spacing-md, 12px);
    border-bottom: 1px solid var(--border-primary);
  }

  .sidebar-section:last-child {
    border-bottom: none;
  }

  .sidebar-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 0 0 var(--spacing-sm, 8px) 0;
  }

  .detail-card {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm, 8px);
  }

  .detail-merchant {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    word-break: break-word;
  }

  .hidden-indicator {
    font-size: 10px;
    color: var(--text-muted);
    background: var(--bg-tertiary);
    padding: 2px 6px;
    border-radius: 4px;
  }

  .detail-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 0;
  }

  .detail-label {
    font-size: 12px;
    color: var(--text-muted);
  }

  .detail-value {
    font-size: 12px;
    color: var(--text-primary);
    font-family: var(--font-mono, monospace);
  }

  .detail-value.cost {
    color: var(--accent-danger, #f85149);
    font-weight: 600;
  }

  .sidebar-actions {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-sm, 8px);
  }

  .action-btn {
    width: 100%;
    padding: 8px 12px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid var(--border-primary);
    background: var(--bg-tertiary);
    color: var(--text-primary);
    transition: all 0.15s;
  }

  .action-btn:hover {
    background: var(--bg-primary);
  }

  .action-btn.primary {
    background: var(--accent-primary);
    border-color: var(--accent-primary);
    color: var(--bg-primary);
  }

  .action-btn.primary:hover {
    opacity: 0.9;
  }

  .sidebar-empty {
    padding: var(--spacing-lg, 16px);
    text-align: center;
    color: var(--text-muted);
    font-size: 12px;
  }

  .summary {
    margin-top: auto;
    background: var(--bg-tertiary);
  }

  .summary-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 0;
  }

  .summary-label {
    font-size: 12px;
    color: var(--text-secondary);
  }

  .summary-value {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    font-family: var(--font-mono, monospace);
  }

  /* Keyboard Hints */
  .keyboard-hints {
    display: flex;
    align-items: center;
    gap: var(--spacing-lg, 16px);
    padding: var(--spacing-sm, 8px) var(--spacing-md, 12px);
    background: var(--bg-secondary);
    border-top: 1px solid var(--border-primary);
    font-size: 11px;
    color: var(--text-muted);
  }

  .hint {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .hint kbd {
    display: inline-block;
    padding: 2px 5px;
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: 3px;
    font-family: var(--font-mono, monospace);
    font-size: 10px;
  }
</style>
