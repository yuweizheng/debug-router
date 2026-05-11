// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { driver_dir } from "../utils/file_lock";
import { defaultLogger } from "../utils/logger";
import {
  PROXY_PROTOCOL_VERSION,
  PROXY_STALE_TIMEOUT,
  ProxyDiscoveryInfo,
} from "./types";

const proxyDir = path.join(driver_dir, "proxy-v1");
const hostLockDir = path.join(proxyDir, "daemon.lock");
const discoveryFile = path.join(proxyDir, "daemon.json");

function ensureProxyDir() {
  fs.mkdirSync(proxyDir, { recursive: true });
}

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

function getMtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export function isProxyEnabled(): boolean {
  return process.env.DEBUG_ROUTER_PROXY !== "false";
}

export function readDiscovery(): ProxyDiscoveryInfo | null {
  const info = readJsonFile<ProxyDiscoveryInfo>(discoveryFile);
  if (!info || info.protocolVersion !== PROXY_PROTOCOL_VERSION) {
    return null;
  }
  return info;
}

export function discoveryIsFresh(info: ProxyDiscoveryInfo | null): boolean {
  if (!info) {
    return false;
  }
  return Date.now() - info.heartbeat < PROXY_STALE_TIMEOUT;
}

export function tryAcquireProxyHostLock(): boolean {
  ensureProxyDir();
  const discovery = readDiscovery();
  const lockAge = Date.now() - getMtime(hostLockDir);
  if (
    fs.existsSync(hostLockDir) &&
    !discoveryIsFresh(discovery) &&
    lockAge > PROXY_STALE_TIMEOUT
  ) {
    try {
      fs.rmSync(hostLockDir, { recursive: true, force: true });
      fs.rmSync(discoveryFile, { force: true });
    } catch (error: any) {
      defaultLogger.warn(
        "DebugRouterProxy: clear stale lock failed:" + error?.message,
      );
    }
  }
  try {
    fs.mkdirSync(hostLockDir);
    return true;
  } catch {
    return false;
  }
}

export function releaseProxyHostLock() {
  try {
    fs.rmSync(hostLockDir, { recursive: true, force: true });
    fs.rmSync(discoveryFile, { force: true });
  } catch (error: any) {
    defaultLogger.debug(
      "DebugRouterProxy: release lock failed:" + error?.message,
    );
  }
}

export function writeDiscovery(info: ProxyDiscoveryInfo) {
  ensureProxyDir();
  const tempFile = `${discoveryFile}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(info), "utf-8");
  fs.renameSync(tempFile, discoveryFile);
}

export function createDiscovery(controlPort: number): ProxyDiscoveryInfo {
  return {
    pid: process.pid,
    protocolVersion: PROXY_PROTOCOL_VERSION,
    controlPort,
    token: randomBytes(16).toString("hex"),
    heartbeat: Date.now(),
  };
}
