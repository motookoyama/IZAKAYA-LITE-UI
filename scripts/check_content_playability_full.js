#!/usr/bin/env node
/**
 * Daily content playability check.
 *
 * This script launches a headless browser, runs through the chat UI,
 * and ensures the BFF + LLM stack are responding. It logs a structured
 * record that Cloud Logging can ingest.
 */

import path from "node:path";
import { chromium } from "playwright";

const REQUIRED_ENVS = ["FE_URL", "BFF_BASE_URL", "TEST_USER_ID"];
const missing = REQUIRED_ENVS.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(
    JSON.stringify({
      event: "daily_test_user",
      status: "failure",
      error: `Missing environment variables: ${missing.join(", ")}`,
      timestamp: new Date().toISOString(),
    }),
  );
  process.exit(1);
}

const FE_URL = process.env.FE_URL.replace(/\/+$/, "");
const BFF_BASE_URL = process.env.BFF_BASE_URL.replace(/\/+$/, "");
const TEST_USER_ID = process.env.TEST_USER_ID.trim();
const TEST_MESSAGE = process.env.LLM_ASSISTED_CHAT_MESSAGE || "テスト：稼働確認";
const EXPECTED_POINTS_CHANGE = Number(process.env.EXPECTED_POINTS_CHANGE ?? "0");
const TIMEOUT_SECONDS = Number(process.env.TIMEOUT_SECONDS ?? "45");
const TIMEOUT_MS = TIMEOUT_SECONDS * 1000;

const baseHeaders = {
  "content-type": "application/json",
  "X-IZK-UID": TEST_USER_ID,
  "X-IZK-TEST-USER": "1",
};

async function fetchWalletBalance(label) {
  const response = await fetch(`${BFF_BASE_URL}/wallet/balance`, {
    method: "GET",
    headers: baseHeaders,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`wallet_balance_${label}_http_${response.status}:${body.slice(0, 120)}`);
  }
  const payload = await response.json();
  if (typeof payload.balance !== "number") {
    throw new Error(`wallet_balance_${label}_invalid_payload`);
  }
  return payload.balance;
}

async function runBrowserScenario() {
  const browser = await chromium.launch({ headless: process.env.PLAYWRIGHT_HEADLESS !== "false" });
  const context = await browser.newContext({
    extraHTTPHeaders: { "x-izk-test-user": "1" },
  });
  await context.addInitScript((uid) => {
    window.localStorage.setItem("IZK_UID", uid);
  }, TEST_USER_ID);
  const page = await context.newPage();

  try {
    await page.goto(FE_URL, { waitUntil: "networkidle", timeout: TIMEOUT_MS });
    const multilineInput = page.locator('textarea[placeholder="メッセージを入力…"]');
    await multilineInput.waitFor({ timeout: TIMEOUT_MS });
    await multilineInput.fill(TEST_MESSAGE, { timeout: TIMEOUT_MS });
    const sendButton = page.getByRole("button", { name: /送信/ });
    const chatResponsePromise = page.waitForResponse(
      (response) => response.url().includes("/chat/v1") && response.status() === 200,
      { timeout: TIMEOUT_MS },
    );
    await sendButton.click();
    const chatResponse = await chatResponsePromise;
    const payload = await chatResponse.json().catch(() => null);
    const replyText = typeof payload?.reply === "string" ? payload.reply.trim() : "";
    if (!replyText) {
      throw new Error("chat_reply_empty");
    }
    await page.waitForTimeout(1500);
    return { replyText, transportStatus: chatResponse.status() };
  } catch (error) {
    const screenshotPath = path.join(process.cwd(), `playability-failure-${Date.now()}.png`);
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    } catch {
      // ignore screenshot errors but keep path for diagnostics
    }
    const enriched = error instanceof Error ? error : new Error(String(error));
    enriched.screenshotPath = screenshotPath;
    throw enriched;
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  const logEntry = {
    event: "daily_test_user",
    timestamp: new Date().toISOString(),
    prompt: TEST_MESSAGE,
    status: "success",
  };
  const started = Date.now();
  try {
    const balanceBefore = await fetchWalletBalance("before");
    logEntry.balance_before = balanceBefore;
    const browserResult = await runBrowserScenario();
    logEntry.reply = browserResult.replyText;
    logEntry.transport_status = browserResult.transportStatus;
    const balanceAfter = await fetchWalletBalance("after");
    logEntry.balance_after = balanceAfter;
    logEntry.delta = Number((balanceAfter - balanceBefore).toFixed(4));
    logEntry.expected_delta = -EXPECTED_POINTS_CHANGE;
    if (Math.abs(logEntry.delta - logEntry.expected_delta) > 0.01) {
      throw new Error(`balance_delta_mismatch actual=${logEntry.delta} expected=${logEntry.expected_delta}`);
    }
    logEntry.response_time_ms = Date.now() - started;
    console.log(JSON.stringify(logEntry));
  } catch (error) {
    logEntry.status = "failure";
    logEntry.error = error instanceof Error ? error.message : String(error);
    logEntry.response_time_ms = Date.now() - started;
    if (error?.screenshotPath) {
      logEntry.screenshot_path = error.screenshotPath;
    }
    console.error(JSON.stringify(logEntry));
    process.exit(1);
  }
}

main();
