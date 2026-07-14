#!/usr/bin/env python3
"""Builds docs/ajax-adapter.pdf from docs/ajax-adapter.mdx.

Purpose-built for this repo's MDX subset: YAML frontmatter, #/##/### headings,
paragraphs with `code` / **bold** / *italic* / [links](...), ``` fences,
"- " bullet lists, | markdown tables |, "> " callouts, and the two-column
before/after JSX grid blocks.

Usage:
    pip install reportlab
    python3 scripts/build-docs-pdf.py

Regenerate the PDF whenever docs/ajax-adapter.mdx changes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from reportlab.lib.colors import HexColor, white
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.pdfmetrics import registerFontFamily
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    HRFlowable,
    KeepTogether,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
    XPreformatted,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
MDX_PATH = REPO_ROOT / "docs" / "ajax-adapter.mdx"
PDF_PATH = REPO_ROOT / "docs" / "ajax-adapter.pdf"

# ---------------------------------------------------------------------------
# Fonts. TrueType and embedded: non-embedded base-14 Type1 fonts (Helvetica &
# co.) render as blank text in several viewers, so embedding is not optional.
# ---------------------------------------------------------------------------

MAC_FONT_DIR = Path("/System/Library/Fonts/Supplemental")
SANS = "DocSans"
SANS_BOLD = "DocSans-Bold"
SANS_ITALIC = "DocSans-Italic"
SANS_BOLD_ITALIC = "DocSans-BoldItalic"
MONO = "DocMono"


def register_fonts() -> None:
    faces = {
        SANS: "Arial.ttf",
        SANS_BOLD: "Arial Bold.ttf",
        SANS_ITALIC: "Arial Italic.ttf",
        SANS_BOLD_ITALIC: "Arial Bold Italic.ttf",
        MONO: "Courier New.ttf",
    }
    for name, filename in faces.items():
        path = MAC_FONT_DIR / filename
        if not path.exists():
            raise FileNotFoundError(
                f"{path} not found - point MAC_FONT_DIR at a directory with Arial and Courier New TTFs"
            )
        pdfmetrics.registerFont(TTFont(name, str(path)))
    # Lets <b>/<i> markup inside paragraphs resolve to the right face.
    registerFontFamily(SANS, normal=SANS, bold=SANS_BOLD, italic=SANS_ITALIC, boldItalic=SANS_BOLD_ITALIC)

# ---------------------------------------------------------------------------
# Palette and styles
# ---------------------------------------------------------------------------

BLUE = "#1a73e8"
BODY_COLOR = "#202124"
MUTED = "#5f6368"
INLINE_CODE = "#c2185b"
KEYWORD = "#1967d2"
STRING = "#188038"
COMMENT = "#9aa0a6"
CODE_BG = "#f8f9fa"
CODE_BORDER = "#dadce0"
RULE = "#e0e0e0"
CALLOUT_BG = "#e8f0fe"

PAGE_WIDTH, _ = letter
MARGIN = 54
CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN

STYLES = {
    "title": ParagraphStyle(
        "title", fontName=SANS_BOLD, fontSize=23, leading=28,
        textColor=HexColor(BODY_COLOR), alignment=TA_CENTER, spaceAfter=10,
    ),
    "subtitle": ParagraphStyle(
        "subtitle", fontName=SANS, fontSize=12, leading=17,
        textColor=HexColor(MUTED), spaceAfter=14,
    ),
    "h2": ParagraphStyle(
        "h2", fontName=SANS_BOLD, fontSize=17, leading=21,
        textColor=HexColor(BODY_COLOR), spaceBefore=6, spaceAfter=8,
    ),
    "h3": ParagraphStyle(
        "h3", fontName=SANS_BOLD, fontSize=12.5, leading=16,
        textColor=HexColor(BODY_COLOR), spaceBefore=14, spaceAfter=6,
    ),
    "body": ParagraphStyle(
        "body", fontName=SANS, fontSize=10.5, leading=15.5,
        textColor=HexColor(BODY_COLOR), spaceAfter=8,
    ),
    "bullet": ParagraphStyle(
        "bullet", fontName=SANS, fontSize=10.5, leading=15.5,
        textColor=HexColor(BODY_COLOR), leftIndent=16, spaceAfter=5,
        bulletFontName=SANS, bulletIndent=4,
    ),
    "code": ParagraphStyle(
        "code", fontName=MONO, fontSize=8, leading=11.2,
        textColor=HexColor(BODY_COLOR), backColor=HexColor(CODE_BG),
        borderColor=HexColor(CODE_BORDER), borderWidth=0.7, borderPadding=8,
        spaceBefore=6, spaceAfter=12,
    ),
    "grid-header": ParagraphStyle(
        "grid-header", fontName=SANS_BOLD, fontSize=9.5, leading=12,
        textColor=HexColor(MUTED), spaceAfter=2,
    ),
    "arrow": ParagraphStyle(
        "arrow", fontName=SANS, fontSize=14, leading=16,
        textColor=HexColor(MUTED), alignment=TA_CENTER,
    ),
    "table-header": ParagraphStyle(
        "table-header", fontName=SANS_BOLD, fontSize=9, leading=12,
        textColor=white,
    ),
    "table-cell": ParagraphStyle(
        "table-cell", fontName=SANS, fontSize=9, leading=12.5,
        textColor=HexColor(BODY_COLOR),
    ),
    "callout": ParagraphStyle(
        "callout", fontName=SANS, fontSize=10, leading=14.5,
        textColor=HexColor(BODY_COLOR),
    ),
}

HEADING_STYLE_NAMES = {"h2", "h3"}

# ---------------------------------------------------------------------------
# Inline markdown -> reportlab markup
# ---------------------------------------------------------------------------

INLINE_TOKEN = re.compile(
    r"(?P<code>`[^`]+`)"
    r"|(?P<bold>\*\*.+?\*\*)"
    r"|(?P<italic>\*[^*\s][^*]*\*)"
    r"|(?P<link>\[[^\]]+\]\([^)]+\))"
)
JS_KEYWORD = re.compile(
    r"\b(var|const|let|new|function|return|throw|try|catch|if|else|switch|case|"
    r"default|while|for|in|of|typeof|instanceof|null|undefined|true|false|this)\b"
)
JS_NUMBER = re.compile(r"\b\d+\b")


def escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def inline(text: str) -> str:
    """Converts inline markdown to reportlab paragraph markup."""
    out: list[str] = []
    position = 0
    for match in INLINE_TOKEN.finditer(text):
        out.append(escape(text[position:match.start()]))
        token = match.group(0)
        if match.lastgroup == "code":
            out.append(f'<font face="{MONO}" color="{INLINE_CODE}">{escape(token[1:-1])}</font>')
        elif match.lastgroup == "bold":
            out.append(f"<b>{inline(token[2:-2])}</b>")
        elif match.lastgroup == "italic":
            out.append(f"<i>{inline(token[1:-1])}</i>")
        else:  # link: keep the text, drop the URL (the PDF is not hyperlinked)
            link_text = token[1:token.index("]")]
            out.append(inline(link_text))
        position = match.end()
    out.append(escape(text[position:]))
    return "".join(out)


# ---------------------------------------------------------------------------
# JS syntax highlighting for code fences
# ---------------------------------------------------------------------------

def highlight_js_line(line: str) -> str:
    """Escapes and colors one physical line of JS."""
    code_part, comment_part = split_comment(line)
    pieces: list[str] = []
    for segment in re.split(r"('[^']*')", code_part):
        if segment.startswith("'"):
            pieces.append(f'<font color="{STRING}">{escape(segment)}</font>')
        else:
            escaped = escape(segment)
            escaped = JS_KEYWORD.sub(rf'<font color="{KEYWORD}">\1</font>', escaped)
            escaped = JS_NUMBER.sub(lambda m: f'<font color="{STRING}">{m.group(0)}</font>', escaped)
            pieces.append(escaped)
    if comment_part:
        pieces.append(f'<font color="{COMMENT}">{escape(comment_part)}</font>')
    return "".join(pieces)


def split_comment(line: str) -> tuple[str, str]:
    """Splits a line at the first // that is not inside a single-quoted string."""
    in_string = False
    for index, char in enumerate(line):
        if char == "'":
            in_string = not in_string
        elif not in_string and line[index:index + 2] == "//":
            return line[:index], line[index:]
    return line, ""


