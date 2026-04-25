<!--
  ContactSection — drops a "get help" block with a mailto: link onto any
  markdown page.

  Reads the contact email from theme config (`docs/.vitepress/config.mts`
  → `themeConfig.contact.email`). To change the address, edit `SITE.contactEmail`
  in config.mts; this component picks up the new value on next build.

  Usage in markdown:

      <ContactSection />

  Component is registered globally in `theme/index.ts`, so no per-page
  imports are needed.
-->
<script setup lang="ts">
import { useData } from "vitepress";
import { computed } from "vue";

const { theme } = useData();
const email = computed(() => (theme.value as { contact?: { email?: string } }).contact?.email ?? "");
const name = computed(() => (theme.value as { contact?: { name?: string } }).contact?.name ?? "");
</script>

<template>
  <div class="contact-section">
    <h2>Get in touch</h2>
    <p>
      Questions about integrating Attesto? Need help onboarding? Looking
      for managed hosting so you don't operate it yourself? The {{ name }}
      reads every email.
    </p>
    <p class="contact-cta">
      <a :href="`mailto:${email}`" class="contact-link">{{ email }}</a>
    </p>
  </div>
</template>

<style scoped>
/* Transparent by default — relies on the parent section for visual
 * treatment. Used standalone in markdown? It still reads fine as
 * centered prose; the email is the visual emphasis. */
.contact-section {
  margin: 0 auto;
  padding: 0;
  max-width: 640px;
  text-align: center;
}

.contact-section h2 {
  margin: 0 0 1rem;
  border: none;
  padding: 0;
  font-size: clamp(1.875rem, 4vw, 2.5rem);
  font-weight: 700;
  letter-spacing: -0.02em;
}

.contact-section p {
  font-size: 1.0625rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  margin: 0 auto 1rem;
  max-width: 540px;
}

.contact-cta {
  margin-top: 2rem !important;
  font-size: 1.5rem !important;
}

.contact-link {
  font-weight: 600;
  color: var(--vp-c-brand-1);
  text-decoration: none;
  border-bottom: 2px solid transparent;
  transition: border-color 0.2s;
}

.contact-link:hover {
  border-bottom-color: var(--vp-c-brand-1);
}
</style>
