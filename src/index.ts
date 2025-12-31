import type { Plugin, PluginContext, PluginSDK, PluginMigration } from "@treeline-money/plugin-sdk";
import SubscriptionsView from "./SubscriptionsView.svelte";
import { mount, unmount } from "svelte";

// Database migrations - run in order by version when plugin loads
const migrations: PluginMigration[] = [
  {
    version: 1,
    name: "create_subscriptions_table",
    up: `
      CREATE TABLE IF NOT EXISTS plugin_subscriptions.subscriptions (
        merchant_key VARCHAR PRIMARY KEY,
        hidden_at TIMESTAMP
      )
    `,
  },
];

export const plugin: Plugin = {
  manifest: {
    id: "subscriptions",
    name: "Subscriptions",
    version: "0.1.0",
    description: "Detect recurring charges and track subscription costs",
    author: "Treeline",
    permissions: {
      read: ["transactions"],
      schemaName: "plugin_subscriptions",
    },
  },

  migrations,

  activate(context: PluginContext) {
    // Register the subscriptions view
    context.registerView({
      id: "subscriptions",
      name: "Subscriptions",
      icon: "repeat",
      mount: (target: HTMLElement, props: { sdk: PluginSDK }) => {
        const instance = mount(SubscriptionsView, {
          target,
          props,
        });

        return () => {
          unmount(instance);
        };
      },
    });

    // Add sidebar item
    context.registerSidebarItem({
      sectionId: "main",
      id: "subscriptions",
      label: "Subscriptions",
      icon: "repeat",
      viewId: "subscriptions",
    });

    // Register command for quick access
    context.registerCommand({
      id: "subscriptions.open",
      name: "View Subscriptions",
      description: "Open the subscriptions view to see recurring charges",
      execute: () => {
        context.openView("subscriptions");
      },
    });

    console.log("✓ Subscriptions plugin loaded");
  },

  deactivate() {
    console.log("Subscriptions plugin deactivated");
  },
};
