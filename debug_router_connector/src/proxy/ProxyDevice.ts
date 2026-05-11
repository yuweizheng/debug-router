// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { BaseDevice } from "../device/BaseDevice";
import { SerializedDevice } from "./types";

export class ProxyDevice extends BaseDevice {
  private readonly host: string;

  constructor(driver: any, serialized: SerializedDevice) {
    super(driver, serialized.info);
    this.port = serialized.ports ?? [];
    this.host = serialized.host;
  }

  getHost(): string {
    return this.host;
  }

  startWatchClient() {
    // The proxy host owns the physical client watcher.
  }

  async stopWatchClient() {
    // The proxy host owns the physical client watcher.
  }

  disConnect() {
    this.connected = false;
  }
}
