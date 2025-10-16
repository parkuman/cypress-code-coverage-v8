import { mergeProcessCovs } from "@bcoe/v8-coverage";
import type { EncodedSourceMap } from "@jridgewell/trace-mapping";
import CDP from "chrome-remote-interface";
import createDebug from "debug";
import fg from "fast-glob";
import {
  existsSync,
  mkdirSync,
  promises as fs,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { Profiler } from "inspector";
import istanbul, { CoverageMap } from "istanbul-lib-coverage";
import { minimatch } from "minimatch";
import path from "node:path";
import v8ToIstanbul from "v8-to-istanbul";

type CypressV8CoverageOptions = {
  coverageDir: string; // the directory where raw istanbul coverage .json files will be saved
  baseUrls: string[]; // the URL(s) the application is served from, the native V8 coverage report will show the file path from that URL
  srcDir: string; // the directory where the application's source code is
  buildDir: string; // the directory where the application's built code is
  includeUncovered: boolean; // includes all source files in the report
  include: string[]; // files from your application's source code to include
  exclude: string[]; // files from your application's source code to exclude
  includeV8Patterns: string[]; // files to include in the raw v8 coverage report to save processing time
  excludeV8Patterns: string[]; // files to skip in the raw v8 coverage report to save processing time
};

type V8ToIstanbulSources = {
  source: string;
  originalSource: string;
  sourceMap?: { sourcemap: EncodedSourceMap };
};

const PLUGIN_PREFIX = "cypress:v8-coverage";
const debug = createDebug(PLUGIN_PREFIX);
function error(msg: string) {
  console.error(`  \x1b[1;31m${PLUGIN_PREFIX}\x1b[0m ${msg}`);
}

let _options: CypressV8CoverageOptions;

let cdp: any;

const v8CoverageBrowserHandler = async (browser: any, launchOptions: any) => {
  if (browser.name !== "chrome") {
    return error("⚠️ you are trying to obtain coverage from a non-V8 browser");
  }

  debug("launching chrome with args %O", launchOptions.args);

  const rdpArg = launchOptions.args.find((arg: string) =>
    arg.startsWith("--remote-debugging-port"),
  );
  if (!rdpArg) {
    return error(
      `⚠️ Could not find launch argument that starts with --remote-debugging-port`,
    );
  }
  const rdp = parseInt(rdpArg.split("=")[1]); // '--remote-debugging-port=50052'

  debug(`using chrome remote debugging port ${rdp}`);

  const tryConnect = async (disconnected = false) => {
    try {
      debug("attempting to connect to Chrome Debugger Protocol...");
      cdp = await CDP({ port: rdp, local: true });
      debug("☑ successfully connected to Chrome Debugger Protocol");

      // if we disconnect (which happens between tests and at the end of the test suite),
      // attempt to reconnect after 1 second.
      cdp.on("disconnect", () => {
        debug("chrome debugger protocol was disconnected");
        setTimeout(() => tryConnect(true), 1000);
      });
    } catch (err) {
      // if we were disconnected, don't error and don't retry, since in this scenario we are
      // most likely finished the test suite and there are no more tests to inspect. otherwise we might see:
      //    Error: No inspectable targets
      //    Error: connect ECONNREFUSED 127.0.0.1:<port>
      if (!disconnected) {
        error(
          `⚠️ error while connecting to Chrome Debugger Protocol:\n${err}\nRetrying...`,
        );
        setTimeout(tryConnect, 1000); // retry every 1 second to connect to CDP
      } else {
        debug(
          "ran into an error while connecting to chrome debugger protocol, but since we just disconnected from it, its probably the end of the test suite",
        );
      }
    }
  };

  setTimeout(tryConnect, 1000); // try to connect to CDP after 1 second to give the browser time to start

  return launchOptions;
};

function filterV8CoverageResult(coverage: Profiler.ScriptCoverage): boolean {
  // skip files that are not part of the application(s) under test
  if (!_options.baseUrls.some((url) => coverage.url.startsWith(url))) {
    return false;
  }

  // don't try to process a source of node_modules, people don't care about these and it would waste CPU
  if (coverage.url.includes("/node_modules/")) {
    return false;
  }

  const isIncluded = _options.includeV8Patterns.some((pattern) =>
    minimatch(coverage.url, pattern),
  );
  const isExcluded = _options.excludeV8Patterns.some((pattern) =>
    minimatch(coverage.url, pattern),
  );

  return isIncluded && !isExcluded;
}

async function getUntestedFileCoverage(
  testedFiles: string[],
): Promise<Profiler.TakePreciseCoverageReturnType> {
  let allFiles = await fg(_options.include, {
    cwd: _options.srcDir,
    ignore: _options.exclude,
  });
  allFiles = allFiles.map((file) => path.resolve(_options.srcDir, file));

  const untestedFiles = allFiles.filter((file) => !testedFiles.includes(file));

  let merged: Profiler.TakePreciseCoverageReturnType = { result: [] };

  const coverages = await Promise.all(
    untestedFiles.map(async (file) => {
      const originalSource = await fs.readFile(file, { encoding: "utf-8" });

      const coverage = {
        url: file,
        scriptId: "0",
        // Create a made up function to mark whole file as uncovered. Note that this does not exist in source maps.
        functions: [
          {
            ranges: [
              {
                startOffset: 0,
                endOffset: originalSource.length,
                count: 0,
              },
            ],
            isBlockCoverage: true,
            // This is magical value that indicates an empty report: https://github.com/istanbuljs/v8-to-istanbul/blob/fca5e6a9e6ef38a9cdc3a178d5a6cf9ef82e6cab/lib/v8-to-istanbul.js#LL131C40-L131C40
            functionName: "(empty-report)",
          },
        ],
      };

      return { result: [coverage] };
    }),
  );

  merged = mergeProcessCovs([merged, ...coverages]); // merge the v8 coverage results

  return merged;
}

/**
 * attempts to read a `.map` file for a given built source file.
 * @param filePath - the path to the built JS file
 * @returns an object containing the source information required by v8-to-istanbul
 */
async function getSources(filePath: string): Promise<V8ToIstanbulSources> {
  debug(`getting sources for: ${filePath}`);
  let sourceMap: EncodedSourceMap | undefined;

  try {
    const mapFilePath = `${filePath}.map`;
    const mapFile = await fs.readFile(mapFilePath, { encoding: "utf-8" });
    sourceMap = JSON.parse(mapFile) as EncodedSourceMap;

    sourceMap.sources = sourceMap.sources.map(
      (source: string | null) => path.resolve(`${_options.buildDir}${source}`), // resolves the actual path to source file `../../src/App.tsx` to `/code/src/App.tsx`
    );
  } catch (e) {
    error(`⚠️ Error reading map file for file "${filePath}": ${e}`);
  }

  const jsFileCode = await fs.readFile(filePath, { encoding: "utf-8" });

  return {
    source: jsFileCode,
    originalSource: jsFileCode,
    sourceMap: sourceMap
      ? {
          sourcemap: sourceMap,
        }
      : undefined,
  };
}

/**
 * takes a filepath and its sourcemap sources and creates Istanbul coverage.
 * this function will attempt to locate a corresponsing .map sourcemap file if it exists.
 * You may also pass in previous coverage to append to the new coverage.
 * @param filePath - the absolute path to the file
 * @param functions - the V8 format coverage functions
 * @param sources - an object containing the source information required by v8-to-istanbul
 * @returns the converted Istanbul coverage
 */
async function convertCoverage(
  filePath: string,
  functions: Profiler.FunctionCoverage[],
  sources: V8ToIstanbulSources,
) {
  debug(`converting coverage for: ${filePath}`);

  try {
    const converter = v8ToIstanbul(filePath, undefined, sources);
    await converter.load();
    converter.applyCoverage(functions);

    return converter.toIstanbul();
  } catch (e) {
    error(
      `error while converting the following file into Istanbul coverage format: ${filePath}`,
    );
    error(`${JSON.stringify(e, null, 2)}`);
  }
}

/**
 * takes a given V8 coverage object and generates a coverage report for it in Istanbul format.
 * You may also pass in previous coverage to append to the new coverage.
 * @param coverage - the raw v8 coverage object
 * @param prevIstanbulCoverage - an existing coverage map you wish to append to
 * @returns the converted Istanbul coverage
 */
async function generateCoverage(
  coverage: Profiler.TakePreciseCoverageReturnType,
  existingIstanbulCoverage: CoverageMap | {} = {},
): Promise<CoverageMap> {
  const coverageMap = istanbul.createCoverageMap(existingIstanbulCoverage);

  // take the v8 coverage which has URL and assets from build and convert it to istanbul
  await Promise.all(
    coverage.result.map(async ({ url, functions }) => {
      const jsFileName = new URL(url).pathname; // extracts the file name from the file URL since it will look like `http://localhost:3000/assets/index-l1JwU4I9.js`
      const filePath = path.resolve(`${_options.buildDir}${jsFileName}`); // resolves the actual path to the build directory `/code/dist/assets/index-l1JwU4I9.js`

      const sources = await getSources(filePath);

      if (!sources.source) {
        return;
      }

      const istanbulCoverage = await convertCoverage(
        filePath,
        functions,
        sources,
      );

      if (istanbulCoverage) {
        coverageMap.merge(istanbulCoverage);
      }
    }),
  );

  // if we want all coverage, find all the untested files, construct dummy v8 coverage, then convert to istanbul
  if (_options.includeUncovered === true) {
    debug("--all is set, generating untested file coverage");
    const coveredFiles = coverageMap.files();
    const untestedCoverage = await getUntestedFileCoverage(coveredFiles);
    await Promise.all(
      untestedCoverage.result.map(async ({ url: absFilePath, functions }) => {
        debug("creating istanbul coverage for untested file: " + absFilePath);
        const istanbulCoverage = await convertCoverage(absFilePath, functions, {
          source: "",
          originalSource: "",
        }); // by passing null strings, v8-to-istanbul will read the source from the absolute file path

        if (istanbulCoverage) {
          coverageMap.merge(istanbulCoverage); // finally, merge the untested coverage into the main coverage
        }
      }),
    );
  }

  return coverageMap;
}

// ======================| Test Hooks |======================

/**
 * This function runs before all tests in a given `.cy` test file. It checks
 * the provided coverage directory and clears it of any old coverage files.
 */
async function v8CoverageBefore(testFileName: string) {
  debug("cypress before() hook");

  const oldV8CoverageFile = path.join(
    _options.coverageDir,
    `${testFileName}_v8.json`,
  );
  if (existsSync(oldV8CoverageFile)) {
    debug(`deleting old v8 coverage for testfile: ${testFileName}`);
    unlinkSync(oldV8CoverageFile);
  }

  const oldIstanbulCoverageFile = path.join(
    _options.coverageDir,
    `${testFileName}.json`,
  );
  if (existsSync(oldIstanbulCoverageFile)) {
    debug(`deleting old v8 coverage for testfile: ${testFileName}`);
    unlinkSync(oldIstanbulCoverageFile);
  }

  return null;
}

/**
 * This function runs before each test in a given `.cy` test file. It enables
 * the chrome debugger protocol for coverage and starts the profiler.
 */
function v8CoverageBeforeEach() {
  debug("cypress beforeEach() hook");

  if (cdp) {
    const callCount = true;
    const detailed = true;
    return Promise.all([
      cdp.Profiler.enable(),
      cdp.Profiler.startPreciseCoverage(callCount, detailed),
    ]);
  }

  error(
    "⚠️ connection was lost to the chrome debugger protocol, unable to start coverage",
  );
  return null;
}

/**
 * This function runs after each test in a given `.cy` test file. It takes coverage
 * information from the Chrome Debugger Protocol, then writes it to a file. If
 * that file is already present (say, from a previous test in the same file), it appends the coverage to it.
 */
async function v8CoverageAfterEach(testFileName: string) {
  debug("cypress afterEach() hook");

  if (cdp) {
    const rawV8Coverage = await cdp.Profiler.takePreciseCoverage();

    // filter out browser extensions, cypress scripts, etc.
    const filteredV8Coverage = rawV8Coverage.result.filter(
      filterV8CoverageResult,
    );

    if (!existsSync(_options.coverageDir)) {
      mkdirSync(_options.coverageDir);
    }

    // read from previous test runs' coverage reports and append
    // the latest test run's coverage
    const filename = path.join(_options.coverageDir, `${testFileName}_v8.json`);
    const previousCoverage = existsSync(filename)
      ? JSON.parse(readFileSync(filename, "utf8"))
      : { result: [] };

    // #2 merge instead of append new coverage and write
    const merged = mergeProcessCovs([previousCoverage, { result: filteredV8Coverage }]);
    writeFileSync(filename, JSON.stringify(merged), "utf8");

    // lastly, stop the coverage for the current test
    return cdp.Profiler.stopPreciseCoverage();
  }

  error(
    "⚠️ connection was lost to the chrome debugger protocol, unable to take coverage",
  );
  return null;
}

/**
 * This function runs after the all tests in a `.cy` test file have been run, it will
 * take the coverage file appended to by each test and convert it into Istanbul format
 * for easier reading.
 */
async function v8CoverageAfter(testFileName: string) {
  debug("cypress after() hook");

  const v8CoverageFile = path.join(
    _options.coverageDir,
    `${testFileName}_v8.json`,
  );

  if (!existsSync(v8CoverageFile)) {
    debug(
      `v8 coverage file not found for test, it was probably skipped. skipping coverage creation: ${testFileName}`,
    );
    return null;
  }

  const v8Coverage = JSON.parse(
    readFileSync(v8CoverageFile, "utf8"),
  ) as Profiler.TakePreciseCoverageReturnType;

  const existingIstanbulCoverageFile = path.join(
    _options.coverageDir,
    `${testFileName}.json`,
  );
  const existingIstanbulCoverage = existsSync(existingIstanbulCoverageFile)
    ? JSON.parse(readFileSync(existingIstanbulCoverageFile, "utf8"))
    : {};

  const istanbulCoverage = await generateCoverage(
    v8Coverage,
    existingIstanbulCoverage,
  );

  writeFileSync(
    existingIstanbulCoverageFile,
    JSON.stringify(istanbulCoverage),
    "utf8",
  );
  // remove the v8 coverage file so nyc doesn't get confused later
  unlinkSync(v8CoverageFile);

  return null;
}

// registers the v8 coverage plugin
function register(
  on: Cypress.PluginEvents,
  config: Cypress.PluginConfigOptions,
  options?: Partial<CypressV8CoverageOptions>,
) {
  if (process.env.CYPRESS_COVERAGE === "true") {
    _options = {
      coverageDir: path.resolve(options?.coverageDir ?? "cypress-coverage"),
      baseUrls: options?.baseUrls ?? (config.baseUrl ? [config.baseUrl] : []),
      srcDir: path.resolve(options?.srcDir ?? "src"),
      buildDir: path.resolve(options?.buildDir ?? "dist"),
      includeUncovered: options?.includeUncovered ?? true,
      include: options?.include ?? [
        "**/*.ts",
        "**/*.tsx",
        "**/*.js",
        "**/*.jsx",
      ],
      exclude: options?.exclude ?? [
        "**/*.spec.ts",
        "**/*.spec.tsx",
        "**/*.spec.jsx",
        "**/*.spec.js",
        "**/*.d.ts",
      ],
      includeV8Patterns: options?.includeV8Patterns ?? ["**/assets/**/*.js"], // by default, only include JS files from the assets folder

      // skip cypress related files by default
      excludeV8Patterns: options?.excludeV8Patterns ?? [
        "**/__cypress/**",
        "**/__/**",
      ],
    };

    debug("using options %O", _options);

    on("task", {
      v8CoverageBefore,
      v8CoverageBeforeEach,
      v8CoverageAfterEach,
      v8CoverageAfter,
    });

    on("before:browser:launch", (browser, launchOptions) => {
      v8CoverageBrowserHandler(browser, launchOptions);
    });

    // set a variable to let the hooks running in the browser
    // know that they can use the Chrome Debugger Protocol for coverage
    config.env.v8CoveragePluginRegistered = true;
  } else {
    debug(
      "CYPRESS_COVERAGE environment variable not set, skipping v8 coverage generation",
    );
  }

  return config;
}

export default register;
