#!/usr/bin/env python3

import argparse
import asyncio
import json
import os
import re
import sys
from typing import Any, Callable, Optional

# Native to python
from xml.etree.ElementTree import Element

import marimo
from marimo import MarimoIslandGenerator

try:
    from marimo._ast.app import App
    from marimo._convert.markdown.markdown import (
        MARIMO_MD,
        MarimoMdParser as MarimoParser,
        SafeWrap as SafeWrapGeneric,
        extract_frontmatter,
    )

    SafeWrap = SafeWrapGeneric[App]
except ImportError:
    # Fallback for marimo < 0.13.16
    from marimo._cli.convert.markdown import (  # type: ignore[import, no-redef]
        MARIMO_MD,
        MarimoParser,
        SafeWrap,
        extract_frontmatter,
    )

from marimo._islands import MarimoIslandStub
from marimo._utils.yaml import dump as yaml_dump

__version__ = "0.1.0"

# See https://quarto.org/docs/computations/execution-options.html
default_config = {
    "eval": True,
    "echo": False,
    "output": True,
    "warning": True,
    "error": True,
    "include": True,
    # Particular to marimo
    "editor": False,
}


def extract_and_strip_quarto_config(block: str) -> tuple[dict[str, Any], str]:
    pattern = r"^\s*\#\|\s*(.*?)\s*:\s*(.*?)(?=\n|\Z)"
    config: dict[str, Any] = {}
    lines = block.split("\n")
    if not lines:
        return config, block

    split_index = 0
    for i, line in enumerate(lines):
        split_index = i
        line = line.strip()
        if not line:
            continue
        source_match = re.search(pattern, line)
        if not source_match:
            break
        key, value = source_match.groups()
        config[key] = json.loads(value)
    return config, "\n".join(lines[split_index:])


def generate_markdown_output(
    global_options: dict[str, Any],
    stub: Optional[MarimoIslandStub],
    config: dict[str, bool],
    mime_sensitive: bool,
) -> str:
    """Generate markdown output for a single marimo cell."""
    # Local supersede global supersedes default options
    config = {**global_options, **config}
    if not config["include"] or stub is None:
        return ""

    markdown_output = ""

    # Show static code if echo (but not editor - that's handled by marimo)
    if config["echo"] and not config["editor"]:
        markdown_output += f"```python\n{stub.code}\n```\n\n"

    # Generate output based on MIME type and sensitivity
    output = stub.output
    if output and config["output"]:
        mimetype = output.mimetype

        if mime_sensitive:
            # For PDF/LaTeX formats
            if mimetype.startswith("image"):
                markdown_output += f"![Generated Figure]({output.data})\n\n"
            elif mimetype.startswith("text/plain") or mimetype.startswith("text/markdown"):
                markdown_output += f"{output.data}\n\n"
            elif mimetype == "application/vnd.marimo+error":
                if config["error"]:
                    markdown_output += f"> {output.data}\n\n"
                # Suppress errors otherwise
        else:
            # For HTML formats, check for errors first
            if mimetype == "application/vnd.marimo+error":
                if config["warning"]:
                    sys.stderr.write(
                        "Warning: Only the `disabled` codeblock attribute is utilized"
                        " for pandoc export. Be sure to set desired code attributes "
                        "in quarto form.\n"
                    )
                if not config["error"]:
                    return markdown_output

            # Enclose HTML in proper fencing - ensure newline before backticks
            html_content = stub.render(
                display_code=None,  # Use the display_code setting from add_code()
                display_output=True,
                is_reactive=config["eval"] and not mime_sensitive,
                as_raw=mime_sensitive
            )
            markdown_output += f"\n```{{=html}}\n{html_content}\n```\n\n"

    return markdown_output


def app_config_from_root(root: Element) -> dict[str, Any]:
    # Extract meta data from root attributes.
    config_keys = {"title": "app_title", "marimo-layout": "layout_file"}
    config = {
        config_keys[key]: value for key, value in root.items() if key in config_keys
    }
    # Try to pass on other attributes as is
    config.update({k: v for k, v in root.items() if k not in config_keys})
    # Remove values particular to markdown saves.
    config.pop("marimo-version", None)
    return config


