"""Probing the machine - the half that cannot be unit tested.

Every source here is best effort. A machine where one probe is blocked by
policy still gets a fingerprint from the others, which is exactly what the
weighted comparison in ``fingerprint.py`` is for. Nothing in this module
raises.
"""

from __future__ import annotations

import platform as platform_module
import re
import socket
import subprocess
import uuid
from pathlib import Path

from .fingerprint import combine_fingerprint, hash_components
from .types import DeviceIdentity

#: Firmware that ships a placeholder is worse than nothing: taken at face value
#: it makes every machine of one model look like the same computer.
PLACEHOLDERS = frozenset(
    {
        "to be filled by o.e.m.",
        "to be filled by oem",
        "default string",
        "system serial number",
        "none",
        "n/a",
        "not specified",
        "not available",
        "00000000",
        "0",
    }
)


def _run(command: list[str]) -> str:
    try:
        result = subprocess.run(  # noqa: S603
            command,
            capture_output=True,
            text=True,
            timeout=4,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout.strip()


def _read(path: str) -> str:
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return ""


def _powershell(script: str) -> str:
    return _run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script])


def _windows_components() -> dict[str, str]:
    def cim(class_name: str, field: str) -> str:
        raw = _powershell(
            f"(Get-CimInstance -ClassName {class_name} | Select-Object -First 1).{field}"
        )
        return raw.splitlines()[0].strip() if raw else ""

    machine_id = _run(
        ["reg", "query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"]
    )
    return {
        # The registry MachineGuid is written at installation and survives
        # everything short of a reinstall.
        "machine_id": machine_id.split()[-1] if machine_id else "",
        "board": cim("Win32_BaseBoard", "SerialNumber"),
        "disk": cim("Win32_DiskDrive", "SerialNumber"),
        "cpu": cim("Win32_Processor", "ProcessorId"),
    }


def _macos_components() -> dict[str, str]:
    profile = _run(["system_profiler", "SPHardwareDataType"])

    def field(label: str) -> str:
        match = re.search(rf"{label}:\s*(.+)", profile)
        return match.group(1).strip() if match else ""

    ioreg = _run(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"])
    uuid_match = re.search(r'"IOPlatformUUID"\s*=\s*"([^"]+)"', ioreg)
    return {
        # IOPlatformUUID is the closest macOS equivalent of a machine id and
        # survives a reinstall.
        "machine_id": uuid_match.group(1) if uuid_match else "",
        "board": field(r"Serial Number \(system\)"),
        "disk": field("Hardware UUID"),
        "cpu": field("(?:Chip|Processor Name)"),
    }


def _linux_components() -> dict[str, str]:
    cpuinfo = re.search(r"model name\s*:\s*(.+)", _read("/proc/cpuinfo"))
    disk = _run(["lsblk", "-ndo", "SERIAL"])
    return {
        "machine_id": _read("/etc/machine-id") or _read("/var/lib/dbus/machine-id"),
        "board": _read("/sys/class/dmi/id/board_serial")
        or _read("/sys/class/dmi/id/product_uuid"),
        "disk": disk.splitlines()[0].strip() if disk else "",
        "cpu": cpuinfo.group(1).strip() if cpuinfo else "",
    }


def _mac_address() -> str:
    node = uuid.getnode()
    # getnode() invents a random value when it cannot find a real adapter, and
    # marks it by setting the multicast bit. A random address would change the
    # fingerprint on every start.
    if node >> 40 & 0x01:
        return ""
    return ":".join(f"{(node >> shift) & 0xFF:02x}" for shift in range(40, -8, -8))


def collect_components(install_id: str | None = None) -> dict[str, str]:
    """Probe the machine. Returns raw values - hash them before sending."""
    system = platform_module.system()
    if system == "Windows":
        components = _windows_components()
    elif system == "Darwin":
        components = _macos_components()
    else:
        components = _linux_components()

    components["mac"] = _mac_address()
    try:
        import getpass

        components["user"] = f"{getpass.getuser()}@{socket.gethostname()}"
    except Exception:  # noqa: BLE001 - a container with no passwd entry
        components["user"] = ""
    if install_id:
        components["install_id"] = install_id

    return {
        name: value.strip()
        for name, value in components.items()
        if value and value.strip() and value.strip().lower() not in PLACEHOLDERS
    }


def detect_virtual_machine() -> bool:
    """Whether this looks like a virtual machine.

    Reported to the server, never a reason to refuse on its own: virtual
    desktop infrastructure is how a great many companies hand out
    workstations.
    """
    markers = re.compile(r"virtualbox|vmware|qemu|kvm|xen|hyper-?v|parallels|bochs", re.I)
    system = platform_module.system()
    if system == "Windows":
        return bool(
            markers.search(
                _powershell(
                    "$c = Get-CimInstance Win32_ComputerSystem; "
                    '"$($c.Manufacturer) $($c.Model)"'
                )
            )
        )
    if system == "Darwin":
        # Apple hardware is not virtualised in any way that matters here.
        return False
    return bool(
        markers.search(_read("/sys/class/dmi/id/product_name"))
        or markers.search(_read("/sys/class/dmi/id/sys_vendor"))
        or "docker" in _read("/proc/1/cgroup")
    )


def identify_device(install_id: str | None = None) -> DeviceIdentity:
    """Everything the activation endpoint wants about this machine, hashed."""
    components = hash_components(collect_components(install_id))
    return DeviceIdentity(
        fingerprint=combine_fingerprint(components),
        components=components,
        install_id=install_id,
        name=socket.gethostname(),
        platform=platform_module.system().lower(),
        os_version=platform_module.release(),
        vm_suspected=detect_virtual_machine(),
    )
