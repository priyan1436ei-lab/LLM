"""Scheduler daemon: runs the daily briefing at a configured local time.

    python scheduler.py                      run in the foreground, briefing at schedule.briefing_time
    python scheduler.py --time 06:45         override the time
    python scheduler.py --once               run one briefing now and exit
    python scheduler.py --list-tasks         show how to install it as a Windows task

It never installs a system task or registry entry by itself: those are printed
as commands for you to review and run yourself.
"""

from __future__ import annotations

import argparse
import signal
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from briefing import build_briefing  # noqa: E402
from config import ensure_dirs, load_config  # noqa: E402
from store import Store  # noqa: E402

PROJECT = Path(__file__).resolve().parent


def parse_time(text: str) -> tuple[int, int]:
    try:
        hour_text, minute_text = text.strip().split(":")
        hour, minute = int(hour_text), int(minute_text)
    except ValueError as exc:
        raise ValueError(f"time must look like HH:MM, got '{text}'") from exc
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError(f"time out of range: '{text}'")
    return hour, minute


def next_run(hour: int, minute: int, now: datetime | None = None) -> datetime:
    now = now or datetime.now()
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return target


def run_once(cfg: dict, store: Store) -> None:
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{stamp}] building briefing...")
    try:
        build_briefing(cfg, store, use_model=bool(cfg.get("schedule", {}).get("briefing_use_model", True)))
    except Exception as exc:  # noqa: BLE001 - a daemon must survive one bad run
        print(f"[{time.strftime('%H:%M:%S')}] briefing failed: {type(exc).__name__}: {exc}")


def list_tasks(cfg: dict, write_helper: bool = True) -> None:
    hour, minute = parse_time(str(cfg.get("schedule", {}).get("briefing_time", "07:30")))
    python = sys.executable
    script = PROJECT / "scheduler.py"
    stamp = f"{hour:02d}:{minute:02d}"

    print("To have Windows run the briefing automatically, review and run ONE of these yourself.")
    print("Nothing is installed for you on purpose - a scheduled task is a change to your system.\n")

    print("Option A - PowerShell's own task cmdlets (no quote escaping, recommended):")
    print(f"   $action  = New-ScheduledTaskAction -Execute '{python}' -Argument '\"{script}\" --once'")
    print(f"   $trigger = New-ScheduledTaskTrigger -Daily -At {stamp}")
    print(
        "   Register-ScheduledTask -TaskName 'PersonalAgentBriefing' -Action $action "
        "-Trigger $trigger -Description 'Local personal agent daily briefing'"
    )

    if write_helper:
        helper = Path(cfg["paths"]["data"]) / "install-briefing-task.cmd"
        remover = Path(cfg["paths"]["data"]) / "remove-briefing-task.cmd"
        helper.write_text(
            "@echo off\r\n"
            "rem Review this file before running it. Installs a daily Windows task.\r\n"
            f'schtasks /Create /TN "PersonalAgentBriefing" /SC DAILY /ST {stamp} '
            f'/TR "\\"{python}\\" \\"{script}\\" --once" /F\r\n',
            encoding="utf-8",
        )
        remover.write_text(
            "@echo off\r\n" f'schtasks /Delete /TN "PersonalAgentBriefing" /F\r\n', encoding="utf-8"
        )
        print("\nOption B - reviewable .cmd helper scripts (already written, nothing ran yet):")
        print(f"   install: {helper}")
        print(f"   remove:  {remover}")
        print("   Open the install one, check the paths, then run it. cmd.exe handles the quotes correctly.")

    print("\nVerify or undo after installing:")
    print('   schtasks /Query /TN "PersonalAgentBriefing" /V /FO LIST')
    print('   schtasks /Delete /TN "PersonalAgentBriefing" /F')
    print("\nOption C - skip the system task and keep the daemon open while you work:")
    print(f'   "{python}" "{script}"')


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="scheduler.py", description="Run the daily briefing on a timer.")
    parser.add_argument("--config", help="path to an alternative config.json")
    parser.add_argument("--time", help="local time as HH:MM (default from config.json)")
    parser.add_argument("--once", action="store_true", help="build the briefing once and exit")
    parser.add_argument("--list-tasks", action="store_true", help="print commands to schedule it with Windows")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    cfg = load_config(args.config)
    ensure_dirs(cfg)
    store = Store(Path(cfg["paths"]["data"]) / "agent.db")

    try:
        if args.list_tasks:
            list_tasks(cfg)
            return 0
        if args.once:
            run_once(cfg, store)
            return 0

        clock = args.time or str(cfg.get("schedule", {}).get("briefing_time", "07:30"))
        hour, minute = parse_time(clock)
        print(f"scheduler started - daily briefing at {hour:02d}:{minute:02d}. Ctrl+C to stop.")
        stopping = {"flag": False}

        def stop(_signum, _frame):
            stopping["flag"] = True
            print("\nstopping after this wait...")

        signal.signal(signal.SIGINT, stop)
        while not stopping["flag"]:
            target = next_run(hour, minute)
            sleep_for = max(1.0, (target - datetime.now()).total_seconds())
            print(f"  next briefing: {target.strftime('%Y-%m-%d %H:%M')} (in {sleep_for / 3600:.1f}h)")
            while sleep_for > 0 and not stopping["flag"]:
                step = min(30.0, sleep_for)
                time.sleep(step)
                sleep_for -= step
            if stopping["flag"]:
                break
            run_once(cfg, store)
        print("scheduler stopped.")
        return 0
    finally:
        store.close()


if __name__ == "__main__":
    raise SystemExit(main())