def build_export_with_mime_context(
    mime_sensitive: bool,
    debug: bool = False,
    frontmatter: dict[str, Any] = {},
) -> Callable[[Element], SafeWrap]:
    def tree_to_pandoc_export(root: Element) -> SafeWrap:
        global_options = {**default_config, **app_config_from_root(root)}
        app = MarimoIslandGenerator()

        # Track parsed document structure
        markdown_sections = []
        stubs = []
        has_attrs: bool = False
        chunk_sequence = []  # Track the sequence of chunks for debugging
        debug_info = []  # Track editor settings for debugging

        # Process each element in the document
        for child in root:
            if child.tag == MARIMO_MD:
                # Regular markdown content - preserve as is
                chunk_sequence.append("markdown")
                markdown_sections.append(str(child.text) if child.text else "")
                continue

            # Process marimo code blocks
            chunk_sequence.append("marimo")
            # We only care about the disabled attribute.
            if child.attrib.get("disabled") == "true":
                # Don't even add to generator
                stubs.append(({"include": False}, None))
                continue

            # Check to see if attrs are defined on the tag
            has_attrs = has_attrs | bool(child.attrib.items())

            code = str(child.text) if child.text else ""
            config, code = extract_and_strip_quarto_config(code)

            # Merge config to get final editor setting
            merged_config = {**global_options, **config}
            display_code = merged_config.get("editor", False)

            if debug:
                debug_info.append({
                    "cell_code_preview": code[:50] if code else "",
                    "local_config": config,
                    "editor_setting": merged_config.get("editor"),
                    "eval_setting": merged_config.get("eval"),
                    "display_code": display_code,
                })

            try:
                stub = app.add_code(
                    code,
                    is_raw=True,
                    display_code=display_code,
                )
            except Exception:
                stubs.append((config, None))
                continue

            assert isinstance(stub, MarimoIslandStub), "Unexpected error, please report"

            stubs.append((config, stub))

        if has_attrs and global_options.get("warning", True):
            pass

        # Execute all code
        _ = asyncio.run(app.build())

        # Generate header for resources
        dev_server = os.environ.get("QUARTO_MARIMO_DEBUG_ENDPOINT", False)
        version_override = os.environ.get("QUARTO_MARIMO_VERSION", marimo.__version__)
        header = app.render_head(
            _development_url=dev_server, version_override=version_override
        )

        # Generate outputs for all cells
        cell_outputs = []
        for config, stub in stubs:
            output = generate_markdown_output(global_options, stub, config, mime_sensitive)
            cell_outputs.append(output)

        # Output debug info before reconstruction if requested
        if debug:
            sys.stderr.write(f"Debug: Chunk sequence = {chunk_sequence}\n")
            sys.stderr.write(f"Debug: Markdown sections = {len(markdown_sections)}, Code blocks = {len(cell_outputs)}\n")
            sys.stderr.write(f"Debug: First markdown section (first 200 chars): {markdown_sections[0][:200] if markdown_sections else 'NONE'}\n")

        # Rebuild the document using chunk_sequence to preserve order
        full_markdown = ""
        markdown_idx = 0
        marimo_idx = 0

        for i, chunk_type in enumerate(chunk_sequence):
            if chunk_type == "markdown":
                full_markdown += markdown_sections[markdown_idx]
                markdown_idx += 1
            else:  # "marimo"
                full_markdown += cell_outputs[marimo_idx]
                marimo_idx += 1

            # Add blank line between chunks if not the last chunk
            # and if the current chunk doesn't already end with double newline
            if i < len(chunk_sequence) - 1 and not full_markdown.endswith("\n\n"):
                full_markdown += "\n"

        # Verify we consumed all elements
        assert markdown_idx == len(markdown_sections), \
            f"Did not consume all markdown sections: used {markdown_idx} of {len(markdown_sections)}"
        assert marimo_idx == len(cell_outputs), \
            f"Did not consume all code outputs: used {marimo_idx} of {len(cell_outputs)}"

        # Prepend YAML frontmatter if it exists
        if frontmatter:
            yaml_body = yaml_dump(frontmatter).rstrip()
            full_markdown = f"---\n{yaml_body}\n---\n\n{full_markdown}"

        result = {
            "header": header,
            "markdown": full_markdown,
            "outputs": cell_outputs,
            "count": len(cell_outputs),
        }

        # Include debug information if requested
        if debug:
            result["chunk_sequence"] = chunk_sequence
            result["first_markdown"] = markdown_sections[0][:500] if markdown_sections else None
            result["cell_debug_info"] = debug_info

        return SafeWrap(result)  # type: ignore[arg-type]

    return tree_to_pandoc_export


def convert_from_md_to_pandoc_export(text: str, mime_sensitive: bool, debug: bool = False) -> dict[str, Any]:
    if not text:
        return {"header": "", "markdown": "", "outputs": [], "count": 0}

    # Extract YAML frontmatter before parsing
    frontmatter_dict, remaining_text = extract_frontmatter(text)

    # Create a custom parser class with the debug flag and frontmatter baked in
    class MarimoPandocParser(MarimoParser):
        """Parses Markdown to marimo notebook string."""
        # TODO: Could upstream generic for keys- but this is fine.
        output_formats = {  # type: ignore[assignment, misc]
            "marimo-pandoc-export": build_export_with_mime_context(mime_sensitive=False, debug=debug, frontmatter=frontmatter_dict),  # type: ignore[dict-item]
            "marimo-pandoc-export-with-mime": build_export_with_mime_context(mime_sensitive=True, debug=debug, frontmatter=frontmatter_dict),  # type: ignore[dict-item]
        }

    if mime_sensitive:
        parser = MarimoPandocParser(output_format="marimo-pandoc-export-with-mime")  # type: ignore[arg-type]
    else:
        parser = MarimoPandocParser(output_format="marimo-pandoc-export")  # type: ignore[arg-type]
    # Parse the remaining text without the frontmatter
    return parser.convert(remaining_text)  # type: ignore[arg-type, return-value]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Process markdown with marimo.')
    parser.add_argument('reference_file', help='Reference file path')
    parser.add_argument('mime_sensitive', help='Whether output is MIME sensitive (yes/no)')
    parser.add_argument('--debug', action='store_true', help='Include debug information in output')
    args = parser.parse_args(sys.argv[1:])

    file = sys.stdin.read()
    if not file:
        with open(args.reference_file) as f:
            file = f.read()
    no_js = args.mime_sensitive.lower() == "yes"
    os.environ["MARIMO_NO_JS"] = str(no_js).lower()

    conversion = convert_from_md_to_pandoc_export(file, no_js, args.debug)
    sys.stdout.write(json.dumps(conversion))
