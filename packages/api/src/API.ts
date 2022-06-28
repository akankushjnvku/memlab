/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {Page, Browser} from 'puppeteer';
import type {ParsedArgs} from 'minimist';
import type {
  AnyFunction,
  AnyValue,
  ISerializedInfo,
  IScenario,
  XvfbType,
  Optional,
} from '@memlab/core';

import {
  analysis,
  info,
  utils,
  browserInfo,
  config as defaultConfig,
  MemLabConfig,
  fileManager,
} from '@memlab/core';
import {
  defaultTestPlanner,
  TestPlanner,
  Xvfb,
  E2EInteractionManager,
} from '@memlab/e2e';
import {BaseAnalysis} from '@memlab/heap-analysis';
import APIUtils from './lib/APIUtils';
import BrowserInteractionResultReader from './result-reader/BrowserInteractionResultReader';

/**
 * Options for configuring browser interaction run
 */
export type RunOptions = {
  /** test scenario definition */
  scenario?: IScenario;
  /** cookies file */
  cookiesFile?: string;
  /** function to be evaluated in browser context after the web page initial load */
  evalInBrowserAfterInitLoad?: AnyFunction;
  /**
   * if true, take heap snapshot for each interaction step,
   * by default this is false, which means memlab will decide
   * which steps it will take heap snapshots
   */
  snapshotForEachStep?: boolean;
};

/**
 * Options for memlab inter-package API calls
 * @internal
 */
export type APIOptions = {
  // NOTE: cannot pass in a different config instance
  //       before refactoring the codebase to not use the global config
  testPlanner?: TestPlanner;
  cache?: boolean;
  config?: MemLabConfig;
  evalInBrowserAfterInitLoad?: AnyFunction;
};

/**
 * This API warms up web server, runs E2E interaction, and takes heap snapshots.
 * This is equivalent to run `memlab warmup-and-snapshot` in CLI.
 * This is also equivalent to call {@link warmup} and {@link takeSnapshots}.
 *
 * @param options configure browser interaction run
 * @returns browser interaction results
 */
export async function warmupAndTakeSnapshots(
  options: RunOptions = {},
): Promise<BrowserInteractionResultReader> {
  const config = MemLabConfig.resetConfigWithTranscientDir();
  setConfigByRunOptions(config, options);
  config.externalCookiesFile = options.cookiesFile;
  config.scenario = options.scenario;
  const testPlanner = new TestPlanner({config});
  const {evalInBrowserAfterInitLoad} = options;
  await warmup({testPlanner, config, evalInBrowserAfterInitLoad});
  await testInBrowser({testPlanner, config, evalInBrowserAfterInitLoad});
  return BrowserInteractionResultReader.from(config.workDir);
}

/**
 * This API runs browser interaction and find memory leaks triggered in browser
 * This is equivalent to run `memlab run` in CLI.
 * This is also equivalent to call {@link warmup}, {@link takeSnapshots},
 * and {@link findLeaks}.
 *
 * @param options configure browser interaction run
 * @returns an array of leak traces detected and clustered from the
 * browser interaction
 */
export async function run(
  options: RunOptions = {},
): Promise<ISerializedInfo[]> {
  const config = MemLabConfig.resetConfigWithTranscientDir();
  setConfigByRunOptions(config, options);
  config.externalCookiesFile = options.cookiesFile;
  config.scenario = options.scenario;
  const testPlanner = new TestPlanner({config});
  const {evalInBrowserAfterInitLoad} = options;
  await warmup({testPlanner, config, evalInBrowserAfterInitLoad});
  await testInBrowser({testPlanner, config, evalInBrowserAfterInitLoad});
  const runResult = BrowserInteractionResultReader.from(config.workDir);
  return await findLeaks(runResult);
}

/**
 * This API runs E2E interaction and takes heap snapshots.
 * This is equivalent to run `memlab snapshot` in CLI.
 *
 * @param options configure browser interaction run
 * @returns browser interaction results
 */
export async function takeSnapshots(
  options: RunOptions = {},
): Promise<BrowserInteractionResultReader> {
  const config = MemLabConfig.resetConfigWithTranscientDir();
  setConfigByRunOptions(config, options);
  config.externalCookiesFile = options.cookiesFile;
  config.scenario = options.scenario;
  const testPlanner = new TestPlanner();
  const {evalInBrowserAfterInitLoad} = options;
  await testInBrowser({testPlanner, config, evalInBrowserAfterInitLoad});
  return BrowserInteractionResultReader.from(config.workDir);
}

/**
 * This API finds memory leaks by analyzing heap snapshot(s)
 * This is equivalent to `memlab find-leaks` in CLI.
 *
 * @param runResult return value of a browser interaction run
 * @returns an array of leak traces detected and clustered from the
 * browser interaction
 */
export async function findLeaks(
  runResult: BrowserInteractionResultReader,
): Promise<ISerializedInfo[]> {
  const workDir = runResult.getRootDirectory();
  fileManager.initDirs(defaultConfig, {workDir});
  defaultConfig.chaseWeakMapEdge = false;
  return await analysis.checkLeak();
}

