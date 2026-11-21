import { Quasar } from "quasar";
import "quasar/dist/quasar.css";
import { createApp } from "vue";
import App from "./App.vue";

// The window's accent, and its dark surfaces, which follow the system's light or dark mode.
createApp(App)
  .use(Quasar, {
    config: {
      dark: "auto",
      brand: { primary: "#4263eb", negative: "#e03131", dark: "#151a22", "dark-page": "#0e1117" },
    },
  })
  .mount("#app");
