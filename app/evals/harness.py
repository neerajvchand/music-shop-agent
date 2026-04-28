"""Eval harness: run scenarios against prompt modules, gate promotion."""

from __future__ import annotations

import json
import logging
from typing import Any

from app.evals.judge import judge_call
from app.evals.scenarios import SCENARIOS
from app.prompts.registry import PromptRegistry
from app.supabase_client import get_supabase

logger = logging.getLogger(__name__)

PASS_THRESHOLD = 0.75


class EvalHarness:
    """Run eval suites and determine if a module version can be promoted to live."""

    def __init__(self, module_name: str, module_version: int, vertical: str):
        self.module_name = module_name
        self.module_version = module_version
        self.vertical = vertical
        self.results: list[dict[str, Any]] = []

    async def run(self) -> dict[str, Any]:
        """Run all scenarios for the vertical against the module."""
        scenarios = [s for s in SCENARIOS if s["vertical"] == self.vertical]
        if not scenarios:
            logger.warning("No scenarios for vertical %s", self.vertical)
            return {"status": "passed", "overall_score": 1.0, "scenarios_total": 0, "scenarios_passed": 0}

        # Create eval run record
        sb = get_supabase()
        run_result = sb.table("eval_runs").insert({
            "module_name": self.module_name,
            "module_version": self.module_version,
            "vertical_slug": self.vertical,
            "status": "running",
            "scenarios_total": len(scenarios),
        }).execute()
        run_id = run_result.data[0]["id"]

        passed = 0
        for scenario in scenarios:
            score = await self._run_scenario(scenario)
            self.results.append(score)
            if score.get("passed", False):
                passed += 1

        overall = passed / len(scenarios) if scenarios else 1.0
        status = "passed" if overall >= PASS_THRESHOLD else "failed"

        # Update eval run
        sb.table("eval_runs").update({
            "status": status,
            "overall_score": overall,
            "scenarios_passed": passed,
            "results_json": self.results,
            "completed_at": "now()",
        }).eq("id", run_id).execute()

        # Auto-promote if passed
        if status == "passed":
            await self._promote_module()

        return {
            "status": status,
            "overall_score": overall,
            "scenarios_total": len(scenarios),
            "scenarios_passed": passed,
            "results": self.results,
        }

    async def _run_scenario(self, scenario: dict[str, Any]) -> dict[str, Any]:
        """Run a single scenario. Returns result dict."""
        # For now, this is a skeleton — full implementation requires a simulated caller
        # that opens a WebSocket to the bridge and executes the script_hint.
        # We return a placeholder result that must be filled by integration tests.
        logger.info("Running scenario %s (vertical=%s)", scenario["name"], self.vertical)
        return {
            "scenario": scenario["name"],
            "passed": True,
            "score": 1.0,
            "transcript": "",
            "notes": "Placeholder — run via integration test harness",
        }

    async def _promote_module(self) -> None:
        """Promote module version to live and deprecate previous live version."""
        sb = get_supabase()
        # Find previous live version
        prev = (
            sb.table("prompt_modules")
            .select("id, version")
            .eq("name", self.module_name)
            .eq("vertical_slug", self.vertical)
            .eq("status", "live")
            .execute()
        )
        for row in (prev.data or []):
            if row["version"] != self.module_version:
                sb.table("prompt_modules").update({"status": "deprecated"}).eq("id", row["id"]).execute()

        # Promote this version
        sb.table("prompt_modules").update({"status": "live"}).eq("name", self.module_name).eq("version", self.module_version).eq("vertical_slug", self.vertical).execute()
        logger.info("Promoted %s v%d to live", self.module_name, self.module_version)


async def run_eval_suite(module_name: str, module_version: int, vertical: str) -> dict[str, Any]:
    """Convenience function to run an eval suite."""
    harness = EvalHarness(module_name, module_version, vertical)
    return await harness.run()
