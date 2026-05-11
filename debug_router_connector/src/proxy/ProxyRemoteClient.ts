// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { WebSocket } from "ws";
import { defaultLogger } from "../utils/logger";
import { discoveryIsFresh, readDiscovery } from "./discovery";
import { ProxyDevice } from "./ProxyDevice";
import { ProxyUsbClient } from "./ProxyUsbClient";
import {
  PROXY_CONTROL_PATH,
  ProxyDiscoveryInfo,
  ProxyEvent,
  ProxyRequest,
  ProxyResponse,
  SerializedClient,
  SerializedDevice,
} from "./types";

type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class ProxyRemoteClient {
  private socket: WebSocket | null = null;
  private requestId = 0;
  private readonly pending = new Map<number, Pending>();
  private readyPromise: Promise<void>;
  private readyResolve?: () => void;
  private reconnectTimer?: NodeJS.Timeout;
  private readonly proxyClients = new Map<number, ProxyUsbClient>();

  constructor(
    private readonly driver: any,
    private discovery: ProxyDiscoveryInfo | null,
  ) {
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
    this.connect();
  }

  private connect() {
    if (!discoveryIsFresh(this.discovery)) {
      this.discovery = readDiscovery();
      if (!this.discovery) {
        this.scheduleReconnect();
        return;
      }
    }
    const discovery = this.discovery;
    if (!discovery) {
      this.scheduleReconnect();
      return;
    }
    const url =
      `ws://127.0.0.1:${discovery.controlPort}` +
      `${PROXY_CONTROL_PATH}?token=${discovery.token}`;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.on("open", () => {
      defaultLogger.info("DebugRouterProxy: connected to proxy host");
      this.readyResolve?.();
    });
    socket.on("message", (data: any) => {
      this.handleMessage(data.toString());
    });
    socket.on("close", () => {
      defaultLogger.warn("DebugRouterProxy: proxy host connection closed");
      if (this.socket === socket) {
        this.socket = null;
        this.discovery = null;
        this.resetReadyPromise();
        this.rejectPending(new Error("DebugRouterProxy connection closed"));
        this.scheduleReconnect();
      }
    });
    socket.on("error", (error: Error) => {
      defaultLogger.warn("DebugRouterProxy: proxy host error:" + error.message);
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, 500);
  }

  private resetReadyPromise() {
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
  }

  private rejectPending(error: Error) {
    this.pending.forEach((pending) => {
      clearTimeout(pending.timer);
      pending.reject(error);
    });
    this.pending.clear();
  }

  private async ready() {
    await this.readyPromise;
  }

  private handleMessage(message: string) {
    let payload: ProxyResponse | ProxyEvent;
    try {
      payload = JSON.parse(message);
    } catch {
      return;
    }
    if ("id" in payload) {
      const pending = this.pending.get(payload.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(payload.id);
      if (payload.ok) {
        pending.resolve(payload.result);
      } else {
        pending.reject(new Error(payload.error ?? "Proxy request failed"));
      }
      return;
    }
    this.handleEvent(payload);
  }

  private handleEvent(event: ProxyEvent) {
    switch (event.event) {
      case "snapshot":
        this.applySnapshot(event.payload);
        break;
      case "device-connected":
        this.upsertDevice(event.payload);
        this.driver.emit(
          "device-connected",
          this.driver.devices.get(event.payload.info.serial),
        );
        break;
      case "device-disconnected": {
        const device = this.driver.devices.get(event.payload.serial);
        this.driver.devices.delete(event.payload.serial);
        if (device) {
          this.driver.emit("device-disconnected", device);
        }
        break;
      }
      case "client-connected":
        this.upsertClient(event.payload);
        this.driver.emit(
          "client-connected",
          this.driver.usbClients.get(event.payload.info.id),
        );
        this.driver.emit(
          "app-client-connected",
          this.driver.usbClients.get(event.payload.info.id),
        );
        break;
      case "client-disconnected": {
        const id = event.payload.id;
        this.proxyClients.delete(id);
        this.driver.usbClients.delete(id);
        this.driver.emit("client-disconnected", id);
        this.driver.emit("app-client-disconnected", id);
        break;
      }
      case "usb-client-message": {
        const id = event.payload.id;
        const client = this.proxyClients.get(id);
        client?.handleProxyMessage(event.payload.message);
        this.driver.emit("usb-client-message", event.payload);
        break;
      }
    }
  }

  private applySnapshot(payload: {
    devices: SerializedDevice[];
    clients: SerializedClient[];
  }) {
    const deviceSerials = new Set(
      payload.devices.map((device) => device.info?.serial).filter(Boolean),
    );
    Array.from(this.driver.devices.keys() as Iterable<string>).forEach(
      (serial) => {
        if (!deviceSerials.has(serial)) {
          const device = this.driver.devices.get(serial);
          this.driver.devices.delete(serial);
          if (device) {
            this.driver.emit("device-disconnected", device);
          }
        }
      },
    );
    const clientIds = new Set(
      payload.clients.map((client) => client.info?.id).filter(Boolean),
    );
    Array.from(this.driver.usbClients.keys() as Iterable<number>).forEach(
      (id) => {
        if (!clientIds.has(id)) {
          this.proxyClients.delete(id);
          this.driver.usbClients.delete(id);
          this.driver.emit("client-disconnected", id);
          this.driver.emit("app-client-disconnected", id);
        }
      },
    );
    payload.devices.forEach((device) => this.upsertDevice(device));
    payload.clients.forEach((client) => this.upsertClient(client));
  }

  private upsertDevice(serialized: SerializedDevice) {
    if (!serialized?.info?.serial) {
      return;
    }
    this.driver.devices.set(
      serialized.info.serial,
      new ProxyDevice(this.driver, serialized),
    );
  }

  private upsertClient(serialized: SerializedClient) {
    if (!serialized?.info?.id) {
      return;
    }
    const client = ProxyUsbClient.fromSerialized(serialized, this);
    this.proxyClients.set(client.clientId(), client);
    this.driver.usbClients.set(client.clientId(), client);
  }

  private async request(method: string, params?: any): Promise<any> {
    await this.ready();
    const discovery = this.discovery;
    if (!discovery) {
      throw new Error("DebugRouterProxy discovery is not ready");
    }
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("DebugRouterProxy is not connected");
    }
    const id = ++this.requestId;
    const payload: ProxyRequest = {
      id,
      method,
      params,
      token: discovery.token,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DebugRouterProxy request timeout: ${method}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify(payload));
    });
  }

  async connectDevices(timeout = -1, serial: string | null = null) {
    await this.request("connectDevices", { timeout, serial });
    return this.getDevices(timeout, serial);
  }

  async getDevices(timeout = -1, serial: string | null = null) {
    const devices = (await this.request("getDevices", {
      timeout,
      serial,
    })) as SerializedDevice[];
    devices.forEach((device) => this.upsertDevice(device));
    return Array.from(this.driver.devices.values()).filter(
      (device: any) => serial === null || device.serial === serial,
    );
  }

  async connectUsbClients(
    deviceId: string,
    timeout = -1,
    waitTimeout = true,
    clientName: string | null = null,
  ) {
    const clients = (await this.request("connectUsbClients", {
      deviceId,
      timeout,
      waitTimeout,
      clientName,
    })) as SerializedClient[];
    clients.forEach((client) => this.upsertClient(client));
    return clients.map((client) => this.driver.usbClients.get(client.info.id));
  }

  async startWSServer() {
    return this.request("startWSServer");
  }

  startWatchAllClients(force = true) {
    this.request("startWatchAllClients", { force }).catch((error) => {
      defaultLogger.warn(
        "DebugRouterProxy startWatchAllClients:" + error.message,
      );
    });
  }

  sendMessageToWeb(message: string) {
    this.request("sendMessageToWeb", { message }).catch((error) => {
      defaultLogger.warn("DebugRouterProxy sendMessageToWeb:" + error.message);
    });
  }

  sendMessageToApp(id: number, message: string) {
    this.request("sendMessageToApp", { id, message }).catch((error) => {
      defaultLogger.warn("DebugRouterProxy sendMessageToApp:" + error.message);
    });
  }

  sendCustomizedMessage(
    clientId: number,
    method: string,
    params: Object,
    sessionId: number,
    type: string,
    originalMessageId: number,
  ) {
    return this.request("sendCustomizedMessage", {
      clientId,
      method,
      params,
      sessionId,
      type,
      originalMessageId,
    });
  }

  sendRawMessage(clientId: number, message: any) {
    return this.request("sendRawMessage", { clientId, message });
  }

  sendMessage(clientId: number, message: any) {
    this.request("sendMessage", { clientId, message }).catch((error) => {
      defaultLogger.warn("DebugRouterProxy sendMessage:" + error.message);
    });
  }

  closeClient(clientId: number) {
    this.request("closeClient", { clientId }).catch((error) => {
      defaultLogger.warn("DebugRouterProxy closeClient:" + error.message);
    });
  }
}
