// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { spawn } from "child_process";
import { defaultLogger } from "../utils/logger";
import {
  discoveryIsFresh,
  readDiscovery,
  releaseProxySpawnLock,
  tryAcquireProxySpawnLock,
} from "./discovery";
import {
  PROXY_DAEMON_READY_TIMEOUT,
  ProxyDaemonConfig,
  ProxyDiscoveryInfo,
} from "./types";

let launchInProgress = false;

function buildDaemonConfig(option: any): ProxyDaemonConfig {
  return {
    autoConnect: option?.manualConnect !== true,
    enableAndroid: option?.enableAndroid,
    enableIOS: option?.enableIOS,
    enableHarmony: option?.enableHarmony,
    enableDesktop: option?.enableDesktop,
    enableNetworkDevice: option?.enableNetworkDevice,
    adbHostPort: option?.adbHostPort,
    hdcHostPort: option?.hdcHostPort,
    usbConnectOpt: option?.usbConnectOpt,
    enableWebSocket: option?.enableWebSocket,
    websocketOption: option?.websocketOption,
    networkDeviceOpt: option?.networkDeviceOpt,
    idleTimeout: option?.proxyDaemonIdleTimeout,
  };
}

function resolveDaemonEntry(): string {
  return require.resolve("./daemon");
}

function waitForFreshDiscovery(timeout: number): Promise<ProxyDiscoveryInfo> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const discovery = readDiscovery();
      if (discoveryIsFresh(discovery) && discovery) {
        resolve(discovery);
        return;
      }
      if (Date.now() - start >= timeout) {
        reject(new Error("DebugRouterProxy daemon start timeout"));
        return;
      }
      setTimeout(check, 200);
    };
    check();
  });
}

export function ensureProxyDaemonStarted(option: any = {}) {
  const discovery = readDiscovery();
  if (discoveryIsFresh(discovery)) {
    return;
  }
  if (launchInProgress) {
    return;
  }
  if (!tryAcquireProxySpawnLock()) {
    return;
  }
  launchInProgress = true;
  try {
    const daemonEntry = resolveDaemonEntry();
    const config = buildDaemonConfig(option);
    const child = spawn(process.execPath, [daemonEntry], {
      detached: true,
      env: {
        ...process.env,
        DEBUG_ROUTER_PROXY_DAEMON: "true",
        DEBUG_ROUTER_PROXY_DAEMON_CONFIG: JSON.stringify(config),
      },
      stdio: "ignore",
    });
    child.unref();
    defaultLogger.info(
      "DebugRouterProxy: spawned detached daemon pid:" + child.pid,
    );
    waitForFreshDiscovery(PROXY_DAEMON_READY_TIMEOUT)
      .catch((error) => {
        defaultLogger.warn(
          "DebugRouterProxy: wait daemon failed:" + error.message,
        );
      })
      .finally(() => {
        launchInProgress = false;
        releaseProxySpawnLock();
      });
  } catch (error: any) {
    launchInProgress = false;
    releaseProxySpawnLock();
    defaultLogger.warn("DebugRouterProxy: spawn daemon failed:" + error.message);
  }
}
