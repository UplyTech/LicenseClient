/**
 * Probing the machine - the half that cannot be unit tested.
 *
 * Every source here is best effort. A machine where one probe is blocked by
 * policy still gets a fingerprint from the others, which is exactly what the
 * weighted comparison in `fingerprint.ts` is for. Nothing in this file throws.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname, networkInterfaces, platform, release, userInfo } from 'node:os';

import { combineFingerprint, hashComponents, type ComponentMap } from './fingerprint.js';

function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function readFile(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Firmware that ships a placeholder is worse than nothing: taken at face value
 * it makes every machine of one model look like the same computer.
 */
const PLACEHOLDERS = new Set([
  'to be filled by o.e.m.',
  'to be filled by oem',
  'default string',
  'system serial number',
  'none',
  'n/a',
  'not specified',
  'not available',
  '00000000',
  '0',
]);

function firstMac(): string {
  const interfaces = networkInterfaces();
  const candidates: string[] = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.internal || !address.mac || address.mac === '00:00:00:00:00:00') continue;
      // Virtual adapters come and go with VPN clients and container runtimes.
      // Treating one as *the* address would change the fingerprint every time
      // somebody connects to a VPN.
      if (/^(veth|docker|br-|vmnet|vboxnet|utun|tun|tap|zt)/i.test(name)) continue;
      candidates.push(`${name}:${address.mac}`);
    }
  }
  // Sorted, so the enumeration order of the adapters cannot change the result.
  candidates.sort();
  return candidates[0] ?? '';
}

function powershell(script: string): string {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

function windowsComponents(): ComponentMap {
  const cim = (className: string, field: string): string =>
    powershell(`(Get-CimInstance -ClassName ${className} | Select-Object -First 1).${field}`)
      .split('\n')[0]
      ?.trim() ?? '';

  return {
    // The registry MachineGuid is written at installation and survives
    // everything short of a reinstall.
    machine_id:
      run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'])
        .split(/\s+/)
        .pop() ?? '',
    board: cim('Win32_BaseBoard', 'SerialNumber'),
    disk: cim('Win32_DiskDrive', 'SerialNumber'),
    cpu: cim('Win32_Processor', 'ProcessorId'),
  };
}

function macComponents(): ComponentMap {
  const profile = run('system_profiler', ['SPHardwareDataType']);
  const field = (label: string): string =>
    new RegExp(`${label}:\\s*(.+)`).exec(profile)?.[1]?.trim() ?? '';

  return {
    // IOPlatformUUID is the closest macOS equivalent of a machine id and
    // survives a reinstall.
    machine_id:
      /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']))
        ?.[1] ?? '',
    board: field('Serial Number \\(system\\)'),
    disk: field('Hardware UUID'),
    cpu: field('(?:Chip|Processor Name)'),
  };
}

function linuxComponents(): ComponentMap {
  return {
    machine_id: readFile('/etc/machine-id') || readFile('/var/lib/dbus/machine-id'),
    board: readFile('/sys/class/dmi/id/board_serial') || readFile('/sys/class/dmi/id/product_uuid'),
    disk: run('lsblk', ['-ndo', 'SERIAL']).split('\n')[0]?.trim() ?? '',
    cpu: /model name\s*:\s*(.+)/.exec(readFile('/proc/cpuinfo'))?.[1]?.trim() ?? '',
  };
}

/**
 * Probe the machine. Returns raw values - hash them before sending anything.
 *
 * `installId` is supplied by the caller: it belongs to the installation, is
 * generated once and stored, and is the one component that cannot be derived
 * from the hardware.
 */
export function collectComponents(installId?: string): ComponentMap {
  let os: ComponentMap;
  switch (platform()) {
    case 'win32':
      os = windowsComponents();
      break;
    case 'darwin':
      os = macComponents();
      break;
    default:
      os = linuxComponents();
      break;
  }

  const raw: ComponentMap = {
    ...os,
    mac: firstMac(),
    user: `${userInfo().username}@${hostname()}`,
  };
  if (installId) raw.install_id = installId;

  const cleaned: ComponentMap = {};
  for (const [name, value] of Object.entries(raw)) {
    const trimmed = value?.trim();
    if (!trimmed || PLACEHOLDERS.has(trimmed.toLowerCase())) continue;
    cleaned[name] = trimmed;
  }
  return cleaned;
}

/**
 * Whether this looks like a virtual machine.
 *
 * Reported to the server, never a reason to refuse on its own: virtual desktop
 * infrastructure is how a great many companies hand out workstations.
 */
export function detectVirtualMachine(): boolean {
  const markers = /virtualbox|vmware|qemu|kvm|xen|hyper-?v|parallels|bochs/i;
  switch (platform()) {
    case 'win32':
      return markers.test(
        powershell(
          '$c = Get-CimInstance Win32_ComputerSystem; "$($c.Manufacturer) $($c.Model)"',
        ),
      );
    case 'darwin':
      // Apple hardware is not virtualised in any way that matters here.
      return false;
    default:
      return (
        markers.test(readFile('/sys/class/dmi/id/product_name')) ||
        markers.test(readFile('/sys/class/dmi/id/sys_vendor')) ||
        readFile('/proc/1/cgroup').includes('docker')
      );
  }
}

export interface DeviceIdentity {
  fingerprint: string;
  components: ComponentMap;
  installId?: string;
  name: string;
  platform: string;
  osVersion: string;
  vmSuspected: boolean;
}

/** Everything the activation endpoint wants about this machine, already hashed. */
export function identifyDevice(installId?: string): DeviceIdentity {
  const components = hashComponents(collectComponents(installId));
  return {
    fingerprint: combineFingerprint(components),
    components,
    installId,
    name: hostname(),
    platform: platform(),
    osVersion: release(),
    vmSuspected: detectVirtualMachine(),
  };
}
