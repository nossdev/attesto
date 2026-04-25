import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import "./custom.css";
import ContactSection from "./components/ContactSection.vue";

// Extend the default theme with custom global components so they're
// available in any markdown page without per-page imports.
//
// To add another global component:
//   1. Drop the .vue file under ./components/
//   2. Import + register here
//   3. Use as <YourComponent /> in any .md file
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("ContactSection", ContactSection);
  },
} satisfies Theme;