def code_block(lines: list[str], width: float) -> XPreformatted:
    """Wraps long lines to the box width, highlights, and boxes the code."""
    max_chars = max(20, int((width - 16) / (STYLES["code"].fontSize * 0.6)))
    wrapped: list[str] = []
    for line in lines:
        while len(line) > max_chars:
            wrapped.append(line[:max_chars])
            line = line[max_chars:]
        wrapped.append(line)
    marked = "\n".join(highlight_js_line(line) for line in wrapped)
    return XPreformatted(marked, STYLES["code"])


# ---------------------------------------------------------------------------
# Block-level MDX parsing
# ---------------------------------------------------------------------------

@dataclass
class Block:
    kind: str
    text: str = ""
    lines: list[str] = field(default_factory=list)
    rows: list[list[str]] = field(default_factory=list)
    cells: list[list["Block"]] = field(default_factory=list)


def parse_frontmatter(lines: list[str]) -> tuple[dict[str, str], list[str]]:
    if not lines or lines[0].strip() != "---":
        return {}, lines
    meta: dict[str, str] = {}
    for index in range(1, len(lines)):
        if lines[index].strip() == "---":
            return meta, lines[index + 1:]
        key, _, value = lines[index].partition(":")
        meta[key.strip()] = value.strip()
    raise ValueError("unterminated frontmatter")


