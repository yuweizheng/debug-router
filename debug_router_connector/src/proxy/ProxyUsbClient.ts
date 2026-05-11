// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import EventEmitter from "events";
import { Client } from "../connector/Client";
import { CustomizedEventType, SocketEvent } from "../utils/type";
import { SerializedClient } from "./types";

export class ProxyUsbClient extends Client {
  private readonly events = new EventEmitter();

  constructor(
    readonly info: any,
    private readonly remote: {
      sendCustomizedMessage: (
        clientId: number,
        method: string,
        params: Object,
        sessionId: number,
        type: string,
        originalMessageId: number,
      ) => Promise<string>;
      sendRawMessage: (clientId: number, message: any) => Promise<any>;
      sendMessage: (clientId: number, message: any) => void;
      closeClient: (clientId: number) => void;
    },
  ) {
    super();
  }

  static fromSerialized(
    serialized: SerializedClient,
    remote: ConstructorParameters<typeof ProxyUsbClient>[1],
  ) {
    return new ProxyUsbClient(serialized.info, remote);
  }

  clientId(): number {
    return this.info.id;
  }

  deviceId() {
    return this.info.query.device_id;
  }

  close() {
    this.remote.closeClient(this.clientId());
  }

  on(event: string, callback: (...params: any[]) => void) {
    this.events.on(event, callback);
  }

  onAllEvents(callback: (...params: any[]) => void) {
    this.events.on("all-cdp-message", callback);
  }

  off(event: string, callback: (...params: any[]) => void) {
    this.events.off(event, callback);
  }

  once(event: string, callback: (...params: any[]) => void) {
    this.events.once(event, callback);
  }

  sendCustomizedMessage(
    method: string,
    params: Object = "",
    sessionId: number = -1,
    type: string = "CDP",
  ): Promise<string> {
    const originalMessageId = (ProxyUsbClient as any).messageIdCounter++;
    return this.remote.sendCustomizedMessage(
      this.clientId(),
      method,
      params,
      sessionId,
      type,
      originalMessageId,
    );
  }

  sendRawMessage(message: any): Promise<any> {
    return this.remote.sendRawMessage(this.clientId(), message);
  }

  sendMessage(message: any) {
    this.remote.sendMessage(this.clientId(), message);
  }

  sendClientMessage(method: string, params: Object = {}): Promise<string> {
    return this.sendCustomizedMessage(method, params, -1, "App");
  }

  handleProxyMessage(message: string) {
    let response: any;
    try {
      response = JSON.parse(message);
    } catch {
      return;
    }
    if (response?.event !== SocketEvent.Customized) {
      return;
    }
    const data = response.data;
    if (data?.type === CustomizedEventType.SessionList) {
      this.events.emit("SessionList", data.data);
      return;
    }
    if (
      data?.type !== CustomizedEventType.CDP &&
      data?.type !== CustomizedEventType.App
    ) {
      return;
    }
    const payload = data?.data?.message;
    if (typeof payload !== "string") {
      return;
    }
    try {
      const cdpMessage = JSON.parse(payload);
      if (cdpMessage?.method) {
        const session = { session_id: data?.data?.session_id ?? -1 };
        this.events.emit(cdpMessage.method, cdpMessage.params, session);
        this.events.emit(
          "all-cdp-message",
          cdpMessage.method,
          cdpMessage.params,
          session,
        );
      }
    } catch {
      // Ignore non-CDP payloads.
    }
  }
}