/**
 * This API analyzes heap snapshot(s) with a specified heap analysis.
 * This is equivalent to `memlab analyze` in CLI.
 *
 * @param runResult return value of a browser interaction run
 * @param heapAnalyzer instance of a heap analysis
 * @param args other CLI arguments that needs to be passed to the heap analysis
 * @returns
 */
export async function analyze(
  runResult: BrowserInteractionResultReader,
  heapAnalyzer: BaseAnalysis,
  args: ParsedArgs = {_: []},
): Promise<AnyValue> {
  const workDir = runResult.getRootDirectory();
  fileManager.initDirs(defaultConfig, {workDir});
  return await heapAnalyzer.run({args});
}

/**
 * This warms up web server by sending web requests to the web sever.
 * This is equivalent to run `memlab warmup` in CLI.
 * @internal
 *
 * @param options configure browser interaction run
 */
export async function warmup(options: APIOptions = {}): Promise<void> {
  const config = options.config ?? defaultConfig;
  if (config.verbose) {
    info.lowLevel(`Xvfb: ${config.useXVFB}`);
  }
  const testPlanner = options.testPlanner ?? defaultTestPlanner;
  try {
    if (config.skipWarmup) {
      return;
    }
    const browser = await APIUtils.getBrowser({warmup: true});

    const visitPlan = testPlanner.getVisitPlan();
    config.setDevice(visitPlan.device);

    const numOfWarmup = visitPlan.numOfWarmup || 3;
    const promises = [];
    for (let i = 0; i < numOfWarmup; ++i) {
      promises.push(browser.newPage());
    }
    const pages = await Promise.all(promises);
    info.beginSection('warmup');
    await Promise.all(
      pages.map(async page => {
        await setupPage(page, {cache: false});
        const interactionManager = new E2EInteractionManager(page);
        await interactionManager.warmupInPage();
      }),
    ).catch(err => {
      info.error(err.message);
    });
    info.endSection('warmup');

    await utils.closePuppeteer(browser, pages, {warmup: true});
  } catch (ex) {
    const error = utils.getError(ex);
    utils.checkUninstalledLibrary(error);
    throw ex;
  }
}

function setConfigByRunOptions(
  config: MemLabConfig,
  options: RunOptions,
): void {
  config.isFullRun = !!options.snapshotForEachStep;
}

async function setupPage(page: Page, options: APIOptions = {}): Promise<void> {
  const config = options.config ?? defaultConfig;
  const testPlanner = options.testPlanner ?? defaultTestPlanner;
  if (config.emulateDevice) {
    await page.emulate(config.emulateDevice);
  }

  if (config.defaultUserAgent) {
    await page.setUserAgent(config.defaultUserAgent);
  }

  // set login session
  await page.setCookie(...testPlanner.getCookies());
  const cache = options.cache ?? true;
  await page.setCacheEnabled(cache);

  // automatically accept dialog
  page.on('dialog', async dialog => {
    await dialog.accept();
  });
}

function autoDismissDialog(page: Page, options: APIOptions = {}): void {
  const config = options.config ?? defaultConfig;
  page.on('dialog', async dialog => {
    if (config.verbose) {
      info.lowLevel(`Browser dialog: ${dialog.message()}`);
    }
    await dialog.dismiss();
  });
}

async function initBrowserInfoInConfig(
  browser: Browser,
  options: APIOptions = {},
): Promise<void> {
  const config = options.config ?? defaultConfig;
  browserInfo.setPuppeteerConfig(config.puppeteerConfig);
  const version = await browser.version();
  browserInfo.setBrowserVersion(version);
  if (config.verbose) {
    info.lowLevel(JSON.stringify(browserInfo, null, 2));
  }
}

/**
 * Browser interaction API used by MemLab API and MemLab CLI
 * @internal
 */
export async function testInBrowser(options: APIOptions = {}): Promise<void> {
  const config = options.config ?? defaultConfig;
  if (config.verbose) {
    info.lowLevel(`Xvfb: ${config.useXVFB}`);
  }

  const testPlanner = options.testPlanner ?? defaultTestPlanner;
  let interactionManager: E2EInteractionManager | null = null;
  let xvfb: XvfbType | null = null;
  try {
    xvfb = Xvfb.startIfEnabled();
    const browser = await APIUtils.getBrowser();
    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    interactionManager = new E2EInteractionManager(page);

    if (options.evalInBrowserAfterInitLoad) {
      interactionManager.setEvalFuncAfterInitLoad(
        options.evalInBrowserAfterInitLoad,
      );
    }

    const visitPlan = testPlanner.getVisitPlan();
    config.setDevice(visitPlan.device);

    autoDismissDialog(page);
    await initBrowserInfoInConfig(browser);

    browserInfo.monitorWebConsole(page);

    await setupPage(page, options);

    await interactionManager.visitAndGetSnapshots(options);
    await utils.closePuppeteer(browser, [page]);
  } catch (ex) {
    const error = utils.getError(ex);
    utils.checkUninstalledLibrary(error);
    info.error(error.message);
  } finally {
    if (interactionManager) {
      interactionManager.clearCDPSession();
    }
    if (xvfb) {
      xvfb.stop((err: Optional<Error>) => {
        if (err) {
          utils.haltOrThrow(err);
        }
      });
    }
  }
}
