// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import http from "http";
import detectPort from "detect-port";
import { WebSocket, WebSocketServer } from "ws";
import { defaultLogger } from "../utils/logger";
import {
  createDiscovery,
  releaseProxyDaemonLock,
  writeDiscovery,
} from "./discovery";
import {
  DEFAULT_PROXY_CONTROL_PORT,
  PROXY_CONTROL_PATH,
  PROXY_HEARTBEAT_INTERVAL,
  ProxyEvent,
  ProxyHostOptions,
  ProxyRequest,
  SerializedClient,
  SerializedDevice,
} from "./types";

type ControlConnection = {
  id: number;
  socket: WebSocket;
};

type PendingTarget =
  | {
      kind: "control";
      controlId: number;
      originalId: number;
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  | {
      kind: "websocket";
      webClientId: number;
      originalId: number;
    };

export class ProxyHost {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private token = "";
  private frontendId = 1000000;
  private globalMessageId = 1000000000;
  private readonly controls = new Map<number, ControlConnection>();
  private readonly pending = new Map<number, PendingTarget>();
  private heartbeatTimer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private closed = false;
  private unregisterProcessCleanup?: () => void;

  constructor(
    private readonly driver: any,
    private readonly options: ProxyHostOptions = {},
  ) {
    this.attachDriverEvents();
  }

  async start() {
    const port = await detectPort(DEFAULT_PROXY_CONTROL_PORT);
    const discovery = createDiscovery(port);
    this.token = discovery.token;
    this.server = http.createServer((request, response) => {
      if (request.url?.startsWith("/health")) {
        const url = new URL(request.url, "http://127.0.0.1");
        if (url.searchParams.get("token") !== this.token) {
          response.writeHead(401);
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: true,
            pid: process.pid,
            protocolVersion: discovery.protocolVersion,
          }),
        );
        return;
      }
      response.writeHead(404);
      response.end();
    });
    this.wss = new WebSocketServer({
      server: this.server,
      path: PROXY_CONTROL_PATH,
    });
    this.wss.on("connection", (socket, request) => {
      const url = new URL(request.url ?? "", "http://127.0.0.1");
      if (url.searchParams.get("token") !== this.token) {
        socket.close();
        return;
      }
      this.handleControlConnection(socket);
    });
    await new Promise<void>((resolve, reject) => {
      const handleError = (error: Error) => {
        this.close();
        reject(error);
      };
      this.server?.once("error", handleError);
      this.server?.listen(port, "127.0.0.1", () => {
        this.server?.off("error", handleError);
        writeDiscovery({ ...discovery, heartbeat: Date.now() });
        this.heartbeatTimer = setInterval(() => {
          writeDiscovery({ ...discovery, heartbeat: Date.now() });
        }, PROXY_HEARTBEAT_INTERVAL);
        defaultLogger.info("DebugRouterProxy: proxy host listening:" + port);
        resolve();
      });
    });
    this.registerProcessCleanup();
    this.scheduleIdleTimerIfNeeded();
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    try {
      this.wss?.close();
      this.server?.close();
    } catch (error: any) {
      defaultLogger.debug("DebugRouterProxy: close failed:" + error?.message);
    }
    releaseProxyDaemonLock();
  }

  private registerProcessCleanup() {
    if (this.unregisterProcessCleanup) {
      return;
    }
    try {
      const signalExitModule = require("signal-exit");
      const onExit =
        typeof signalExitModule === "function"
          ? signalExitModule
          : signalExitModule.onExit || signalExitModule.default || null;
      if (typeof onExit === "function") {
        this.unregisterProcessCleanup = onExit(() => this.close());
        return;
      }
    } catch {
      // Fall back to the native exit event below.
    }
    process.once("exit", () => this.close());
  }

  private attachDriverEvents() {
    this.driver.on("device-connected", (device: any) => {
      this.broadcast({
        event: "device-connected",
        payload: this.serializeDevice(device),
      });
    });
    this.driver.on("device-disconnected", (device: any) => {
      this.broadcast({
        event: "device-disconnected",
        payload: { serial: device.serial },
      });
    });
    this.driver.on("client-connected", (client: any) => {
      this.broadcast({
        event: "client-connected",
        payload: this.serializeClient(client),
      });
    });
    this.driver.on("client-disconnected", (id: number) => {
      this.broadcast({ event: "client-disconnected", payload: { id } });
    });
  }

  private handleControlConnection(socket: WebSocket) {
    const id = ++this.frontendId;
    this.cancelIdleTimer();
    this.controls.set(id, { id, socket });
    socket.on("message", (data) => {
      this.handleControlRequest(id, data.toString()).catch((error) => {
        defaultLogger.warn("DebugRouterProxy request error:" + error.message);
      });
    });
    socket.on("close", () => {
      this.controls.delete(id);
      this.clearPendingForControl(id);
      this.scheduleIdleTimerIfNeeded();
    });
    this.sendControlEvent(id, {
      event: "snapshot",
      payload: {
        devices: this.serializeDevices(),
        clients: this.serializeClients(),
      },
    });
  }

  private cancelIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private scheduleIdleTimerIfNeeded() {
    const timeout = this.options.idleTimeout;
    if (this.closed || timeout === undefined || timeout < 0) {
      return;
    }
    if (this.controls.size > 0 || this.idleTimer) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (!this.closed && this.controls.size === 0) {
        defaultLogger.info("DebugRouterProxy: daemon idle timeout");
        this.options.onIdleTimeout?.();
      }
    }, timeout);
  }

  private async handleControlRequest(controlId: number, raw: string) {
    let request: ProxyRequest;
    try {
      request = JSON.parse(raw);
    } catch {
      return;
    }
    if (request.token !== this.token) {
      this.sendResponse(controlId, request.id, false, undefined, "bad token");
      return;
    }
    try {
      const result = await this.dispatch(controlId, request);
      this.sendResponse(controlId, request.id, true, result);
    } catch (error: any) {
      this.sendResponse(
        controlId,
        request.id,
        false,
        undefined,
        error?.message,
      );
    }
  }

  private async dispatch(controlId: number, request: ProxyRequest) {
    const params = request.params ?? {};
    switch (request.method) {
      case "connectDevices":
        return this.driver.connectDevices(params.timeout, params.serial);
      case "getDevices":
        return this.serializeDevices(
          await this.driver.getDevices(params.timeout, params.serial),
        );
      case "connectUsbClients":
        return this.serializeClients(
          await this.driver.connectUsbClients(
            params.deviceId,
            params.timeout,
            params.waitTimeout,
            params.clientName,
          ),
        );
      case "startWSServer":
        if (params.enableWebSocket !== undefined) {
          this.driver.enableWebSocket = params.enableWebSocket;
        }
        if (params.wssPort !== undefined) {
          this.driver.wssPort = params.wssPort;
        }
        if (params.roomId !== undefined) {
          this.driver.roomId = params.roomId;
        }
        if (this.driver.wss) {
          return {
            wssPath: this.driver.wss?.wssPath,
            wssHost: this.driver.wssHost,
            wssPort: this.driver.wssPort,
            roomId: this.driver.roomId,
          };
        }
        await this.driver.startWSServer();
        return {
          wssPath: this.driver.wss?.wssPath,
          wssHost: this.driver.wssHost,
          wssPort: this.driver.wssPort,
          roomId: this.driver.roomId,
        };
      case "startWatchAllClients":
        this.driver.startWatchAllClients(params.force);
        return true;
      case "sendMessageToWeb":
        this.driver.sendMessageToWeb(params.message);
        return true;
      case "sendMessageToApp":
        this.driver.sendMessageToApp(params.id, params.message);
        return true;
      case "sendCustomizedMessage":
        return this.sendCustomizedMessageForControl(
          controlId,
          request.id,
          params,
        );
      case "sendRawMessage":
        return this.sendRawMessageForControl(controlId, request.id, params);
      case "sendMessage":
        this.routeRawMessage(params.clientId, params.message);
        return true;
      case "closeClient":
        this.driver.usbClients.get(params.clientId)?.close();
        return true;
      default:
        throw new Error("Unknown proxy method:" + request.method);
    }
  }

  private sendCustomizedMessageForControl(
    controlId: number,
    _rpcId: number,
    params: any,
  ) {
    const globalId = ++this.globalMessageId;
    const originalId = params.originalMessageId ?? globalId;
    const message = {
      event: "Customized",
      data: {
        type: params.type,
        data: {
          client_id: -1,
          session_id: params.sessionId,
          message: {
            id: globalId,
            method: params.method,
            params: params.params,
          },
        },
        sender: 0,
      },
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(globalId);
        reject(new Error("DebugRouterProxy sendCustomizedMessage timeout"));
      }, 10000);
      this.pending.set(globalId, {
        kind: "control",
        controlId,
        originalId,
        resolve,
        reject,
        timer,
      });
      try {
        this.routeRawMessage(params.clientId, message);
      } catch (error: any) {
        clearTimeout(timer);
        this.pending.delete(globalId);
        reject(error);
      }
    });
  }

  private sendRawMessageForControl(
    controlId: number,
    _rpcId: number,
    params: any,
  ) {
    if (this.extractMessageId(params.message) <= 0) {
      this.routeRawMessage(params.clientId, params.message);
      return true;
    }
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const rewritten = this.rewriteOutgoingMessage(params.message, {
        kind: "control",
        controlId,
        originalId: -1,
        resolve,
        reject,
        timer: (timer = setTimeout(() => {
          this.pending.forEach((target, id) => {
            if (target.kind === "control" && target.timer === timer) {
              this.pending.delete(id);
            }
          });
          reject(new Error("DebugRouterProxy sendRawMessage timeout"));
        }, 10000)),
      });
      const rewrittenId = this.extractMessageId(rewritten);
      try {
        this.routeRawMessage(params.clientId, rewritten);
      } catch (error: any) {
        if (rewrittenId > 0) {
          const target = this.pending.get(rewrittenId);
          if (target?.kind === "control") {
            clearTimeout(target.timer);
          }
          this.pending.delete(rewrittenId);
        }
        reject(error);
      }
    });
  }

  routeWebMessage(
    clientId: number,
    message: string,
    webClientId?: number,
  ): boolean {
    if (!webClientId) {
      return false;
    }
    let data: any;
    try {
      data = JSON.parse(message);
    } catch {
      return false;
    }
    if (
      data?.data?.type === "UsbConnect" ||
      data?.data?.type === "UsbConnectAck"
    ) {
      return true;
    }
    const rewritten = this.rewriteOutgoingMessage(data, {
      kind: "websocket",
      webClientId,
      originalId: -1,
    });
    this.routeRawMessage(clientId, rewritten);
    return true;
  }

  routeUsbMessage(clientId: number, message: string): boolean {
    let data: any;
    try {
      data = JSON.parse(message);
    } catch {
      return false;
    }
    this.rewriteRuntimeIdentity(data, clientId);
    const responseId = this.extractMessageId(data);
    if (responseId > 0) {
      const pending = this.pending.get(responseId);
      if (!pending) {
        return true;
      }
      this.pending.delete(responseId);
      this.replaceMessageId(data, pending.originalId);
      const routedMessage = JSON.stringify(data);
      if (pending.kind === "control") {
        const payload = data?.data?.data?.message ?? routedMessage;
        clearTimeout(pending.timer);
        pending.resolve(payload);
      } else {
        this.driver.wss?.sendMessageToWebClient?.(
          pending.webClientId,
          routedMessage,
        );
      }
      return true;
    }
    const routedMessage = JSON.stringify(data);
    this.driver.wss?.sendMessageToWeb(routedMessage);
    this.broadcast({
      event: "usb-client-message",
      payload: { id: clientId, message: routedMessage },
    });
    return true;
  }

  private rewriteOutgoingMessage(message: any, target: PendingTarget) {
    const id = this.extractMessageId(message);
    if (id <= 0) {
      this.rewriteClientIdForRuntime(message);
      return message;
    }
    const globalId = ++this.globalMessageId;
    const pendingTarget = { ...target, originalId: id } as PendingTarget;
    this.pending.set(globalId, pendingTarget);
    this.replaceMessageId(message, globalId);
    this.rewriteClientIdForRuntime(message);
    return message;
  }

  private routeRawMessage(clientId: number, message: any) {
    const client = this.driver.usbClients.get(clientId);
    if (!client) {
      throw new Error("Cannot find client:" + clientId);
    }
    if (typeof message === "string") {
      client.sendMessage(JSON.parse(message));
    } else {
      client.sendMessage(message);
    }
  }

  private extractMessageId(message: any): number {
    const payload = message?.data?.data?.message;
    if (payload == null) {
      return -1;
    }
    if (typeof payload === "object") {
      return typeof payload.id === "number" ? payload.id : -1;
    }
    try {
      const parsed = JSON.parse(payload);
      return typeof parsed.id === "number" ? parsed.id : -1;
    } catch {
      return -1;
    }
  }

  private replaceMessageId(message: any, id: number) {
    const payload = message?.data?.data?.message;
    if (payload == null) {
      return;
    }
    if (typeof payload === "object") {
      payload.id = id;
      return;
    }
    try {
      const parsed = JSON.parse(payload);
      parsed.id = id;
      message.data.data.message = JSON.stringify(parsed);
    } catch {
      // Ignore non-JSON payloads.
    }
  }

  private rewriteClientIdForRuntime(message: any) {
    if (message?.data?.data?.hasOwnProperty("client_id")) {
      message.data.data.client_id = -1;
    }
  }

  private rewriteRuntimeIdentity(message: any, clientId: number) {
    if (message.data && message.data.hasOwnProperty("sender")) {
      message.data.sender = clientId;
    }
    if (message.data?.data?.hasOwnProperty("client_id")) {
      message.data.data.client_id = clientId;
    }
  }

  private clearPendingForControl(controlId: number) {
    this.pending.forEach((target, id) => {
      if (target.kind === "control" && target.controlId === controlId) {
        clearTimeout(target.timer);
        target.reject(new Error("DebugRouterProxy control connection closed"));
        this.pending.delete(id);
      }
    });
  }

  private sendControlEvent(id: number, event: ProxyEvent) {
    const control = this.controls.get(id);
    if (control && control.socket.readyState === WebSocket.OPEN) {
      control.socket.send(JSON.stringify(event));
    }
  }

  private broadcast(event: ProxyEvent) {
    this.controls.forEach((control) => {
      if (control.socket.readyState === WebSocket.OPEN) {
        control.socket.send(JSON.stringify(event));
      }
    });
  }

  private sendResponse(
    controlId: number,
    id: number,
    ok: boolean,
    result?: any,
    error?: string,
  ) {
    const control = this.controls.get(controlId);
    if (!control || control.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    control.socket.send(JSON.stringify({ id, ok, result, error }));
  }

  private serializeDevice(device: any): SerializedDevice {
    return {
      info: device.info,
      ports: device.ports ?? [],
      host:
        typeof device.getHost === "function" ? device.getHost() : "127.0.0.1",
    };
  }

  private serializeDevices(devices?: any[]): SerializedDevice[] {
    const list = devices ?? Array.from(this.driver.devices.values());
    return list.map((device) => this.serializeDevice(device));
  }

  private serializeClient(client: any): SerializedClient {
    return {
      info: client.info,
    };
  }

  private serializeClients(clients?: any[]): SerializedClient[] {
    const list = clients ?? Array.from(this.driver.usbClients.values());
    return list.map((client) => this.serializeClient(client));
  }
}