def parse_blocks(lines: list[str]) -> list[Block]:
    blocks: list[Block] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        stripped = line.strip()
        if stripped == "":
            index += 1
        elif stripped == "---":
            blocks.append(Block("hr"))
            index += 1
        elif stripped.startswith("<div style={{display:'grid'"):
            block, index = parse_grid(lines, index)
            blocks.append(block)
        elif stripped.startswith("# ") and not blocks:
            blocks.append(Block("title", text=stripped[2:]))
            index += 1
        elif stripped.startswith("## "):
            blocks.append(Block("h2", text=stripped[3:]))
            index += 1
        elif stripped.startswith("### "):
            blocks.append(Block("h3", text=stripped[4:]))
            index += 1
        elif stripped.startswith("```"):
            fence: list[str] = []
            index += 1
            while lines[index].strip() != "```":
                fence.append(lines[index].rstrip())
                index += 1
            blocks.append(Block("code", lines=fence))
            index += 1
        elif stripped.startswith("- "):
            items: list[str] = []
            while index < len(lines) and lines[index].strip().startswith("- "):
                items.append(lines[index].strip()[2:])
                index += 1
            blocks.append(Block("bullets", lines=items))
        elif stripped.startswith("|"):
            rows: list[list[str]] = []
            while index < len(lines) and lines[index].strip().startswith("|"):
                cells = [cell.strip() for cell in lines[index].strip().strip("|").split("|")]
                if not all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells):
                    rows.append(cells)
                index += 1
            blocks.append(Block("table", rows=rows))
        elif stripped.startswith("> "):
            quoted: list[str] = []
            while index < len(lines) and lines[index].strip().startswith(">"):
                quoted.append(lines[index].strip().lstrip("> "))
                index += 1
            blocks.append(Block("callout", text=" ".join(quoted)))
        else:
            paragraph = [stripped]
            index += 1
            while index < len(lines) and lines[index].strip() not in ("",) \
                    and not re.match(r"^(#|-|\||>|```|<div|---)", lines[index].strip()):
                paragraph.append(lines[index].strip())
                index += 1
            blocks.append(Block("paragraph", text=" ".join(paragraph)))
    return blocks


def parse_grid(lines: list[str], start: int) -> tuple[Block, int]:
    """Parses a two-column before/after JSX grid into its two content cells."""
    block = Block("grid")
    depth = 0
    index = start
    cell_lines: list[str] | None = None
    while index < len(lines):
        stripped = lines[index].strip()
        if stripped.startswith("<div") and "</div>" in stripped:
            pass  # the one-line arrow divider; skip it
        elif stripped.startswith("<div"):
            depth += 1
            if depth == 2:
                cell_lines = []
                index += 1
                continue
        elif stripped == "</div>":
            depth -= 1
            if depth == 1 and cell_lines is not None:
                block.cells.append(parse_blocks(cell_lines))
                cell_lines = None
            if depth == 0:
                return block, index + 1
        if cell_lines is not None:
            cell_lines.append(lines[index])
        index += 1
    raise ValueError("unterminated grid block")


# ---------------------------------------------------------------------------
# Flowable rendering
# ---------------------------------------------------------------------------

def render(blocks: list[Block], description: str) -> list:
    story: list = []
    for block in blocks:
        if block.kind == "title":
            story.append(Paragraph(inline(block.text), STYLES["title"]))
            story.append(Paragraph(inline(description), STYLES["subtitle"]))
            story.append(HRFlowable(width="100%", thickness=2, color=HexColor(BLUE), spaceAfter=18))
        elif block.kind == "hr":
            story.append(HRFlowable(width="100%", thickness=0.7, color=HexColor(RULE), spaceBefore=10, spaceAfter=16))
        elif block.kind in ("h2", "h3"):
            story.append(Paragraph(inline(block.text), STYLES[block.kind]))
        elif block.kind == "paragraph":
            story.append(Paragraph(inline(block.text), STYLES["body"]))
        elif block.kind == "bullets":
            for item in block.lines:
                story.append(Paragraph(
                    f'<bullet color="{BLUE}">•</bullet>{inline(item)}', STYLES["bullet"],
                ))
            story.append(Spacer(1, 4))
        elif block.kind == "code":
            story.append(code_block(block.lines, CONTENT_WIDTH))
        elif block.kind == "table":
            story.append(render_table(block.rows))
        elif block.kind == "callout":
            story.append(render_callout(block.text))
        elif block.kind == "grid":
            story.append(render_grid(block))
    return keep_headings_with_next(story)


