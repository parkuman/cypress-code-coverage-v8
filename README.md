# cypress-code-coverage-v8

> Collects code coverage of your application under test using V8's built in
> JavaScript code coverage. No need to instrument your application!

## Install

```shell
npm install -D cypress-code-coverage-v8
```

**Note:** This plugin assumes that `cypress` is a peer dependency already installed in your project.

Then add the code below to the `supportFile` and `setupNodeEvents` function.

```js
// cypress/support/e2e.{js|ts}
import "cypress-code-coverage-v8/support";
```

```js
// cypress.config.{js|ts}
import { defineConfig } from "cypress";
import cypressV8Coverage from "cypress-code-coverage-v8/task";

export default defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      cypressV8Coverage(on, config);
      // include any other plugin code...

      // It's IMPORTANT to return the config object here
      return config;
    },

    baseUrl: "http://localhost:5173/",
  },
});
```

Next, run your Cypress tests with coverage enabled.
**Note:** it must be run within Chrome.

```shell
CYPRESS_COVERAGE=true npx cypress run --browser chrome
```

Then you can generate the coverage report using `nyc`.

```shell
npx nyc report --reporter=text --reporter=text-summary --reporter=html --temp-dir=cypress-coverage --report-dir=cypress-coverage-reports
```

## Examples

Check out the examples in the `test-apps` directory to see how this might work for your type of application.

## V8 Coverage vs Istanbul?

There are some [trade-offs](https://github.com/jestjs/jest/issues/11188) associated with taking Coverage using V8's native system vs Istanbul. Please give the above a read and make your own decision on whether or not it is worth it for you.

## How it works

1. It takes V8 coverage directly from the the V8 engine while Cypress tests are running

2. After each test, it looks at the V8 coverage object and finds all files served from the application’s URL

3. it takes built source files and finds their corresponding sourcemap files .map

4. the sourcemap files are parsed to find all the source .ts and .tsx files which were loaded and ran by the V8 engine

5. we also find all the files which were NOT loaded by the V8 engine and create dummy coverage files for them, allowing us to get a full view of the coverage of our application. these will have 0% coverage in the final report

6. these files, along with the V8 coverage are then converted to the Istanbul coverage format

7. from there, it is easy to use existing cli tools like `nyc` to convert these istanbul coverage JSON objects into html, text, coburtura, etc, report styles

## Acknowledgements

- [Gleb Bahmutov](https://github.com/glebbahmutov) for the original proof-of-concept for V8 coverage working with Cypress [cypress-native-chrome-code-coverage-example](https://github.com/bahmutov/cypress-native-chrome-code-coverage-example)
- [Jennifer Shehane](https://github.com/jennifer-shehane) for letting me know that this was [no longer a feature in-progress by the Cypress team](https://github.com/cypress-io/cypress-documentation/commit/280dccb42005d990f159e39330d5d9941a2ff249)
- [The Vitest Team](https://github.com/vitest-dev/vitest/tree/main) who's V8 coverage code I built on top of for this plugin.

