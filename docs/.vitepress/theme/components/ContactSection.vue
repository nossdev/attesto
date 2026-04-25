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
.contact-section {
  margin: 4rem auto 2rem;
  padding: 2rem;
  max-width: 720px;
  text-align: center;
  background: var(--vp-c-bg-soft);
  border-radius: 12px;
  border: 1px solid var(--vp-c-divider);
}

.contact-section h2 {
  margin-top: 0;
  border-top: none;
  padding-top: 0;
}

.contact-cta {
  margin-top: 1.5rem;
  font-size: 1.25rem;
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