def render_table(rows: list[list[str]]) -> Table:
    header = [Paragraph(inline(cell), STYLES["table-header"]) for cell in rows[0]]
    body = [[Paragraph(inline(cell), STYLES["table-cell"]) for cell in row] for row in rows[1:]]
    column_count = len(rows[0])
    # The last column carries the prose ("Meaning", "What to do"), so it gets double weight.
    weights = [1.0] * (column_count - 1) + [2.0] if column_count > 2 else [1.0] * column_count
    total = sum(weights)
    widths = [CONTENT_WIDTH * weight / total for weight in weights]
    table = Table([header] + body, colWidths=widths, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), HexColor(BLUE)),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [white, HexColor(CODE_BG)]),
        ("GRID", (0, 0), (-1, -1), 0.5, HexColor(CODE_BORDER)),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ]))
    table.spaceBefore = 6
    table.spaceAfter = 12
    return table


def render_callout(text: str) -> Table:
    content = Paragraph(inline(text), STYLES["callout"])
    table = Table([["", content]], colWidths=[4, CONTENT_WIDTH - 4])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), HexColor(KEYWORD)),
        ("BACKGROUND", (1, 0), (1, -1), HexColor(CALLOUT_BG)),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (1, 0), (1, -1), 9),
        ("BOTTOMPADDING", (1, 0), (1, -1), 9),
        ("LEFTPADDING", (1, 0), (1, -1), 10),
        ("RIGHTPADDING", (1, 0), (1, -1), 10),
    ]))
    table.spaceBefore = 8
    table.spaceAfter = 12
    return table


def render_grid(block: Block) -> Table:
    if len(block.cells) != 2:
        raise ValueError(f"expected 2 grid cells, found {len(block.cells)}")
    arrow_width = 30
    cell_width = (CONTENT_WIDTH - arrow_width) / 2
    columns = []
    for cell_blocks in block.cells:
        flowables = []
        for cell_block in cell_blocks:
            if cell_block.kind == "paragraph":
                flowables.append(Paragraph(inline(cell_block.text), STYLES["grid-header"]))
            elif cell_block.kind == "code":
                flowables.append(code_block(cell_block.lines, cell_width))
        columns.append(flowables)
    table = Table(
        [[columns[0], Paragraph("→", STYLES["arrow"]), columns[1]]],
        colWidths=[cell_width, arrow_width, cell_width],
    )
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (0, 0), "TOP"),
        ("VALIGN", (2, 0), (2, 0), "TOP"),
        ("VALIGN", (1, 0), (1, 0), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ]))
    table.spaceBefore = 4
    table.spaceAfter = 8
    return table


def keep_headings_with_next(story: list) -> list:
    """Binds each heading to the following flowable so it never widows at a page foot."""
    bound: list = []
    index = 0
    while index < len(story):
        flowable = story[index]
        is_heading = isinstance(flowable, Paragraph) and flowable.style.name in HEADING_STYLE_NAMES
        if is_heading and index + 1 < len(story):
            bound.append(KeepTogether([flowable, story[index + 1]]))
            index += 2
        else:
            bound.append(flowable)
            index += 1
    return bound


# ---------------------------------------------------------------------------
# Document assembly
# ---------------------------------------------------------------------------

def draw_footer(canvas, doc) -> None:
    canvas.saveState()
    canvas.setFont(SANS, 8)
    canvas.setFillColor(HexColor(MUTED))
    canvas.drawString(MARGIN, 40, "sn-ajax-adapter")
    canvas.drawRightString(PAGE_WIDTH - MARGIN, 40, f"Page {doc.page}")
    canvas.restoreState()


def main() -> None:
    register_fonts()
    lines = MDX_PATH.read_text(encoding="utf-8").splitlines()
    meta, content = parse_frontmatter(lines)
    blocks = parse_blocks(content)
    story = render(blocks, meta.get("description", ""))
    document = SimpleDocTemplate(
        str(PDF_PATH), pagesize=letter,
        leftMargin=MARGIN, rightMargin=MARGIN, topMargin=64, bottomMargin=64,
        title=meta.get("title", "AjaxAdapter + AjaxProxy"), author="sn-ajax-adapter",
    )
    document.build(story, onFirstPage=draw_footer, onLaterPages=draw_footer)
    print(f"wrote {PDF_PATH.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
