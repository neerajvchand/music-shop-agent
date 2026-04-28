"""Assemble system prompt from independently versioned modules."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any

from app.prompts.registry import PromptRegistry

logger = logging.getLogger(__name__)

SEPARATOR = "\n\n---\n\n"


@dataclass
class CallContext:
    """Runtime context for prompt composition."""

    shop_id: str
    vertical: str | None
    caller_phone: str | None
    current_state: str = "greeting"
    today: str = ""
    calendar_snapshot: list[dict] = field(default_factory=list)
    promos: list[str] = field(default_factory=list)
    staff_status: dict[str, Any] = field(default_factory=dict)
    test_mode: bool = False
    resume_draft: dict[str, Any] | None = None


def compose(context: CallContext, bindings: list[dict[str, Any]] | None = None) -> tuple[str, list[dict[str, Any]]]:
    """
    Assemble the full system prompt and tool definitions from modules.

    Returns (system_prompt_text, tool_definitions_list).
    """
    if bindings is None:
        bindings = PromptRegistry.resolve_bindings(context.shop_id, context.vertical)

    sections: list[str] = []
    tools: list[dict[str, Any]] = []

    # Order matters: persona -> vertical -> business -> state -> runtime -> tools -> guardrails -> few_shot
    ordered_names = ["persona", "vertical", "business", "state", "runtime", "tools", "guardrails", "few_shot"]
    binding_map = {b["module_name"]: b for b in bindings}

    for name in ordered_names:
        binding = binding_map.get(name)
        if not binding:
            continue

        try:
            module = PromptRegistry.get_module(
                name=binding["module_name"],
                version=binding["module_version"],
                vertical=binding.get("vertical_slug") or context.vertical,
            )
        except ModuleNotFoundError as e:
            logger.warning("Module not found: %s", e)
            continue

        content = _render_module(module, context)
        if name == "tools":
            tools = _extract_tools(content)
        sections.append(f"## {name.upper()}\n{content}")

    if context.test_mode:
        sections.append("## TEST MODE\nThis is a TEST call. Do NOT write to any calendar. Confirm verbally that this is a test.")

    if context.resume_draft:
        sections.append(f"## RESUMED DRAFT\nThe caller was previously booking and disconnected. Here is what was already captured: {json.dumps(context.resume_draft)}")

    full_prompt = SEPARATOR.join(sections)
    return full_prompt, tools


def _render_module(module: dict[str, Any], context: CallContext) -> str:
    """Substitute runtime params into module content."""
    content: str = module.get("content", "")
    params_schema = module.get("params_schema") or {}

    # Build params dict from context
    params: dict[str, Any] = {}
    for key in params_schema.get("properties", {}).keys():
        if hasattr(context, key):
            params[key] = getattr(context, key)

    # Simple {{param}} substitution
    for key, value in params.items():
        placeholder = f"{{{{{key}}}}}"
        if placeholder in content:
            if isinstance(value, (list, dict)):
                content = content.replace(placeholder, json.dumps(value))
            else:
                content = content.replace(placeholder, str(value))

    return content


def _extract_tools(content: str) -> list[dict[str, Any]]:
    """Parse tool definitions embedded in the tools module content.

    Expected format: markdown code blocks with json inside, or a special
    <!-- TOOLS START --> ... <!-- TOOLS END --> block.
    """
    import re

    # Look for a JSON array inside a markdown code block or raw
    patterns = [
        r"<!-- TOOLS START -->(.*?)<!-- TOOLS END -->",
        r"```json\n(.*?)\n```",
        r"```\n(.*?)\n```",
    ]
    for pattern in patterns:
        match = re.search(pattern, content, re.DOTALL)
        if match:
            try:
                data = json.loads(match.group(1).strip())
                if isinstance(data, list):
                    return data
                if isinstance(data, dict) and "functions" in data:
                    return data["functions"]
            except json.JSONDecodeError:
                continue
    return []
