import { type Locator, type Page } from 'playwright-core';
export declare function snapshotPage(page: Page, args: Record<string, unknown>): Promise<string>;
export declare function takeScreenshot(page: Page, args: Record<string, unknown>, outputDir: string): Promise<unknown>;
export declare function resolveTargetLocator(page: Page, target: string): Promise<Locator>;
