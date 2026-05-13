// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

export const PROXY_PROTOCOL_VERSION = 1;
export const PROXY_CONTROL_PATH = "/debug-router-proxy/control";
export const DEFAULT_PROXY_CONTROL_PORT = 19883;
export const PROXY_HEARTBEAT_INTERVAL = 1000;
export const PROXY_STALE_TIMEOUT = 10000;
export const PROXY_DAEMON_READY_TIMEOUT = 10000;
export const DEFAULT_PROXY_DAEMON_IDLE_TIMEOUT = 60000;

export type ProxyDiscoveryInfo = {
  pid: number;
  protocolVersion: number;
  controlPort: number;
  token: string;
  heartbeat: number;
};

export type SerializedDevice = {
  info: any;
  ports: number[];
  host: string;
};

export type SerializedClient = {
  info: any;
};

export type ProxyRequest = {
  id: number;
  method: string;
  params?: any;
  token?: string;
};

export type ProxyResponse = {
  id: number;
  ok: boolean;
  result?: any;
  error?: string;
};

export type ProxyEvent = {
  event: string;
  payload?: any;
};

export type ProxyHostOptions = {
  idleTimeout?: number;
  onIdleTimeout?: () => void;
};

export type ProxyDaemonConfig = {
  autoConnect?: boolean;
  enableAndroid?: boolean;
  enableIOS?: boolean;
  enableHarmony?: boolean;
  enableDesktop?: boolean;
  enableNetworkDevice?: boolean;
  adbHostPort?: {
    host?: string;
    port?: number;
  };
  hdcHostPort?: {
    host?: string;
    port?: number;
  };
  usbConnectOpt?: {
    retryTime: number;
  };
  enableWebSocket?: boolean;
  websocketOption?: {
    port?: number;
    roomId?: string;
  };
  networkDeviceOpt?: {
    ip: string;
    port: number[];
  };
  idleTimeout?: number;
};
