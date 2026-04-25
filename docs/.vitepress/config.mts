import { defineConfig } from "vitepress";

// VitePress site config for the Attesto documentation. Mirrors the
// babelon-docs pattern (default theme + custom CSS, local search, no
// Algolia signup). Brand color override (#EC4899) is in theme/custom.css.

export default defineConfig({
  title: "Attesto",
  description: "Receipt validation for Apple App Store and Google Play, without the headache.",
  cleanUrls: true,

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    ["meta", { name: "theme-color", content: "#EC4899" }],
    ["meta", { property: "og:title", content: "Attesto — Receipt validation done right" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "Open-source receipt validation proxy for Apple App Store and Google Play. Verify purchase tokens, ingest webhooks, forward signed events. Self-host or managed.",
      },
    ],
    ["meta", { property: "og:type", content: "website" }],
  ],

  themeConfig: {
    logo: "/favicon.svg",
    siteTitle: "Attesto",

    nav: [
      {
        text: "Guide",
        items: [
          { text: "What is Attesto?", link: "/guide/what-is-attesto" },
          { text: "Quickstart", link: "/guide/quickstart" },
          { text: "Architecture", link: "/guide/architecture" },
          { text: "Apple setup", link: "/guide/apple-setup" },
          { text: "Google setup", link: "/guide/google-setup" },
          { text: "Tenants", link: "/guide/tenants" },
          { text: "Webhooks", link: "/guide/webhooks" },
          { text: "Deployment", link: "/guide/deployment" },
          { text: "Operations", link: "/guide/operations" },
          { text: "Maintenance", link: "/guide/maintenance" },
          { text: "Testing", link: "/guide/testing" },
          { text: "Troubleshooting", link: "/guide/troubleshooting" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "API", link: "/reference/api" },
          { text: "Error codes", link: "/reference/error-codes" },
        ],
      },
      { text: "GitHub", link: "https://github.com/nossdev/attesto" },
    ],

    sidebar: {
      "/guide/": [
        {
          text: "Getting started",
          items: [
            { text: "What is Attesto?", link: "/guide/what-is-attesto" },
            { text: "Quickstart", link: "/guide/quickstart" },
            { text: "Architecture", link: "/guide/architecture" },
          ],
        },
        {
          text: "Setup",
          items: [
            { text: "Apple setup", link: "/guide/apple-setup" },
            { text: "Google setup", link: "/guide/google-setup" },
            { text: "Tenants", link: "/guide/tenants" },
            { text: "Webhooks", link: "/guide/webhooks" },
          ],
        },
        {
          text: "Running it",
          items: [
            { text: "Deployment", link: "/guide/deployment" },
            { text: "Operations", link: "/guide/operations" },
            { text: "Maintenance", link: "/guide/maintenance" },
            { text: "Testing", link: "/guide/testing" },
            { text: "Troubleshooting", link: "/guide/troubleshooting" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "API", link: "/reference/api" },
            { text: "Error codes", link: "/reference/error-codes" },
          ],
        },
      ],
    },

    outline: { level: [2, 3] },

    socialLinks: [
      { icon: "github", link: "https://github.com/nossdev/attesto" },
    ],

    search: {
      provider: "local",
    },

    footer: {
      message:
        'Released under the MIT License. Built by <a href="https://nossdev.com">Night Owl Software Studios</a>.',
      copyright: "Copyright © 2026 nossdev",
    },

    editLink: {
      pattern: "https://github.com/nossdev/attesto/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
  },
});
