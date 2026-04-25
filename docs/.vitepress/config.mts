import { defineConfig } from "vitepress";

// VitePress site config for the Attesto documentation. Mirrors the
// babelon-docs pattern (default theme + custom CSS, local search, no
// Algolia signup). Brand color override (#EC4899) is in theme/custom.css.

// ────────────────────────────────────────────────────────────────────────────
// SITE CONSTANTS — single source of truth.
//
// To change any of these (contact email, API hostname, etc.), edit them
// here and rebuild. Markdown files reference these via:
//   - <ContactSection /> Vue component for the email (reads theme config)
//   - {{ATTESTO_API_HOST}} placeholder for the hostname (replaced by the
//     Vite plugin below at build time — works in code blocks too,
//     unlike Vue components)
//   - footer.message via template literal at build time
// ────────────────────────────────────────────────────────────────────────────
const SITE = {
  contactEmail: "nossteam@nossdev.com",
  contactName: "NOSS team",
  apiHost: "api.attesto.nossdev.com",
  githubUrl: "https://github.com/nossdev/attesto",
  orgUrl: "https://nossdev.com",
} as const;

// Tokens that the build-time Vite plugin replaces in every .md file.
// Add a new entry here + reference {{TOKEN}} in markdown to make any
// other value site-configurable.
const MD_PLACEHOLDERS: Record<string, string> = {
  "{{ATTESTO_API_HOST}}": SITE.apiHost,
};

export default defineConfig({
  title: "Attesto",
  description: "Receipt validation for Apple App Store and Google Play, without the headache.",
  cleanUrls: true,

  // Vite plugin: substitute `{{ATTESTO_API_HOST}}` (and any other tokens
  // added to MD_PLACEHOLDERS above) in every .md file at build time.
  // Runs before the markdown parser so the substitution shows up in
  // code blocks, prose, and frontmatter alike.
  vite: {
    plugins: [
      {
        name: "attesto-md-placeholders",
        enforce: "pre",
        transform(code: string, id: string) {
          if (!id.endsWith(".md")) return null;
          let out = code;
          for (const [token, value] of Object.entries(MD_PLACEHOLDERS)) {
            out = out.split(token).join(value);
          }
          return out === code ? null : { code: out, map: null };
        },
      },
    ],
  },

  head: [
    // The `?v=` query string forces browsers with the OLD favicon (cached
    // for a year by an earlier `immutable` cache-control rule that has
    // since been removed) to re-fetch. Bump the version when the favicon
    // file content changes.
    ["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg?v=2" }],
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
    // Navbar logo. Uses /attesto-logo.svg (the dedicated brand mark)
    // rather than /favicon.svg — both files have identical content but
    // different URLs, which sidesteps the year-long browser cache that
    // /favicon.svg accumulated before the immutable cache rule was
    // removed. /attesto-logo.svg is also semantically the right choice
    // (favicon.svg is for the browser tab icon).
    logo: "/attesto-logo.svg",
    siteTitle: "Attesto",

    // Custom extension — read by <ContactSection /> via useData().
    // Not a built-in VitePress field; lives alongside standard themeConfig.
    contact: {
      email: SITE.contactEmail,
      name: SITE.contactName,
    },

    nav: [
      {
        text: "Guide",
        items: [
          { text: "What is Attesto?", link: "/guide/what-is-attesto" },
          { text: "Quickstart", link: "/guide/quickstart" },
          { text: "Architecture", link: "/guide/architecture" },
          { text: "Integration guide", link: "/guide/integration" },
        ],
      },
      {
        text: "Operate",
        items: [
          { text: "Onboarding a tenant", link: "/guide/onboarding" },
          { text: "Apple setup", link: "/guide/apple-setup" },
          { text: "Google setup", link: "/guide/google-setup" },
          { text: "Tenants", link: "/guide/tenants" },
          { text: "Webhooks", link: "/guide/webhooks" },
          { text: "Deployment", link: "/guide/deployment" },
          { text: "Operations", link: "/guide/operations" },
          { text: "Maintenance", link: "/guide/maintenance" },
          { text: "Testing", link: "/guide/testing" },
          { text: "Load testing", link: "/guide/load-testing" },
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
      { text: "GitHub", link: SITE.githubUrl },
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
          text: "For integrators",
          items: [
            { text: "Integration guide", link: "/guide/integration" },
            { text: "Webhooks", link: "/guide/webhooks" },
          ],
        },
        {
          text: "For operators — tenant setup",
          items: [
            { text: "Onboarding a tenant", link: "/guide/onboarding" },
            { text: "Apple setup", link: "/guide/apple-setup" },
            { text: "Google setup", link: "/guide/google-setup" },
            { text: "Tenants", link: "/guide/tenants" },
          ],
        },
        {
          text: "For operators — running it",
          items: [
            { text: "Deployment", link: "/guide/deployment" },
            { text: "Operations", link: "/guide/operations" },
            { text: "Maintenance", link: "/guide/maintenance" },
            { text: "Testing", link: "/guide/testing" },
            { text: "Load testing", link: "/guide/load-testing" },
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
      { icon: "github", link: SITE.githubUrl },
    ],

    search: {
      provider: "local",
    },

    footer: {
      message:
        `Released under the MIT License. Contact: <a href="mailto:${SITE.contactEmail}">${SITE.contactEmail}</a> · Built by <a href="${SITE.orgUrl}">Night Owl Software Studios</a>.`,
      copyright: "Copyright © 2026 nossdev",
    },

    editLink: {
      pattern: "https://github.com/nossdev/attesto/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
  },
});
