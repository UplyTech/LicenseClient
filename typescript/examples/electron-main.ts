/**
 * Wiring the licence into an Electron main process.
 *
 * This is the shape TeamProManager and FlashTrix both use. The renderer never
 * sees a licence key or a device token: it asks over IPC and gets back a
 * verdict and a feature list.
 *
 * Not runnable as it stands - `electron` is a peer of the host application,
 * not of this package.
 */

import { join } from 'node:path';

import {
  ApiError,
  FileStorage,
  LicenseClient,
  NetworkError,
  SeatLimitError,
  isValidKey,
  type Evaluation,
} from '@uplytech/license-client';

// Compiled in. Fetching this at runtime would let whoever is in the middle
// hand out their own key - and with it, any licence they like.
const PUBLIC_KEYS = {
  lk_2026_01: 'REPLACE_WITH_THE_PUBLIC_KEY_FROM_uplytech_signing_generate-keypair',
};

// Stand-ins for the Electron API, so this file reads without it.
declare const app: { getPath(name: string): string; getVersion(): string };
declare const ipcMain: {
  handle(channel: string, handler: (event: unknown, ...args: never[]) => unknown): void;
};
declare function readSetting(key: string): string | undefined;
declare function writeSetting(key: string, value: string): void;
declare function randomUUID(): string;

/**
 * The installation id belongs to this install, not to the hardware.
 *
 * Generated once and kept. It is the one fingerprint component the library
 * cannot derive on its own, and it is what lets two installations on the same
 * machine be told apart.
 */
function installId(): string {
  let stored = readSetting('installId');
  if (!stored) {
    stored = randomUUID();
    writeSetting('installId', stored);
  }
  return stored;
}

export function createLicenseClient(): LicenseClient {
  return new LicenseClient({
    // Configurable, because the API address is not the same in development,
    // on a customer's own server and in production.
    apiBaseUrl: readSetting('apiBaseUrl') ?? 'http://localhost:8000',
    productSlug: 'teampromanager',
    appVersion: app.getVersion(),
    publicKeys: PUBLIC_KEYS,
    storage: new FileStorage(join(app.getPath('userData'), 'licence.bin')),
    installId: installId(),
  });
}

const licence = createLicenseClient();

/** What the renderer gets. Never the key, never a token. */
interface LicenseView {
  state: string;
  reason: string | null;
  canRun: boolean;
  daysLeftOffline: number | null;
  tier: string;
  features: string[];
  warnings: string[];
}

function view(evaluation: Evaluation): LicenseView {
  const snapshot = licence.snapshot;
  return {
    state: evaluation.state,
    reason: evaluation.reason,
    canRun: evaluation.canRun,
    daysLeftOffline: evaluation.daysLeftOffline,
    tier: snapshot?.tier ?? 'free',
    features: snapshot?.features ?? [],
    warnings: snapshot?.warnings ?? [],
  };
}

export function registerLicenceIpc(): void {
  ipcMain.handle('licence:status', async () => view(await licence.ensure()));

  ipcMain.handle('licence:activate', async (_event, ...args: never[]) => {
    const key = args[0] as unknown as string;

    // Offline first: a typo never needs a round trip, and the server is not a
    // place to check whether a key exists.
    if (!isValidKey(key)) {
      return { ok: false, error: 'invalid_key' };
    }

    try {
      return { ok: true, licence: view(await licence.activate(key)) };
    } catch (error) {
      if (error instanceof SeatLimitError) {
        // Hand the machines back so the dialog can offer to free one, rather
        // than telling the customer to write to support.
        return { ok: false, error: 'seat_limit', seats: error.seats };
      }
      if (error instanceof NetworkError) {
        return { ok: false, error: 'offline' };
      }
      if (error instanceof ApiError) {
        return { ok: false, error: error.code, message: error.message };
      }
      throw error;
    }
  });

  ipcMain.handle('licence:deactivate', async () => {
    await licence.deactivate();
    return view(licence.evaluation);
  });

  ipcMain.handle('licence:hasFeature', (_event, ...args: never[]) =>
    licence.hasFeature(args[0] as unknown as string),
  );
}

/**
 * Called at start-up, before the first window opens.
 *
 * `ensure()` never throws for a connection problem, so a customer on a train
 * still gets their application - as long as the offline window has not run
 * out.
 */
export async function gateStartup(): Promise<LicenseView> {
  return view(await licence.ensure());
}

/**
 * Check in periodically while the application runs.
 *
 * Twice the heartbeat interval is deliberate: the offline window is measured in
 * days, so a missed check costs nothing, and a laptop that sleeps for eight
 * hours should not wake up to a locked application.
 */
export function scheduleHeartbeat(): NodeJS.Timeout {
  return setInterval(
    () => {
      void licence.ensure().catch(() => {
        // Already handled inside ensure(); anything that escapes is a refusal
        // the user will see at the next status query.
      });
    },
    6 * 60 * 60 * 1000,
  );
}
