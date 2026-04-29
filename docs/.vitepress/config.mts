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
  description:
    "Receipt validation for Apple App Store and Google Play, without the headache.",
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
    ["meta", {
      property: "og:title",
      content: "Attesto — Receipt validation done right",
    }],
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
        text: "Integrate",
        items: [
          { text: "What is Attesto?", link: "/guide/what-is-attesto" },
          { text: "Quickstart", link: "/guide/quickstart" },
          { text: "Architecture", link: "/guide/architecture" },
          { text: "Integration guide", link: "/guide/integration" },
        ],
      },
      {
        text: "Recipes",
        items: [
          { text: "Overview", link: "/recipes/" },
          { text: "Deno + Hono", link: "/recipes/deno" },
          { text: "Node + Express", link: "/recipes/node" },
          { text: "Python + FastAPI", link: "/recipes/python" },
          { text: "Java + Spring Boot", link: "/recipes/java" },
          { text: "Ruby + Sinatra", link: "/recipes/ruby" },
        ],
      },
      {
        text: "Self-host",
        items: [
          { text: "Overview", link: "/self-host/" },
          { text: "Quickstart", link: "/self-host/quickstart" },
          { text: "Onboarding a tenant", link: "/self-host/onboarding" },
          { text: "Apple setup", link: "/self-host/apple-setup" },
          { text: "Google setup", link: "/self-host/google-setup" },
          { text: "Tenants", link: "/self-host/tenants" },
          { text: "Webhooks", link: "/self-host/webhooks" },
          { text: "Deployment", link: "/self-host/deployment" },
          { text: "Operations", link: "/self-host/operations" },
          { text: "Maintenance", link: "/self-host/maintenance" },
          { text: "Testing", link: "/self-host/testing" },
          { text: "Load testing", link: "/self-host/load-testing" },
          { text: "Troubleshooting", link: "/self-host/troubleshooting" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "API", link: "/reference/api" },
          { text: "Webhooks", link: "/reference/webhooks" },
          { text: "Error codes", link: "/reference/error-codes" },
          { text: "Glossary", link: "/reference/glossary" },
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
          text: "Integrate",
          items: [
            { text: "Integration guide", link: "/guide/integration" },
          ],
        },
        {
          text: "Backend recipes",
          items: [
            { text: "Overview", link: "/recipes/" },
            { text: "Deno + Hono", link: "/recipes/deno" },
            { text: "Node + Express", link: "/recipes/node" },
            { text: "Python + FastAPI", link: "/recipes/python" },
            { text: "Java + Spring Boot", link: "/recipes/java" },
            { text: "Ruby + Sinatra", link: "/recipes/ruby" },
          ],
        },
      ],
      "/recipes/": [
        {
          text: "Backend recipes",
          items: [
            { text: "Overview", link: "/recipes/" },
            { text: "Deno + Hono", link: "/recipes/deno" },
            { text: "Node + Express", link: "/recipes/node" },
            { text: "Python + FastAPI", link: "/recipes/python" },
            { text: "Java + Spring Boot", link: "/recipes/java" },
            { text: "Ruby + Sinatra", link: "/recipes/ruby" },
          ],
        },
        {
          text: "Back to integrate",
          items: [
            { text: "Integration guide", link: "/guide/integration" },
            { text: "Quickstart", link: "/guide/quickstart" },
          ],
        },
      ],
      "/self-host/": [
        {
          text: "Getting started",
          items: [
            { text: "Overview", link: "/self-host/" },
            { text: "Quickstart", link: "/self-host/quickstart" },
          ],
        },
        {
          text: "Tenant setup",
          items: [
            { text: "Onboarding a tenant", link: "/self-host/onboarding" },
            {
              text: "Staging tenant alongside prod",
              link: "/self-host/staging-tenant",
            },
            { text: "Apple setup", link: "/self-host/apple-setup" },
            { text: "Google setup", link: "/self-host/google-setup" },
            { text: "Webhooks", link: "/self-host/webhooks" },
            { text: "Tenants", link: "/self-host/tenants" },
          ],
        },
        {
          text: "Operating it",
          items: [
            { text: "Deployment", link: "/self-host/deployment" },
            { text: "Operations", link: "/self-host/operations" },
            { text: "Maintenance", link: "/self-host/maintenance" },
            { text: "Testing", link: "/self-host/testing" },
            { text: "Load testing", link: "/self-host/load-testing" },
            { text: "Troubleshooting", link: "/self-host/troubleshooting" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "API", link: "/reference/api" },
            { text: "Webhooks", link: "/reference/webhooks" },
            { text: "Error codes", link: "/reference/error-codes" },
            { text: "Glossary", link: "/reference/glossary" },
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
