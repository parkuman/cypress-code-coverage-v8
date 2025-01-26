// @ts-check

import { defineConfig } from "cypress";
import cypressV8Coverage from "cypress-code-coverage-v8/task";

export default defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      cypressV8Coverage(on, config);

      return config;
    },

    baseUrl: "http://localhost:5173/",
  },
});
