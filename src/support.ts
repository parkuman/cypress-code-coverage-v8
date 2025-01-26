/**
 * Consistently logs the given string to the Command Log
 * so the user knows the log message is coming from this plugin.
 * @param s - Message to log.
 */
const logMessage = (s: string) => {
  cy.log(`${s} \`[V8 Coverage]\``);
};

const COVERAGE_TIMEOUT = 480_000; // ms to wait for the after coverage task to complete before failing

const registerHooks = () => {
  before(() => {
    const logInstance = Cypress.log({
      name: "V8 Coverage",
      message: ["Reset [V8 coverage]"],
    });

    cy.task("v8CoverageBefore", Cypress.spec.fileName).then(() => {
      logInstance.end();
    });
  });

  beforeEach(() => {
    cy.task("v8CoverageBeforeEach");
  });

  afterEach(() => {
    cy.task("v8CoverageAfterEach", Cypress.spec.fileName);
  });

  after(() => {
    const logInstance = Cypress.log({
      name: "V8 Coverage",
      message: ["Collect and convert coverage [V8 coverage]"],
    });

    cy.task("v8CoverageAfter", Cypress.spec.fileName, {
      timeout: COVERAGE_TIMEOUT,
    }).then(() => {
      logInstance.end();
    });
  });
};

// if the CLI envrionment variable isn't set, don't bother doing coverage.
// this variable is parsed by cypress from CYPRESS_COVERAGE and cast to a bool according to:
// https://docs.cypress.io/guides/guides/environment-variables#Option-3-CYPRESS_
if (Cypress.env("COVERAGE") === true) {
  // register hooks before and after each spec that we can hook into to trigger
  // the required chrome debugger commands for coverage.
  if (Cypress.env("v8CoveragePluginRegistered") !== true) {
    before(() => {
      logMessage(`
      ⚠️ V8 Code coverage tasks were not registered by the cypressV8Coverage plugin file. 
      Please ensure you have enabled the plugin in your cypress config.
    `);
    });
  } else {
    registerHooks();
  }
}
