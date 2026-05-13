// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { DebugRouterConnector } from "../connector/DebugRouterConnector";
import { defaultLogger } from "../utils/logger";
import { tryAcquireProxyDaemonLock } from "./discovery";
import { ProxyHost } from "./ProxyHost";
import {
  DEFAULT_PROXY_DAEMON_IDLE_TIMEOUT,
  ProxyDaemonConfig,
} from "./types";

function readConfig(): ProxyDaemonConfig {
  const raw = process.env.DEBUG_ROUTER_PROXY_DAEMON_CONFIG;
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as ProxyDaemonConfig;
  } catch (error: any) {
    defaultLogger.warn(
      "DebugRouterProxy: parse daemon config failed:" + error?.message,
    );
    return {};
  }
}

function getIdleTimeout(config: ProxyDaemonConfig): number {
  if (config.idleTimeout !== undefined) {
    return config.idleTimeout;
  }
  const value = process.env.DEBUG_ROUTER_PROXY_DAEMON_IDLE_TIMEOUT;
  if (!value) {
    return DEFAULT_PROXY_DAEMON_IDLE_TIMEOUT;
  }
  const timeout = Number(value);
  if (Number.isFinite(timeout)) {
    return timeout;
  }
  return DEFAULT_PROXY_DAEMON_IDLE_TIMEOUT;
}

async function main() {
  if (!tryAcquireProxyDaemonLock()) {
    defaultLogger.info("DebugRouterProxy: daemon already exists");
    return;
  }
  const config = readConfig();
  const driver = new DebugRouterConnector({
    internalProxyDaemon: true,
    enableProxy: false,
    manualConnect: true,
    enableAndroid: config.enableAndroid,
    enableIOS: config.enableIOS,
    enableHarmony: config.enableHarmony,
    enableDesktop: config.enableDesktop,
    enableNetworkDevice: config.enableNetworkDevice,
    adbHostPort: config.adbHostPort,
    hdcHostPort: config.hdcHostPort,
    networkDeviceOpt: config.networkDeviceOpt,
    usbConnectOpt: config.usbConnectOpt,
    enableWebSocket: config.enableWebSocket ?? true,
    websocketOption: config.websocketOption,
    reportService: null,
  });
  let closing = false;
  let host: ProxyHost;
  const closeAndExit = (code = 0) => {
    if (closing) {
      return;
    }
    closing = true;
    host?.close();
    driver
      .close()
      .catch((error) => {
        defaultLogger.warn(
          "DebugRouterProxy: daemon close failed:" + error?.message,
        );
      })
      .finally(() => {
        process.exit(code);
      });
  };
  host = new ProxyHost(driver, {
    idleTimeout: getIdleTimeout(config),
    onIdleTimeout: () => closeAndExit(0),
  });
  driver.attachProxyHost(host);
  await host.start();
  if (config.autoConnect !== false) {
    driver.connectDevices().catch((error) => {
      defaultLogger.warn(
        "DebugRouterProxy: daemon connectDevices failed:" + error?.message,
      );
    });
  }
  process.once("SIGINT", () => closeAndExit(0));
  process.once("SIGTERM", () => closeAndExit(0));
}

main().catch((error) => {
  defaultLogger.error("DebugRouterProxy: daemon failed:" + error?.message);
  process.exit(1);
});
